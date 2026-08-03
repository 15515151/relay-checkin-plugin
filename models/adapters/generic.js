import { request, parseUserInfo, parseCheckinResult } from './common.js'

/**
 * 通用 cookie 型（AnyRouter 无 WAF 同源站、旧版 new-api/one-api 魔改站）
 * 鉴权：Cookie: session=<值> + New-Api-User: <站点用户ID>
 * 签到：POST <signPath>，默认 /api/user/sign_in
 * 注：token 字段存的是 session cookie 值；带阿里云 WAF 的站（如 AnyRouter 官站）
 *     纯 HTTP 会被拦截，属于二期浏览器方案范围
 */
export default {
  type: 'generic',
  label: 'Cookie通用',

  buildHeaders(account) {
    return {
      Cookie: `session=${account.token}`,
      'New-Api-User': String(account.siteUserId ?? ''),
      'X-Requested-With': 'XMLHttpRequest',
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
    const signPath = account.signPath || '/api/user/sign_in'
    const { status, json } = await request(`${account.baseUrl}${signPath}`, {
      method: 'POST',
      headers: this.buildHeaders(account)
    })
    return parseCheckinResult(status, json)
  }
}
