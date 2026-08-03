import { getConfig } from './config.js'
import { proxyForHost } from './adapters/common.js'

/**
 * 无头浏览器工具：用于过阿里云 WAF（AnyRouter 系）与 Cloudflare Turnstile 挑战。
 * puppeteer 惰性加载（复用 Yunzai 根目录依赖，缺失时仅浏览器功能不可用，不影响插件加载）；
 * 浏览器单例复用，空闲一段时间后自动关闭。
 * 目标站点命中 proxy 配置时以 --proxy-server 启动（带账密代理经 page.authenticate 认证）。
 */

let browserInstance = null
let browserMode = null
let idleTimer = null
let activeTasks = 0

async function getPuppeteer() {
  try {
    return (await import('puppeteer')).default
  } catch {
    throw new Error('未找到 puppeteer 依赖，无法使用浏览器方案')
  }
}

// 反自动化检测：任一项失败都不应中断页面初始化，整体 try 包裹
const STEALTH_SCRIPT = `
  try {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    window.chrome = window.chrome || { runtime: {} }
    Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] })
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] })
    const origQuery = window.navigator.permissions?.query
    if (origQuery) {
      window.navigator.permissions.query = parameters =>
        parameters.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : origQuery(parameters)
    }
  } catch (e) {}
`

function isBrowserAlive() {
  if (!browserInstance) return false
  // puppeteer v20+ 为 connected 属性，老版本为 isConnected()
  return browserInstance.connected ?? browserInstance.isConnected?.() ?? false
}

/**
 * 解析代理地址：chromium 的 --proxy-server 不支持带账密，账密拆出来走 page.authenticate
 */
function parseProxy(proxyUrl) {
  if (!proxyUrl) return null
  try {
    const u = new URL(proxyUrl)
    return {
      server: `${u.protocol}//${u.host}`,
      auth: (u.username || u.password)
        ? { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) }
        : null
    }
  } catch {
    logger.warn(`[relay-checkin-plugin] 代理地址格式不正确，已忽略: ${proxyUrl}`)
    return null
  }
}

async function getBrowser(proxy) {
  const mode = proxy?.server || 'direct'
  if (isBrowserAlive()) {
    if (browserMode === mode) return browserInstance
    // 代理模式不同需重启浏览器；有其他任务在用时沿用现有实例，避免中断
    if (activeTasks > 1) {
      logger.warn(`[relay-checkin-plugin] 浏览器正被其他任务使用，本次沿用 ${browserMode} 模式`)
      return browserInstance
    }
    const inst = browserInstance
    browserInstance = null
    await inst.close().catch(() => {})
  }
  const puppeteer = await getPuppeteer()
  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled'
  ]
  if (proxy?.server) args.push(`--proxy-server=${proxy.server}`)
  browserInstance = await puppeteer.launch({ headless: 'new', args })
  browserMode = mode
  return browserInstance
}

function scheduleIdleClose() {
  const idleSec = getConfig().browser.idleCloseSec || 300
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(async () => {
    idleTimer = null
    // 仍有任务在用浏览器时不回收，等最后一个任务结束再调度
    if (activeTasks > 0) return
    const inst = browserInstance
    browserInstance = null
    try {
      await inst?.close()
    } catch {
      // 忽略关闭异常
    }
  }, idleSec * 1000)
}

/**
 * 打开一个已注入 stealth 的页面执行任务，自动关闭页面并调度浏览器空闲回收
 * @param {string} host 目标站点 host（用于判断是否走代理）
 */
async function withPage(host, fn) {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  activeTasks++
  let page = null
  try {
    const proxy = parseProxy(proxyForHost(host))
    const browser = await getBrowser(proxy)
    page = await browser.newPage()
    if (proxy?.auth) await page.authenticate(proxy.auth)
    await page.setUserAgent(getConfig().request.userAgent)
    await page.evaluateOnNewDocument(STEALTH_SCRIPT)
    return await fn(page)
  } finally {
    if (page) await page.close().catch(() => {})
    activeTasks--
    scheduleIdleClose()
  }
}

/**
 * 在页面上下文内发起 fetch（自动携带页面 cookie，可附加请求头）
 * 页面导航中（WAF 挑战自动刷新）evaluate 会抛异常，统一吞掉返回 status 0 由调用方重试
 * @returns {Promise<{status: number, json: object|null}>}
 */
async function pageFetch(page, url, { method = 'GET', headers = {} } = {}) {
  try {
    return await page.evaluate(async ({ url, method, headers }) => {
      try {
        const res = await fetch(url, { method, headers, credentials: 'include' })
        let json = null
        try {
          json = await res.json()
        } catch {
          // 非 JSON（WAF 拦截页等）
        }
        return { status: res.status, json }
      } catch (err) {
        return { status: 0, json: null, error: String(err) }
      }
    }, { url, method, headers })
  } catch (err) {
    return { status: 0, json: null, error: String(err?.message || err) }
  }
}

/**
 * 带重试的页内请求：WAF 挑战自刷新会中断页内 fetch（status 0），间隔重试几次
 */
async function pageFetchRetry(page, url, opts, tries = 3, delayMs = 1500) {
  let res = null
  for (let i = 0; i < tries; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, delayMs))
    res = await pageFetch(page, url, opts)
    if (res.status !== 0) return res
  }
  return res
}

/**
 * 等待站点 API 可访问（WAF 放行标志）：页内请求 /api/status 返回有效 JSON
 * 且包含 success 或 data 字段（排除 WAF 拦截的 JSON 响应）；
 * 放行后短暂等待，避开挑战通过瞬间的页面刷新
 */
async function waitApiReady(page, baseUrl, timeoutSec) {
  const deadline = Date.now() + timeoutSec * 1000
  while (Date.now() < deadline) {
    const { json } = await pageFetch(page, `${baseUrl}/api/status`)
    if (json && (json.success !== undefined || json.data !== undefined)) {
      await new Promise(r => setTimeout(r, 800))
      return true
    }
    await new Promise(r => setTimeout(r, 1500))
  }
  return false
}

/**
 * AnyRouter 系（阿里云 WAF）浏览器会话：注入 session cookie → 过 WAF → 页内签到 + 查询用户信息
 * @returns {Promise<{checkin: {status, json}, self: {status, json}}|{wafBlocked: true}>}
 */
export async function anyrouterSession(account) {
  const cfg = getConfig()
  const host = new URL(account.baseUrl).hostname
  return await withPage(host, async page => {
    await page.setCookie({ name: 'session', value: account.token, domain: host, path: '/' })
    await page.goto(account.baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })

    if (!await waitApiReady(page, account.baseUrl, cfg.browser.wafTimeoutSec || 25)) {
      return { wafBlocked: true }
    }

    const headers = {
      'New-Api-User': String(account.siteUserId ?? ''),
      'X-Requested-With': 'XMLHttpRequest',
      'Content-Type': 'application/json'
    }
    const checkin = await pageFetchRetry(page, `${account.baseUrl}${account.signPath || '/api/user/sign_in'}`, {
      method: 'POST',
      headers
    })
    const self = await pageFetchRetry(page, `${account.baseUrl}/api/user/self`, { headers })
    return { checkin, self }
  })
}

/**
 * AnyRouter 系仅查询用户信息（余额查询用）
 */
export async function anyrouterUserInfo(account) {
  const cfg = getConfig()
  const host = new URL(account.baseUrl).hostname
  return await withPage(host, async page => {
    await page.setCookie({ name: 'session', value: account.token, domain: host, path: '/' })
    await page.goto(account.baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })

    if (!await waitApiReady(page, account.baseUrl, cfg.browser.wafTimeoutSec || 25)) {
      return { wafBlocked: true }
    }
    const self = await pageFetchRetry(page, `${account.baseUrl}/api/user/self`, {
      headers: {
        'New-Api-User': String(account.siteUserId ?? ''),
        'X-Requested-With': 'XMLHttpRequest'
      }
    })
    return { self }
  })
}

/**
 * 在站点页面上下文内渲染 Cloudflare Turnstile 挑战并获取 token
 * @returns {Promise<string|null>}
 */
async function solveTurnstile(page, siteKey, timeoutSec) {
  return await page.evaluate(async ({ siteKey, timeoutSec }) => {
    try {
      if (!window.turnstile) {
        await new Promise((resolve, reject) => {
          const s = document.createElement('script')
          s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
          s.onload = resolve
          s.onerror = () => reject(new Error('Turnstile 脚本加载失败'))
          document.head.appendChild(s)
          setTimeout(() => reject(new Error('Turnstile 脚本加载超时')), 15000)
        })
      }
      const el = document.createElement('div')
      document.body.appendChild(el)
      return await new Promise(resolve => {
        const timer = setTimeout(() => resolve(null), timeoutSec * 1000)
        window.turnstile.render(el, {
          sitekey: siteKey,
          callback: token => {
            clearTimeout(timer)
            resolve(token)
          },
          'error-callback': () => {
            clearTimeout(timer)
            resolve(null)
          }
        })
      })
    } catch {
      return null
    }
  }, { siteKey, timeoutSec })
}

/**
 * Turnstile 站点浏览器签到：打开站点 → 渲染挑战拿 token → 带 token 调签到接口
 * @param {object} account 账号
 * @param {object} opts { checkinPath: 签到接口路径, headers: 鉴权请求头, siteKey: Turnstile site key }
 * @returns {Promise<{status: number, json: object|null}|{turnstileFailed: true}>}
 */
export async function turnstileCheckin(account, { checkinPath, headers, siteKey }) {
  const cfg = getConfig()
  return await withPage(new URL(account.baseUrl).hostname, async page => {
    await page.goto(account.baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })

    const token = await solveTurnstile(page, siteKey, cfg.browser.turnstileTimeoutSec || 30)
    if (!token) return { turnstileFailed: true }

    const url = `${account.baseUrl}${checkinPath}?turnstile=${encodeURIComponent(token)}`
    return await pageFetch(page, url, { method: 'POST', headers })
  })
}

/**
 * 关闭浏览器（供测试/退出时清理）
 */
export async function closeBrowser() {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
  try {
    await browserInstance?.close()
  } catch {
    // 忽略
  }
  browserInstance = null
}
