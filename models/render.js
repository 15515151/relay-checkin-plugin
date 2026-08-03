import path from 'node:path'
import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import { PLUGIN_PATH, getConfig } from './config.js'
import { accountLabel } from './store.js'

const TPL_PATH = path.join(PLUGIN_PATH, 'resources', 'template')

function now() {
  const d = new Date()
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

let renderSeq = 0

/**
 * 通用模板渲染，返回可直接发送的图片消息段（失败返回 false）
 * saveId 轮转编号，避免定时任务与手动指令并发渲染时写同名文件
 */
async function render(tplName, data) {
  renderSeq = (renderSeq + 1) % 20
  return await puppeteer.screenshot(`relay-checkin-plugin/${tplName}`, {
    tplFile: path.join(TPL_PATH, `${tplName}.html`),
    pluResPath: path.join(PLUGIN_PATH, 'resources') + path.sep,
    saveId: `${tplName}_${renderSeq}`,
    ...data
  })
}

/**
 * 渲染结果卡片（签到/查询/添加共用）
 * users: [{ nickname, userId, accounts: [{ name, status, statusText, award, balance, msg }] }]
 */
export async function renderResult({ title, subtitle = '', users }) {
  return await render('result', { title, subtitle, time: now(), users })
}

/**
 * 按每图最多 N 个用户分页渲染，返回图片数组（群合并转发用）
 * 6 个用户、N=5 时 → 2 张图
 */
export async function renderResultPages({ title, users }) {
  const per = Math.max(1, getConfig().push.usersPerImage || 5)
  const pages = []
  for (let i = 0; i < users.length; i += per) {
    pages.push(users.slice(i, i + per))
  }
  const images = []
  for (let i = 0; i < pages.length; i++) {
    const subtitle = pages.length > 1 ? `第 ${i + 1}/${pages.length} 页` : ''
    const img = await renderResult({ title, subtitle, users: pages[i] })
    if (img) images.push(img)
  }
  return images
}

/**
 * 渲染账号列表（余额/签到状态来自最近一次操作的缓存）
 */
export async function renderList({ nickname, userId, autoCheckin, accounts }) {
  const rows = accounts.map((acc, i) => {
    const checkedToday = isCheckedToday(acc.lastCheckinAt)
    const autoOn = acc.auto !== false
    return {
      index: i + 1,
      name: accountLabel(acc),
      baseUrl: acc.baseUrl,
      typeLabel: { newapi: 'new-api', veloera: 'Veloera', generic: 'Cookie', agentrouter: 'AgentRouter', anyrouter: 'AnyRouter' }[acc.type] || acc.type,
      tokenMasked: maskToken(acc.token),
      balance: acc.lastBalance || '-',
      checkinText: checkedToday ? '今日已签' : '今日未签',
      checkinClass: checkedToday ? 'on' : 'off',
      autoText: autoOn ? '定时开' : '定时关',
      autoClass: autoOn ? 'on' : 'off'
    }
  })
  return await render('list', {
    nickname,
    userId,
    autoText: autoCheckin ? '已开启' : '已关闭',
    time: now(),
    accounts: rows
  })
}

/**
 * lastCheckinAt 是否为今天（本地时区；仅统计经本插件签到/保活成功的记录）
 */
function isCheckedToday(iso) {
  if (!iso) return false
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return false
  const n = new Date()
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()
}

/**
 * 渲染帮助
 */
export async function renderHelp() {
  return await render('help', { time: now() })
}

function maskToken(token) {
  const t = String(token || '')
  if (t.length <= 8) return '****'
  return t.slice(0, 4) + '****' + t.slice(-4)
}
