import { request, parseUserInfo, parseCheckinResult } from './common.js'

/**
 * new-api（QuantumNous/new-api 及多数同源魔改）
 * 鉴权：Authorization: Bearer <系统访问令牌>
 * 签到：POST /api/user/checkin（站点开启 Turnstile 时无法纯 API 签到）
 */
export default {
  type: 'newapi',
  label: 'new-api',
  checkinPath: '/api/user/checkin',
  compareBalance: true,

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

  async getCheckinStatus(account) {
    const now = new Date()
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    const today = `${month}-${String(now.getDate()).padStart(2, '0')}`
    const res = await request(`${account.baseUrl}/api/user/checkin?month=${month}`, {
      headers: this.buildHeaders(account)
    })
    if (res.status === 404) return { supported: false }
    const stats = res.json?.data?.stats
    if (!res.json?.success || typeof stats?.checked_in_today !== 'boolean') {
      return { supported: true, ok: false, msg: res.json?.message || res.json?.msg || `签到状态查询失败 (HTTP ${res.status})` }
    }
    const todayRecord = Array.isArray(stats.records)
      ? stats.records.find(record => record?.checkin_date === today)
      : null
    return {
      supported: true,
      ok: true,
      checked: stats.checked_in_today,
      awardQuota: todayRecord?.quota_awarded ?? null
    }
  },

  async checkin(account) {
    const res = await request(`${account.baseUrl}/api/user/checkin`, {
      method: 'POST',
      headers: this.buildHeaders(account)
    })
    return parseCheckinResult(res.status, res.json, res)
  }
}
