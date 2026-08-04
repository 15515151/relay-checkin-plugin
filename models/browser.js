import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { DATA_PATH, getConfig } from './config.js'
import { proxyForHost } from './adapters/common.js'
import { assertSafeRequestUrl } from './url-security.js'

/**
 * 浏览器工具：用于过阿里云 WAF（AnyRouter 系）与 Cloudflare Turnstile 挑战。
 * puppeteer 惰性加载（复用 Yunzai 根目录依赖，缺失时仅浏览器功能不可用，不影响插件加载）。
 *
 * 无头实例按代理模式复用；可见实例按站点与代理模式隔离，并使用持久用户档案。
 * 这样直连站与代理站可同时进行，任何站点都不会被迫用错的网络模式访问
 * （带账密代理的认证走 page.authenticate，chromium 的 --proxy-server 不接受账密）。
 */

// Map<poolKey, { instance, activeTasks, idleTimer, launching, interactive }>
const pools = new Map()

function getPool(poolKey, interactive = false) {
  if (!pools.has(poolKey)) {
    pools.set(poolKey, { instance: null, activeTasks: 0, idleTimer: null, launching: null, interactive })
  }
  return pools.get(poolKey)
}

function profileFingerprint(profileKey, proxyServer = '') {
  return crypto.createHash('sha256')
    .update(`${String(profileKey).toLowerCase()}\n${proxyServer || 'direct'}`)
    .digest('hex')
    .slice(0, 20)
}

/**
 * 导出纯逻辑辅助函数供冒烟测试验证池隔离和档案路径稳定性。
 */
export function browserPoolKey({ interactive = false, proxyServer = '', profileKey = '' } = {}) {
  const route = proxyServer || 'direct'
  return interactive
    ? `interactive|${profileFingerprint(profileKey, route)}`
    : `headless|${route}`
}

export function interactiveProfilePath(profileKey, proxyServer = '') {
  return path.join(DATA_PATH, 'browser-profile', profileFingerprint(profileKey, proxyServer || 'direct'))
}

/**
 * 全局页面并发闸门：定时任务多用户并发时，浏览器页面是最吃内存的资源
 * （每页数十 MB），超过上限的任务排队等待，避免拖垮服务器。
 * 排队有上限时间，超时即放弃并从队列摘除，避免调用方已超时放弃、
 * 任务却在稍后拿到槽位继续跑（结果与用户看到的提示相反）
 */
let pageSlotsUsed = 0
const pageWaiters = []

async function acquirePageSlot() {
  const cfg = getConfig().browser
  const max = Math.max(1, Math.min(cfg.maxConcurrentPages || 2, 10))
  if (pageSlotsUsed < max) {
    pageSlotsUsed++
    return
  }
  // Number 转换与 clamp 区间需与 checkin.js 的 hangBudgetMs 保持一致
  const waitMs = Math.max(30, Math.min(Number(cfg.slotWaitSec) || 120, 600)) * 1000
  logger.info(`[relay-checkin-plugin] 浏览器页面已达上限 ${max}，排队等待中（当前队列 ${pageWaiters.length + 1}）`)
  await new Promise((resolve, reject) => {
    const waiter = { settled: false, timer: null }
    waiter.grant = () => {
      if (waiter.settled) return false
      waiter.settled = true
      clearTimeout(waiter.timer)
      resolve()
      return true
    }
    waiter.timer = setTimeout(() => {
      if (waiter.settled) return
      waiter.settled = true
      const i = pageWaiters.indexOf(waiter)
      if (i >= 0) pageWaiters.splice(i, 1)
      reject(new Error(`等待浏览器空闲超过 ${waitMs / 1000} 秒，请稍后重试`))
    }, waitMs)
    pageWaiters.push(waiter)
  })
}

/**
 * 释放槽位：有等待者时直接交接（不减计数），避免空窗期被插队导致短暂超出上限
 */
function releasePageSlot() {
  while (pageWaiters.length) {
    const next = pageWaiters.shift()
    if (next.grant()) return
  }
  pageSlotsUsed = Math.max(0, pageSlotsUsed - 1)
}

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

/**
 * 给 puppeteer 调用套硬性超时：个别环境下 launch/newPage/goto 可能永不 resolve，
 * 没有这层兜底会让整个签到流程静默挂起
 */
function withTimeout(promise, ms, msg) {
  let timer = null
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(msg)), ms)
    })
  ])
}

/**
 * 打开页面并带超时：超时后底层调用仍可能产出 Page，
 * 挂个兜底回调把晚到的页面关掉，避免数十 MB 常驻泄漏
 */
async function newPageSafe(browser, ms) {
  const pending = browser.newPage()
  try {
    return await withTimeout(pending, ms, '打开页面超时')
  } catch (err) {
    pending.then(pg => pg?.close?.().catch(() => {})).catch(() => {})
    throw err
  }
}

function isBrowserAlive(inst) {
  if (!inst) return false
  // puppeteer v20+ 为 connected 属性，老版本为 isConnected()
  return inst.connected ?? inst.isConnected?.() ?? false
}

async function browserUserAgent(browser) {
  const configured = String(getConfig().request.userAgent || '')
  try {
    const version = await browser.version()
    const runtime = String(version).match(/(?:Chrome|Chromium)\/([\d.]+)/)?.[1]
    if (runtime && /Chrome\/[\d.]+/.test(configured)) {
      return configured.replace(/Chrome\/[\d.]+/, `Chrome/${runtime}`)
    }
  } catch {
    // 读取内核版本失败时沿用用户配置
  }
  return configured
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

/**
 * 取该模式的浏览器实例（不存在则启动）。同模式并发任务共享同一次启动过程，
 * 不再因模式不同而互相关闭实例
 */
async function getBrowser(pool, proxy, { interactive = false, profileKey = '' } = {}) {
  if (isBrowserAlive(pool.instance)) return pool.instance
  if (!pool.launching) {
    pool.launching = (async () => {
      if (interactive && process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
        throw new Error('当前 Linux 环境没有图形桌面（DISPLAY/WAYLAND_DISPLAY），无法打开可见浏览器')
      }
      const puppeteer = await getPuppeteer()
      const args = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=TranslateUI,BackForwardCache',
        '--no-first-run',
        '--no-default-browser-check'
      ]
      if (interactive) {
        args.push('--start-maximized', '--window-size=1200,860')
      } else {
        // 无头 WAF 页面会持续执行挑战脚本，限制单实例资源占用。
        args.push(
          '--disable-gpu',
          '--disable-extensions',
          '--disable-background-networking',
          '--renderer-process-limit=1',
          '--js-flags=--max-old-space-size=256'
        )
      }
      if (proxy?.server) {
        args.push(`--proxy-server=${proxy.server}`)
        // 让 Chrome 到代理自身（本机回环）的连接不再经过代理，
        // 避免 Clash 等开启 TUN/系统代理时形成环路把请求打进黑洞
        args.push('--proxy-bypass-list=<-loopback>')
      }
      // protocolTimeout 给所有 CDP 调用兜底（setCookie/evaluate 等在浏览器无响应时
      // 会永久挂起且不受 launch 的 timeout 约束）；timeout 管启动连接本身
      const launchOptions = {
        headless: interactive ? false : 'new',
        args,
        timeout: 60000,
        // solveTurnstile 的 page.evaluate 会一直等到 token 或配置超时；CDP 超时必须
        // 高于允许的等待上限，否则默认 120 秒的可见验证会在 90 秒被提前掐断。
        protocolTimeout: interactive ? 660000 : 150000
      }
      if (interactive) {
        const userDataDir = interactiveProfilePath(profileKey, proxy?.server)
        fs.mkdirSync(userDataDir, { recursive: true })
        launchOptions.userDataDir = userDataDir
        launchOptions.defaultViewport = null
        launchOptions.ignoreDefaultArgs = ['--enable-automation']
      }
      return await puppeteer.launch(launchOptions)
    })().then(inst => {
      pool.instance = inst
      pool.launching = null
      // 调用方可能已因启动超时放弃：此时无人持有也无回收排期，
      // 补一次空闲回收，避免 chromium 进程孤儿常驻
      if (pool.activeTasks === 0 && !pool.idleTimer) scheduleIdleClose(pool)
      return inst
    }).catch(err => {
      pool.launching = null
      throw err
    })
  }
  return await pool.launching
}

function scheduleIdleClose(pool, idleMs = null) {
  // 定时器回调内不再取配置：getConfig 可能读盘/建 watcher 并抛错，
  // 而 async 回调里的异常无人接管会触发 unhandledRejection 直接退进程
  let ms = idleMs
  if (ms === null) {
    try {
      ms = (getConfig().browser.idleCloseSec || 300) * 1000
    } catch {
      ms = 300000
    }
  }
  if (pool.idleTimer) clearTimeout(pool.idleTimer)
  pool.idleTimer = setTimeout(async () => {
    try {
      pool.idleTimer = null
      // 仍有任务在用浏览器时不回收，等最后一个任务结束再调度
      if (pool.activeTasks > 0) return
      // 启动中（调用方已超时放弃）时不能提前置空，否则实例落地后无人回收
      if (pool.launching) {
        scheduleIdleClose(pool, ms)
        return
      }
      const inst = pool.instance
      pool.instance = null
      await inst?.close()
    } catch (err) {
      logger.error(`[relay-checkin-plugin] 浏览器回收异常: ${err?.message || err}`)
    }
  }, ms)
}

/**
 * 打开一个已注入 stealth 的页面执行任务，自动关闭页面并调度浏览器空闲回收
 * @param {string} host 目标站点 host（用于判断是否走代理）
 */
/**
 * 浏览器方案熔断：某站点连续失败达到阈值后临时停用一段时间。
 * 打不开的站点会让 Chrome 反复重试并可能拖慢宿主机，熔断可避免定时任务
 * 每天在同一个站上白耗资源、影响其他站点与机器人本身
 */
const breaker = new Map() // host -> { fails, until }
const BREAK_THRESHOLD = 3
const BREAK_MS = 30 * 60 * 1000

function checkBreaker(host) {
  const b = breaker.get(host)
  if (!b?.until) return
  if (Date.now() < b.until) {
    const mins = Math.ceil((b.until - Date.now()) / 60000)
    throw new Error(`该站点浏览器方案连续失败已暂停，约 ${mins} 分钟后自动恢复`)
  }
  breaker.delete(host)
}

function noteResult(host, ok) {
  if (ok) {
    breaker.delete(host)
    return
  }
  const b = breaker.get(host) || { fails: 0, until: 0 }
  b.fails++
  if (b.fails >= BREAK_THRESHOLD) {
    b.until = Date.now() + BREAK_MS
    b.fails = 0
    logger.warn(`[relay-checkin-plugin] ${host} 浏览器方案连续失败 ${BREAK_THRESHOLD} 次，暂停 ${BREAK_MS / 60000} 分钟`)
  }
  breaker.set(host, b)
}

function browserResultOk(out) {
  return !out?.wafBlocked && !out?.turnstileFailed && out?.status !== 0
}

/**
 * 浏览器会自动跟随 30x；拦截每个导航请求并重新校验目标，防止重定向绕过 SSRF 防护。
 */
async function installNavigationGuard(page) {
  await withTimeout(page.setRequestInterception(true), 15000, '启用浏览器地址校验超时')
  page.on('request', request => {
    const url = request.url()
    if (!request.isNavigationRequest() || url === 'about:blank') {
      request.continue().catch(() => {})
      return
    }
    assertSafeRequestUrl(url).then(() => {
      request.continue().catch(() => {})
    }).catch(err => {
      logger.warn(`[relay-checkin-plugin] 已阻止浏览器访问不安全地址 ${url}: ${err?.message || err}`)
      request.abort('blockedbyclient').catch(() => {})
    })
  })
}

async function withPage(host, fn, { interactive = false, profileKey = host, trackResult = true } = {}) {
  checkBreaker(host)
  await acquirePageSlot()
  // 外层只负责槽位：内部任何异常（含取配置/解析代理失败）都不会漏掉释放
  try {
    const proxy = parseProxy(proxyForHost(host, true))
    const poolKey = browserPoolKey({ interactive, proxyServer: proxy?.server, profileKey })
    const pool = getPool(poolKey, interactive)
    if (pool.idleTimer) {
      clearTimeout(pool.idleTimer)
      pool.idleTimer = null
    }
    pool.activeTasks++
    let page = null
    try {
      logger.info(`[relay-checkin-plugin] ${interactive ? '可见' : '无头'}浏览器方案启动: ${host}${proxy ? ` (代理 ${proxy.server})` : ' (直连)'}`)
      const browser = await withTimeout(
        getBrowser(pool, proxy, { interactive, profileKey }),
        70000,
        `${interactive ? '可见' : '无头'}浏览器启动超时（检查 puppeteer 与图形桌面是否可用）`
      )
      page = await newPageSafe(browser, 30000)
      logger.info('[relay-checkin-plugin] 浏览器页面就绪，开始初始化')
      // 以下都是本地 CDP 调用，正常都是毫秒级；浏览器无响应时必须超时而不是静默挂死
      if (proxy?.auth) await withTimeout(page.authenticate(proxy.auth), 15000, '设置代理认证超时')
      await withTimeout(page.setViewport({ width: 1365, height: 900, deviceScaleFactor: 1 }), 15000, '设置浏览器窗口超时')
      const userAgent = await withTimeout(browserUserAgent(browser), 15000, '读取浏览器版本超时')
      await withTimeout(page.setUserAgent(userAgent), 15000, '设置 UA 超时（浏览器无响应）')
      await withTimeout(page.setExtraHTTPHeaders({ 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' }), 15000, '设置浏览器语言超时')
      await withTimeout(page.evaluateOnNewDocument(STEALTH_SCRIPT), 15000, '注入初始化脚本超时（浏览器无响应）')
      await installNavigationGuard(page)
      if (interactive) await withTimeout(page.bringToFront(), 15000, '显示浏览器窗口超时')
      logger.info('[relay-checkin-plugin] 页面初始化完成')
      const out = await fn(page)
      if (trackResult) noteResult(host, browserResultOk(out))
      return out
    } catch (err) {
      if (trackResult) noteResult(host, false)
      throw err
    } finally {
      // 关闭也可能挂起（挑战页忙循环等），必须带超时否则计数永久失衡
      if (page) await withTimeout(page.close(), 15000, '关闭页面超时').catch(() => {})
      pool.activeTasks--
      // 可见窗口完成后尽快退出；用户档案已经落盘，下次仍能复用信任状态。
      scheduleIdleClose(pool, interactive ? 1000 : null)
    }
  } finally {
    releasePageSlot()
  }
}

/**
 * 在页面上下文内发起 fetch（自动携带页面 cookie，可附加请求头）
 * 页面导航中（WAF 挑战自动刷新）evaluate 会抛异常，统一吞掉返回 status 0 由调用方重试；
 * 页内 fetch 带 AbortSignal 超时，避免代理隧道挂起时无限等待
 * @returns {Promise<{status: number, json: object|null}>}
 */
async function pageFetch(page, url, { method = 'GET', headers = {}, timeoutMs: override = null } = {}) {
  const timeoutMs = override ?? (getConfig().request.timeout || 15) * 1000
  try {
    await assertSafeRequestUrl(url)
    const evaluating = page.evaluate(async ({ url, method, headers, timeoutMs }) => {
      // 用 AbortController 而非 AbortSignal.timeout：后者要 Chrome 103+，
      // 内置 Chromium 偏旧时会直接抛 TypeError 使每次请求都失败
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const res = await fetch(url, {
          method,
          headers,
          credentials: 'include',
          signal: controller.signal
        })
        let json = null
        try {
          json = await res.json()
        } catch {
          // 非 JSON（WAF 拦截页等）
        }
        return { status: res.status, json }
      } catch (err) {
        return { status: 0, json: null, error: String(err) }
      } finally {
        clearTimeout(timer)
      }
    }, { url, method, headers, timeoutMs })
    // evaluate 自身也可能不返回（挑战页导航中/渲染器卡住），外层再兜一层超时，
    // 否则单轮探测就能吃掉整个 WAF 预算且不留任何日志
    return await withTimeout(evaluating, timeoutMs + 5000, '页内请求无响应')
  } catch (err) {
    return { status: 0, json: null, error: String(err?.message || err) }
  }
}

/**
 * 打印当前页面状态：是否还停在 WAF 挑战页、拿到了哪些 WAF cookie
 */
async function logPageState(page) {
  try {
    const [url, title, cookies] = await Promise.all([
      Promise.resolve(page.url()),
      withTimeout(page.title(), 8000, '取标题超时').catch(() => '?'),
      withTimeout(page.cookies(), 8000, '取 cookie 超时').catch(() => [])
    ])
    const names = cookies.map(c => c.name)
    const waf = names.filter(n => /^acw_|^cdn_sec_tc$|^_c_WBKFRo$/i.test(n))
    logger.info(`[relay-checkin-plugin] 页面状态: url=${url} title=${JSON.stringify(title)} WAFcookie=[${waf.join(', ') || '无'}] 全部cookie=[${names.join(', ') || '无'}]`)
  } catch (err) {
    logger.info(`[relay-checkin-plugin] 取页面状态失败: ${err?.message || err}`)
  }
}


/**
 * 打开站点让阿里云 WAF 挑战通过，取出全部 cookie（含 WAF 三件套与 session）。
 * 参考实现（dctx-team/Regular-inspection）同样是「浏览器只负责过 WAF 拿 cookie，
 * 之后用普通 HTTP 调接口」——页内 fetch 受 CDP 与页面导航时序影响，不如这条路稳。
 * @returns {Promise<{cookieHeader: string}|{wafBlocked: true}>}
 */
export async function fetchWafCookies(account) {
  const cfg = getConfig()
  const host = new URL(account.baseUrl).hostname
  return await withPage(host, async page => {
    await withTimeout(
      page.setCookie({ name: 'session', value: account.token, domain: host, path: '/' }),
      15000, '注入 session cookie 超时（浏览器无响应）'
    )
    logger.info(`[relay-checkin-plugin] 正在打开 ${account.baseUrl}（取 WAF cookie）`)
    await withTimeout(
      page.goto(account.baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }),
      40000, '打开站点页面超时（网络或代理不通）'
    )

    // 等 WAF 的 acw_sc__v2 出现（挑战 JS 执行完的标志）
    const deadline = Date.now() + (cfg.browser.wafTimeoutSec || 60) * 1000
    let cookies = []
    while (Date.now() < deadline) {
      try {
        cookies = await withTimeout(page.cookies(), 8000, '取 cookie 超时')
      } catch {
        cookies = []
      }
      if (cookies.some(c => /^acw_sc__v2$/i.test(c.name))) break
      await new Promise(r => setTimeout(r, 1000))
    }
    await logPageState(page)

    if (!cookies.some(c => /^acw_sc__v2$/i.test(c.name))) return { wafBlocked: true }
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ')
    logger.info(`[relay-checkin-plugin] 已取得 ${cookies.length} 个 cookie，改用普通 HTTP 调用接口`)
    return { cookieHeader }
  })
}

async function setTurnstilePanelStatus(page, text) {
  await page.evaluate(value => {
    const el = document.getElementById('relay-checkin-turnstile-status')
    if (el) el.textContent = value
  }, text).catch(() => {})
}

/**
 * 可见模式先尝试一次正常鼠标点击。Cloudflare iframe 为跨域内容，页面脚本无法读取，
 * 必须从 Puppeteer 的页面坐标点击；若控件结构变化则停止自动操作并交给用户。
 */
async function autoClickTurnstileCheckbox(page, timeoutSec, shouldStop) {
  const deadline = Date.now() + Math.min(timeoutSec * 1000, 20000)
  while (!shouldStop() && Date.now() < deadline) {
    let iframe = null
    try {
      iframe = await page.$(
        '#relay-checkin-turnstile iframe[src*="challenges.cloudflare.com"], ' +
        '#relay-checkin-turnstile iframe[src*="turnstile"]'
      )
      const box = await iframe?.boundingBox()
      if (box && box.width >= 200 && box.height >= 50) {
        const targetX = box.x + Math.min(30, box.width * 0.1)
        const targetY = box.y + Math.min(35, box.height * 0.5)
        const startX = Math.max(1, targetX - 90)
        const startY = Math.max(1, targetY + 35)
        await page.mouse.move(startX, startY)
        await page.mouse.move(targetX, targetY, { steps: 14 })
        await page.mouse.click(targetX, targetY, { delay: 120 })
        await setTurnstilePanelStatus(page, '已自动点击验证，等待 Cloudflare 确认...')
        logger.info('[relay-checkin-plugin] 已自动点击 Turnstile 复选框，等待验证结果')
        return true
      }
    } catch {
      // iframe 正在重建时继续短暂轮询
    } finally {
      await iframe?.dispose?.().catch(() => {})
    }
    await new Promise(resolve => setTimeout(resolve, 350))
  }

  if (!shouldStop()) {
    await setTurnstilePanelStatus(page, '未能自动点击，请手动勾选上方“请验证您是真人”')
    logger.warn('[relay-checkin-plugin] 未能自动定位 Turnstile 复选框，请在可见窗口中手动点击')
  }
  return false
}


/**
 * 在站点页面上下文内渲染 Cloudflare Turnstile 挑战并获取 token
 * @returns {Promise<{token: string|null, stage: string, reason: string, errorCode?: string, detail?: string}>}
 */
async function solveTurnstile(page, siteKey, timeoutSec, { interactive = false, host = '' } = {}) {
  try {
    const evaluating = page.evaluate(async ({ siteKey, timeoutSec, interactive, host }) => {
      const deadline = Date.now() + timeoutSec * 1000
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
      const responseInput = () => document.querySelector('input[name="cf-turnstile-response"]')?.value || ''
      // 可见模式始终渲染自己的组件，确保用户看到的是当前签到所需的验证；
      // 无头模式优先复用站点组件，保留站点可能附带的 action / cData。
      const existingWidget = interactive ? null : document.querySelector('.cf-turnstile, [data-sitekey]')

      // 优先等待站点自己的组件，以保留 action / cData 等站点参数。
      if (existingWidget) {
        while (Date.now() < deadline) {
          const token = responseInput()
          if (token) return { token, stage: 'site-widget', reason: 'token' }
          await wait(500)
        }
        return { token: null, stage: 'site-widget', reason: 'timeout' }
      }

      try {
        const waitForApi = async () => {
          while (Date.now() < deadline) {
            if (window.turnstile?.render) return true
            await wait(100)
          }
          return false
        }
        if (!window.turnstile?.render) {
          let script = document.querySelector('script[src*="challenges.cloudflare.com/turnstile/v0/api.js"]')
          if (!script) {
            script = document.createElement('script')
            script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
            script.async = true
            script.defer = true
            document.head.appendChild(script)
          }
          if (!await waitForApi()) {
            return { token: null, stage: 'script', reason: 'load-timeout' }
          }
        }

        let el = null
        let statusEl = null
        if (interactive) {
          const overlay = document.createElement('div')
          overlay.id = 'relay-checkin-turnstile'
          overlay.style.cssText = [
            'position:fixed', 'inset:0', 'z-index:2147483647', 'display:grid',
            'place-items:center', 'background:#f3f1ea', 'color:#18231d',
            'font-family:"Microsoft YaHei","PingFang SC",sans-serif'
          ].join(';')
          const panel = document.createElement('main')
          panel.style.cssText = [
            'width:min(520px,calc(100vw - 40px))', 'box-sizing:border-box',
            'padding:34px 38px', 'background:#fff', 'border:1px solid #cad0c8',
            'box-shadow:0 18px 50px rgba(30,42,35,.16)', 'text-align:center'
          ].join(';')
          const title = document.createElement('h1')
          title.textContent = '中转站签到验证'
          title.style.cssText = 'margin:0 0 10px;font-size:24px;font-weight:700;letter-spacing:0'
          const site = document.createElement('div')
          site.textContent = host
          site.style.cssText = 'margin-bottom:18px;color:#587063;font-size:14px;word-break:break-all'
          const tip = document.createElement('p')
          tip.textContent = `插件会先自动尝试下方验证；若复选框仍停留，请在 ${timeoutSec} 秒内手动勾选。通过后会立即提交签到并关闭窗口。`
          tip.style.cssText = 'margin:0 0 24px;line-height:1.7;font-size:15px;color:#303b35'
          el = document.createElement('div')
          el.style.cssText = 'min-height:70px;display:grid;place-items:center'
          statusEl = document.createElement('p')
          statusEl.id = 'relay-checkin-turnstile-status'
          statusEl.textContent = '正在加载验证组件...'
          statusEl.style.cssText = 'margin:20px 0 0;color:#6a746e;font-size:13px'
          panel.append(title, site, tip, el, statusEl)
          overlay.appendChild(panel)
          document.body.appendChild(overlay)
          document.title = `请完成签到验证 - ${host}`
        } else {
          el = document.createElement('div')
          el.style.minHeight = '70px'
          el.style.display = 'grid'
          el.style.placeItems = 'center'
          document.body.appendChild(el)
        }
        el.scrollIntoView({ block: 'center', inline: 'center' })

        const left = Math.max(1000, deadline - Date.now())
        return await new Promise(resolve => {
          let settled = false
          const finish = result => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            resolve(result)
          }
          const timer = setTimeout(() => finish({ token: null, stage: 'explicit-widget', reason: 'timeout' }), left)
          try {
            window.turnstile.render(el, {
              sitekey: siteKey,
              theme: 'light',
              callback: token => {
                if (statusEl) statusEl.textContent = '验证通过，正在提交签到...'
                finish({ token, stage: 'explicit-widget', reason: 'token' })
              },
              'error-callback': code => finish({
                token: null,
                stage: 'explicit-widget',
                reason: 'error-callback',
                errorCode: code == null ? '' : String(code)
              }),
              'expired-callback': () => finish({ token: null, stage: 'explicit-widget', reason: 'expired' }),
              'timeout-callback': () => finish({ token: null, stage: 'explicit-widget', reason: 'challenge-timeout' })
            })
          } catch (err) {
            finish({ token: null, stage: 'explicit-widget', reason: 'render-error', detail: String(err) })
          }
        })
      } catch (err) {
        return { token: null, stage: 'script', reason: 'exception', detail: String(err) }
      }
    }, { siteKey, timeoutSec, interactive, host })

    let stopAutoClick = false
    const autoClick = interactive
      ? autoClickTurnstileCheckbox(page, timeoutSec, () => stopAutoClick)
      : null
    try {
      return await evaluating
    } finally {
      stopAutoClick = true
      if (autoClick) await autoClick.catch(() => {})
    }
  } catch (err) {
    return { token: null, stage: 'page', reason: 'evaluate-error', detail: String(err?.message || err) }
  }
}

function turnstileFailureMessage(result, timeoutSec, interactive = false) {
  if (result?.reason === 'error-callback') {
    return `Turnstile 返回错误回调${result.errorCode ? `（错误码 ${result.errorCode}）` : ''}`
  }
  if (result?.stage === 'script') return 'Turnstile 脚本未能正常加载或初始化'
  if (result?.reason === 'render-error' || result?.reason === 'evaluate-error') return 'Turnstile 组件执行异常'
  if (result?.reason === 'expired') return 'Turnstile token 在提交前已过期'
  return interactive
    ? `Turnstile 在 ${timeoutSec} 秒内未完成，请在机器人运行设备弹出的浏览器窗口中完成验证`
    : `Turnstile 在 ${timeoutSec} 秒内未签发 token（无头浏览器未获放行）`
}

/**
 * 在一种浏览器模式内完成 Turnstile 获取与签到提交。token 由 Cloudflare 绑定当前
 * 浏览器上下文和出口网络，因此必须在同一个页面里立即提交，不能跨模式搬运。
 */
async function runTurnstileAttempt(account, { checkinPath, headers, siteKey }, { interactive, timeoutSec }) {
  const host = new URL(account.baseUrl).hostname
  return await withPage(host, async page => {
    await withTimeout(page.setBypassCSP(true), 15000, '设置 Turnstile 页面策略超时')
    await withTimeout(
      page.goto(account.baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }),
      40000, '打开站点页面超时（网络或代理不通）'
    )

    const attempt = await solveTurnstile(page, siteKey, timeoutSec, { interactive, host })
    if (!attempt.token) {
      return {
        turnstileFailed: true,
        message: turnstileFailureMessage(attempt, timeoutSec, interactive),
        detail: attempt
      }
    }

    const url = new URL(checkinPath, `${account.baseUrl}/`)
    url.searchParams.set('turnstile', attempt.token)
    return await pageFetch(page, url.toString(), { method: 'POST', headers })
  }, { interactive, profileKey: host, trackResult: false })
}

function boundedSeconds(value, fallback, min, max) {
  const n = Number(value)
  return Math.max(min, Math.min(Number.isFinite(n) ? n : fallback, max))
}

/**
 * 手动指令的浏览器总预算：覆盖排队、启动/导航余量、无头尝试和可见验证。
 * 由调用层和测试共用，避免两处 clamp 漂移后外层先于浏览器超时。
 */
export function browserHangBudgetMs(browser = {}) {
  const slotSec = boundedSeconds(browser.slotWaitSec, 120, 30, 600)
  const quickSec = boundedSeconds(browser.turnstileTimeoutSec, 30, 5, 120)
  const interactiveSec = browser.turnstileInteractive === false
    ? 0
    : boundedSeconds(browser.turnstileInteractiveTimeoutSec, 120, 30, 600)
  const executionSec = Math.max(300, quickSec + interactiveSec + 120)
  return (slotSec + executionSec) * 1000
}

/**
 * Turnstile 站点浏览器签到：先做一次无头快速尝试；未获 token 时升级到持久档案的
 * 可见浏览器，让 Cloudflare 自动放行或由机器人运行设备上的用户完成验证。
 * @param {object} account 账号
 * @param {object} opts { checkinPath: 签到接口路径, headers: 鉴权请求头, siteKey: Turnstile site key }
 * @returns {Promise<{status: number, json: object|null}|{turnstileFailed: true}>}
 */
export async function turnstileCheckin(account, { checkinPath, headers, siteKey }) {
  const cfg = getConfig()
  const host = new URL(account.baseUrl).hostname
  const quickTimeoutSec = boundedSeconds(cfg.browser.turnstileTimeoutSec, 30, 5, 120)
  const interactiveTimeoutSec = boundedSeconds(cfg.browser.turnstileInteractiveTimeoutSec, 120, 30, 600)

  const quick = await runTurnstileAttempt(
    account,
    { checkinPath, headers, siteKey },
    { interactive: false, timeoutSec: quickTimeoutSec }
  )
  if (!quick.turnstileFailed) {
    noteResult(host, browserResultOk(quick))
    return quick
  }

  logger.info(`[relay-checkin-plugin] Turnstile 无头尝试未通过: ${quick.message}`)
  if (cfg.browser.turnstileInteractive === false) {
    const result = {
      ...quick,
      message: `${quick.message}；可见浏览器接管已在配置中关闭`
    }
    noteResult(host, false)
    return result
  }

  logger.info(`[relay-checkin-plugin] 将打开可见浏览器接管 ${host}，请在机器人运行设备上于 ${interactiveTimeoutSec} 秒内完成验证`)
  let interactive
  try {
    interactive = await runTurnstileAttempt(
      account,
      { checkinPath, headers, siteKey },
      { interactive: true, timeoutSec: interactiveTimeoutSec }
    )
  } catch (err) {
    const detail = err?.message || String(err)
    interactive = {
      turnstileFailed: true,
      message: `无法启动或使用可见浏览器：${detail}`,
      detail: { stage: 'interactive-browser', reason: 'exception', detail }
    }
  }

  const ok = browserResultOk(interactive)
  noteResult(host, ok)
  if (interactive.turnstileFailed) {
    logger.warn(`[relay-checkin-plugin] Turnstile 可见浏览器接管未完成: ${interactive.message}`)
  } else {
    logger.info(`[relay-checkin-plugin] Turnstile 已通过可见浏览器完成并提交签到`)
  }
  return interactive
}

/**
 * 关闭全部浏览器实例（供测试/退出时清理）
 */
export async function closeBrowser() {
  for (const pool of pools.values()) {
    if (pool.idleTimer) clearTimeout(pool.idleTimer)
    pool.idleTimer = null
    const inst = pool.instance
    pool.instance = null
    try {
      await inst?.close()
    } catch {
      // 忽略
    }
  }
  pools.clear()
}
