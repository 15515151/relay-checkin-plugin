/**
 * TRSS-Yunzai 宿主实现
 *
 * 这里是插件在 TRSS 下的原有行为：全局 `logger` / `Bot` / `segment`、
 * Yunzai 自带的 lib/puppeteer 出图、插件目录下的 data/ 存数据。
 *
 * `lib/puppeteer` 用动态 import：静态 import 会让这个只有 TRSS 存在的路径
 * 在 NG 侧解析模块时就报错，而出图本身是首次用到才需要的。
 */
import path from 'node:path'
import { PLUGIN_PATH, TRSS_DATA_PATH, readYamlConfig } from '../models/config.js'

const TPL_PATH = path.join(PLUGIN_PATH, 'resources', 'template')

/** QQ 号在 icqq 侧要数字，OneBot 侧字符串也收；能转数字就转 */
function numOr(value) {
  return Number(value) || value
}

/** 出图落盘名的轮转编号，避免定时任务与手动指令并发渲染时写同名文件 */
let renderSeq = 0

/**
 * 造一个 TRSS 宿主实现
 * @returns {object} 宿主实现，交给 host/index.js 的 installHost
 */
export function createTrssHost() {
  return {
    kind: 'trss',

    get logger() {
      return globalThis.logger
    },

    get dataDir() {
      return TRSS_DATA_PATH
    },

    getConfig() {
      return readYamlConfig()
    },

    segment: {
      reply: messageId => globalThis.segment.reply(messageId),
      at: uid => globalThis.segment.at(numOr(uid)),
      image: file => globalThis.segment.image(file)
    },

    /**
     * 默认账号。TRSS 多账号时全局 Bot.uin 是数组，取第一个
     */
    defaultSelfId() {
      const uin = globalThis.Bot?.uin
      if (Array.isArray(uin)) return String(uin[0] ?? '')
      return String(uin ?? '')
    },

    /**
     * 取账号门面。TRSS 的 `Bot[selfId]` 是具体账号，`Bot` 本身是兜底
     */
    pickBot(selfId) {
      const root = globalThis.Bot
      if (!root) return null
      const bot = (selfId != null && root[selfId]) ? root[selfId] : root
      return {
        selfId: String(selfId ?? bot.uin ?? ''),

        sendPrivate(uid, content) {
          return bot.pickFriend(numOr(uid)).sendMsg(content)
        },

        sendGroup(gid, content) {
          return bot.pickGroup(numOr(gid)).sendMsg(content)
        },

        recallGroupMsg(gid, messageId) {
          return bot.pickGroup(numOr(gid)).recallMsg(messageId)
        },

        /**
         * 群合并转发。Miao-Yunzai（icqq）在群对象上构造，TRSS 用全局 Bot.makeForwardMsg
         */
        async sendForwardToGroup(gid, nodes) {
          const group = bot.pickGroup(numOr(gid))
          const trssNodes = nodes.map(node => ({
            message: node.message,
            nickname: node.name,
            user_id: numOr(node.uid)
          }))
          const forward = group.makeForwardMsg
            ? await group.makeForwardMsg(trssNodes)
            : await root.makeForwardMsg(trssNodes)
          return await group.sendMsg(forward)
        }
      }
    },

    /**
     * 出图：走 Yunzai 的 lib/puppeteer（art-template + 单例浏览器）
     */
    async renderTemplate(tplName, data) {
      const puppeteer = (await import('../../../lib/puppeteer/puppeteer.js')).default
      renderSeq = (renderSeq + 1) % 20
      return await puppeteer.screenshot(`relay-checkin-plugin/${tplName}`, {
        tplFile: path.join(TPL_PATH, `${tplName}.html`),
        pluResPath: path.join(PLUGIN_PATH, 'resources') + path.sep,
        saveId: `${tplName}_${renderSeq}`,
        // 模板里小字密集：webp 体积只有 png 的几分之一，又没有 jpeg 那种糊边
        // （imgType 由渲染器直接透传给 puppeteer 的 screenshot({type})）
        imgType: 'webp',
        quality: 90,
        ...data
      })
    }
  }
}
