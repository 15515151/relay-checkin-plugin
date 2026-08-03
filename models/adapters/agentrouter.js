import { request, parseUserInfo, parseCheckinResult } from './common.js'

/**
 * AgentRouter（agentrouter.org）
 * 鉴权：Cookie: session=<值> + New-Api-User: <站点用户ID>，无 WAF，纯 HTTP 可用
 * 签到：先尝试 POST /api/user/sign_in；接口不存在(404)时降级为
 *       GET /api/user/self —— 该站查询用户信息即完成保活续期
 * 参考：dctx-team/Regular-inspection
 */
export default {
  type: 'agentrouter',
  label: 'AgentRouter',

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
    const { status, json } = await request(`${account.baseUrl}/api/user/sign_in`, {
      method: 'POST',
      headers: this.buildHeaders(account)
    })
    if (status !== 404) {
      return parseCheckinResult(status, json)
    }
    // 无 sign_in 接口：查询用户信息即视为保活成功，顺带携带余额避免重复请求
    const info = await this.userInfo(account)
    if (info.ok) {
      return {
        ok: true,
        already: false,
        msg: '',
        statusTextOverride: '保活成功',
        balanceText: info.balanceText
      }
    }
    return { ok: false, already: false, msg: info.msg || '保活失败' }
  }
}
