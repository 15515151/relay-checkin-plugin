import { request, parseUserInfo, parseCheckinResult } from './common.js'
import { anyrouterSession, anyrouterUserInfo } from '../browser.js'
import { getConfig } from '../config.js'

const WAF_MSG = 'WAF 未放行（浏览器等待超时），请稍后重试'

/**
 * 解析浏览器页内 /api/user/self 结果，失败时补充状态码便于定位
 * （status 0 = 页内请求被 WAF 刷新中断；非 JSON = 可能被 WAF 拦截）
 */
function parseSelfWithDiag(self) {
  const info = parseUserInfo(self?.json)
  if (!info.ok && self && self.json == null) {
    info.msg = self.status === 0
      ? '页面内请求被站点刷新中断，请稍后重试'
      : `用户信息接口未返回有效数据 (HTTP ${self.status})，可能被 WAF 拦截`
  }
  return info
}

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
    logger.info(`[relay-checkin-plugin] anyrouter 开始浏览器签到会话: ${account.name}`)
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
    const checkin = parseCheckinResult(session.checkin.status, session.checkin.json)
    if (!checkin.ok && session.checkin.status === 0) {
      checkin.msg = '页面内签到请求被站点刷新中断，请稍后重试'
    }
    return {
      checkin,
      info: parseSelfWithDiag(session.self)
    }
  },

  async checkin(account) {
    const { checkin } = await this.checkinWithInfo(account)
    return checkin
  },

  async userInfo(account) {
    // 快速试一次纯 HTTP（个别镜像站无 WAF）：短超时不重试，避免长时间静默；
    // 只有拿到成功响应才采信，避免把 WAF 的 JSON 拦截响应误判为 session 失效
    try {
      const { json } = await request(`${account.baseUrl}/api/user/self`, {
        headers: this.buildHeaders(account),
        timeoutMs: 8000,
        maxRetry: 0
      })
      if (json?.success) return parseUserInfo(json)
      logger.info('[relay-checkin-plugin] anyrouter 纯 HTTP 探测未通过（WAF 拦截），走浏览器方案')
    } catch (err) {
      logger.info(`[relay-checkin-plugin] anyrouter 纯 HTTP 探测失败（${err.message}），走浏览器方案`)
    }
    if (!getConfig().browser.enable) {
      return { ok: false, msg: '浏览器方案未启用（browser.enable），无法过 WAF' }
    }
    const result = await anyrouterUserInfo(account)
    if (result.wafBlocked) return { ok: false, msg: WAF_MSG }
    return parseSelfWithDiag(result.self)
  }
}
