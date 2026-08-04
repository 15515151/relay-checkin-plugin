import { getAdapter } from './adapters/index.js'
import { quotaToUsd, request, parseCheckinResult, deriveAwardQuota } from './adapters/common.js'
import { turnstileCheckin } from './browser.js'
import { getConfig } from './config.js'
import { accountLabel, persist } from './store.js'

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * 落盘失败（磁盘满、Windows 文件被占用等）只记日志：
 * 签到结果本身已在内存，不能因缓存落盘失败让整轮任务中断
 */
function safePersist() {
  try {
    persist()
  } catch (err) {
    logger.error(`[relay-checkin-plugin] 状态缓存落盘失败: ${err?.message || err}`)
  }
}

export const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min

const STATUS_TEXT = { ok: '签到成功', already: '今日已签', unknown: '签到未确认', fail: '签到失败' }

/**
 * 站点回复是否属于「需要人机验证」类拦截（应降级到浏览器方案重试）：
 * 除 Turnstile 明示外，部分魔改站提示「缺少完整性标记 / 请刷新页面 / 验证失败」等
 */
function needsBrowser(msg) {
  return /turnstile|完整性|刷新页面|人机|验证码|captcha|verif/i.test(String(msg || ''))
}

/**
 * Turnstile 站点浏览器降级签到：取 site key → 页面内过挑战 → 带 token 重调签到接口
 */
async function turnstileFallback(account, adapter) {
  let siteKey = null
  try {
    const { json } = await request(`${account.baseUrl}/api/status`)
    siteKey = json?.data?.turnstile_site_key || null
  } catch {
    // 取不到 site key 走下方统一失败
  }
  if (!siteKey) {
    return { ok: false, already: false, msg: '站点要求人机验证但无法获取 site key，无法自动签到' }
  }

  const res = await turnstileCheckin(account, {
    checkinPath: adapter.checkinPath,
    headers: adapter.buildHeaders(account),
    siteKey
  })
  if (res.turnstileFailed) {
    return { ok: false, already: false, msg: 'Turnstile 挑战未通过（站点可能要求交互验证）' }
  }
  const parsed = parseCheckinResult(res.status, res.json, res)
  if (!parsed.ok && needsBrowser(parsed.msg)) {
    parsed.msg = `${parsed.msg}（浏览器方案已重试，站点可能要求交互式验证）`
  }
  return parsed
}

async function readCheckinStatus(adapter, account) {
  if (typeof adapter.getCheckinStatus !== 'function') return null
  try {
    return await adapter.getCheckinStatus(account)
  } catch (err) {
    logger.warn(`[relay-checkin-plugin] ${account.name} 签到状态查询失败: ${err?.message || err}`)
    return { supported: true, ok: false, msg: err?.message || String(err) }
  }
}

async function readUserInfo(adapter, account) {
  try {
    const info = await adapter.userInfo(account)
    return info?.ok ? info : null
  } catch {
    return null
  }
}

/**
 * 对单个账号执行签到，并顺带查询最新余额
 * @returns {Promise<{name, status, statusText, award, balance, msg}>}
 */
export async function checkinAccount(account) {
  const adapter = getAdapter(account.type)
  let r = null
  let beforeStatus = null
  let beforeInfo = null
  let afterInfo = null

  try {
    beforeStatus = await readCheckinStatus(adapter, account)
    if (beforeStatus?.ok && beforeStatus.checked) {
      // 明确查到本轮执行前已经签到：跳过非幂等 POST。
      r = {
        ok: true,
        already: true,
        confirmed: true,
        awardQuota: beforeStatus.awardQuota ?? null,
        statusTextOverride: '本轮前已签到',
        msg: ''
      }
    } else {
      const compareBalance = typeof adapter.compareBalance === 'function'
        ? adapter.compareBalance(account)
        : adapter.compareBalance
      if (compareBalance || (beforeStatus?.ok && beforeStatus.checked === false)) {
        beforeInfo = await readUserInfo(adapter, account)
      }

      if (adapter.checkinWithInfo) {
        // AnyRouter 系在同一套 WAF cookie 下完成前后余额查询与签到。
        const session = await adapter.checkinWithInfo(account)
        r = session.checkin
        if (session.info?.ok) afterInfo = session.info
      } else {
        try {
          r = await adapter.checkin(account)
          if (r.info?.ok) afterInfo = r.info
        } catch (err) {
          r = { ok: false, already: false, uncertain: true, msg: err?.message || String(err) }
        }
        // 站点要求人机验证且浏览器方案可用时，自动降级为浏览器签到
        if (!r.ok && needsBrowser(r.msg) && adapter.checkinPath && getConfig().browser.enable) {
          logger.info(`[relay-checkin-plugin] ${account.name} 需人机验证，尝试浏览器方案`)
          r = await turnstileFallback(account, adapter)
        }
      }

      const afterStatus = beforeStatus?.supported === false
        ? null
        : await readCheckinStatus(adapter, account)
      if (afterStatus?.ok && afterStatus.checked) {
        const changedThisRun = beforeStatus?.ok && beforeStatus.checked === false
        if (!r.ok || r.already) {
          r = {
            ok: true,
            already: !changedThisRun,
            confirmed: true,
            awardQuota: r.awardQuota ?? afterStatus.awardQuota ?? null,
            statusTextOverride: changedThisRun ? '状态复核成功' : '状态复核已签',
            msg: ''
          }
        } else {
          r.confirmed = true
          if (r.awardQuota == null) r.awardQuota = afterStatus.awardQuota ?? null
        }
      } else if (r.uncertain && afterStatus?.ok && !afterStatus.checked) {
        r.msg = `${r.msg}；状态复核仍为未签到`
      }
    }
  } catch (err) {
    r = { ok: false, already: false, msg: err?.message || String(err) }
  }

  // 查询签到后余额；失败不影响已经确认的签到结果。
  if (!afterInfo) afterInfo = await readUserInfo(adapter, account)
  if (!r?.ok && r?.uncertain && adapter.reconcileByBalance) {
    const awardQuota = deriveAwardQuota(beforeInfo, afterInfo)
    if (awardQuota != null) {
      r = {
        ok: true,
        already: false,
        confirmed: true,
        awardQuota,
        statusTextOverride: '余额复核成功',
        msg: ''
      }
    }
  }
  return finalizeCheckinResult(account, r, { beforeInfo, afterInfo })
}

/**
 * 把适配器结果整理成统一展示行，并更新账号运行状态。
 * 邮箱绑定时首次登录本身已经完成签到，可复用该结果避免重复登录。
 */
export function finalizeCheckinResult(account, r, { beforeInfo = null, afterInfo = null } = {}) {
  const result = { name: accountLabel(account), status: 'fail', statusText: '', award: '', balance: '-', msg: '' }
  if (afterInfo?.balanceText) result.balance = afterInfo.balanceText
  else if (r?.balanceText) result.balance = r.balanceText

  if (r?.ok && !r.already && r.awardQuota == null) {
    r.awardQuota = deriveAwardQuota(beforeInfo, afterInfo)
  }

  if (r?.ok) {
    result.status = r.confirmed === false ? 'unknown' : (r.already ? 'already' : 'ok')
    result.statusText = r.statusTextOverride || STATUS_TEXT[result.status]
    result.msg = r.msg || ''
    if (r.awardQuota != null) {
      const value = quotaToUsd(r.awardQuota) ?? r.awardQuota
      result.award = r.already ? `今日 +${value}` : `+${value}`
    }
  } else {
    result.status = 'fail'
    result.statusText = STATUS_TEXT.fail
    result.msg = r?.msg || '签到失败'
  }

  // 缓存运行时状态供 #中转列表 展示（由调用方批量落盘）
  const now = new Date().toISOString()
  if (result.status === 'ok' || result.status === 'already') {
    account.lastCheckinAt = now
    account.lastCheckinAttemptAt = now
    account.lastCheckinConfirmed = true
  } else if (result.status === 'unknown') {
    account.lastCheckinAttemptAt = now
    account.lastCheckinConfirmed = false
  }
  if (result.balance !== '-') account.lastBalance = result.balance

  return result
}

/**
 * 对一个用户条目的全部（或指定序号）账号执行签到
 * @param {object} entry 存储条目
 * @param {object} opts { index: 1起的序号(可选), delayRange: [min,max]秒(可选，账号间随机间隔),
 *                        autoOnly: 仅执行定时开关打开的账号（定时任务用） }
 */
export async function checkinEntry(entry, { index = null, delayRange = null, autoOnly = false } = {}) {
  let accounts = index ? [entry.accounts[index - 1]].filter(Boolean) : entry.accounts
  if (autoOnly) accounts = accounts.filter(acc => acc.auto !== false)
  const results = []
  for (let i = 0; i < accounts.length; i++) {
    if (i > 0 && delayRange) {
      await sleep(randInt(delayRange[0], delayRange[1]) * 1000)
    }
    results.push(await checkinAccount(accounts[i]))
  }
  safePersist()
  return results
}

/**
 * 刷新条目内各账号的余额缓存（#中转列表 用）：
 * 纯 HTTP 站实时查询；AnyRouter 等浏览器站太慢，跳过用缓存。
 * 并发执行，单账号超时/失败保留旧缓存，不影响其他账号
 */
const BROWSER_TYPES = new Set(['anyrouter'])

export async function refreshBalances(entry, { timeoutMs = 10000 } = {}) {
  await Promise.allSettled(entry.accounts.map(async account => {
    if (BROWSER_TYPES.has(account.type)) return
    const adapter = getAdapter(account.type)
    let timer = null
    try {
      // 超时后原 promise 仍会被本 race 接管（不会变成未处理拒绝），同时清掉定时器避免悬挂
      const info = await Promise.race([
        adapter.userInfo(account),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('刷新超时')), timeoutMs)
        })
      ])
      if (info.ok) {
        account.lastBalance = info.balanceText
        if (info.username) account.username = info.username
      }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }))
  safePersist()
}

/**
 * 余额查询（不签到）
 * @returns {Promise<Array<{name, status, statusText, award, balance, msg}>>}
 */
export async function queryEntry(entry) {
  const results = []
  for (const account of entry.accounts) {
    const adapter = getAdapter(account.type)
    const row = { name: accountLabel(account), status: 'ok', statusText: '正常', award: '', balance: '-', msg: '' }
    try {
      const info = await adapter.userInfo(account)
      if (info.ok) {
        row.balance = info.balanceText
        row.award = `已用 ${info.usedText}`
        account.lastBalance = info.balanceText
      } else {
        row.status = 'fail'
        row.statusText = '查询失败'
        row.msg = info.msg
      }
    } catch (err) {
      row.status = 'fail'
      row.statusText = '查询失败'
      row.msg = err.message
    }
    results.push(row)
  }
  safePersist()
  return results
}
