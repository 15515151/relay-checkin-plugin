import { getAdapter } from './adapters/index.js'
import { quotaToUsd, request, parseCheckinResult } from './adapters/common.js'
import { turnstileCheckin } from './browser.js'
import { getConfig } from './config.js'
import { accountLabel, persist } from './store.js'

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min

const STATUS_TEXT = { ok: '签到成功', already: '今日已签', fail: '签到失败' }

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
    return { ok: false, already: false, msg: '站点开启 Turnstile 但无法获取 site key' }
  }

  const res = await turnstileCheckin(account, {
    checkinPath: adapter.checkinPath,
    headers: adapter.buildHeaders(account),
    siteKey
  })
  if (res.turnstileFailed) {
    return { ok: false, already: false, msg: 'Turnstile 挑战未通过（站点可能要求交互验证）' }
  }
  const parsed = parseCheckinResult(res.status, res.json)
  if (!parsed.ok && /turnstile/i.test(parsed.msg)) {
    parsed.msg = 'Turnstile 验证未通过，请稍后重试'
  }
  return parsed
}

/**
 * 对单个账号执行签到，并顺带查询最新余额
 * @returns {Promise<{name, status, statusText, award, balance, msg}>}
 */
export async function checkinAccount(account) {
  const adapter = getAdapter(account.type)
  const result = { name: accountLabel(account), status: 'fail', statusText: '', award: '', balance: '-', msg: '' }
  let statusTextOverride = null
  let skipInfoQuery = false

  try {
    let r
    if (adapter.checkinWithInfo) {
      // AnyRouter 系：一次浏览器会话同时拿签到结果与用户信息
      const session = await adapter.checkinWithInfo(account)
      r = session.checkin
      if (session.info?.ok) {
        r = { ...r, balanceText: session.info.balanceText }
      }
      skipInfoQuery = true
    } else {
      r = await adapter.checkin(account)
      // 站点开启 Turnstile 且浏览器方案可用时，自动降级为浏览器签到
      if (!r.ok && /turnstile/i.test(r.msg) && adapter.checkinPath && getConfig().browser.enable) {
        logger.info(`[relay-checkin-plugin] ${account.name} 触发 Turnstile，尝试浏览器方案`)
        r = await turnstileFallback(account, adapter)
      }
    }

    if (r.ok) {
      result.status = r.already ? 'already' : 'ok'
      statusTextOverride = r.statusTextOverride || null
      if (r.balanceText) result.balance = r.balanceText
      if (!r.already && r.awardQuota != null) {
        result.award = '+' + (quotaToUsd(r.awardQuota) ?? r.awardQuota)
      }
    } else {
      result.msg = r.msg
    }
  } catch (err) {
    result.msg = err.message
  }
  result.statusText = statusTextOverride || STATUS_TEXT[result.status]

  // 余额查询失败不影响签到结果（适配器已携带余额或已在会话中查询时跳过）
  if (result.balance === '-' && !skipInfoQuery) {
    try {
      const info = await adapter.userInfo(account)
      if (info.ok) result.balance = info.balanceText
    } catch {
      // 忽略
    }
  }

  // 缓存运行时状态供 #中转列表 展示（由调用方批量落盘）
  if (result.status === 'ok' || result.status === 'already') {
    account.lastCheckinAt = new Date().toISOString()
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
  persist()
  return results
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
  persist()
  return results
}
