import fs from 'node:fs'
import path from 'node:path'
import { DATA_PATH, renameWithRetry } from './config.js'

const STORE_PATH = path.join(DATA_PATH, 'accounts.json')
const PUSH_GROUPS_PATH = path.join(DATA_PATH, 'push_groups.json')

let storeCache = null
let pushGroupsCache = null

/**
 * 存储结构（data/accounts.json）：
 * {
 *   "u:QQ号": {
 *     groupId, userId, selfId, nickname,
 *     autoCheckin: true,
 *     accounts: [{ name, baseUrl, type, token, siteUserId, signPath,
 *                  username, auto, lastBalance, lastCheckinAt }]
 *   }
 * }
 * 按用户隔离：同一 QQ 在任意群/私聊共享同一份账号数据；
 * groupId 记录最近一次在群内使用本插件的群号，作为定时推送目标（null = 私聊推送）；
 * 同一站点可存多个账号，按站点用户ID区分；auto 为单账号定时开关（缺省视为开）
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
  renameWithRetry(tmp, STORE_PATH)
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
  // 群内使用时把该群记入候选列表；私聊使用不清空，保持推回用过的群
  if (e.isGroup && e.group_id) rememberGroup(entry, e.group_id)
  else normalizeGroups(entry)
}

// 记录的候选推送群上限（最近使用优先）
const MAX_GROUPS = 5

/**
 * 兼容旧数据：只有 groupId 时补出 groupIds 列表
 */
function normalizeGroups(entry) {
  if (!Array.isArray(entry.groupIds)) {
    entry.groupIds = entry.groupId ? [String(entry.groupId)] : []
  }
}

/**
 * 把某群提到候选推送群列表首位（最近使用优先，去重、限长）。
 * 记多个群是为了：用户最近用指令的群若未开启推送，还能推到他用过的其他已开启群
 */
export function rememberGroup(entry, groupId) {
  normalizeGroups(entry)
  const gid = String(groupId)
  entry.groupIds = [gid, ...entry.groupIds.filter(g => g !== gid)].slice(0, MAX_GROUPS)
  entry.groupId = gid // 保留旧字段语义：最近使用的群
}

/**
 * 候选推送群列表（最近使用优先）
 */
export function groupCandidates(entry) {
  if (Array.isArray(entry.groupIds) && entry.groupIds.length) return entry.groupIds
  return entry.groupId ? [String(entry.groupId)] : []
}

/**
 * 添加或更新账号：同站点同站点用户ID（都缺ID时同令牌）视为同一账号更新凭据，
 * 否则作为新账号追加（同站多账号）；更新时保留 auto 偏好与运行时缓存
 * @returns {{entry: object, index: number, updated: boolean, account: object}} account 为入库后的对象引用
 */
export function upsertAccount(e, account) {
  const entry = ensureEntry(e)
  const idx = entry.accounts.findIndex(acc =>
    acc.baseUrl === account.baseUrl &&
    (acc.siteUserId != null && account.siteUserId != null
      ? String(acc.siteUserId) === String(account.siteUserId)
      : acc.token === account.token)
  )
  if (idx >= 0) {
    const keep = entry.accounts[idx]
    entry.accounts[idx] = { ...keep, ...account, auto: keep.auto !== false }
    save()
    return { entry, index: idx + 1, updated: true, account: entry.accounts[idx] }
  }
  entry.accounts.push(account)
  save()
  return { entry, index: entry.accounts.length, updated: false, account }
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
 * 设置定时签到总开关
 */
export function setAuto(e, enable) {
  const entry = ensureEntry(e)
  entry.autoCheckin = enable
  save()
}

/**
 * 设置单个账号的定时签到开关（序号 1 起），返回账号或 null
 */
export function setAccountAuto(e, index, enable) {
  const entry = getEntry(e)
  if (!entry || index < 1 || index > entry.accounts.length) return null
  entry.accounts[index - 1].auto = enable
  save()
  return entry.accounts[index - 1]
}

/**
 * 账号展示名：站点 host（+ 站点用户名区分同站多账号）
 */
export function accountLabel(account) {
  return account.username ? `${account.name} (${account.username})` : account.name
}

/**
 * 全部条目（定时任务用）
 */
export function allEntries() {
  const store = load()
  return Object.entries(store).map(([key, entry]) => ({ key, ...entry }))
}

/**
 * 持久化外部对 entry 的直接修改（如签到后更新余额缓存）
 */
export function persist() {
  if (storeCache) save()
}

/**
 * 定时推送白名单（data/push_groups.json，群号字符串数组）：
 * 群推送模式下只有名单内的群才会收到定时签到结果
 */
function loadPushGroups() {
  if (pushGroupsCache) return pushGroupsCache
  try {
    pushGroupsCache = fs.existsSync(PUSH_GROUPS_PATH)
      ? JSON.parse(fs.readFileSync(PUSH_GROUPS_PATH, 'utf-8'))
      : []
    if (!Array.isArray(pushGroupsCache)) pushGroupsCache = []
  } catch (err) {
    logger.error(`[relay-checkin-plugin] 推送白名单读取失败: ${err.message}`)
    pushGroupsCache = []
  }
  return pushGroupsCache
}

function savePushGroups() {
  if (!fs.existsSync(DATA_PATH)) fs.mkdirSync(DATA_PATH, { recursive: true })
  const tmp = PUSH_GROUPS_PATH + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(pushGroupsCache, null, 2))
  renameWithRetry(tmp, PUSH_GROUPS_PATH)
}

/**
 * 某群是否在定时推送白名单内
 */
export function isPushGroup(groupId) {
  return loadPushGroups().includes(String(groupId))
}

/**
 * 开关某群的定时推送，返回状态是否发生变化（重复开/关返回 false）
 */
export function setPushGroup(groupId, enable) {
  const list = loadPushGroups()
  const gid = String(groupId)
  const idx = list.indexOf(gid)
  if (enable && idx < 0) {
    list.push(gid)
    savePushGroups()
    return true
  }
  if (!enable && idx >= 0) {
    list.splice(idx, 1)
    savePushGroups()
    return true
  }
  return false
}
