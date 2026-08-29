/**
 * Yunzai NG 的出图实现（插件自带）
 *
 * NG 的 `ctx.render` 需要有渲染器插件注册进来，但官方 renderer-puppeteer 目前
 * 还没有放出（组织下只有内核与面板插件），所以这里自己用 art-template + puppeteer
 * 出图：模板文件与 TRSS 侧完全共用，不改一行 HTML。
 *
 * 浏览器实例惰性创建、空闲自动关闭，并在插件卸载时由 disposeRenderer 收掉 ——
 * NG 要求「卸载真的归还资源」，留一个 Chromium 常驻是最典型的泄漏。
 */
import fs from 'node:fs'
import path from 'node:path'
import art from 'art-template'
import { PLUGIN_PATH, getConfig } from '../models/config.js'
import { resolveBrowserExecutable } from '../models/browser.js'
import { logger } from '../host/index.js'

const TPL_PATH = path.join(PLUGIN_PATH, 'resources', 'template')

/** 模板名 → 编译好的渲染函数 */
const compiledTemplates = new Map()

/** 出图浏览器（与 models/browser.js 的过码浏览器互不干扰，用途与生命周期都不同） */
let browser = null
let idleTimer = null
let launching = null

/**
 * 编译模板（首次用到才读盘，之后复用）
 * @param {string} tplName 模板名，不含扩展名
 * @returns {Function} art-template 渲染函数
 */
function compileTemplate(tplName) {
  const cached = compiledTemplates.get(tplName)
  if (cached) return cached
  const file = path.join(TPL_PATH, `${tplName}.html`)
  const source = fs.readFileSync(file, 'utf-8')
  // 与 Yunzai 的 lib/puppeteer 保持同一套 art-template 选项：默认转义、不缓存文件
  const render = art.compile(source, { filename: file, cache: false, debug: false })
  compiledTemplates.set(tplName, render)
  return render
}

/**
 * 排空闲关闭定时器（每次出图后重排）
 */
function armIdleClose() {
  if (idleTimer) clearTimeout(idleTimer)
  const sec = Math.max(30, getConfig().browser.idleCloseSec || 300)
  idleTimer = setTimeout(() => {
    idleTimer = null
    closeRenderBrowser('空闲超时')
  }, sec * 1000)
  idleTimer.unref?.()
}

/**
 * 取出图浏览器。并发调用共用同一次启动（launching 兜住竞态），
 * 找不到系统 Chrome/Edge 时退回 puppeteer 自带的 Chromium
 */
async function getBrowser() {
  if (browser?.connected ?? browser?.isConnected?.()) return browser
  if (launching) return await launching

  launching = (async () => {
    const puppeteer = (await import('puppeteer')).default
    const cfg = getConfig()
    let executablePath = ''
    try {
      executablePath = resolveBrowserExecutable(cfg.browser.executablePath) || ''
    } catch {
      // 探测系统浏览器失败不致命：puppeteer 自带 Chromium 时仍能出图
    }
    const launched = await puppeteer.launch({
      headless: true,
      executablePath: executablePath || undefined,
      // root 下跑必须关沙箱；出图页面全是本地内容，没有外部输入
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none']
    })
    logger.info(`[relay-checkin-plugin] 出图浏览器已启动（${executablePath || 'puppeteer 自带 Chromium'}）`)
    return launched
  })()

  try {
    browser = await launching
  } finally {
    launching = null
  }
  return browser
}

/**
 * 关掉出图浏览器
 * @param {string} reason 关闭原因，仅用于日志
 */
async function closeRenderBrowser(reason = '') {
  const current = browser
  browser = null
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  if (!current) return
  try {
    await current.close()
    logger.info(`[relay-checkin-plugin] 出图浏览器已关闭${reason ? `（${reason}）` : ''}`)
  } catch {
    // 已经崩了或被外部杀掉，忽略
  }
}

/**
 * 渲染模板为 PNG 字节
 *
 * 模板都是内联 CSS、不引外部资源（见 resources/template/*.html），所以不必设
 * `<base>` 或注入资源根路径；截图对象固定是模板里的 `#container`。
 * @param {string} tplName 模板名
 * @param {object} data 模板数据
 * @returns {Promise<Buffer|false>} PNG 字节，失败 false
 */
export async function renderToImage(tplName, data) {
  let page = null
  try {
    const html = compileTemplate(tplName)(data)
    const instance = await getBrowser()
    page = await instance.newPage()
    await page.setViewport({ width: 900, height: 600, deviceScaleFactor: 1.5 })
    await page.setContent(html, { waitUntil: 'domcontentloaded' })
    // 本地内容不需要等网络；字体已在系统里，等一帧布局稳定即可
    await page.evaluate(() => document.fonts?.ready)
    const target = (await page.$('#container')) || (await page.$('body'))
    const image = await target.screenshot({ type: 'png' })
    armIdleClose()
    return Buffer.isBuffer(image) ? image : Buffer.from(image)
  } catch (err) {
    logger.error(`[relay-checkin-plugin] 模板 ${tplName} 渲染失败: ${err?.message || err}`)
    // 浏览器本身出问题时下次重新启动，避免一直拿着坏实例
    if (/Target closed|Session closed|Connection closed|browser has disconnected/i.test(String(err?.message))) {
      await closeRenderBrowser('实例异常')
    }
    return false
  } finally {
    try {
      await page?.close()
    } catch {
      // 页面已随浏览器一起消失，忽略
    }
  }
}

/**
 * 插件卸载时收掉浏览器（注册到 ctx.onDispose）
 */
export async function disposeRenderer() {
  compiledTemplates.clear()
  await closeRenderBrowser('插件卸载')
}
