/**
 * Yunzai NG 宿主实现
 *
 * 一切能力来自注入的 `ctx`，进程里没有全局 logger / Bot / segment。
 * 与 TRSS 侧的差异都收在这一个文件里：
 *   - 数据目录是内核给每个插件分的 ctx.dataDir（不再写进插件安装目录）
 *   - 配置由内核按 configSchema 管理，面板保存即生效，不需要 chokidar
 *   - 出图是插件自带的 art-template + puppeteer（NG 还没有官方渲染器插件）
 */
import { seg } from '@yunzai-ng/core'
import { withDefaults } from '../models/config.js'
import { renderToImage } from '../ng/render.js'

/**
 * 造一个 NG 宿主实现
 * @param {object} ctx NG 注入的插件上下文
 * @returns {object} 宿主实现，交给 host/index.js 的 installHost
 */
export function createNgHost(ctx) {
  // ctx.config.get() 保证「变更后才换新对象」，故按引用缓存补全结果，
  // 免得每次读配置都深合并一遍（request 层每个请求都会读）
  let cachedRaw = null
  let cachedConfig = null

  /**
   * 把 NG 的 BotApi 包成插件内部用的账号门面
   * @param {object} bot NG BotApi
   * @returns {object} 账号门面
   */
  const wrapBot = bot => ({
    selfId: String(bot.selfId ?? ''),

    sendPrivate(uid, content) {
      return bot.sendMessage({ scene: 'private', uid: String(uid) }, content)
    },

    sendGroup(gid, content) {
      return bot.sendMessage({ scene: 'group', gid: String(gid) }, content)
    },

    recallGroupMsg(_gid, messageId) {
      // NG 按消息 id 撤回，不需要会话；参数保留是为了与 TRSS 门面同签名
      return bot.recallMessage(String(messageId))
    },

    /**
     * 群合并转发。适配器不一定实现 sendForward（它在 BotApi 里是可选能力），
     * 没有就逐张发出去 —— 宁可刷几条图，也不能把签到结果丢掉
     */
    async sendForwardToGroup(gid, nodes) {
      const target = { scene: 'group', gid: String(gid) }
      if (typeof bot.sendForward === 'function') {
        return await bot.sendForward(target, nodes.map(node => ({
          uid: node.uid != null ? String(node.uid) : undefined,
          name: node.name,
          message: Array.isArray(node.message) ? node.message : [node.message]
        })))
      }
      let last = null
      for (const node of nodes) last = await bot.sendMessage(target, node.message)
      return last
    }
  })

  return {
    kind: 'ng',

    logger: ctx.logger,

    get dataDir() {
      return ctx.dataDir
    },

    getConfig() {
      const raw = ctx.config.get()
      if (raw !== cachedRaw) {
        cachedRaw = raw
        cachedConfig = withDefaults(raw)
      }
      return cachedConfig
    },

    segment: {
      reply: messageId => seg.reply(String(messageId)),
      at: uid => seg.at(String(uid)),
      image: file => seg.image(file)
    },

    defaultSelfId() {
      return String(ctx.pickBot()?.selfId ?? '')
    },

    /**
     * 取账号门面。指定账号不在线时回落到任意在线账号：
     * 定时推送宁可换个账号发出去，也不要因为原账号掉线就静默丢结果
     */
    pickBot(selfId) {
      const bot = (selfId != null && selfId !== '' ? ctx.pickBot(String(selfId)) : null) || ctx.pickBot()
      return bot ? wrapBot(bot) : null
    },

    async renderTemplate(tplName, data) {
      const image = await renderToImage(tplName, data)
      return image ? seg.image(image) : false
    }
  }
}
