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
 * 无头实例按代理模式复用；可见实例按站点、代理和浏览器内核隔离，并使用持久用户档案。
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

const PROFILE_SCHEMA_VERSION = 'turnstile-system-browser-v2'

function profileFingerprint(profileKey, proxyServer = '', executablePath = '') {
  return crypto.createHash('sha256')
    .update(`${PROFILE_SCHEMA_VERSION}\n${String(profileKey).toLowerCase()}\n${proxyServer || 'direct'}\n${executablePath || 'default'}`)
    .digest('hex')
    .slice(0, 20)
}

/**
 * 导出纯逻辑辅助函数供冒烟测试验证池隔离和档案路径稳定性。
 */
export function browserPoolKey({ interactive = false, proxyServer = '', profileKey = '', executablePath = '' } = {}) {
  const route = proxyServer || 'direct'
  return interactive
    ? `interactive|${profileFingerprint(profileKey, route, executablePath)}`
    : `headless|${route}`
}

export function interactiveProfilePath(profileKey, proxyServer = '', executablePath = '') {
  return path.join(DATA_PATH, 'browser-profile', profileFingerprint(profileKey, proxyServer || 'direct', executablePath))
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

/**
 * Turnstile 会拒绝过旧 Chromium。TRSS-Yunzai 内置 Puppeteer 可能数年未更新，
 * 因此优先使用机器上持续更新的 Chrome/Edge，找不到时才回退 Puppeteer 自带内核。
 */
export function resolveBrowserExecutable(configured = '', {
  platform = process.platform,
  env = process.env,
  exists = fs.existsSync
} = {}) {
  const explicit = String(configured || '').trim()
  if (explicit) {
    const resolved = path.resolve(explicit)
    if (!exists(resolved)) throw new Error(`配置的浏览器程序不存在: ${resolved}`)
    return resolved
  }

  const candidates = []
  if (platform === 'win32') {
    if (env.PROGRAMFILES) candidates.push(path.join(env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'))
    if (env['PROGRAMFILES(X86)']) {
      candidates.push(path.join(env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'))
      candidates.push(path.join(env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
    }
    if (env.LOCALAPPDATA) candidates.push(path.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'))
    if (env.PROGRAMFILES) candidates.push(path.join(env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
  } else if (platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
    )
  } else {
    candidates.push(
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium'
    )
  }
  return candidates.find(candidate => exists(candidate)) || null
}

// 反自动化检测：各项独立保护，任一项失败都不影响其余初始化。
const STEALTH_SCRIPT = `
  try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }) } catch (e) {}
  try { window.chrome = window.chrome || { runtime: {} } } catch (e) {}
  try { Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] }) } catch (e) {}
  try {
    const origQuery = window.navigator.permissions?.query
    if (origQuery) {
      window.navigator.permissions.query = parameters =>
        parameters.name === 'notifications'
          ? Promise.resolve({ state: globalThis.Notification?.permission || 'default' })
          : origQuery.call(window.navigator.permissions, parameters)
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
export async function newPageSafe(browser, ms, { reuseBlank = false } = {}) {
  if (reuseBlank && typeof browser.pages === 'function') {
    try {
      const pages = await withTimeout(browser.pages(), ms, '读取浏览器初始页面超时')
      const blank = pages.find(page => page?.url?.() === 'about:blank')
      if (blank) return blank
    } catch {
      // 读取初始页失败时回退到新建页面，不能阻断签到。
    }
  }
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
    const native = String(await browser.userAgent())
    if (/(?:Headless)?Chrome\/[\d.]+/.test(native)) {
      // 沿用 Chromium 实际操作系统和版本，仅去掉无头专用标记，避免 UA 与
      // navigator.platform 在 Linux 部署时出现 Windows/Linux 自相矛盾。
      return native.replace(/HeadlessChrome\//, 'Chrome/')
    }
  } catch {
    // 老版本 Puppeteer 取不到 userAgent 时再回落到配置值
  }
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
async function getBrowser(pool, proxy, { interactive = false, profileKey = '', executablePath = null } = {}) {
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
        '--lang=zh-CN',
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
      if (executablePath) {
        launchOptions.executablePath = executablePath
        logger.info(`[relay-checkin-plugin] 使用系统浏览器内核: ${executablePath}`)
      } else {
        logger.warn('[relay-checkin-plugin] 未找到系统 Chrome/Edge，将使用 Puppeteer 自带 Chromium；Turnstile 可能拒绝过旧内核')
      }
      if (interactive) {
        const userDataDir = interactiveProfilePath(
          profileKey,
          proxy?.server,
          executablePath || 'puppeteer-bundled'
        )
        fs.mkdirSync(userDataDir, { recursive: true })
        logger.info(`[relay-checkin-plugin] 可见浏览器隔离档案: ${userDataDir}`)
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

function pageCdpClient(page) {
  try {
    return typeof page?._client === 'function' ? page._client() : page?._client
  } catch {
    return null
  }
}

/**
 * Puppeteer 新版提供 Page.setBypassServiceWorker，TRSS-Yunzai 内置的旧版通常只有
 * Page._client()。两者最终调用同一个 CDP 命令；都不可用时允许继续，Service Worker
 * 绕过只用于避免持久档案命中旧缓存，不应阻断浏览器签到。
 */
export async function bypassServiceWorkerCompat(page) {
  if (typeof page?.setBypassServiceWorker === 'function') {
    try {
      await page.setBypassServiceWorker(true)
      return 'page-api'
    } catch (err) {
      logger.warn(`[relay-checkin-plugin] Puppeteer Service Worker API 调用失败，尝试旧版兼容方式: ${err?.message || err}`)
    }
  }

  try {
    const client = pageCdpClient(page)
    if (client && typeof client.send === 'function') {
      await client.send('Network.setBypassServiceWorker', { bypass: true })
      return 'cdp'
    }
  } catch (err) {
    logger.warn(`[relay-checkin-plugin] 旧版 Puppeteer 无法禁用 Service Worker，继续浏览器签到: ${err?.message || err}`)
  }

  return 'unsupported'
}

/**
 * Puppeteer 20 之前没有 Frame.frameElement()。旧版仍暴露 frame id 与页面 CDP
 * 客户端，可由 DOM.getFrameOwner 取得跨域 iframe 的真实屏幕坐标。
 */
export async function legacyFrameOwnerBox(page, frame) {
  const frameId = frame?._id || frame?._frameId || (typeof frame?.id === 'function' ? frame.id() : null)
  const client = pageCdpClient(page)
  if (!frameId || !client || typeof client.send !== 'function') return null

  const owner = await withTimeout(
    client.send('DOM.getFrameOwner', { frameId }),
    5000,
    '旧版 Puppeteer 定位 Turnstile frame 超时'
  )
  const node = owner?.backendNodeId
    ? { backendNodeId: owner.backendNodeId }
    : owner?.nodeId
      ? { nodeId: owner.nodeId }
      : null
  if (!node) return null

  const result = await withTimeout(
    client.send('DOM.getBoxModel', node),
    5000,
    '旧版 Puppeteer 读取 Turnstile 坐标超时'
  )
  const quad = result?.model?.border || result?.model?.content
  if (!Array.isArray(quad) || quad.length < 8 || quad.some(value => !Number.isFinite(value))) return null
  const xs = quad.filter((_, index) => index % 2 === 0)
  const ys = quad.filter((_, index) => index % 2 === 1)
  const left = Math.min(...xs)
  const right = Math.max(...xs)
  const top = Math.min(...ys)
  const bottom = Math.max(...ys)
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/**
 * Turnstile 的复选框位于关闭的 Shadow DOM，普通选择器无法观察其加载状态。
 * Chrome 无障碍树会在控件真正可交互后暴露 checkbox 节点；其坐标相对 iframe，
 * 加上 frame owner 坐标即可得到页面鼠标所需的精确位置。
 */
export async function turnstileCheckboxPoint(page, frame, ownerBox) {
  const frameId = frame?._id || frame?._frameId || (typeof frame?.id === 'function' ? frame.id() : null)
  let client = null
  try {
    client = typeof frame?._client === 'function' ? frame._client() : frame?._client
  } catch {
    client = null
  }
  client ||= pageCdpClient(page)
  if (!frameId || !client || typeof client.send !== 'function') {
    return { supported: false, point: null }
  }

  const tree = await withTimeout(
    client.send('Accessibility.getFullAXTree', { frameId }),
    5000,
    '等待 Turnstile 复选框可交互超时'
  )
  const checkbox = tree?.nodes?.find(node => node?.role?.value === 'checkbox' && !node.ignored)
  if (!checkbox?.backendDOMNodeId) return { supported: true, point: null }

  const result = await withTimeout(
    client.send('DOM.getBoxModel', { backendNodeId: checkbox.backendDOMNodeId }),
    5000,
    '读取 Turnstile 复选框坐标超时'
  )
  const quad = result?.model?.border || result?.model?.content
  if (!Array.isArray(quad) || quad.length < 8 || quad.some(value => !Number.isFinite(value))) {
    return { supported: true, point: null }
  }
  const xs = quad.filter((_, index) => index % 2 === 0)
  const ys = quad.filter((_, index) => index % 2 === 1)
  const left = Math.min(...xs)
  const right = Math.max(...xs)
  const top = Math.min(...ys)
  const bottom = Math.max(...ys)
  const width = right - left
  return {
    supported: true,
    point: {
      // AX 节点同时覆盖方框与文字，左侧约 22px 是复选框中心。
      x: ownerBox.x + left + Math.min(22, width / 2),
      y: ownerBox.y + top + (bottom - top) / 2
    },
    name: checkbox?.name?.value || ''
  }
}

async function withPage(host, fn, { interactive = false, profileKey = host, trackResult = true } = {}) {
  checkBreaker(host)
  await acquirePageSlot()
  // 外层只负责槽位：内部任何异常（含取配置/解析代理失败）都不会漏掉释放
  try {
    const proxy = parseProxy(proxyForHost(host, true))
    const executablePath = resolveBrowserExecutable(getConfig().browser.executablePath)
    const poolKey = browserPoolKey({
      interactive,
      proxyServer: proxy?.server,
      profileKey,
      executablePath: executablePath || 'puppeteer-bundled'
    })
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
        getBrowser(pool, proxy, { interactive, profileKey, executablePath }),
        70000,
        `${interactive ? '可见' : '无头'}浏览器启动超时（检查 puppeteer 与图形桌面是否可用）`
      )
      const engineVersion = typeof browser.version === 'function'
        ? await withTimeout(browser.version(), 5000, '读取浏览器内核版本超时').catch(() => '')
        : ''
      if (engineVersion) logger.info(`[relay-checkin-plugin] 浏览器内核版本: ${engineVersion}`)
      page = await newPageSafe(browser, 30000, {
        // Chrome 启动时已有 about:blank；直接复用可避免可见窗口多出一个白屏标签页。
        reuseBlank: interactive && pool.activeTasks === 1
      })
      logger.info('[relay-checkin-plugin] 浏览器页面就绪，开始初始化')
      // 以下都是本地 CDP 调用，正常都是毫秒级；浏览器无响应时必须超时而不是静默挂死
      if (proxy?.auth) await withTimeout(page.authenticate(proxy.auth), 15000, '设置代理认证超时')
      await withTimeout(page.setViewport({ width: 1365, height: 900, deviceScaleFactor: 1 }), 15000, '设置浏览器窗口超时')
      const userAgent = await withTimeout(browserUserAgent(browser), 15000, '读取浏览器版本超时')
      await withTimeout(page.setUserAgent(userAgent), 15000, '设置 UA 超时（浏览器无响应）')
      await withTimeout(page.setExtraHTTPHeaders({ 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' }), 15000, '设置浏览器语言超时')
      const serviceWorkerMode = await withTimeout(
        bypassServiceWorkerCompat(page),
        15000,
        '禁用页面 Service Worker 超时'
      ).catch(err => {
        logger.warn(`[relay-checkin-plugin] 禁用页面 Service Worker 超时，继续浏览器签到: ${err?.message || err}`)
        return 'unsupported'
      })
      if (serviceWorkerMode === 'cdp') {
        logger.info('[relay-checkin-plugin] 已使用旧版 Puppeteer 兼容方式禁用页面 Service Worker')
      } else if (serviceWorkerMode === 'unsupported') {
        logger.warn('[relay-checkin-plugin] 当前 Puppeteer 不支持禁用页面 Service Worker，已跳过该可选优化')
      }
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
 * Turnstile 只需要目标源上存在可注入组件的页面主体，不要求站点所有资源都完成加载。
 * 某些 SPA/统计脚本会让 DOMContentLoaded 长时间不结束；导航超时后若同源 body 已可用，
 * 停止剩余加载并继续。错误页、跨域页和空白页仍按真实导航失败处理。
 */
export async function navigateForTurnstile(page, targetUrl) {
  try {
    await withTimeout(
      page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }),
      40000,
      '打开站点页面超时（网络或代理不通）'
    )
    const finalUrl = page.url()
    if (new URL(finalUrl).origin !== new URL(targetUrl).origin) {
      throw new Error(`站点跳转到了不同域名 ${new URL(finalUrl).origin}，请使用该最终地址重新绑定`)
    }
    return { partial: false }
  } catch (err) {
    const detail = err?.message || String(err)
    const recoverableNavigation = /timeout|超时|ERR_ABORTED/i.test(detail)
    let sameOrigin = false
    try {
      sameOrigin = new URL(page.url()).origin === new URL(targetUrl).origin
    } catch {
      sameOrigin = false
    }

    if (recoverableNavigation && sameOrigin) {
      const body = await withTimeout(
        page.waitForSelector('body', { timeout: 5000 }),
        7000,
        '等待页面主体超时'
      ).catch(() => null)
      if (body) {
        try {
          if (body.dispose) await withTimeout(body.dispose(), 5000, '释放页面主体句柄超时')
        } catch {
          // 页面导航中句柄可能已经失效，不影响后续 window.stop
        }
        await withTimeout(page.evaluate(() => window.stop()), 5000, '停止页面剩余加载超时').catch(() => {})
        logger.warn(`[relay-checkin-plugin] 站点导航未完整结束但同源页面已可用，停止剩余加载并继续 Turnstile: ${detail}`)
        return { partial: true, detail }
      }
    }

    if (/timeout|超时/i.test(detail)) {
      throw new Error('打开站点页面超时：30 秒内未加载出可用页面，请检查站点或代理网络')
    }
    throw new Error(`打开站点页面失败：${detail}`)
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
  await withTimeout(
    page.evaluate(value => {
      const el = document.getElementById('relay-checkin-turnstile-status')
      if (el) el.textContent = value
    }, text),
    5000,
    '更新 Turnstile 页面状态超时'
  ).catch(() => {})
}

/**
 * 等到关闭 Shadow DOM 内真正出现可交互 checkbox 后再点击。仅在旧内核无法读取
 * 无障碍树时，才对稳定显示超过 3 秒的 iframe 使用兼容坐标。
 */
export async function autoClickTurnstileCheckbox(page, timeoutSec, shouldStop) {
  const deadline = Date.now() + Math.min(timeoutSec * 1000, 20000)
  const fallbackSeen = new Map()
  let lastError = ''
  let announcedWaiting = false
  while (!shouldStop() && Date.now() < deadline) {
    let iframe = null
    try {
      let target = null
      const challengeFrames = typeof page.frames === 'function'
        ? page.frames().filter(frame => /challenges\.cloudflare\.com|turnstile/i.test(String(frame.url?.() || '')))
        : []

      for (const frame of challengeFrames) {
        let candidate = null
        try {
          let ownerBox = null
          if (frame?.frameElement) {
            candidate = await withTimeout(frame.frameElement(), 5000, '从 frame tree 定位 Turnstile iframe 超时')
            ownerBox = await withTimeout(candidate.boundingBox(), 5000, '读取 Turnstile frame 坐标超时')
          } else {
            ownerBox = await legacyFrameOwnerBox(page, frame)
          }
          if (!ownerBox || ownerBox.width < 200 || ownerBox.height < 50) continue

          let ready
          try {
            ready = await turnstileCheckboxPoint(page, frame, ownerBox)
          } catch (err) {
            lastError = err?.message || String(err)
            ready = { supported: false, point: null }
          }
          if (ready.point) {
            iframe = candidate
            target = ready.point
            candidate = null
            break
          }

          if (!ready.supported) {
            const key = String(frame?._id || frame?._frameId || frame.url?.() || 'turnstile')
            const firstSeen = fallbackSeen.get(key) || Date.now()
            fallbackSeen.set(key, firstSeen)
            if (Date.now() - firstSeen >= 3000) {
              iframe = candidate
              target = {
                x: ownerBox.x + Math.min(30, ownerBox.width * 0.1),
                y: ownerBox.y + Math.min(35, ownerBox.height * 0.5)
              }
              candidate = null
              break
            }
          }
        } finally {
          if (candidate?.dispose) {
            await withTimeout(candidate.dispose(), 5000, '释放隐藏 Turnstile frame 句柄超时').catch(() => {})
          }
        }
      }

      if (!target && challengeFrames.length === 0) {
        iframe = await withTimeout(
          page.$(
            '#relay-checkin-turnstile iframe[src*="challenges.cloudflare.com"], ' +
            '#relay-checkin-turnstile iframe[src*="turnstile"]'
          ),
          5000,
          '从页面 DOM 定位 Turnstile iframe 超时'
        )
        const ownerBox = iframe
          ? await withTimeout(iframe.boundingBox(), 5000, '读取 Turnstile 坐标超时')
          : null
        if (ownerBox && ownerBox.width >= 200 && ownerBox.height >= 50) {
          const firstSeen = fallbackSeen.get('dom-fallback') || Date.now()
          fallbackSeen.set('dom-fallback', firstSeen)
          if (Date.now() - firstSeen >= 3000) {
            target = {
              x: ownerBox.x + Math.min(30, ownerBox.width * 0.1),
              y: ownerBox.y + Math.min(35, ownerBox.height * 0.5)
            }
          }
        }
      }

      if (!target && !announcedWaiting && challengeFrames.length > 0) {
        announcedWaiting = true
        await setTurnstilePanelStatus(page, '验证组件加载中，等待复选框可点击...')
        logger.info('[relay-checkin-plugin] Turnstile iframe 已出现，等待内部复选框可交互')
      }
      if (target && !shouldStop()) {
        const startX = Math.max(1, target.x - 90)
        const startY = Math.max(1, target.y + 35)
        await withTimeout(page.mouse.move(startX, startY), 5000, '移动鼠标到 Turnstile 前超时')
        await withTimeout(page.mouse.move(target.x, target.y, { steps: 14 }), 5000, '移动鼠标到 Turnstile 超时')
        await withTimeout(page.mouse.click(target.x, target.y, { delay: 120 }), 5000, '点击 Turnstile 超时')
        await setTurnstilePanelStatus(page, '已自动点击验证，等待 Cloudflare 确认...')
        logger.info(`[relay-checkin-plugin] 已在复选框可交互后自动点击 Turnstile（x=${target.x.toFixed(1)}, y=${target.y.toFixed(1)}）`)
        return true
      }
    } catch (err) {
      lastError = err?.message || String(err)
      // iframe 正在重建时继续短暂轮询
    } finally {
      try {
        if (iframe?.dispose) await withTimeout(iframe.dispose(), 5000, '释放 Turnstile iframe 句柄超时')
      } catch {
        // iframe 在验证过程中会重建，旧句柄失效属正常情况
      }
    }
    await new Promise(resolve => setTimeout(resolve, 350))
  }

  if (!shouldStop()) {
    await setTurnstilePanelStatus(page, '自动验证未完成，请手动勾选上方“请验证您是真人”')
    logger.warn(`[relay-checkin-plugin] Turnstile 自动操作未完成，请在可见窗口中手动点击${lastError ? `：${lastError}` : ''}`)
  }
  return false
}

async function turnstileRetrySequence(page) {
  return await withTimeout(
    page.evaluate(() => Number(document.getElementById('relay-checkin-turnstile-status')?.dataset.retry || 0)),
    5000,
    '读取 Turnstile 重试状态超时'
  ).catch(() => 0)
}

/**
 * 首次点击后只监听页面端明确发出的 reset 序号；序号递增才重新等待 checkbox 并点击，
 * 避免挑战仍在处理时重复点击。
 */
async function autoClickTurnstileWithRetries(page, timeoutSec, shouldStop) {
  const deadline = Date.now() + timeoutSec * 1000
  let retrySequence = await turnstileRetrySequence(page)
  let clicked = await autoClickTurnstileCheckbox(
    page,
    Math.max(1, Math.ceil((deadline - Date.now()) / 1000)),
    shouldStop
  )

  while (!shouldStop() && Date.now() < deadline) {
    let nextSequence = retrySequence
    while (!shouldStop() && Date.now() < deadline && nextSequence <= retrySequence) {
      await new Promise(resolve => setTimeout(resolve, 350))
      nextSequence = await turnstileRetrySequence(page)
    }
    if (shouldStop() || nextSequence <= retrySequence) break
    retrySequence = nextSequence
    logger.info(`[relay-checkin-plugin] Turnstile 组件已重置，开始第 ${retrySequence + 1} 次自动点击`)
    const didClick = await autoClickTurnstileCheckbox(
      page,
      Math.max(1, Math.ceil((deadline - Date.now()) / 1000)),
      shouldStop
    )
    clicked ||= didClick
  }
  return clicked
}


/**
 * 在站点页面上下文内渲染 Cloudflare Turnstile 挑战并获取 token
 * @returns {Promise<{token: string|null, stage: string, reason: string, errorCode?: string, detail?: string}>}
 */
export async function solveTurnstile(page, siteKey, timeoutSec, { interactive = false, host = '' } = {}) {
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
          // 页面被 window.stop() 截断时可能残留一个永远不会完成的 script 标签。
          // API 尚未就绪就移除残留并重新加载，避免继续等到总超时。
          document.querySelectorAll('script[src*="challenges.cloudflare.com/turnstile/v0/api.js"]')
            .forEach(script => script.remove())
          const script = document.createElement('script')
          script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
          script.async = true
          script.defer = true
          document.head.appendChild(script)
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
          statusEl.dataset.retry = '0'
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
          let widgetId = null
          let retryCount = 0
          let lastErrorCode = ''
          let retryTimer = null
          let retryPending = false
          const finish = result => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            clearTimeout(retryTimer)
            resolve(result)
          }
          const timer = setTimeout(() => finish(lastErrorCode
            ? {
                token: null,
                stage: 'explicit-widget',
                reason: 'error-callback',
                errorCode: lastErrorCode,
                retries: retryCount
              }
            : { token: null, stage: 'explicit-widget', reason: 'timeout' }), left)
          const retryableError = code => /^(?:110600|110620|200500|3\d{5}|6\d{5})$/.test(code)
          const handleError = code => {
            const errorCode = code == null ? '' : String(code)
            lastErrorCode = errorCode
            if (retryPending) return
            if (retryableError(errorCode) && retryCount < 2 && Date.now() + 2000 < deadline) {
              retryCount++
              retryPending = true
              if (statusEl) {
                statusEl.textContent = `验证暂未通过（错误码 ${errorCode}），正在重置后重试 ${retryCount}/2...`
              }
              retryTimer = setTimeout(() => {
                try {
                  window.turnstile.reset(widgetId)
                  retryPending = false
                  if (statusEl) {
                    statusEl.dataset.retry = String(retryCount)
                    statusEl.textContent = `验证已重置，等待第 ${retryCount + 1} 次自动点击...`
                  }
                } catch (err) {
                  finish({
                    token: null,
                    stage: 'explicit-widget',
                    reason: 'render-error',
                    errorCode,
                    detail: String(err)
                  })
                }
              }, 1200)
              return
            }
            finish({
              token: null,
              stage: 'explicit-widget',
              reason: 'error-callback',
              errorCode,
              retries: retryCount
            })
          }
          try {
            widgetId = window.turnstile.render(el, {
              sitekey: siteKey,
              theme: 'light',
              callback: token => {
                if (statusEl) statusEl.textContent = '验证通过，正在提交签到...'
                finish({ token, stage: 'explicit-widget', reason: 'token' })
              },
              'error-callback': handleError,
              'expired-callback': () => finish({ token: null, stage: 'explicit-widget', reason: 'expired' }),
              'timeout-callback': () => handleError('110620')
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
      ? autoClickTurnstileWithRetries(page, timeoutSec, () => stopAutoClick)
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
    await navigateForTurnstile(page, account.baseUrl)

    const attempt = await solveTurnstile(page, siteKey, timeoutSec, { interactive, host })
    if (!attempt.token) {
      return {
        turnstileFailed: true,
        message: turnstileFailureMessage(attempt, timeoutSec, interactive),
        detail: attempt
      }
    }

    logger.info(`[relay-checkin-plugin] Turnstile ${interactive ? '可见' : '无头'}验证已签发 token，正在提交签到接口`)
    const url = new URL(checkinPath, `${account.baseUrl}/`)
    url.searchParams.set('turnstile', attempt.token)
    return await pageFetch(page, url.toString(), { method: 'POST', headers })
  }, { interactive, profileKey: host, trackResult: false })
}

function boundedSeconds(value, fallback, min, max) {
  const n = Number(value)
  return Math.max(min, Math.min(Number.isFinite(n) ? n : fallback, max))
}

export function turnstileBrowserMode(browser = {}) {
  return browser.turnstileInteractive === false ? 'headless' : 'interactive'
}

/**
 * 手动指令的浏览器总预算：可见接管开启时直接走可见模式；关闭时才走无头模式。
 * 由调用层和测试共用，避免两处 clamp 漂移后外层先于浏览器超时。
 */
export function browserHangBudgetMs(browser = {}) {
  const slotSec = boundedSeconds(browser.slotWaitSec, 120, 30, 600)
  const quickSec = boundedSeconds(browser.turnstileTimeoutSec, 30, 5, 120)
  const interactiveEnabled = turnstileBrowserMode(browser) === 'interactive'
  const interactiveSec = !interactiveEnabled
    ? 0
    : boundedSeconds(browser.turnstileInteractiveTimeoutSec, 120, 30, 600)
  const activeSec = interactiveEnabled ? interactiveSec : quickSec
  // 300 秒覆盖 launch/newPage/初始化/导航/接口提交/关闭的硬超时余量。
  return (slotSec + activeSec + 300) * 1000
}

/**
 * Turnstile 站点浏览器签到：允许可见接管时直接使用持久可见浏览器，避免先进行一次
 * 大概率失败的无头挑战并污染同一出口的风险评分；关闭可见接管时才使用无头模式。
 * @param {object} account 账号
 * @param {object} opts { checkinPath: 签到接口路径, headers: 鉴权请求头, siteKey: Turnstile site key }
 * @returns {Promise<{status: number, json: object|null}|{turnstileFailed: true}>}
 */
export async function turnstileCheckin(account, { checkinPath, headers, siteKey }) {
  const cfg = getConfig()
  const host = new URL(account.baseUrl).hostname
  const quickTimeoutSec = boundedSeconds(cfg.browser.turnstileTimeoutSec, 30, 5, 120)
  const interactiveTimeoutSec = boundedSeconds(cfg.browser.turnstileInteractiveTimeoutSec, 120, 30, 600)

  if (turnstileBrowserMode(cfg.browser) === 'interactive') {
    logger.info(`[relay-checkin-plugin] 将直接打开可见浏览器处理 ${host}，请在机器人运行设备上于 ${interactiveTimeoutSec} 秒内完成验证`)
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
      logger.info('[relay-checkin-plugin] Turnstile 已通过可见浏览器完成并提交签到')
    }
    return interactive
  }

  let quick
  try {
    quick = await runTurnstileAttempt(
      account,
      { checkinPath, headers, siteKey },
      { interactive: false, timeoutSec: quickTimeoutSec }
    )
  } catch (err) {
    const detail = err?.message || String(err)
    quick = {
      turnstileFailed: true,
      message: `无头浏览器阶段失败：${detail}`,
      detail: { stage: 'headless-browser', reason: 'exception', detail }
    }
  }
  if (!quick.turnstileFailed) {
    noteResult(host, browserResultOk(quick))
    return quick
  }

  logger.info(`[relay-checkin-plugin] Turnstile 无头尝试未通过: ${quick.message}`)
  const result = {
    ...quick,
    message: `${quick.message}；可见浏览器接管已在配置中关闭`
  }
  noteResult(host, false)
  return result
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
