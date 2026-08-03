import newapi from './newapi.js'
import veloera from './veloera.js'
import generic from './generic.js'
import agentrouter from './agentrouter.js'

const adapters = { newapi, veloera, generic, agentrouter }

export function getAdapter(type) {
  return adapters[type] || newapi
}

/**
 * Cookie 方式添加时按域名选择适配器
 */
export function cookieTypeForHost(host) {
  return /agentrouter/i.test(host) ? 'agentrouter' : 'generic'
}

/**
 * 规范化站点地址：去尾部斜杠、补 https://
 */
export function normalizeBaseUrl(input) {
  let url = String(input).trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url
  return url
}

/**
 * 自动探测站点类型（令牌方式添加时用）
 * 依次尝试 new-api（Bearer）、Veloera（原始令牌 + Veloera-User）
 * @returns {Promise<{ok: boolean, type?: string, info?: object, msg?: string}>}
 */
export async function probeAccount(baseUrl, token, siteUserId) {
  // 1) new-api：Bearer 令牌
  try {
    const info = await newapi.userInfo({ baseUrl, token, siteUserId })
    if (info.ok) {
      return { ok: true, type: 'newapi', info }
    }
  } catch (err) {
    return { ok: false, msg: err.message }
  }

  // 2) Veloera：需要站点用户ID
  if (siteUserId) {
    try {
      const info = await veloera.userInfo({ baseUrl, token, siteUserId })
      if (info.ok) {
        return { ok: true, type: 'veloera', info }
      }
    } catch {
      // 网络层失败在上一步已返回，这里静默进入最终失败
    }
  }

  return {
    ok: false,
    msg: siteUserId
      ? '令牌验证失败，请检查地址与令牌是否正确'
      : '令牌验证失败。若为 Veloera 站点，请在指令末尾附加站点用户ID重试'
  }
}
