import fs from 'node:fs'
import path from 'node:path'
import { DATA_PATH } from './config.js'

const STORE_PATH = path.join(DATA_PATH, 'accounts.json')

let storeCache = null

/**
 * 存储结构（data/accounts.json）：
 * {
 *   "u:QQ号": {
 *     groupId, userId, selfId, nickname,
 *     autoCheckin: true,
 *     accounts: [{ name, baseUrl, type, token, siteUserId, signPath }]
 *   }
 * }
 * 按用户隔离：同一 QQ 在任意群/私聊共享同一份账号数据；
 * groupId 记录最近一次在群内使用本插件的群号，作为定时推送目标（null = 私聊推送）
 */
function load() {
  if (storeCache) return storeCache
  try {
    if (fs.existsSync(STORE_PATH)) {
      storeCache = JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8'))
    } else {
      storeCache = {}
    }
  } catch (err) {
    logger.error(`[relay-checkin-plugin] 账号数据读取失败: ${err.message}`)
    storeCache = {}
  }
  return storeCache
}

/**
 * 原子写入，避免写一半崩溃损坏数据
 */
function save() {
  if (!fs.existsSync(DATA_PATH)) fs.mkdirSync(DATA_PATH, { recursive: true })
  const tmp = STORE_PATH + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(storeCache, null, 2))
  fs.renameSync(tmp, STORE_PATH)
}

/**
 * 由消息事件计算隔离键（仅按用户隔离）
 */
export function keyOf(e) {
  return `u:${e.user_id}`
}

/**
 * 获取当前用户条目（不存在时返回 null）
 */
export function getEntry(e) {
  return load()[keyOf(e)] || null
}

/**
 * 刷新条目的昵称/selfId/最近使用群（条目不存在返回 null）
 */
export function touchEntry(e) {
  const entry = getEntry(e)
  if (!entry) return null
  applyEvent(entry, e)
  save()
  return entry
}

/**
 * 获取或创建当前用户条目
 */
export function ensureEntry(e) {
  const store = load()
  const key = keyOf(e)
  if (!store[key]) {
    store[key] = {
      groupId: null,
      userId: String(e.user_id),
      selfId: String(e.self_id ?? Bot.uin),
      nickname: '',
      autoCheckin: true,
      accounts: []
    }
  }
  const entry = store[key]
  applyEvent(entry, e)
  save()
  return entry
}

function applyEvent(entry, e) {
  entry.nickname = e.sender?.card || e.sender?.nickname || entry.nickname || String(e.user_id)
  entry.selfId = String(e.self_id ?? entry.selfId)
  // 群内使用时更新推送目标群；私聊使用不清空，保持推回最近的群
  if (e.isGroup && e.group_id) entry.groupId = String(e.group_id)
}

/**
 * 添加账号
 */
export function addAccount(e, account) {
  const entry = ensureEntry(e)
  entry.accounts.push(account)
  save()
  return entry.accounts.length
}

/**
 * 按序号（1 起）删除账号，返回被删账号或 null
 */
export function removeAccount(e, index) {
  const entry = getEntry(e)
  if (!entry || index < 1 || index > entry.accounts.length) return null
  const [removed] = entry.accounts.splice(index - 1, 1)
  save()
  return removed
}

/**
 * 设置定时签到开关
 */
export function setAuto(e, enable) {
  const entry = ensureEntry(e)
  entry.autoCheckin = enable
  save()
}

/**
 * 全部条目（定时任务用）
 */
export function allEntries() {
  const store = load()
  return Object.entries(store).map(([key, entry]) => ({ key, ...entry }))
}

/**
 * 持久化外部对 entry 的直接修改（如更新已有账号凭据）
 */
export function persist() {
  save()
}
