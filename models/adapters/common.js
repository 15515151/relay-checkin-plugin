import { getConfig } from '../config.js'

/**
 * 发起 JSON 请求（带超时与重试）
 * @returns {Promise<{status: number, json: object|null}>}
 */
export async function request(url, { method = 'GET', headers = {} } = {}) {
  const cfg = getConfig()
  const timeoutMs = (cfg.request.timeout || 15) * 1000
  const maxRetry = cfg.request.retry ?? 1

  let lastErr = null
  for (let attempt = 0; attempt <= maxRetry; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(url, {
        method,
        headers: {
          'User-Agent': cfg.request.userAgent,
          Accept: 'application/json',
          ...headers
        },
        redirect: 'manual',
        signal: controller.signal
      })
      let json = null
      try {
        json = await res.json()
      } catch {
        // 非 JSON 响应（404 页面 / WAF 拦截页等）
      }
      return { status: res.status, json }
    } catch (err) {
      lastErr = err
    } finally {
      clearTimeout(timer)
    }
  }
  throw new Error(`网络请求失败: ${lastErr?.message || lastErr}`)
}

/**
 * new-api 系 quota 换算美元（500000 quota = $1），兼容字符串数字；
 * 缺失值（null/undefined/空串）返回 null 而非 $0.00
 */
export function quotaToUsd(quota) {
  if (quota === null || quota === undefined || quota === '') return null
  const n = Number(quota)
  if (!Number.isFinite(n)) return null
  return '$' + (n / 500000).toFixed(2)
}

/**
 * 解析 /api/user/self 响应为统一结构
 */
export function parseUserInfo(json) {
  if (!json?.success || !json?.data) {
    return { ok: false, msg: json?.message || '获取用户信息失败' }
  }
  const d = json.data
  return {
    ok: true,
    username: d.display_name || d.username || '',
    siteUserId: d.id,
    quota: d.quota,
    usedQuota: d.used_quota,
    balanceText: quotaToUsd(d.quota) ?? '-',
    usedText: quotaToUsd(d.used_quota) ?? '-'
  }
}

/**
 * 解析签到响应为统一结构
 */
export function parseCheckinResult(status, json) {
  if (status === 404) {
    return { ok: false, already: false, msg: '站点无此签到接口（可能未启用签到功能）' }
  }
  if (status === 401 || status === 403) {
    return { ok: false, already: false, msg: `凭据无效或已过期 (HTTP ${status})` }
  }
  if (status === 301 || status === 302) {
    return { ok: false, already: false, msg: '被重定向到登录页，凭据可能已失效' }
  }
  if (!json) {
    return { ok: false, already: false, msg: `响应异常 (HTTP ${status})` }
  }
  const msg = json.message || ''
  if (json.success) {
    // new-api 为 quota_awarded；Veloera 为 quota（均为本次奖励额度）
    const award = json.data?.quota_awarded ?? json.data?.quota ?? null
    return { ok: true, already: false, msg: msg || '签到成功', awardQuota: award }
  }
  if (/已签|签过|重复签|already/i.test(msg)) {
    return { ok: true, already: true, msg: '今日已签到' }
  }
  if (/turnstile/i.test(msg)) {
    return { ok: false, already: false, msg: '站点开启了 Turnstile 人机验证，无法自动签到' }
  }
  return { ok: false, already: false, msg: msg || '签到失败' }
}
