import { request, parseUserInfo, parseCheckinResult } from './common.js'
import { anyrouterSession, anyrouterUserInfo } from '../browser.js'
import { getConfig } from '../config.js'

const WAF_MSG = 'WAF 未放行（浏览器等待超时），请稍后重试'

/**
 * AnyRouter 系（anyrouter.top 及同源站，带阿里云 WAF）
 * 鉴权：Cookie: session=<值> + New-Api-User: <站点用户ID>
 * 签到：POST /api/user/sign_in；纯 HTTP 会被 WAF 拦截，
 *       走无头浏览器：注入 session → 等 WAF 放行 → 页内 fetch 完成签到与查询
 * 参考：dctx-team/Regular-inspection、millylee/anyrouter-check-in
 */
export default {
  type: 'anyrouter',
  label: 'AnyRouter',

  buildHeaders(account) {
    return {
      Cookie: `session=${account.token}`,
      'New-Api-User': String(account.siteUserId ?? ''),
      'X-Requested-With': 'XMLHttpRequest',
      'Content-Type': 'application/json'
    }
  },

  /**
   * 一次浏览器会话完成签到 + 用户信息查询（executor 优先调用）
   */
  async checkinWithInfo(account) {
    if (!getConfig().browser.enable) {
      return {
        checkin: { ok: false, already: false, msg: '浏览器方案未启用（browser.enable），无法过 WAF' },
        info: { ok: false, msg: '浏览器方案未启用' }
      }
    }
    const session = await anyrouterSession(account)
    if (session.wafBlocked) {
      return {
        checkin: { ok: false, already: false, msg: WAF_MSG },
        info: { ok: false, msg: WAF_MSG }
      }
    }
    return {
      checkin: parseCheckinResult(session.checkin.status, session.checkin.json),
      info: parseUserInfo(session.self.json)
    }
  },

  async checkin(account) {
    const { checkin } = await this.checkinWithInfo(account)
    return checkin
  },

  async userInfo(account) {
    // 先试纯 HTTP（个别镜像站无 WAF）；只有拿到成功响应才采信，
    // 避免把 WAF 的 JSON 拦截响应误判为 session 失效
    try {
      const { json } = await request(`${account.baseUrl}/api/user/self`, {
        headers: this.buildHeaders(account)
      })
      if (json?.success) return parseUserInfo(json)
    } catch {
      // 网络失败继续走浏览器
    }
    if (!getConfig().browser.enable) {
      return { ok: false, msg: '浏览器方案未启用（browser.enable），无法过 WAF' }
    }
    const result = await anyrouterUserInfo(account)
    if (result.wafBlocked) return { ok: false, msg: WAF_MSG }
    return parseUserInfo(result.self.json)
  }
}
