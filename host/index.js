/**
 * 宿主适配层：把插件对宿主框架的依赖收在一处
 *
 * 本插件要同时跑在两个互不兼容的宿主上：
 *   - TRSS-Yunzai：全局 `logger` / `Bot` / `segment`、`lib/puppeteer`、插件目录下的 data/
 *   - Yunzai NG：一切都在注入的 `ctx` 上，进程里没有任何全局变量
 *
 * 于是业务代码一律通过本模块取用宿主能力，由入口在启动时装上对应实现。
 *
 * 硬约束：**任何模块的顶层都不许调用这里的函数**。ESM 的 import 会在入口执行
 * `installHost()` 之前求值完毕，顶层调用必然拿到空宿主。路径、配置这些以前是
 * 顶层常量的东西，因此全部改成了惰性函数。
 */

/** 当前宿主实现，由 installHost 装入 */
let impl = null

/**
 * 装入宿主实现（入口调用，一次）
 * @param {object} host 宿主实现
 */
export function installHost(host) {
  impl = host
}

/** 是否已装入宿主（供只在某一宿主下生效的分支判断） */
export function hasHost() {
  return Boolean(impl)
}

/** 宿主标识：'trss' | 'ng' */
export function hostKind() {
  return impl?.kind || 'unknown'
}

/**
 * 取当前宿主，未装入时抛错
 *
 * 宁可抛错也不静默回落到「假装是 TRSS」：那样在 NG 下会去读不存在的全局 Bot，
 * 报出来的是 `Bot is not defined` 这种与真实病因无关的错。
 */
export function currentHost() {
  if (!impl) {
    throw new Error('[relay-checkin-plugin] 宿主适配层未初始化：入口应先调用 installHost()')
  }
  return impl
}

const LOG_METHODS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'mark']

/**
 * 日志门面。调用写法与全局 `logger` 完全一致，业务代码只需多一行 import。
 * 宿主未装入时退回 console，避免「日志本身把插件搞崩」。
 */
export const logger = Object.fromEntries(LOG_METHODS.map(level => [
  level,
  (...args) => {
    const target = impl?.logger
    if (target && typeof target[level] === 'function') return target[level](...args)
    const fallback = level === 'error' || level === 'fatal' ? 'error' : (level === 'warn' ? 'warn' : 'log')
    console[fallback](...args)
  }
]))

/** 本插件的数据目录（TRSS：插件下 data/；NG：ctx.dataDir） */
export function dataDir() {
  return currentHost().dataDir
}

/** 读配置（TRSS：data/config.yaml；NG：ctx.config.get()） */
export function getConfig() {
  return currentHost().getConfig()
}

/** 消息段构造器（image / at / reply 三个够用） */
export function segment() {
  return currentHost().segment
}

/**
 * 取一个可发消息的 Bot 门面
 * @param {string|number} selfId 账号 id，取不到时由宿主选默认账号
 * @returns {{sendPrivate:Function,sendGroup:Function,recall:Function,sendForwardToGroup:Function,selfId:string}|null}
 */
export function pickBot(selfId) {
  return currentHost().pickBot(selfId)
}

/**
 * 默认账号 id（消息事件没带 self_id 时的兜底）
 * @returns {string} 账号 id，一个都没有时空串
 */
export function defaultSelfId() {
  return currentHost().defaultSelfId()
}

/**
 * 渲染模板出图
 * @param {string} tplName resources/template 下的模板名（不含扩展名）
 * @param {object} data 模板数据
 * @returns {Promise<any|false>} 可直接发送的图片消息段，失败 false
 */
export function renderTemplate(tplName, data) {
  return currentHost().renderTemplate(tplName, data)
}
