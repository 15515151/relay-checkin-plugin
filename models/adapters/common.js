import { getConfig } from '../config.js'

/**
 * 按代理配置判断某 host 是否走代理，返回代理地址或 null（纯函数便于测试）
 * hosts 为域名关键字（包含匹配）；空数组 = 配置了代理后全部走代理
 */
export function matchProxy(host, proxyCfg) {
  if (!proxyCfg?.url) return null
  const hosts = (Array.isArray(proxyCfg.hosts) ? proxyCfg.hosts : []).filter(Boolean)
  if (!hosts.length) return proxyCfg.url
  return hosts.some(h => String(host).includes(String(h))) ? proxyCfg.url : null
}

/**
 * 当前配置下某 host 应使用的代理地址（无需代理返回 null）
 */
export function proxyForHost(host) {
  return matchProxy(host, getConfig().proxy)
}

let proxyAgentCache = null

/**
 * 复用 Yunzai 根目录自带的 https-proxy-agent 构建代理 Agent（按代理地址缓存）
 * 兼容 v7（具名导出 HttpsProxyAgent）与 v5（默认导出）
 */
async function getProxyAgent(proxyUrl) {
  if (proxyAgentCache?.url === proxyUrl) return proxyAgentCache.agent
  let mod
  try {
    mod = await import('https-proxy-agent')
  } catch {
    throw new Error('未找到 https-proxy-agent 依赖（Yunzai 自带），代理不可用')
  }
  const HttpsProxyAgent = mod.HttpsProxyAgent ?? mod.default
  if (typeof HttpsProxyAgent !== 'function') {
    throw new Error('https-proxy-agent 版本不兼容，代理不可用')
  }
  proxyAgentCache = { url: proxyUrl, agent: new HttpsProxyAgent(proxyUrl) }
  return proxyAgentCache.agent
}

/**
 * 经 http 代理请求 https 站点（node:https + proxy agent；不跟随重定向，与 fetch 路径语义一致）
 * 用独立定时器兜底超时：options.timeout 依赖 socket 分配，代理 CONNECT 阶段挂起时不会触发
 */
async function proxiedRequest(url, { method, headers, timeoutMs, proxyUrl }) {
  const agent = await getProxyAgent(proxyUrl)
  const { request: httpsRequest } = await import('node:https')
  return await new Promise((resolve, reject) => {
    const req = httpsRequest(url, { method, headers, agent }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        clearTimeout(timer)
        let json = null
        try {
          json = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch {
          // 非 JSON 响应
        }
        resolve({ status: res.statusCode, json })
      })
    })
    const timer = setTimeout(() => req.destroy(new Error('代理请求超时（代理隧道无响应）')), timeoutMs)
    req.on('error', err => {
      clearTimeout(timer)
      reject(err)
    })
    req.end()
  })
}

/**
 * 发起 JSON 请求（带超时与重试；命中代理配置的 https 站点走代理）
 * @param {object} opts { method, headers, timeoutMs: 覆盖配置超时, maxRetry: 覆盖配置重试次数 }
 * @returns {Promise<{status: number, json: object|null}>}
 */
export async function request(url, { method = 'GET', headers = {}, timeoutMs = null, maxRetry = null } = {}) {
  const cfg = getConfig()
  const tMs = timeoutMs ?? (cfg.request.timeout || 15) * 1000
  const retries = maxRetry ?? (cfg.request.retry ?? 1)
  const fullHeaders = {
    'User-Agent': cfg.request.userAgent,
    Accept: 'application/json',
    ...headers
  }
  const proxyUrl = url.startsWith('https:') ? proxyForHost(new URL(url).hostname) : null

  let lastErr = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (proxyUrl) {
      try {
        return await proxiedRequest(url, { method, headers: fullHeaders, timeoutMs: tMs, proxyUrl })
      } catch (err) {
        lastErr = err
        continue
      }
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), tMs)
    try {
      const res = await fetch(url, {
        method,
        headers: fullHeaders,
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
