import { request, parseUserInfo, parseCheckinResult } from './common.js'

/**
 * Veloera
 * 鉴权：Authorization 直接放访问令牌（源码不剥离 Bearer 前缀，勿加），
 *       且必须携带 Veloera-User: <站点用户ID>
 * 签到：POST /api/user/check_in
 */
export default {
  type: 'veloera',
  label: 'Veloera',
  checkinPath: '/api/user/check_in',

  buildHeaders(account) {
    return {
      Authorization: account.token,
      'Veloera-User': String(account.siteUserId ?? ''),
      'Content-Type': 'application/json'
    }
  },

  async userInfo(account) {
    const { json } = await request(`${account.baseUrl}/api/user/self`, {
      headers: this.buildHeaders(account)
    })
    return parseUserInfo(json)
  },

  async checkin(account) {
    const { status, json } = await request(`${account.baseUrl}/api/user/check_in`, {
      method: 'POST',
      headers: this.buildHeaders(account)
    })
    return parseCheckinResult(status, json)
  }
}
