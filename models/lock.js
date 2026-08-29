import { logger } from '../host/index.js'
/**
 * 按用户的互斥锁：同一 QQ 的签到/查询/添加/删除等操作串行执行。
 *
 * 目的：
 * 1. 防重复触发——用户连发 #中转签到 不会对同一账号并发签到（可能被站点判为异常）
 * 2. 防数据竞争——签到遍历 accounts 期间不会被 #中转删除 改动数组导致错位
 * 3. 定时任务与手动指令共用同一把锁，同一用户不会被同时签两次
 *
 * 锁只在单进程内有效（Yunzai 单进程运行，够用）；
 * 带持有上限兜底，避免个别未预见的挂起把用户永久锁死。
 */

const MAX_HOLD_MS = 30 * 60 * 1000

// userId(string) -> token 对象 { label, since, key }
const locks = new Map()

/**
 * 清理超时未释放的锁（防御性兜底，正常路径由 finally 释放）。
 * 注意：这里只放行后来者，并不能中断原任务，因此阈值取得足够宽松；
 * 配合 release 的归属校验，被夺锁的旧任务结束时不会误删新持有者的锁
 */
function evictStale(key) {
  const held = locks.get(key)
  if (held && Date.now() - held.since > MAX_HOLD_MS) {
    logger.error(`[relay-checkin-plugin] 用户 ${key} 的「${held.label}」锁超过 ${MAX_HOLD_MS / 60000} 分钟未释放，已强制清除`)
    locks.delete(key)
  }
}

/**
 * 尝试获取锁，成功返回释放句柄，失败返回 null
 * release 带归属校验：只有 Map 中当前仍是自己这把锁时才删除
 * @returns {{release: Function}|null}
 */
export function tryAcquire(userId, label) {
  const key = String(userId)
  evictStale(key)
  if (locks.has(key)) return null
  const token = { label, since: Date.now(), key }
  locks.set(key, token)
  return {
    release() {
      if (locks.get(key) === token) locks.delete(key)
    }
  }
}

/**
 * 当前持有的锁信息（供提示用），未加锁返回 null
 * @returns {{label: string, seconds: number}|null}
 */
export function heldBy(userId) {
  const key = String(userId)
  evictStale(key)
  const held = locks.get(key)
  if (!held) return null
  return { label: held.label, seconds: Math.max(1, Math.round((Date.now() - held.since) / 1000)) }
}

/**
 * 加锁执行：已被占用时不排队，直接返回 busy 让调用方提示用户
 * @returns {Promise<{ok: true, result: any}|{ok: false, busy: {label, seconds}}>}
 */
export async function withUserLock(userId, label, fn) {
  const lock = tryAcquire(userId, label)
  if (!lock) {
    return { ok: false, busy: heldBy(userId) ?? { label: '上一个操作', seconds: 1 } }
  }
  try {
    return { ok: true, result: await fn() }
  } finally {
    lock.release()
  }
}
