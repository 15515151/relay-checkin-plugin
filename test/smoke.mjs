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

// 预置一份"旧版本"残缺配置：验证升级后新增项自动补齐、用户已改的值保留
fs.mkdirSync(DATA, { recursive: true })
fs.writeFileSync(path.join(DATA, 'config.yaml'), 'schedule:\n  cron: "0 0 9 * * *"\npush:\n  mode: private\n')

try {
  // ---- config ----
  const { getConfig } = await import('../models/config.js')
  const cfg = getConfig()
  assert.equal(cfg.schedule.cron, '0 0 9 * * *', '用户已改的值应保留')
  assert.equal(cfg.push.mode, 'private', '用户已改的值应保留')
  assert.equal(cfg.push.usersPerImage, 5)
  assert.deepEqual(cfg.schedule.accountDelay, [5, 15])
  assert.equal(cfg.browser.enable, true)
  assert.equal(cfg.browser.wafTimeoutSec, 25)
  assert.equal(cfg.bind.timeoutSec, 300)
  assert.equal(cfg.bind.groupRecallSec, 60)
  assert.equal(cfg.proxy.url, '')
  assert.deepEqual(cfg.proxy.hosts, ['anyrouter'])
  const cfgText = fs.readFileSync(path.join(DATA, 'config.yaml'), 'utf-8')
  assert.ok(cfgText.includes('proxy:') && cfgText.includes('groupRecallSec'), '新增配置项应写回配置文件')
  assert.ok(cfgText.includes('0 0 9 * * *') && cfgText.includes('mode: private'), '写回后用户值应保留')
  assert.ok(cfgText.includes('# 代理设置'), '模板注释应保留')
  console.log('config OK')

  // ---- adapters/common ----
  const { quotaToUsd, parseUserInfo, parseCheckinResult, matchProxy } = await import('../models/adapters/common.js')
  // 代理域名匹配：hosts 关键字包含匹配；空数组 = 全部走代理；未配置 url = 不走
  const P = 'http://127.0.0.1:7890'
  assert.equal(matchProxy('anyrouter.top', { url: P, hosts: ['anyrouter'] }), P)
  assert.equal(matchProxy('agentrouter.org', { url: P, hosts: ['anyrouter'] }), null)
  assert.equal(matchProxy('agentrouter.org', { url: P, hosts: [] }), P, '空 hosts 应全部走代理')
  assert.equal(matchProxy('anyrouter.top', { url: '', hosts: ['anyrouter'] }), null, '未配置代理地址不走代理')
  assert.equal(matchProxy('anyrouter.top', null), null)
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
  assert.equal(cookieTypeForHost('ps.air-outer.com'), 'agentrouter', 'air-outer.com 系域名应识别为 AgentRouter')
  assert.equal(cookieTypeForHost('anyrouter.top'), 'anyrouter')
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
  const anyrouter = (await import('../models/adapters/anyrouter.js')).default
  h = anyrouter.buildHeaders({ token: 'S', siteUserId: 8 })
  assert.equal(h.Cookie, 'session=S')
  assert.equal(h['New-Api-User'], '8')
  // Turnstile 降级依赖各令牌型适配器声明签到路径
  const newapiMod = (await import('../models/adapters/newapi.js')).default
  const veloeraMod = (await import('../models/adapters/veloera.js')).default
  assert.equal(newapiMod.checkinPath, '/api/user/checkin')
  assert.equal(veloeraMod.checkinPath, '/api/user/check_in')
  console.log('adapter headers OK')

  // ---- store（仅用户隔离 + 同站多账号）----
  const store = await import('../models/store.js')
  const eGroup = { user_id: 111, group_id: 999, isGroup: true, self_id: 10000, sender: { nickname: 'N1', card: 'C1' } }
  const ePrivate = { user_id: 111, isGroup: false, self_id: 10000, sender: { nickname: 'N1' } }
  const eOtherGroup = { user_id: 111, group_id: 888, isGroup: true, self_id: 10000, sender: { nickname: 'N1' } }

  assert.equal(store.keyOf(eGroup), 'u:111')
  assert.equal(store.keyOf(ePrivate), 'u:111', '群/私聊应同键（仅用户隔离）')

  const en1 = store.ensureEntry(eGroup)
  assert.equal(en1.groupId, '999')
  assert.equal(en1.nickname, 'C1', '群名片优先')

  const acc = (over = {}) => ({
    name: 'a.com', baseUrl: 'https://a.com', type: 'agentrouter', token: 't1',
    siteUserId: 1, signPath: null, auto: true, username: 'u1', ...over
  })
  let up = store.upsertAccount(eGroup, acc())
  assert.deepEqual([up.index, up.updated], [1, false])

  // 同站点不同站点用户ID → 追加为新账号（同站多账号）
  up = store.upsertAccount(eGroup, acc({ siteUserId: 2, token: 't2', username: 'u2' }))
  assert.deepEqual([up.index, up.updated], [2, false])
  assert.equal(store.getEntry(eGroup).accounts.length, 2)

  // 同站点同站点用户ID → 更新凭据，且保留单账号定时开关偏好
  store.setAccountAuto(eGroup, 1, false)
  up = store.upsertAccount(eGroup, acc({ token: 't1-new' }))
  assert.deepEqual([up.index, up.updated], [1, true])
  assert.equal(up.account, store.getEntry(eGroup).accounts[0], '应返回入库后的对象引用（供添加后签到直接落缓存）')
  let entryNow = store.getEntry(eGroup)
  assert.equal(entryNow.accounts.length, 2)
  assert.equal(entryNow.accounts[0].token, 't1-new')
  assert.equal(entryNow.accounts[0].auto, false, '更新凭据不应重置单账号定时开关')

  // 无 siteUserId 时按 token 匹配
  up = store.upsertAccount(eGroup, acc({ name: 'b.com', baseUrl: 'https://b.com', siteUserId: null, token: 'bt' }))
  assert.equal(up.updated, false)
  up = store.upsertAccount(eGroup, acc({ name: 'b.com', baseUrl: 'https://b.com', siteUserId: null, token: 'bt' }))
  assert.deepEqual([up.index, up.updated], [3, true])

  // accountLabel / setAccountAuto 边界
  assert.equal(store.accountLabel({ name: 'x.com', username: 'U' }), 'x.com (U)')
  assert.equal(store.accountLabel({ name: 'x.com' }), 'x.com')
  assert.equal(store.setAccountAuto(eGroup, 99, false), null)

  // 私聊可见同一批账号；且私聊不清空 groupId
  const en2 = store.touchEntry(ePrivate)
  assert.equal(en2.accounts.length, 3, '私聊应共享群里添加的账号')
  assert.equal(en2.groupId, '999', '私聊使用不应清空最近群')

  // 换群后 groupId 跟随最近使用的群
  store.touchEntry(eOtherGroup)
  assert.equal(store.getEntry(ePrivate).groupId, '888')

  // 删除（仅操作本用户数据）
  assert.equal(store.removeAccount(eGroup, 9), null)
  assert.equal(store.removeAccount(eGroup, 3).name, 'b.com')
  assert.equal(store.getEntry(eGroup).accounts.length, 2)

  // 定时总开关 + allEntries
  store.setAuto(eGroup, false)
  assert.equal(store.getEntry(eGroup).autoCheckin, false)
  const all = store.allEntries()
  assert.equal(all.length, 1)
  assert.equal(all[0].key, 'u:111')

  // 定时推送白名单
  assert.equal(store.isPushGroup('999'), false)
  assert.equal(store.setPushGroup('999', true), true)
  assert.equal(store.setPushGroup('999', true), false, '重复开启应返回未变化')
  assert.equal(store.isPushGroup(999), true, '数字/字符串群号应等价')
  assert.equal(store.setPushGroup('999', false), true)
  assert.equal(store.isPushGroup('999'), false)
  store.setPushGroup('888', true)
  assert.ok(fs.existsSync(path.join(DATA, 'push_groups.json')), '白名单应落盘')
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(DATA, 'push_groups.json'), 'utf-8')), ['888'])

  // 持久化落盘验证
  const onDisk = JSON.parse(fs.readFileSync(path.join(DATA, 'accounts.json'), 'utf-8'))
  assert.ok(onDisk['u:111'])
  assert.equal(onDisk['u:111'].accounts[0].token, 't1-new')
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
    addCookie: /^#中转添加[cC]ookie\s+\S+(?:\s+\S+)*$/,
    add: /^#中转添加\s+\S+(?:\s+\S+)*$/,
    list: /^#中转列表$/,
    remove: /^#中转删除\s*(\d+)$/,
    checkin: /^#中转签到\s*(\d+)?$/,
    query: /^#中转查询$/,
    toggle: /^#中转定时\s*(开|关)\s*(\d+)?$/,
    pushToggle: /^#中转(开启|关闭)(定时(签到)?)?群推送$/,
    bindPrefixed: /^[#＃/\\]?\s*中转绑定/,
    bind: /^[\s\S]+$/
  }
  assert.ok(rules.help.test('#中转帮助') && rules.help.test('#中转站help'))
  assert.ok(rules.add.test('#中转添加 https://x.com abc'))
  assert.ok(rules.add.test('#中转添加 x.com abc 123'))
  assert.ok(rules.add.test('#中转添加 x.com'), '仅地址应命中（发起私聊绑定流程）')
  assert.ok(rules.add.test('#中转添加 x.com abc 123 多余参数'), '参数过多也应命中，以便撤回并提示')
  assert.ok(!rules.add.test('#中转添加cookie x.com s 1'), 'addCookie 消息不应命中 add 规则')
  assert.ok(rules.addCookie.test('#中转添加cookie x.com sess 1'))
  assert.ok(rules.addCookie.test('#中转添加Cookie x.com sess 1'))
  assert.ok(rules.addCookie.test('#中转添加cookie x.com'), '仅地址应命中（发起私聊绑定流程）')
  assert.ok(rules.addCookie.test('#中转添加cookie x.com sess'), '缺用户ID也应命中，由处理器提示补全')
  assert.ok(rules.addCookie.test('#中转添加cookie x.com sess 1 多余'), '参数过多也应命中，以便撤回并提示')
  assert.ok(rules.checkin.test('#中转签到') && rules.checkin.test('#中转签到 2') && rules.checkin.test('#中转签到2'))
  assert.ok(rules.remove.test('#中转删除 1') && rules.remove.test('#中转删除3'))
  assert.ok(rules.toggle.test('#中转定时 开') && rules.toggle.test('#中转定时关'))
  assert.ok(rules.toggle.test('#中转定时 关 2') && rules.toggle.test('#中转定时开1'), '带序号的单账号定时开关应命中')
  assert.ok(rules.pushToggle.test('#中转开启群推送') && rules.pushToggle.test('#中转关闭群推送'))
  assert.ok(rules.pushToggle.test('#中转开启定时签到群推送'), '长格式应兼容')
  assert.ok(!rules.pushToggle.test('#中转群推送'), '无开启/关闭动词不应命中')
  assert.ok(rules.bind.test('sess-value 12345'), '兜底规则应命中普通私聊消息')
  assert.ok(rules.bind.test('/xgyToken+abc= 250'), '/ 开头的凭据也应命中（核心会归一化首字符，处理器按原文解析）')
  assert.ok(rules.bind.test('#中转列表'), '兜底规则命中指令没关系，处理器按原文首字符放行')
  assert.ok(rules.bindPrefixed.test('中转绑定 tok') && rules.bindPrefixed.test('#中转绑定 tok'), 'disableAdopt 放行用的前缀格式应命中')
  assert.ok(rules.bindPrefixed.test('/中转绑定 tok'), '/ 被归一化前的原文也应识别为前缀格式')
  console.log('指令正则 OK')

  console.log('\n全部冒烟测试通过 ✓')
} finally {
  // 还原 data 目录
  if (fs.existsSync(DATA)) fs.rmSync(DATA, { recursive: true, force: true })
  if (hadData) fs.renameSync(backup, DATA)
}

// config.js 的 chokidar watcher 会保持进程存活（生产为热更新所需），测试显式退出
process.exit(0)
