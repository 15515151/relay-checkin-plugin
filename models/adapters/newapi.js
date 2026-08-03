import { request, parseUserInfo, parseCheckinResult } from './common.js'

/**
 * new-api（QuantumNous/new-api 及多数同源魔改）
 * 鉴权：Authorization: Bearer <系统访问令牌>
 * 签到：POST /api/user/checkin（站点开启 Turnstile 时无法纯 API 签到）
 */
export default {
  type: 'newapi',
  label: 'new-api',

  buildHeaders(account) {
    const headers = {
      Authorization: `Bearer ${account.token}`,
      'Content-Type': 'application/json'
    }
    // 部分魔改站仍校验 New-Api-User 头，有值就带上
    if (account.siteUserId) headers['New-Api-User'] = String(account.siteUserId)
    return headers
  },

  async userInfo(account) {
    const { json } = await request(`${account.baseUrl}/api/user/self`, {
      headers: this.buildHeaders(account)
    })
    return parseUserInfo(json)
  },

  async checkin(account) {
    const { status, json } = await request(`${account.baseUrl}/api/user/checkin`, {
      method: 'POST',
      headers: this.buildHeaders(account)
    })
    return parseCheckinResult(status, json)
  }
}
