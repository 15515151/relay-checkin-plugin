/**
 * 冒烟测试：mock Yunzai 全局环境，验证 store / config / adapters 纯逻辑与指令正则
 * 运行：node test/smoke.mjs（在插件根目录）
 */
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

// ---- mock Yunzai 全局 ----
global.logger = {
  info: () => {}, mark: () => {}, warn: () => {}, error: (...a) => console.error('[logger.error]', ...a)
}
global.Bot = { uin: 10000 }

// 用干净的 data 目录测试
const DATA = path.join(ROOT, 'data')
const hadData = fs.existsSync(DATA)
const backup = path.join(ROOT, 'data_backup_smoke')
if (hadData) fs.renameSync(DATA, backup)

try {
  // ---- config ----
  const { getConfig } = await import('../models/config.js')
  const cfg = getConfig()
  assert.equal(cfg.push.mode, 'group')
  assert.equal(cfg.push.usersPerImage, 5)
  assert.deepEqual(cfg.schedule.accountDelay, [5, 15])
  assert.ok(fs.existsSync(path.join(DATA, 'config.yaml')), 'config.yaml 应自动生成')
  console.log('config OK')

  // ---- adapters/common ----
  const { quotaToUsd, parseUserInfo, parseCheckinResult } = await import('../models/adapters/common.js')
  assert.equal(quotaToUsd(500000), '$1.00')
  assert.equal(quotaToUsd('250000'), '$0.50')
  assert.equal(quotaToUsd('abc'), null)
  assert.equal(quotaToUsd(null), null)  // Number(null)=0 → 应为 null 还是 $0.00？null 意为缺失
  const ui = parseUserInfo({ success: true, data: { id: 88, username: 'u', display_name: 'DN', quota: 1000000, used_quota: 500000 } })
  assert.equal(ui.ok, true)
  assert.equal(ui.siteUserId, 88)
  assert.equal(ui.balanceText, '$2.00')
  assert.equal(ui.usedText, '$1.00')
  assert.equal(parseUserInfo(null).ok, false)
  assert.equal(parseUserInfo({ success: false, message: 'x' }).msg, 'x')

  let r = parseCheckinResult(200, { success: true, message: '签到成功', data: { quota_awarded: 250000 } })
  assert.deepEqual([r.ok, r.already, r.awardQuota], [true, false, 250000])
  r = parseCheckinResult(200, { success: true, data: { quota: 100000 } })  // Veloera
  assert.equal(r.awardQuota, 100000)
  r = parseCheckinResult(200, { success: false, message: '今日已签到' })
  assert.deepEqual([r.ok, r.already], [true, true])
  r = parseCheckinResult(200, { success: false, message: 'Turnstile token 为空' })
  assert.match(r.msg, /Turnstile/)
  r = parseCheckinResult(404, null)
  assert.match(r.msg, /签到接口/)
  r = parseCheckinResult(302, null)
  assert.match(r.msg, /重定向/)
  r = parseCheckinResult(401, { success: false })
  assert.match(r.msg, /凭据/)
  console.log('adapters/common OK')

  // ---- adapters/index ----
  const { normalizeBaseUrl, cookieTypeForHost, getAdapter } = await import('../models/adapters/index.js')
  assert.equal(normalizeBaseUrl('xx.com/'), 'https://xx.com')
  assert.equal(normalizeBaseUrl('http://a.b//'), 'http://a.b')
  assert.equal(cookieTypeForHost('agentrouter.org'), 'agentrouter')
  assert.equal(cookieTypeForHost('xx.agentrouter.cn'), 'agentrouter')
  assert.equal(cookieTypeForHost('other.com'), 'generic')
  assert.equal(getAdapter('veloera').type, 'veloera')
  assert.equal(getAdapter('不存在').type, 'newapi')
  console.log('adapters/index OK')

  // ---- 各 adapter 请求头 ----
  const newapi = (await import('../models/adapters/newapi.js')).default
  let h = newapi.buildHeaders({ token: 'T', siteUserId: 5 })
  assert.equal(h.Authorization, 'Bearer T')
  assert.equal(h['New-Api-User'], '5')
  h = newapi.buildHeaders({ token: 'T' })
  assert.ok(!('New-Api-User' in h))
  const veloera = (await import('../models/adapters/veloera.js')).default
  h = veloera.buildHeaders({ token: 'T', siteUserId: 5 })
  assert.equal(h.Authorization, 'T')  // 不带 Bearer
  assert.equal(h['Veloera-User'], '5')
  const generic = (await import('../models/adapters/generic.js')).default
  h = generic.buildHeaders({ token: 'S', siteUserId: 5 })
  assert.equal(h.Cookie, 'session=S')
  const agentrouter = (await import('../models/adapters/agentrouter.js')).default
  h = agentrouter.buildHeaders({ token: 'S', siteUserId: 7 })
  assert.equal(h.Cookie, 'session=S')
  assert.equal(h['New-Api-User'], '7')
  console.log('adapter headers OK')

  // ---- store（仅用户隔离）----
  const store = await import('../models/store.js')
  const eGroup = { user_id: 111, group_id: 999, isGroup: true, self_id: 10000, sender: { nickname: 'N1', card: 'C1' } }
  const ePrivate = { user_id: 111, isGroup: false, self_id: 10000, sender: { nickname: 'N1' } }
  const eOtherGroup = { user_id: 111, group_id: 888, isGroup: true, self_id: 10000, sender: { nickname: 'N1' } }

  assert.equal(store.keyOf(eGroup), 'u:111')
  assert.equal(store.keyOf(ePrivate), 'u:111', '群/私聊应同键（仅用户隔离）')

  const en1 = store.ensureEntry(eGroup)
  assert.equal(en1.groupId, '999')
  assert.equal(en1.nickname, 'C1', '群名片优先')
  store.addAccount(eGroup, { name: 'a.com', baseUrl: 'https://a.com', type: 'newapi', token: 't1', siteUserId: 1, signPath: null })

  // 私聊可见同一账号；且私聊不清空 groupId
  const en2 = store.touchEntry(ePrivate)
  assert.equal(en2.accounts.length, 1, '私聊应共享群里添加的账号')
  assert.equal(en2.groupId, '999', '私聊使用不应清空最近群')

  // 换群后 groupId 跟随最近使用的群
  store.touchEntry(eOtherGroup)
  assert.equal(store.getEntry(ePrivate).groupId, '888')

  // 删除
  assert.equal(store.removeAccount(eGroup, 2), null)
  assert.equal(store.removeAccount(eGroup, 1).name, 'a.com')
  assert.equal(store.getEntry(eGroup).accounts.length, 0)

  // 定时开关 + allEntries
  store.setAuto(eGroup, false)
  assert.equal(store.getEntry(eGroup).autoCheckin, false)
  store.addAccount(eGroup, { name: 'b.com', baseUrl: 'https://b.com', type: 'veloera', token: 't2', siteUserId: 2, signPath: null })
  const all = store.allEntries()
  assert.equal(all.length, 1)
  assert.equal(all[0].key, 'u:111')

  // 持久化落盘验证
  const onDisk = JSON.parse(fs.readFileSync(path.join(DATA, 'accounts.json'), 'utf-8'))
  assert.ok(onDisk['u:111'])
  assert.equal(onDisk['u:111'].accounts[0].name, 'b.com')
  console.log('store OK')

  // ---- executor 纯逻辑（randInt 边界）----
  const { randInt } = await import('../models/executor.js')
  for (let i = 0; i < 200; i++) {
    const v = randInt(5, 15)
    assert.ok(v >= 5 && v <= 15)
  }
  console.log('executor.randInt OK')

  // ---- 指令正则（与 apps/checkin.js 保持一致）----
  const rules = {
    help: /^#中转(站)?(帮助|help)$/,
    addCookie: /^#中转添加[cC]ookie\s+(\S+)\s+(\S+)\s+(\S+)$/,
    add: /^#中转添加\s+(\S+)\s+(\S+)(?:\s+(\S+))?$/,
    list: /^#中转列表$/,
    remove: /^#中转删除\s*(\d+)$/,
    checkin: /^#中转签到\s*(\d+)?$/,
    query: /^#中转查询$/,
    toggle: /^#中转定时\s*(开|关)$/
  }
  assert.ok(rules.help.test('#中转帮助') && rules.help.test('#中转站help'))
  assert.ok(rules.add.test('#中转添加 https://x.com abc'))
  assert.ok(rules.add.test('#中转添加 x.com abc 123'))
  assert.ok(!rules.add.test('#中转添加cookie x.com s 1'), 'addCookie 消息不应命中 add 规则')
  assert.ok(rules.addCookie.test('#中转添加cookie x.com sess 1'))
  assert.ok(rules.addCookie.test('#中转添加Cookie x.com sess 1'))
  assert.ok(rules.checkin.test('#中转签到') && rules.checkin.test('#中转签到 2') && rules.checkin.test('#中转签到2'))
  assert.ok(rules.remove.test('#中转删除 1') && rules.remove.test('#中转删除3'))
  assert.ok(rules.toggle.test('#中转定时 开') && rules.toggle.test('#中转定时关'))
  console.log('指令正则 OK')

  console.log('\n全部冒烟测试通过 ✓')
} finally {
  // 还原 data 目录
  if (fs.existsSync(DATA)) fs.rmSync(DATA, { recursive: true, force: true })
  if (hadData) fs.renameSync(backup, DATA)
}

// config.js 的 chokidar watcher 会保持进程存活（生产为热更新所需），测试显式退出
process.exit(0)
