import { createHash, randomUUID } from 'node:crypto'
import os from 'node:os'
import { request, parseUserInfo, parseCheckinResult } from './common.js'
import { getConfig } from '../config.js'
import { logger } from '../../host/index.js'

const integritySessions = new Map()

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex')
}

function integritySession(account) {
  const key = `${account.baseUrl}|${account.siteUserId ?? ''}`
  let session = integritySessions.get(key)
  if (!session) {
    session = { id: randomUUID(), seq: 0 }
    integritySessions.set(key, session)
  }
  return session
}

/**
 * 部分 NewAPI 魔改站会给写请求校验网页端生成的 X-Game-* 完整性头。
 * 首次请求明确返回「缺少完整性标记」后，按其公开网页实现补齐再重发。
 */
function gameIntegrityHeaders(account, body = '') {
  const session = integritySession(account)
  const userAgent = getConfig().request.userAgent || ''
  const platform = /windows/i.test(userAgent) ? 'Win32' : (process.platform === 'darwin' ? 'MacIntel' : 'Linux x86_64')
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai'
  const concurrency = typeof os.availableParallelism === 'function' ? os.availableParallelism() : (os.cpus()?.length || 4)
  const fingerprint = [userAgent, 'zh-CN', platform, timeZone, String(concurrency), '8'].join('|')
  session.seq++
  return {
    'X-Game-Action-Id': randomUUID(),
    'X-Game-Client-Ts': String(Date.now()),
    'X-Game-Session-Id': session.id,
    'X-Game-Client-Seq': String(session.seq),
    'X-Game-Client-Fingerprint': sha256(fingerprint),
    'X-Game-Body-SHA256': sha256(body)
  }
}

function needsGameIntegrity(json) {
  const msg = json?.message || json?.msg || json?.error?.message || ''
  return /完整性标记|X-Game-|game.?integrity/i.test(String(msg))
}

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
    const headers = { 'Content-Type': 'application/json' }
    if (account.authMode === 'session') {
      // 网页会话方式（#中转添加cookie）：签到/验证码接口只认 session Cookie
      headers.Cookie = `session=${account.token}`
    } else {
      headers.Authorization = `Bearer ${account.token}`
    }
    // 部分魔改站仍校验 New-Api-User 头，有值就带上
    if (account.siteUserId) headers['New-Api-User'] = String(account.siteUserId)
    // access token + 网页会话并存的账号（手动配置 cookie 字段）
    if (account.cookie) headers.Cookie = account.cookie
    // 会话类魔改站还会校验请求来自本站页面，补齐 Origin/Referer
    if (account.cookie || account.authMode === 'session') {
      const base = String(account.baseUrl || '').replace(/\/+$/, '')
      headers.Origin = base
      headers.Referer = `${base}/console`
    }
    return headers
  },

  // 浏览器验证后的写请求同时需要网页端生成的完整性标记。
  buildValidationHeaders(account, body = '') {
    return {
      ...this.buildHeaders(account),
      ...gameIntegrityHeaders(account, body)
    }
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
    const url = `${account.baseUrl}/api/user/checkin`
    let res = await request(url, {
      method: 'POST',
      headers: this.buildHeaders(account)
    })
    if (needsGameIntegrity(res.json)) {
      logger.info(`[relay-checkin-plugin] ${account.name} 要求网页完整性标记，补齐 X-Game-* 请求头后重试`)
      res = await request(url, {
        method: 'POST',
        headers: {
          ...this.buildHeaders(account),
          ...gameIntegrityHeaders(account)
        }
      })
    }
    return parseCheckinResult(res.status, res.json, res)
  }
}
