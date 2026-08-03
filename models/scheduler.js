import { getConfig } from './config.js'
import { allEntries, isPushGroup, groupCandidates } from './store.js'
import { checkinEntry, sleep, randInt } from './executor.js'
import { renderResult, renderResultPages } from './render.js'
import { withUserLock } from './lock.js'

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

    // 总开关打开且至少有一个账号开着单账号定时开关的用户才参与
    const entries = allEntries().filter(en => en.autoCheckin && en.accounts.some(acc => acc.auto !== false))
    if (!entries.length) {
      logger.info('[relay-checkin-plugin] 无需要定时签到的账号')
      return
    }
    logger.info(`[relay-checkin-plugin] 开始定时签到，共 ${entries.length} 个用户`)

    // 账号/用户间随机间隔，配置非法时回落默认值
    const delayRange = Array.isArray(cfg.schedule.accountDelay) && cfg.schedule.accountDelay.length === 2
      ? cfg.schedule.accountDelay
      : [5, 15]

    // 多用户并发执行（上限由 schedule.concurrency 控制），单用户内部仍逐账号串行；
    // 与手动指令共用用户锁：用户正在手动操作时跳过，避免同一账号被签两次
    const concurrency = Math.max(1, Math.min(cfg.schedule.concurrency || 3, 10))
    const done = []
    let cursor = 0
    let skipped = 0

    const worker = async () => {
      while (cursor < entries.length) {
        const entry = entries[cursor++]
        // 单个用户失败（落盘异常、适配器异常等）不能拖垮整轮，否则已签完的用户全收不到推送
        try {
          // 用户间随机间隔，避免整批请求特征过于集中
          await sleep(randInt(delayRange[0], delayRange[1]) * 1000)
          const r = await withUserLock(entry.userId, '定时签到', () =>
            checkinEntry(entry, { delayRange, autoOnly: true }))
          if (!r.ok) {
            skipped++
            logger.info(`[relay-checkin-plugin] 用户 ${entry.userId} 正在手动操作（${r.busy.label}），本轮跳过`)
            continue
          }
          done.push({ entry, results: r.result })
        } catch (err) {
          logger.error(`[relay-checkin-plugin] 用户 ${entry.userId} 定时签到异常: ${err?.message || err}`)
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, worker))
    if (skipped) logger.info(`[relay-checkin-plugin] 本轮跳过 ${skipped} 个正在手动操作的用户`)

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
 * 该用户结果要推送到的所有群：他用过的群里凡是开启了推送的都推一份
 * （签到本身仍只执行一次，这里只是把同一份结果分发到多个群）
 */
function pickPushGroups(entry) {
  return groupCandidates(entry).filter(gid => isPushGroup(gid))
}

/**
 * 按配置推送签到结果。
 * group 模式：推送到该用户用过且已开启推送的每一个群；
 * 一个群都没推成功（无已开启的群/已退群/发送失败）时私聊兜底，
 * 保证签到执行了就一定尝试过通知，不会静默丢弃
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

  // 同一个群内的多个用户合并成一次推送；同一用户出现在多个已开启的群里则各推一份
  const groups = new Map()
  for (const item of done) {
    for (const groupId of pickPushGroups(item.entry)) {
      const gk = `${item.entry.selfId}:${groupId}`
      if (!groups.has(gk)) {
        groups.set(gk, { selfId: item.entry.selfId, groupId, items: [] })
      }
      groups.get(gk).items.push(item)
    }
  }

  // 至少成功推送到一个群的用户，不再私聊兜底
  const delivered = new Set()
  for (const { selfId, groupId, items } of groups.values()) {
    try {
      const bot = getBot(selfId)
      const group = bot.pickGroup(Number(groupId) || groupId)

      // 过滤已退群的用户；群里已无绑定用户则整群跳过
      let members = null
      try {
        members = await group.getMemberMap()
      } catch {
        // 成员列表取不到（协议端不支持/临时失败）时不做过滤，交给发送环节兜底
      }
      const present = members
        ? items.filter(it => members.has(Number(it.entry.userId)) || members.has(String(it.entry.userId)))
        : items
      if (!present.length) {
        logger.info(`[relay-checkin-plugin] 群 ${groupId} 内已无绑定用户，跳过推送`)
        continue
      }

      const users = present.map(toUserBlock)
      // 每张图最多 usersPerImage 个用户，超出分页成多张图合并转发
      const images = await renderResultPages({ title: '中转站定时签到', users })
      if (!images.length) continue
      const nodes = images.map(img => ({
        message: img,
        nickname: '中转站签到',
        // TRSS 多 bot 时全局 Bot.uin 是数组，转发节点头像直接用所属 bot 的 QQ
        user_id: Number(selfId) || selfId
      }))
      // Miao-Yunzai（icqq）在群对象上构造合并转发；TRSS 用全局 Bot.makeForwardMsg
      const forward = group.makeForwardMsg
        ? await group.makeForwardMsg(nodes)
        : await Bot.makeForwardMsg(nodes)
      await group.sendMsg(forward)
      for (const it of present) delivered.add(it.entry.userId)
    } catch (err) {
      logger.error(`[relay-checkin-plugin] 群 ${groupId} 推送失败: ${err?.message || err}`)
    }
    await sleep(2000)
  }

  // 私聊兜底：一个群都没推成功的用户（含只私聊用过插件的用户）
  for (const item of done) {
    if (delivered.has(item.entry.userId)) continue
    if (groupCandidates(item.entry).length) {
      logger.info(`[relay-checkin-plugin] 用户 ${item.entry.userId} 未能推送到任何群，改为私聊`)
    }
    await pushPrivate(item)
    await sleep(1500)
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
