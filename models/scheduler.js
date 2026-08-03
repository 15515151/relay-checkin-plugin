import { getConfig } from './config.js'
import { allEntries } from './store.js'
import { checkinEntry, sleep, randInt } from './executor.js'
import { renderResult, renderResultPages } from './render.js'

let running = false

/**
 * 定时任务入口：全量签到 + 按配置推送结果
 */
export async function runScheduledCheckin() {
  const cfg = getConfig()
  if (!cfg.schedule.enable) return
  if (running) {
    logger.warn('[relay-checkin-plugin] 上一轮定时签到尚未结束，跳过本次')
    return
  }
  running = true

  try {
    // 随机延迟，避免所有人固定整点签到
    const jitter = cfg.schedule.jitterMinutes || 0
    if (jitter > 0) {
      const delayMs = randInt(0, jitter * 60) * 1000
      logger.info(`[relay-checkin-plugin] 定时签到将在 ${Math.round(delayMs / 1000)} 秒后开始`)
      await sleep(delayMs)
    }

    const entries = allEntries().filter(en => en.autoCheckin && en.accounts.length > 0)
    if (!entries.length) {
      logger.info('[relay-checkin-plugin] 无需要定时签到的账号')
      return
    }
    logger.info(`[relay-checkin-plugin] 开始定时签到，共 ${entries.length} 个用户`)

    // 账号/用户间随机间隔，配置非法时回落默认值
    const delayRange = Array.isArray(cfg.schedule.accountDelay) && cfg.schedule.accountDelay.length === 2
      ? cfg.schedule.accountDelay
      : [5, 15]

    // 逐用户逐账号执行
    const done = []
    for (let i = 0; i < entries.length; i++) {
      if (i > 0) await sleep(randInt(delayRange[0], delayRange[1]) * 1000)
      const results = await checkinEntry(entries[i], { delayRange })
      done.push({ entry: entries[i], results })
    }

    await pushResults(done, cfg)
    logger.info('[relay-checkin-plugin] 定时签到完成')
  } catch (err) {
    logger.error('[relay-checkin-plugin] 定时签到异常:', err)
  } finally {
    running = false
  }
}

function toUserBlock({ entry, results }) {
  return { nickname: entry.nickname || entry.userId, userId: entry.userId, accounts: results }
}

function getBot(selfId) {
  return Bot[selfId] ?? Bot
}

/**
 * 按配置推送签到结果
 */
async function pushResults(done, cfg) {
  const mode = cfg.push.mode || 'group'
  if (mode === 'off') return

  if (mode === 'private') {
    for (const item of done) {
      await pushPrivate(item)
      await sleep(1500)
    }
    return
  }

  // mode === 'group'：推送到用户最近使用的群（合并转发），仅私聊用过的用户私聊推送
  const groups = new Map()
  for (const item of done) {
    if (item.entry.groupId) {
      const gk = `${item.entry.selfId}:${item.entry.groupId}`
      if (!groups.has(gk)) {
        groups.set(gk, { selfId: item.entry.selfId, groupId: item.entry.groupId, items: [] })
      }
      groups.get(gk).items.push(item)
    } else {
      await pushPrivate(item)
      await sleep(1500)
    }
  }

  for (const { selfId, groupId, items } of groups.values()) {
    try {
      const users = items.map(toUserBlock)
      // 每张图最多 usersPerImage 个用户，超出分页成多张图合并转发
      const images = await renderResultPages({ title: '中转站定时签到', users })
      if (!images.length) continue
      const bot = getBot(selfId)
      const nodes = images.map(img => ({
        message: img,
        nickname: '中转站签到',
        // TRSS 多 bot 时全局 Bot.uin 是数组，转发节点头像直接用所属 bot 的 QQ
        user_id: Number(selfId) || selfId
      }))
      await bot.pickGroup(Number(groupId) || groupId).sendMsg(await Bot.makeForwardMsg(nodes))
    } catch (err) {
      logger.error(`[relay-checkin-plugin] 群 ${groupId} 推送失败: ${err?.message || err}`)
    }
    await sleep(2000)
  }
}

async function pushPrivate({ entry, results }) {
  try {
    const img = await renderResult({
      title: '中转站定时签到',
      users: [toUserBlock({ entry, results })]
    })
    if (!img) return
    const userId = Number(entry.userId) || entry.userId
    await getBot(entry.selfId).pickFriend(userId).sendMsg(img)
  } catch (err) {
    logger.error(`[relay-checkin-plugin] 私聊 ${entry.userId} 推送失败: ${err?.message || err}`)
  }
}
