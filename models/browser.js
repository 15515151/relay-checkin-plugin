import { getConfig } from './config.js'
import { proxyForHost } from './adapters/common.js'

/**
 * 无头浏览器工具：用于过阿里云 WAF（AnyRouter 系）与 Cloudflare Turnstile 挑战。
 * puppeteer 惰性加载（复用 Yunzai 根目录依赖，缺失时仅浏览器功能不可用，不影响插件加载）。
 *
 * 按代理模式分池持有实例：direct（直连）与每个代理地址各一个浏览器，各自独立计数与空闲回收。
 * 这样直连站与代理站可同时进行，任何站点都不会被迫用错的网络模式访问
 * （带账密代理的认证走 page.authenticate，chromium 的 --proxy-server 不接受账密）。
 */

// Map<mode, { instance, activeTasks, idleTimer, launching }>，mode 为 'direct' 或代理地址
const pools = new Map()

function getPool(mode) {
  if (!pools.has(mode)) {
    pools.set(mode, { instance: null, activeTasks: 0, idleTimer: null, launching: null })
  }
  return pools.get(mode)
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
async function getBrowser(pool, proxy) {
  if (isBrowserAlive(pool.instance)) return pool.instance
  if (!pool.launching) {
    pool.launching = (async () => {
      const puppeteer = await getPuppeteer()
      const args = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        // 控制资源占用：WAF 挑战页会 JS 自刷新，不限制时可能吃满 CPU/内存
        // 把宿主机拖到无法调度（表现为整个机器人卡死、定时器都不触发）
        '--disable-gpu',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-features=TranslateUI,BackForwardCache',
        '--renderer-process-limit=1',
        '--js-flags=--max-old-space-size=256',
        '--no-first-run'
      ]
      if (proxy?.server) {
        args.push(`--proxy-server=${proxy.server}`)
        // 让 Chrome 到代理自身（本机回环）的连接不再经过代理，
        // 避免 Clash 等开启 TUN/系统代理时形成环路把请求打进黑洞
        args.push('--proxy-bypass-list=<-loopback>')
      }
      // protocolTimeout 给所有 CDP 调用兜底（setCookie/evaluate 等在浏览器无响应时
      // 会永久挂起且不受 launch 的 timeout 约束）；timeout 管启动连接本身
      return await puppeteer.launch({
        headless: 'new',
        args,
        timeout: 60000,
        protocolTimeout: 90000
      })
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

async function withPage(host, fn) {
  checkBreaker(host)
  await acquirePageSlot()
  // 外层只负责槽位：内部任何异常（含取配置/解析代理失败）都不会漏掉释放
  try {
    const proxy = parseProxy(proxyForHost(host, true))
    const mode = proxy?.server || 'direct'
    const pool = getPool(mode)
    if (pool.idleTimer) {
      clearTimeout(pool.idleTimer)
      pool.idleTimer = null
    }
    pool.activeTasks++
    let page = null
    try {
      logger.info(`[relay-checkin-plugin] 浏览器方案启动: ${host}${proxy ? ` (代理 ${proxy.server})` : ' (直连)'}`)
      const browser = await withTimeout(getBrowser(pool, proxy), 70000, '启动浏览器超时（检查 puppeteer 是否可用）')
      page = await newPageSafe(browser, 30000)
      logger.info('[relay-checkin-plugin] 浏览器页面就绪，开始初始化')
      // 以下都是本地 CDP 调用，正常都是毫秒级；浏览器无响应时必须超时而不是静默挂死
      if (proxy?.auth) await withTimeout(page.authenticate(proxy.auth), 15000, '设置代理认证超时')
      await withTimeout(page.setUserAgent(getConfig().request.userAgent), 15000, '设置 UA 超时（浏览器无响应）')
      await withTimeout(page.evaluateOnNewDocument(STEALTH_SCRIPT), 15000, '注入初始化脚本超时（浏览器无响应）')
      logger.info('[relay-checkin-plugin] 页面初始化完成')
      const out = await fn(page)
      noteResult(host, !out?.wafBlocked)
      return out
    } catch (err) {
      noteResult(host, false)
      throw err
    } finally {
      // 关闭也可能挂起（挑战页忙循环等），必须带超时否则计数永久失衡
      if (page) await withTimeout(page.close(), 15000, '关闭页面超时').catch(() => {})
      pool.activeTasks--
      scheduleIdleClose(pool)
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

    if (!cookies.length) return { wafBlocked: true }
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ')
    logger.info(`[relay-checkin-plugin] 已取得 ${cookies.length} 个 cookie，改用普通 HTTP 调用接口`)
    return { cookieHeader }
  })
}


/**
 * 在站点页面上下文内渲染 Cloudflare Turnstile 挑战并获取 token
 * @returns {Promise<string|null>}
 */
async function solveTurnstile(page, siteKey, timeoutSec) {
  return await page.evaluate(async ({ siteKey, timeoutSec }) => {
    const deadline = Date.now() + timeoutSec * 1000

    // 优先等站点自己的挑战组件出结果：保留站点原始参数（action/cData 等），
    // 通过率高于自行 render；站点页面未渲染挑战时再回退到显式 render
    const readExisting = () => {
      const input = document.querySelector('input[name="cf-turnstile-response"]')
      return input?.value || null
    }
    while (Date.now() < deadline) {
      const v = readExisting()
      if (v) return v
      if (!document.querySelector('.cf-turnstile, [data-sitekey]')) break
      await new Promise(r => setTimeout(r, 500))
    }

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
      const left = Math.max(5000, deadline - Date.now())
      return await new Promise(resolve => {
        const timer = setTimeout(() => resolve(null), left)
        try {
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
        } catch {
          clearTimeout(timer)
          resolve(null)
        }
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
    await withTimeout(
      page.goto(account.baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }),
      40000, '打开站点页面超时（网络或代理不通）'
    )

    const timeoutSec = cfg.browser.turnstileTimeoutSec || 30
    // 首次失败多为脚本加载/评分抖动，重载页面再试一次
    let token = await solveTurnstile(page, siteKey, timeoutSec)
    if (!token) {
      logger.info('[relay-checkin-plugin] Turnstile 首次未通过，重载页面重试')
      await withTimeout(
        page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }),
        40000, '重载页面超时'
      ).catch(() => {})
      token = await solveTurnstile(page, siteKey, timeoutSec)
    }
    if (!token) return { turnstileFailed: true }

    const url = `${account.baseUrl}${checkinPath}?turnstile=${encodeURIComponent(token)}`
    return await pageFetch(page, url, { method: 'POST', headers })
  })
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
