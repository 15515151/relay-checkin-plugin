import { request } from './common.js'
import { sub2apiLogin } from '../browser.js'
import { persist } from '../store.js'

/**
 * Sub2API（自研 Go 网关，前端标题 "Sub2API - AI API Gateway"）
 *
 * 与 new-api 系完全不同：接口前缀 /api/v1，响应统一包一层
 * { code: 0, message: "success", data: {...} }，余额字段本身就是美元
 * （balance / free_balance），不存在 new-api 的 quota 换算。
 *
 * 鉴权是 JWT：邮箱密码登录换 access_token（24 小时）+ refresh_token。
 * 站点默认对「登录」开启 Turnstile，但「签到」通常不需要
 * （/check-in/status 的 turnstile_required 字段决定），因此：
 *   1. 优先用未过期的 access_token 直接调接口；
 *   2. 过期则用 refresh_token 纯 HTTP 续期（不开浏览器）；
 *   3. refresh 也失效时才开浏览器过码重新登录。
 *
 * refresh_token 是一次性的：每次 /auth/refresh 都会轮换，旧值立刻 401，
 * 所以换到新值必须立即写回 account 交由 store 落盘，否则下轮只能重新过码。
 */

const API = '/api/v1'
// access_token 名义有效期 24 小时，留 5 分钟余量避免边界上恰好过期
const EXPIRY_SAFETY_MS = 5 * 60 * 1000

function apiUrl(account, path) {
  return `${account.baseUrl}${API}${path}`
}

/**
 * 解包 { code, message, data }。code 为 0 才算成功（HTTP 200 也可能是业务失败）
 */
function unwrap(res) {
  const json = res?.json
  if (json && typeof json === 'object' && 'code' in json) {
    const ok = json.code === 0 || json.code === '0'
    return { ok, data: json.data ?? null, msg: json.message || json.msg || '', reason: json.reason || '' }
  }
  return { ok: false, data: null, msg: json?.message || `响应异常 (HTTP ${res?.status})`, reason: '' }
}

function usd(value) {
  const n = Number(value)
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : null
}

/**
 * 余额展示：付费余额为主，免费额度单独标出（两者用途不同，合计会误导）
 */
function balanceText(data) {
  const paid = usd(data?.balance)
  const free = usd(data?.free_balance)
  if (paid && free) return `${paid} (免费 ${free})`
  return paid || free || '-'
}

function hasLogin(account) {
  return Boolean(String(account?.loginEmail || '').trim()) && Boolean(String(account?.password || ''))
}

/**
 * 取一个可用 access_token。三级兜底，任何一级成功都会把新凭据写回 account。
 * @param {boolean} forceRenew true 时跳过内存中的 access_token（用于 401 重试）
 * @param {boolean} allowBrowser false 时禁止回退到浏览器登录（列表刷余额等短超时场景用：
 *   开浏览器过码要一两分钟，调用方 10 秒就超时了，任务却还在后台占用全局页面槽位）
 */
async function ensureToken(account, { forceRenew = false, allowBrowser = true } = {}) {
  const notExpired = account.tokenExpiresAt
    ? Number(account.tokenExpiresAt) - EXPIRY_SAFETY_MS > Date.now()
    : false
  if (!forceRenew && account.accessToken && notExpired) {
    return { ok: true, token: account.accessToken }
  }

  // 1) refresh_token 纯 HTTP 续期
  const renewed = await renewByRefreshToken(account)
  if (renewed.ok) return { ok: true, token: renewed.token }

  // 2) 浏览器过码重新登录
  if (!allowBrowser) {
    return { ok: false, msg: '凭据已过期，需重新登录（本次查询不启动浏览器，请执行 #中转签到 重新登录）' }
  }
  if (!hasLogin(account)) {
    // 刷新令牌绑定的账号没有密码可用，必须让用户重新取一次
    return {
      ok: false,
      msg: account.authMode === 'refresh'
        ? '刷新令牌已失效，请用「#中转添加刷新令牌 地址」重新绑定（该站点无法自动过人机验证）'
        : 'Session 已过期且未保存邮箱密码，请重新绑定该站点'
    }
  }
  // 浏览器层的熔断与启动失败是 throw 出来的，这里转成统一的失败返回，
  // 避免异常穿透 adapter.login / getCheckinStatus 等约定返回对象的接口
  let login
  try {
    login = await sub2apiLogin(account)
  } catch (err) {
    return { ok: false, msg: err?.message || String(err) }
  }
  if (!login.ok) return { ok: false, msg: login.msg }
  applyTokens(account, login.data)
  if (login.data.user?.id != null) account.siteUserId = login.data.user.id
  if (login.data.user?.username) account.username = login.data.user.username
  return { ok: true, token: login.data.access_token }
}

/**
 * 用 refresh_token 换一对新凭据（纯 HTTP，不开浏览器）。
 * 站点每次都会轮换 refresh_token 并立刻作废旧值，所以换到就必须写回 account。
 */
async function renewByRefreshToken(account) {
  if (!account.token) return { ok: false, msg: '没有可用的刷新令牌' }
  const res = await request(apiUrl(account, '/auth/refresh'), {
    method: 'POST',
    body: { refresh_token: account.token }
  })
  const { ok, data, msg } = unwrap(res)
  if (ok && data?.access_token) {
    applyTokens(account, data)
    return { ok: true, token: data.access_token }
  }
  logger.info(`[relay-checkin-plugin] ${account.name} refresh_token 已失效（${msg || `HTTP ${res.status}`}）`)
  return { ok: false, msg: msg || `刷新令牌无效 (HTTP ${res.status})` }
}

/**
 * 写回登录/续期得到的凭据。token 字段存 refresh_token（长期凭据，由 store 落盘），
 * accessToken 与到期时间同样落盘，避免每次重启都白烧一次 refresh。
 *
 * 必须在这里就地落盘，不能只等调用链末尾的 persist()：站点每次 /auth/refresh 都会
 * 轮换 refresh_token 并立刻作废旧值，而 refreshBalances 之类有超时的调用方在超时后
 * 不会等这次续期跑完（那轮 persist 早已结束），新 refresh_token 就只留在内存里，
 * 下一轮必然 401 且不可逆——只能让用户重新绑定。
 */
function applyTokens(account, data) {
  account.accessToken = data.access_token
  if (data.refresh_token) account.token = data.refresh_token
  const expiresIn = Number(data.expires_in)
  account.tokenExpiresAt = Number.isFinite(expiresIn) && expiresIn > 0
    ? Date.now() + expiresIn * 1000
    : null
  // 落盘失败（磁盘满、文件被占用）只记日志：凭据已在内存，不能让本次签到直接失败
  try {
    persist()
  } catch (err) {
    logger.error(`[relay-checkin-plugin] ${account.name} 凭据落盘失败，refresh_token 可能丢失: ${err?.message || err}`)
  }
}

/**
 * 带 access_token 发请求，遇 401/INVALID_TOKEN 自动续期重试一次
 */
async function authed(account, path, { method = 'GET', body = null, allowBrowser = true } = {}) {
  let auth = await ensureToken(account, { allowBrowser })
  if (!auth.ok) return { authFailed: true, msg: auth.msg }

  const send = token => request(apiUrl(account, path), {
    method,
    headers: { Authorization: `Bearer ${token}` },
    body
  })

  let res = await send(auth.token)
  const invalidToken = res.status === 401 ||
    /INVALID_TOKEN|UNAUTHORIZED/i.test(String(res.json?.code || ''))
  if (invalidToken) {
    auth = await ensureToken(account, { forceRenew: true, allowBrowser })
    if (!auth.ok) return { authFailed: true, msg: auth.msg }
    res = await send(auth.token)
  }
  return res
}

const adapter = {
  type: 'sub2api',
  label: 'Sub2API',
  checkinPath: `${API}/check-in`,
  // 奖励额度由站点直接返回美元金额，无需用前后余额差推算
  compareBalance: false,
  reconcileByBalance: false,

  buildHeaders(account) {
    return {
      Authorization: `Bearer ${account.accessToken || ''}`,
      'Content-Type': 'application/json'
    }
  },

  async userInfo(account, { allowBrowser = true } = {}) {
    const res = await authed(account, '/auth/me', { allowBrowser })
    if (res.authFailed) return { ok: false, msg: res.msg }
    const { ok, data, msg } = unwrap(res)
    if (!ok || !data) return { ok: false, msg: msg || '获取用户信息失败' }
    return {
      ok: true,
      username: data.username || data.email || '',
      siteUserId: data.id,
      // 站点余额本身是美元，不能再进 quotaToUsd
      quota: null,
      usedQuota: null,
      balanceText: balanceText(data),
      usedText: usd(data.total_recharged) ?? '-'
    }
  },

  async getCheckinStatus(account) {
    const res = await authed(account, '/check-in/status')
    if (res.authFailed) return { supported: true, ok: false, msg: res.msg }
    if (res.status === 404) return { supported: false }
    const { ok, data, msg } = unwrap(res)
    if (!ok || typeof data?.checked_in_today !== 'boolean') {
      return { supported: true, ok: false, msg: msg || `签到状态查询失败 (HTTP ${res.status})` }
    }
    return {
      supported: true,
      ok: true,
      checked: data.checked_in_today,
      // 站点管理端可单独给签到开 Turnstile；开了就得在浏览器里取 token
      turnstileRequired: data.turnstile_required === true,
      siteKey: data.turnstile_site_key || '',
      awardText: data.checked_in_today ? usd(data.today_reward) : null,
      balanceText: balanceText(data)
    }
  },

  async checkin(account) {
    const status = await this.getCheckinStatus(account)
    if (status.ok && status.checked) {
      return {
        ok: true,
        already: true,
        confirmed: true,
        awardText: status.awardText,
        balanceText: status.balanceText
      }
    }

    // 签到开了 Turnstile 时先在浏览器里取 token（登录本身也可能顺带完成）
    let turnstileToken = ''
    if (status.ok && status.turnstileRequired) {
      const solved = await sub2apiLogin(account, { siteKey: status.siteKey, tokenOnly: true })
      if (!solved.ok) {
        return { ok: false, already: false, validation: 'turnstile', msg: solved.msg }
      }
      turnstileToken = solved.turnstileToken || ''
    }

    const res = await authed(account, '/check-in', {
      method: 'POST',
      body: { turnstile_token: turnstileToken }
    })
    if (res.authFailed) return { ok: false, already: false, msg: res.msg }
    return parseSub2apiCheckin(res)
  },

  async login(account) {
    const auth = await ensureToken(account, { forceRenew: true })
    if (!auth.ok) return { ok: false, msg: auth.msg }
    return { ok: true }
  },

  /**
   * 只用刷新令牌换凭据，绝不回退到浏览器登录。
   * 供「#中转添加刷新令牌」校验：那类站点本来就过不了码，
   * 回退只会白等两分钟再报一个无关的过码失败。
   */
  async renew(account) {
    return await renewByRefreshToken(account)
  }
}

/**
 * 解析签到响应。成功时 data 与 /check-in/status 同构，
 * already_checked_in 为真代表本次是重复签到。
 */
export function parseSub2apiCheckin(res) {
  const { ok, data, msg, reason } = unwrap(res)
  if (/TURNSTILE/i.test(reason) || /turnstile/i.test(msg)) {
    return { ok: false, already: false, validation: 'turnstile', msg: msg || '签到要求人机验证' }
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, already: false, msg: `凭据无效或已过期 (HTTP ${res.status})` }
  }
  if (!ok) {
    if (/already|已签/i.test(msg)) return { ok: true, already: true, confirmed: true, msg: '今日已签到' }
    return { ok: false, already: false, msg: msg || `签到失败 (HTTP ${res.status})` }
  }
  const already = data?.already_checked_in === true
  return {
    ok: true,
    already,
    confirmed: true,
    awardText: usd(data?.reward_amount) ?? (already ? usd(data?.today_reward) : null),
    balanceText: balanceText(data),
    msg: ''
  }
}

export { balanceText as sub2apiBalanceText, unwrap as unwrapSub2api, hasLogin as hasSub2apiLogin }
export default adapter
