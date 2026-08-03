import { getConfig } from '../models/config.js'
import { touchEntry, ensureEntry, addAccount, removeAccount, setAuto, persist } from '../models/store.js'
import { probeAccount, normalizeBaseUrl, getAdapter, cookieTypeForHost } from '../models/adapters/index.js'
import { checkinEntry, queryEntry } from '../models/executor.js'
import { renderResult, renderList, renderHelp } from '../models/render.js'
import { runScheduledCheckin } from '../models/scheduler.js'

export default class RelayCheckinApp extends plugin {
  constructor() {
    super({
      name: '中转站签到',
      dsc: '中转站（new-api/Veloera 系）自动签到',
      event: 'message',
      priority: 5000,
      rule: [
        { reg: '^#中转(站)?(帮助|help)$', fnc: 'help' },
        { reg: '^#中转添加[cC]ookie\\s+(\\S+)\\s+(\\S+)\\s+(\\S+)$', fnc: 'addCookie' },
        { reg: '^#中转添加\\s+(\\S+)\\s+(\\S+)(\\s+\\S+)?$', fnc: 'add' },
        { reg: '^#中转列表$', fnc: 'list' },
        { reg: '^#中转删除\\s*(\\d+)$', fnc: 'remove' },
        { reg: '^#中转签到\\s*(\\d+)?$', fnc: 'checkin' },
        { reg: '^#中转查询$', fnc: 'query' },
        { reg: '^#中转定时\\s*(开|关)$', fnc: 'toggleAuto' }
      ]
    })

    // 定时签到任务（cron 修改后需重启生效）
    this.task = [{
      name: '中转站定时签到',
      cron: getConfig().schedule.cron,
      fnc: () => runScheduledCheckin()
    }]
  }

  /**
   * 群里发含令牌的指令后尝试撤回，减少泄露
   */
  async recallIfGroup() {
    if (!this.e.isGroup || !getConfig().recallAdd) return
    try {
      await this.e.group.recallMsg(this.e.message_id)
    } catch {
      // 无管理员权限时撤回失败，忽略
    }
  }

  /**
   * 渲染失败时回退为文字
   */
  async replyImage(img, fallbackText) {
    if (img) {
      await this.reply(img)
    } else {
      await this.reply(fallbackText)
    }
  }

  async help() {
    const img = await renderHelp()
    await this.replyImage(img, '帮助图渲染失败，指令：#中转添加 地址 令牌 / #中转列表 / #中转删除 序号 / #中转签到 / #中转查询 / #中转定时 开|关')
    return true
  }

  /**
   * 解析并校验站点地址，非法时返回 null
   */
  parseSite(input) {
    try {
      const baseUrl = normalizeBaseUrl(input)
      const host = new URL(baseUrl).host
      if (!host) return null
      return { baseUrl, host }
    } catch {
      return null
    }
  }

  /**
   * #中转添加 地址 令牌 [站点用户ID]
   */
  async add() {
    const match = /^#中转添加\s+(\S+)\s+(\S+)(?:\s+(\S+))?$/.exec(this.e.msg)
    if (!match) return false
    await this.recallIfGroup()

    const site = this.parseSite(match[1])
    if (!site) {
      await this.reply('站点地址格式不正确，示例：#中转添加 https://xx.com 令牌')
      return true
    }
    const token = match[2]
    const siteUserId = match[3] || null

    await this.reply('正在验证账号，请稍候...')
    const probe = await probeAccount(site.baseUrl, token, siteUserId)
    if (!probe.ok) {
      await this.reply(`添加失败：${probe.msg}`)
      return true
    }

    await this.saveAccount({
      name: site.host,
      baseUrl: site.baseUrl,
      type: probe.type,
      token,
      siteUserId: siteUserId || probe.info.siteUserId || null,
      signPath: null
    }, probe.info)
    return true
  }

  /**
   * #中转添加cookie 地址 session值 站点用户ID
   */
  async addCookie() {
    const match = /^#中转添加[cC]ookie\s+(\S+)\s+(\S+)\s+(\S+)$/.exec(this.e.msg)
    if (!match) return false
    await this.recallIfGroup()

    const site = this.parseSite(match[1])
    if (!site) {
      await this.reply('站点地址格式不正确，示例：#中转添加cookie https://xx.com session值 用户ID')
      return true
    }
    const token = match[2].replace(/^session=/i, '')
    const siteUserId = match[3]
    const type = cookieTypeForHost(site.host)

    await this.reply('正在验证账号，请稍候...')
    const account = { name: site.host, baseUrl: site.baseUrl, type, token, siteUserId, signPath: null }
    let info
    try {
      info = await getAdapter(type).userInfo(account)
    } catch (err) {
      await this.reply(`添加失败：${err.message}`)
      return true
    }
    if (!info.ok) {
      await this.reply(`添加失败：${info.msg}（请检查 session 与用户ID）`)
      return true
    }

    await this.saveAccount(account, info)
    return true
  }

  /**
   * 保存账号（同地址已存在则更新凭据）并回复结果图
   */
  async saveAccount(account, info) {
    const entry = ensureEntry(this.e)
    const exist = entry.accounts.find(acc => acc.baseUrl === account.baseUrl)
    let statusText = '添加成功'
    if (exist) {
      Object.assign(exist, account)
      persist()
      statusText = '已更新凭据'
    } else {
      addAccount(this.e, account)
    }

    const img = await renderResult({
      title: '中转站账号',
      users: [{
        nickname: entry.nickname,
        userId: entry.userId,
        accounts: [{
          name: `${account.name}${info.username ? ` (${info.username})` : ''}`,
          status: 'ok',
          statusText,
          award: '',
          balance: info.balanceText,
          msg: ''
        }]
      }]
    })
    await this.replyImage(img, `${statusText}：${account.name}，当前余额 ${info.balanceText}`)
  }

  async list() {
    const entry = touchEntry(this.e)
    if (!entry || !entry.accounts.length) {
      await this.reply('你还没有添加账号，发送 #中转帮助 查看用法')
      return true
    }
    const img = await renderList(entry)
    await this.replyImage(img, '列表渲染失败，请查看日志')
    return true
  }

  async remove() {
    const index = Number(/(\d+)/.exec(this.e.msg)[1])
    const removed = removeAccount(this.e, index)
    if (!removed) {
      await this.reply(`删除失败：序号 ${index} 不存在，发送 #中转列表 查看`)
    } else {
      await this.reply(`已删除账号 [${index}] ${removed.name}`)
    }
    return true
  }

  async checkin() {
    const entry = touchEntry(this.e)
    if (!entry || !entry.accounts.length) {
      await this.reply('你还没有添加账号，发送 #中转帮助 查看用法')
      return true
    }

    const indexMatch = /^#中转签到\s*(\d+)$/.exec(this.e.msg)
    const index = indexMatch ? Number(indexMatch[1]) : null
    if (index !== null && (index < 1 || index > entry.accounts.length)) {
      await this.reply(`序号 ${index} 不存在，发送 #中转列表 查看`)
      return true
    }

    await this.reply('正在签到，请稍候...')
    const results = await checkinEntry(entry, { index })
    const img = await renderResult({
      title: '中转站签到',
      users: [{ nickname: entry.nickname, userId: entry.userId, accounts: results }]
    })
    await this.replyImage(img, results.map(r => `${r.name}: ${r.statusText}${r.msg ? ` (${r.msg})` : ''}`).join('\n'))
    return true
  }

  async query() {
    const entry = touchEntry(this.e)
    if (!entry || !entry.accounts.length) {
      await this.reply('你还没有添加账号，发送 #中转帮助 查看用法')
      return true
    }

    await this.reply('正在查询，请稍候...')
    const results = await queryEntry(entry)
    const img = await renderResult({
      title: '中转站余额查询',
      users: [{ nickname: entry.nickname, userId: entry.userId, accounts: results }]
    })
    await this.replyImage(img, results.map(r => `${r.name}: 余额 ${r.balance}`).join('\n'))
    return true
  }

  async toggleAuto() {
    const enable = this.e.msg.includes('开')
    setAuto(this.e, enable)
    await this.reply(`定时签到已${enable ? '开启' : '关闭'}（每日自动执行，结果按配置推送）`)
    return true
  }
}
