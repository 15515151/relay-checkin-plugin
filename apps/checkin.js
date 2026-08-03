import { getConfig } from '../models/config.js'
import { touchEntry, upsertAccount, removeAccount, setAuto, setAccountAuto, accountLabel, persist } from '../models/store.js'
import { probeAccount, normalizeBaseUrl, getAdapter, cookieTypeForHost } from '../models/adapters/index.js'
import { checkinEntry, queryEntry } from '../models/executor.js'
import { renderResult, renderList, renderHelp } from '../models/render.js'
import { runScheduledCheckin } from '../models/scheduler.js'

/**
 * 等待私聊补发凭据的绑定会话（key: QQ号字符串）
 * { kind: 'token'|'cookie', baseUrl, host, userId, selfId, groupId, messageId, timer }
 * groupId/messageId 记录发起流程的群与指令消息，绑定结束后引用该消息回执结果
 */
const pendingBinds = new Map()

function clearPending(userId) {
  const pending = pendingBinds.get(String(userId))
  if (pending) {
    clearTimeout(pending.timer)
    pendingBinds.delete(String(userId))
  }
  return pending
}

/**
 * 绑定结果回执到发起流程的群（引用原指令消息，只含非敏感信息）
 */
async function notifyBindGroup(pending, text) {
  if (!pending?.groupId) return
  try {
    const bot = Bot[pending.selfId] ?? Bot
    await bot.pickGroup(Number(pending.groupId) || pending.groupId).sendMsg([
      segment.reply(pending.messageId),
      segment.at(Number(pending.userId) || pending.userId),
      ' ' + text
    ])
  } catch (err) {
    logger.error(`[relay-checkin-plugin] 群 ${pending.groupId} 绑定回执失败: ${err?.message || err}`)
  }
}

async function notifyBindPrivate(pending, text) {
  try {
    const bot = Bot[pending.selfId] ?? Bot
    await bot.pickFriend(Number(pending.userId) || pending.userId).sendMsg(text)
  } catch {
    // 非好友等场景私聊发不出去，忽略（群回执兜底）
  }
}

/**
 * TRSS 的 disablePrivate 是 priority -Infinity 的系统插件：开启后非主人的私聊消息
 * 在进入本插件前即被拦截，仅放行含 disableAdopt「通行字符串」的消息（主人不受限）。
 * 返回 null = 私聊不受限；{ passable } = 「中转绑定 凭据」能否靠通行字符串放行
 */
async function getPrivateBlock(e) {
  if (e.isMaster) return null
  let other
  try {
    other = (await import('../../../lib/config/config.js')).default?.other
  } catch {
    return null // 非 Yunzai 环境（如独立测试）无此配置
  }
  if (!other?.disablePrivate) return null
  const adopt = (Array.isArray(other.disableAdopt) ? other.disableAdopt : [])
    .filter(s => s != null && s !== '')
  return { passable: adopt.some(s => '中转绑定'.includes(String(s))) }
}

export default class RelayCheckinApp extends plugin {
  constructor() {
    super({
      name: '中转站签到',
      dsc: '中转站（new-api/Veloera 系）自动签到',
      event: 'message',
      priority: 5000,
      rule: [
        { reg: '^#中转(站)?(帮助|help)$', fnc: 'help' },
        { reg: '^#中转添加[cC]ookie\\s+\\S+(?:\\s+\\S+)*$', fnc: 'addCookie' },
        { reg: '^#中转添加\\s+\\S+(?:\\s+\\S+)*$', fnc: 'add' },
        { reg: '^#中转列表$', fnc: 'list' },
        { reg: '^#中转删除\\s*(\\d+)$', fnc: 'remove' },
        { reg: '^#中转签到\\s*(\\d+)?$', fnc: 'checkin' },
        { reg: '^#中转查询$', fnc: 'query' },
        { reg: '^#中转定时\\s*(开|关)\\s*(\\d+)?$', fnc: 'toggleAuto' },
        // 私聊补发凭据：带「中转绑定」前缀（配合 disableAdopt 放行）或任意非指令消息
        { reg: '^#?中转绑定', fnc: 'bindCredentials', log: false },
        { reg: '^[^#][\\s\\S]*$', fnc: 'bindCredentials', log: false }
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
    await this.replyImage(img, '帮助图渲染失败，指令：#中转添加 地址 / #中转列表 / #中转删除 序号 / #中转签到 / #中转查询 / #中转定时 开|关 [序号]')
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
   * 令牌方式校验：探测站点类型并取用户信息
   * @returns {Promise<{ok, msg?, account?, info?}>}
   */
  async verifyToken(site, token, siteUserId) {
    const probe = await probeAccount(site.baseUrl, token, siteUserId)
    if (!probe.ok) return { ok: false, msg: probe.msg }
    return {
      ok: true,
      info: probe.info,
      account: {
        name: site.host,
        baseUrl: site.baseUrl,
        type: probe.type,
        token,
        siteUserId: siteUserId || probe.info.siteUserId || null,
        signPath: null,
        auto: true
      }
    }
  }

  /**
   * Cookie 方式校验：按域名选适配器并取用户信息
   * @returns {Promise<{ok, msg?, account?, info?}>}
   */
  async verifyCookie(site, rawSession, siteUserId) {
    const token = String(rawSession).replace(/^session=/i, '')
    const type = cookieTypeForHost(site.host)
    const account = { name: site.host, baseUrl: site.baseUrl, type, token, siteUserId, signPath: null, auto: true }
    try {
      const info = await getAdapter(type).userInfo(account)
      if (!info.ok) return { ok: false, msg: `${info.msg}（请检查 session 与用户ID）` }
      return { ok: true, account, info }
    } catch (err) {
      return { ok: false, msg: err.message }
    }
  }

  /**
   * 发起绑定会话：记录站点，等用户私聊补发凭据；超时自动取消并回执。
   * 机器人开启 disablePrivate 时：disableAdopt 放行了「中转绑定」则引导用户用
   * 「中转绑定 凭据」格式私聊发送，否则提示替代方案且不登记会话
   */
  async startBind(kind, site) {
    const fullCmd = kind === 'cookie'
      ? `#中转添加cookie ${site.host} session值 用户ID`
      : `#中转添加 ${site.host} 令牌`
    const block = await getPrivateBlock(this.e)
    if (block && !block.passable) {
      if (this.e.isGroup) {
        const recallTip = getConfig().recallAdd ? '（机器人会尝试撤回）' : '（注意令牌会暴露在群里，建议发后自行撤回）'
        await this.reply(
          '机器人已开启私聊禁用（disablePrivate），私聊补发凭据会被拦截，本次未发起绑定。可任选：\n' +
          '1) 请主人在 config/config/other.yaml 的 disableAdopt 中加入 中转 ，之后重新发起，私聊发送：中转绑定 凭据\n' +
          `2) 直接在本群发送完整指令${recallTip}：${fullCmd}`,
          true
        )
      } else {
        // 本条私聊指令能到达说明完整指令格式可被放行，单发的裸凭据则会被拦截
        await this.reply(
          '机器人已开启私聊禁用（disablePrivate），后续单发的凭据会被拦截，本次未发起绑定。' +
          `请直接发送完整指令：${fullCmd}，或请主人在 disableAdopt 中加入 中转 后改发：中转绑定 凭据`
        )
      }
      return
    }

    const key = String(this.e.user_id)
    clearPending(key)

    const timeoutSec = getConfig().bind.timeoutSec || 300
    const pending = {
      kind,
      baseUrl: site.baseUrl,
      host: site.host,
      userId: key,
      selfId: String(this.e.self_id ?? Bot.uin),
      groupId: this.e.isGroup ? String(this.e.group_id) : null,
      messageId: this.e.message_id,
      timer: null
    }
    pending.timer = setTimeout(async () => {
      pendingBinds.delete(key)
      await notifyBindPrivate(pending, `中转站 ${pending.host} 绑定超时，已取消，可重新发送添加指令`)
      await notifyBindGroup(pending, `中转站 ${pending.host} 绑定超时，已取消`)
    }, timeoutSec * 1000)
    pendingBinds.set(key, pending)

    const need = kind === 'cookie'
      ? 'session值 用户ID（空格分隔）'
      : '访问令牌（Veloera 站点需再加 空格+站点用户ID）'
    // disablePrivate 开启但「中转绑定」被放行时，凭据必须带该前缀才能通过拦截
    const sendAs = block ? `中转绑定 ${need}` : need
    const mins = Math.max(1, Math.round(timeoutSec / 60))
    if (this.e.isGroup) {
      await this.reply(`已记录站点 ${pending.host}，请在 ${mins} 分钟内私聊我直接发送：${sendAs}。敏感信息不要发在群里，结果会回到本群提示`, true)
    } else {
      await this.reply(`已记录站点 ${pending.host}，请在 ${mins} 分钟内直接发送：${sendAs}`)
    }
  }

  /**
   * #中转添加 地址            → 发起绑定，私聊补发令牌（推荐群内用法）
   * #中转添加 地址 令牌 [用户ID] → 直接添加（建议私聊使用）
   * 规则放宽到任意段数：参数过多时也能撤回消息并提示，避免令牌静默留在群里
   */
  async add() {
    const args = String(this.e.msg).trim().split(/\s+/).slice(1)
    const site = this.parseSite(args[0])

    if (args.length === 1) {
      if (!site) {
        await this.reply('站点地址格式不正确，示例：#中转添加 https://xx.com')
        return true
      }
      await this.startBind('token', site)
      return true
    }

    await this.recallIfGroup()
    if (!site) {
      await this.reply('站点地址格式不正确，示例：#中转添加 https://xx.com 令牌')
      return true
    }
    if (args.length > 3) {
      await this.reply('参数过多：#中转添加 地址 令牌 [站点用户ID]（令牌中不能含空格）')
      return true
    }

    await this.reply('正在验证账号，请稍候...')
    const r = await this.verifyToken(site, args[1], args[2] || null)
    if (!r.ok) {
      await this.reply(`添加失败：${r.msg}`)
      return true
    }
    await this.saveAccount(r.account, r.info)
    return true
  }

  /**
   * #中转添加cookie 地址                  → 发起绑定，私聊补发 session 与用户ID
   * #中转添加cookie 地址 session值 用户ID → 直接添加（建议私聊使用）
   */
  async addCookie() {
    const args = String(this.e.msg).trim().split(/\s+/).slice(1)
    const site = this.parseSite(args[0])

    if (args.length === 1) {
      if (!site) {
        await this.reply('站点地址格式不正确，示例：#中转添加cookie https://xx.com')
        return true
      }
      await this.startBind('cookie', site)
      return true
    }

    await this.recallIfGroup()
    if (!site) {
      await this.reply('站点地址格式不正确，示例：#中转添加cookie https://xx.com session值 用户ID')
      return true
    }
    if (args.length !== 3) {
      await this.reply(args.length === 2
        ? '缺少站点用户ID，格式：#中转添加cookie 地址 session值 用户ID（或只发地址走私聊绑定）'
        : '参数过多：#中转添加cookie 地址 session值 用户ID（session 中不能含空格）')
      return true
    }

    await this.reply('正在验证账号，请稍候...')
    const r = await this.verifyCookie(site, args[1], args[2])
    if (!r.ok) {
      await this.reply(`添加失败：${r.msg}`)
      return true
    }
    await this.saveAccount(r.account, r.info)
    return true
  }

  /**
   * 私聊补发凭据：命中绑定会话时完成校验入库，并回执到发起的群。
   * 支持「中转绑定 凭据」前缀格式（配合 disablePrivate 的 disableAdopt 通行字符串放行）
   */
  async bindCredentials() {
    const raw = String(this.e.msg || '').trim()
    const prefixed = /^#?中转绑定/.test(raw)

    if (this.e.isGroup) {
      // 带前缀说明是误发到群的凭据：尽量撤回并提醒；普通群聊消息放行
      if (prefixed) {
        await this.recallIfGroup()
        await this.reply('凭据请私聊我发送，不要发在群里')
        return true
      }
      return false
    }

    const key = String(this.e.user_id)
    const pending = pendingBinds.get(key)
    if (!pending) {
      if (prefixed) {
        await this.reply('当前没有等待绑定的站点，请先发送：#中转添加 地址（或 #中转添加cookie 地址）')
        return true
      }
      return false
    }

    const parts = raw.replace(/^#?中转绑定\s*/, '').split(/\s+/).filter(Boolean)
    if (!parts.length) {
      if (prefixed) {
        await this.reply('请在 中转绑定 后附上凭据，例如：中转绑定 令牌')
        return true
      }
      return false
    }
    if (pending.kind === 'cookie' && parts.length < 2) {
      // 用户走「中转绑定」前缀（disablePrivate 放行）时，重发也必须带前缀才不被拦截
      const fmt = prefixed ? '中转绑定 session值 用户ID' : 'session值 用户ID'
      await this.reply(`还缺站点用户ID，请一次性发送：${fmt}（空格分隔）`)
      return true
    }

    // 进入验证即消费会话，避免验证期间超时重复回执
    clearPending(key)
    const site = { baseUrl: pending.baseUrl, host: pending.host }

    await this.reply('正在验证账号，请稍候...')
    const r = pending.kind === 'cookie'
      ? await this.verifyCookie(site, parts[0], parts[1])
      : await this.verifyToken(site, parts[0], parts[1] || null)

    if (!r.ok) {
      await this.reply(`绑定失败：${r.msg}\n可重新发送添加指令再试`)
      await notifyBindGroup(pending, `中转站 ${pending.host} 绑定失败：${r.msg}`)
      return true
    }

    const { entry, statusText } = await this.saveAccount(r.account, r.info)
    // 群里发起的绑定：定时推送目标记为该群
    if (pending.groupId) {
      entry.groupId = pending.groupId
      persist()
    }
    await notifyBindGroup(pending, `中转站 ${accountLabel(r.account)} ${statusText}，余额 ${r.info.balanceText}`)
    return true
  }

  /**
   * 保存账号（同站点同站点用户ID才更新凭据，否则新增）并回复结果图
   */
  async saveAccount(account, info) {
    account.username = info.username || ''
    account.lastBalance = info.balanceText || '-'
    const { entry, updated } = upsertAccount(this.e, account)
    const statusText = updated ? '已更新凭据' : '添加成功'

    const img = await renderResult({
      title: '中转站账号',
      users: [{
        nickname: entry.nickname,
        userId: entry.userId,
        accounts: [{
          name: accountLabel(account),
          status: 'ok',
          statusText,
          award: '',
          balance: info.balanceText,
          msg: ''
        }]
      }]
    })
    await this.replyImage(img, `${statusText}：${accountLabel(account)}，当前余额 ${info.balanceText}`)
    return { entry, statusText }
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
      await this.reply(`已删除账号 [${index}] ${accountLabel(removed)}`)
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

  /**
   * #中转定时 开/关       → 本人定时签到总开关
   * #中转定时 开/关 序号  → 单个账号的定时开关（默认开）
   */
  async toggleAuto() {
    const match = /^#中转定时\s*(开|关)\s*(\d+)?$/.exec(this.e.msg)
    if (!match) return false
    const enable = match[1] === '开'
    const index = match[2] ? Number(match[2]) : null

    if (index !== null) {
      const acc = setAccountAuto(this.e, index, enable)
      if (!acc) {
        await this.reply(`序号 ${index} 不存在，发送 #中转列表 查看`)
      } else {
        await this.reply(`已${enable ? '开启' : '关闭'} [${index}] ${accountLabel(acc)} 的定时签到`)
      }
      return true
    }

    setAuto(this.e, enable)
    await this.reply(`定时签到总开关已${enable ? '开启' : '关闭'}（可用 #中转定时 开/关 序号 单独控制某个账号）`)
    return true
  }
}
