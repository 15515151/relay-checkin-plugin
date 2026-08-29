/**
 * NG 侧出图：模板编译在插件内，截图交给内核的渲染器
 *
 * 走的是 `ctx.render(page, opts)` 这条通路（`RenderablePage = { name, html }`）——
 * 与 TSX 模板同一条路：插件把 HTML 准备好，内核按 `render.default` 选一个已注册的
 * 渲染器去截图。因此本插件**不自己启动浏览器、也不注册渲染器**，换渲染器实现与我们无关。
 *
 * 为什么不用 `ctx.render(模板名, 数据)` 那条字符串通路：那条路的模板引擎由渲染器决定，
 * 而这三个模板是 art-template 语法（`{{each}}` / `{{if}}`）且要与 TRSS 侧共用同一份文件。
 * 自己编译成 HTML 再交出去，既不动模板，也不依赖渲染器用的是哪个引擎。
 */
import fs from 'node:fs'
import path from 'node:path'
import art from 'art-template'
import { PLUGIN_PATH } from '../models/config.js'
import { logger } from '../host/index.js'

const TPL_PATH = path.join(PLUGIN_PATH, 'resources', 'template')

/** 模板名 → 编译好的渲染函数 */
const compiledTemplates = new Map()

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
 * 渲染模板并交给内核渲染器出图
 * @param {object} ctx 插件上下文
 * @param {string} tplName 模板名
 * @param {object} data 模板数据
 * @returns {Promise<any|false>} 可直接发送的图片段（分页时为数组），失败 false
 */
export async function renderViaCore(ctx, tplName, data) {
  try {
    const html = compileTemplate(tplName)(data)
    // 模板都是内联 CSS、不引外部资源，所以不需要资源根；截图对象固定是模板里的 #container
    const image = await ctx.render({ name: `relay-checkin/${tplName}`, html }, {
      selector: '#container',
      // 模板里小字密集，先出无损图再交给平台压
      type: 'png'
    })
    if (Array.isArray(image)) return image.length === 1 ? image[0] : image
    return image
  } catch (err) {
    const msg = String(err?.message || err)
    // 「已尝试 0 个渲染器」是内核在完全没有渲染器时的说法，对用户毫无指向性，翻译一下
    const hint = /已尝试 0 个渲染器/.test(msg)
      ? '：当前 Yunzai NG 没有装任何渲染器插件，出图不可用（装一个渲染器插件即可，本插件不自带）'
      : `: ${msg}`
    logger.error(`[relay-checkin-plugin] 模板 ${tplName} 出图失败${hint}`)
    return false
  }
}

/**
 * 插件卸载时清掉编译缓存（浏览器归渲染器插件管，与本插件无关）
 */
export function disposeRenderer() {
  compiledTemplates.clear()
}
