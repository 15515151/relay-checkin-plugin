import { getAdapter } from './adapters/index.js'
import { quotaToUsd } from './adapters/common.js'

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min

const STATUS_TEXT = { ok: '签到成功', already: '今日已签', fail: '签到失败' }

/**
 * 对单个账号执行签到，并顺带查询最新余额
 * @returns {Promise<{name, status, statusText, award, balance, msg}>}
 */
export async function checkinAccount(account) {
  const adapter = getAdapter(account.type)
  const result = { name: account.name, status: 'fail', statusText: '', award: '', balance: '-', msg: '' }
  let statusTextOverride = null

  try {
    const r = await adapter.checkin(account)
    if (r.ok) {
      result.status = r.already ? 'already' : 'ok'
      statusTextOverride = r.statusTextOverride || null
      if (r.balanceText) result.balance = r.balanceText
      if (!r.already && r.awardQuota != null) {
        result.award = '+' + (quotaToUsd(r.awardQuota) ?? r.awardQuota)
      }
    } else {
      result.msg = r.msg
    }
  } catch (err) {
    result.msg = err.message
  }
  result.statusText = statusTextOverride || STATUS_TEXT[result.status]

  // 余额查询失败不影响签到结果（适配器已携带余额时跳过）
  if (result.balance === '-') {
    try {
      const info = await adapter.userInfo(account)
      if (info.ok) result.balance = info.balanceText
    } catch {
      // 忽略
    }
  }

  return result
}

/**
 * 对一个用户条目的全部（或指定序号）账号执行签到
 * @param {object} entry 存储条目
 * @param {object} opts { index: 1起的序号(可选), delayRange: [min,max]秒(可选，账号间随机间隔) }
 */
export async function checkinEntry(entry, { index = null, delayRange = null } = {}) {
  const accounts = index ? [entry.accounts[index - 1]].filter(Boolean) : entry.accounts
  const results = []
  for (let i = 0; i < accounts.length; i++) {
    if (i > 0 && delayRange) {
      await sleep(randInt(delayRange[0], delayRange[1]) * 1000)
    }
    results.push(await checkinAccount(accounts[i]))
  }
  return results
}

/**
 * 余额查询（不签到）
 * @returns {Promise<Array<{name, status, statusText, award, balance, msg}>>}
 */
export async function queryEntry(entry) {
  const results = []
  for (const account of entry.accounts) {
    const adapter = getAdapter(account.type)
    const row = { name: account.name, status: 'ok', statusText: '正常', award: '', balance: '-', msg: '' }
    try {
      const info = await adapter.userInfo(account)
      if (info.ok) {
        row.balance = info.balanceText
        row.award = `已用 ${info.usedText}`
      } else {
        row.status = 'fail'
        row.statusText = '查询失败'
        row.msg = info.msg
      }
    } catch (err) {
      row.status = 'fail'
      row.statusText = '查询失败'
      row.msg = err.message
    }
    results.push(row)
  }
  return results
}
