/**
 * 行为测试：mock fetch 验证适配器签到链路 + art-template 渲染模板
 * 运行：node test/behavior.mjs（在插件根目录，需 npm i --no-save yaml chokidar art-template）
 */
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

global.logger = { info: () => {}, mark: () => {}, warn: () => {}, error: (...a) => console.error('[logger.error]', ...a) }
global.Bot = { uin: 10000 }

const DATA = path.join(ROOT, 'data')
const hadData = fs.existsSync(DATA)
const backup = path.join(ROOT, 'data_backup_behavior')
if (hadData) fs.renameSync(DATA, backup)

// ---- mock fetch：按 (method, url) 路由 ----
let routes = {}
const realFetch = global.fetch
global.fetch = async (url, opts = {}) => {
  const key = `${opts.method || 'GET'} ${url}`
  const handler = routes[key]
  if (!handler) throw new Error(`mock fetch 未定义路由: ${key}`)
  const { status = 200, body = null, capture } = typeof handler === 'function' ? handler(opts) : handler
  if (capture) capture(opts)
  return {
    status,
    json: async () => {
      if (body === null) throw new Error('no json')
      return body
    }
  }
}

try {
  const agentrouter = (await import('../models/adapters/agentrouter.js')).default
  const { probeAccount } = await import('../models/adapters/index.js')
  const { checkinAccount } = await import('../models/executor.js')

  const AR = { name: 'agentrouter.org', baseUrl: 'https://agentrouter.org', type: 'agentrouter', token: 'S', siteUserId: 7 }

  // ---- 1. agentrouter：sign_in 存在时正常签到 ----
  routes = {
    'POST https://agentrouter.org/api/user/sign_in': { status: 200, body: { success: true, message: '签到成功', data: { quota_awarded: 500000 } } },
    'GET https://agentrouter.org/api/user/self': { status: 200, body: { success: true, data: { id: 7, username: 'u', quota: 5000000, used_quota: 0 } } }
  }
  let r = await agentrouter.checkin(AR)
  assert.deepEqual([r.ok, r.awardQuota], [true, 500000])

  // ---- 2. agentrouter：sign_in 404 时降级保活，携带余额 ----
  routes = {
    'POST https://agentrouter.org/api/user/sign_in': { status: 404, body: null },
    'GET https://agentrouter.org/api/user/self': { status: 200, body: { success: true, data: { id: 7, username: 'u', quota: 5000000, used_quota: 0 } } }
  }
  r = await agentrouter.checkin(AR)
  assert.equal(r.ok, true)
  assert.equal(r.statusTextOverride, '保活成功')
  assert.equal(r.balanceText, '$10.00')

  // executor 组合：降级路径不应再次请求 user/self（余额已携带）
  let selfCalls = 0
  routes = {
    'POST https://agentrouter.org/api/user/sign_in': { status: 404, body: null },
    'GET https://agentrouter.org/api/user/self': () => { selfCalls++; return { status: 200, body: { success: true, data: { id: 7, quota: 5000000, used_quota: 0 } } } }
  }
  const res = await checkinAccount(AR)
  assert.equal(res.status, 'ok')
  assert.equal(res.statusText, '保活成功')
  assert.equal(res.balance, '$10.00')
  assert.equal(selfCalls, 1, '降级保活后不应重复查询用户信息')

  // ---- 3. agentrouter：session 失效 ----
  routes = {
    'POST https://agentrouter.org/api/user/sign_in': { status: 404, body: null },
    'GET https://agentrouter.org/api/user/self': { status: 401, body: { success: false, message: '无权进行此操作，未登录且未提供 access token' } }
  }
  r = await agentrouter.checkin(AR)
  assert.equal(r.ok, false)

  // ---- 4. probeAccount：new-api 命中 ----
  let capturedAuth = ''
  routes = {
    'GET https://n.com/api/user/self': (opts) => {
      capturedAuth = opts.headers.Authorization
      return { status: 200, body: { success: true, data: { id: 3, username: 'n', quota: 1000000, used_quota: 0 } } }
    }
  }
  let probe = await probeAccount('https://n.com', 'TOK', null)
  assert.equal(probe.ok, true)
  assert.equal(probe.type, 'newapi')
  assert.equal(probe.info.siteUserId, 3, '应从探测结果取回站点用户ID')
  assert.equal(capturedAuth, 'Bearer TOK')

  // ---- 5. probeAccount：new-api 失败 → Veloera 命中（需 siteUserId）----
  let veloHeaders = null
  routes = {
    'GET https://v.com/api/user/self': (opts) => {
      if (opts.headers.Authorization.startsWith('Bearer ')) {
        return { status: 401, body: { success: false, message: '未登录' } }
      }
      veloHeaders = opts.headers
      return { status: 200, body: { success: true, data: { id: 9, username: 'v', quota: 2000000, used_quota: 0 } } }
    }
  }
  probe = await probeAccount('https://v.com', 'VTOK', '9')
  assert.equal(probe.ok, true)
  assert.equal(probe.type, 'veloera')
  assert.equal(veloHeaders.Authorization, 'VTOK', 'Veloera 不应带 Bearer 前缀')
  assert.equal(veloHeaders['Veloera-User'], '9')

  // 未提供 siteUserId 时应提示补充用户ID
  routes = {
    'GET https://v.com/api/user/self': { status: 401, body: { success: false, message: '未登录' } }
  }
  probe = await probeAccount('https://v.com', 'VTOK', null)
  assert.equal(probe.ok, false)
  assert.match(probe.msg, /用户ID/)

  // ---- 6. 网络错误重试后抛出，executor 兜底为失败结果 ----
  routes = {}
  const bad = await checkinAccount({ name: 'x.com', baseUrl: 'https://x.com', type: 'newapi', token: 't' })
  assert.equal(bad.status, 'fail')
  assert.ok(bad.msg.length > 0)
  console.log('适配器行为 OK')

  // ---- 7. art-template 渲染模板（与 TRSS-Yunzai 同引擎）----
  const art = (await import('art-template')).default
  const tplDir = path.join(ROOT, 'resources', 'template')
  const users = [
    { nickname: '用户A', userId: '111', accounts: [
      { name: 'a.com', status: 'ok', statusText: '签到成功', award: '+$0.50', balance: '$12.30', msg: '' },
      { name: 'b.com', status: 'fail', statusText: '签到失败', award: '', balance: '-', msg: '凭据无效或已过期 (HTTP 401)' }
    ] },
    { nickname: '用户B', userId: '222', accounts: [
      { name: 'agentrouter.org', status: 'ok', statusText: '保活成功', award: '', balance: '$25.00', msg: '' }
    ] }
  ]
  let html = art(path.join(tplDir, 'result.html'), { title: '中转站定时签到', subtitle: '第 1/2 页', time: '2026-08-03 08:10', users })
  assert.ok(html.includes('用户A') && html.includes('保活成功') && html.includes('第 1/2 页'))
  assert.ok(html.includes('badge ok') && html.includes('badge fail'))
  assert.ok(html.includes('凭据无效'))

  html = art(path.join(tplDir, 'result.html'), { title: '中转站签到', subtitle: '', time: 'T', users: [users[0]] })
  assert.ok(!html.includes('subtitle">'), '无副标题时不应输出 subtitle 节点')

  html = art(path.join(tplDir, 'list.html'), {
    nickname: 'N', userId: '111', autoText: '已开启', time: 'T',
    accounts: [{ index: 1, name: 'a.com', baseUrl: 'https://a.com', typeLabel: 'new-api', tokenMasked: 'abcd****wxyz' }]
  })
  assert.ok(html.includes('a.com') && html.includes('abcd****wxyz') && !html.includes('暂无账号'))
  html = art(path.join(tplDir, 'list.html'), { nickname: 'N', userId: '1', autoText: '已开启', time: 'T', accounts: [] })
  assert.ok(html.includes('暂无账号'))

  html = art(path.join(tplDir, 'help.html'), { time: 'T' })
  assert.ok(html.includes('#中转添加') && html.includes('#中转定时'))
  console.log('模板渲染 OK')

  console.log('\n全部行为测试通过 ✓')
} finally {
  global.fetch = realFetch
  if (fs.existsSync(DATA)) fs.rmSync(DATA, { recursive: true, force: true })
  if (hadData) fs.renameSync(backup, DATA)
}

// config.js 的 chokidar watcher 会保持进程存活（生产为热更新所需），测试显式退出
process.exit(0)
