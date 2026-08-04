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
  const { status = 200, body = null, capture, setCookies = [] } = typeof handler === 'function' ? handler(opts) : handler
  if (capture) capture(opts)
  return {
    status,
    json: async () => {
      if (body === null) throw new Error('no json')
      return body
    },
    headers: {
      get: name => String(name).toLowerCase() === 'set-cookie' ? (setCookies[0] || null) : null,
      getSetCookie: () => setCookies
    }
  }
}

try {
  // 行为测试使用 mock fetch，不应依赖测试域名的真实 DNS；显式信任这些测试目标。
  const cfgMod = await import('../models/config.js')
  const cfgNow = cfgMod.getConfig()
  cfgNow.security.allowedPrivateHosts = [
    'agentrouter.org', 'newapi.test', 'n.com', 'v.com', 'x.com', 't.com', 'anyrouter.top'
  ]
  const agentrouter = (await import('../models/adapters/agentrouter.js')).default
  const { probeAccount } = await import('../models/adapters/index.js')
  const { checkinAccount, checkinEntry, refreshBalances } = await import('../models/executor.js')
  const { request } = await import('../models/adapters/common.js')
  const now = new Date()
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const today = `${month}-${String(now.getDate()).padStart(2, '0')}`

  const AR = { name: 'agentrouter.org', baseUrl: 'https://agentrouter.org', type: 'agentrouter', token: 'S', siteUserId: 7 }
  const EMAIL_AR = {
    ...AR,
    authMode: 'email',
    loginEmail: 'user@example.com',
    password: 'agentrouter-site-password'
  }

  // ---- 1. AgentRouter：邮箱 + 站内密码重新登录，更新 Session 并确认 $25 ----
  let loginCalls = 0
  let loginBody = null
  let loginCookieHeader = null
  routes = {
    'POST https://agentrouter.org/api/user/login?turnstile=': opts => {
      loginCalls++
      loginBody = JSON.parse(opts.body)
      loginCookieHeader = opts.headers.Cookie
      return {
        status: 200,
        body: { success: true, data: { id: 7, username: 'u', checked_in: true, quota: 17500000, used_quota: 0 } },
        setCookies: ['session=NEW_SESSION; Path=/; HttpOnly']
      }
    },
    'GET https://agentrouter.org/api/status': {
      status: 200,
      body: {
        success: true,
        data: { quota_per_unit: 500000, announcements: [{ content: '支持登录签到；签到送 $25 Credit' }] }
      }
    }
  }
  let emailAccount = { ...EMAIL_AR }
  let r = await agentrouter.checkin(emailAccount)
  assert.deepEqual([r.ok, r.already, r.awardQuota], [true, false, 12500000])
  assert.deepEqual(loginBody, { username: 'user@example.com', password: 'agentrouter-site-password' })
  assert.equal(loginCookieHeader, undefined, '重新登录请求不得携带旧 Session')
  assert.equal(emailAccount.token, 'NEW_SESSION', '应保存登录响应的新 Session')
  assert.equal(loginCalls, 1, '登录 POST 必须只发送一次')

  // executor 组合：签到前后余额复核，结果明确显示本次 +$25.00。
  let selfCalls = 0
  routes['GET https://agentrouter.org/api/user/self'] = () => {
    selfCalls++
    return { status: 200, body: { success: true, data: { id: 7, quota: 5000000, used_quota: 0 } } }
  }
  emailAccount = { ...EMAIL_AR }
  const emailResult = await checkinAccount(emailAccount)
  assert.equal(emailResult.status, 'ok')
  assert.equal(emailResult.statusText, '邮箱登录签到成功')
  assert.equal(emailResult.award, '+$25.00')
  assert.equal(emailResult.balance, '$35.00')
  assert.equal(selfCalls, 1, '登录响应已含新余额时无需再次查询 self')

  // checked_in=false 表示本次登录未新增，按今日已签展示。
  routes = {
    'POST https://agentrouter.org/api/user/login?turnstile=': {
      status: 200,
      body: { success: true, data: { id: 7, username: 'u', checked_in: false, quota: 17500000, used_quota: 0 } },
      setCookies: ['session=NEXT_SESSION; Path=/; HttpOnly']
    }
  }
  r = await agentrouter.checkin({ ...EMAIL_AR })
  assert.equal(r.ok, true)
  assert.equal(r.already, true)
  assert.equal(r.statusTextOverride, '今日已签（登录复核）')

  routes = {
    'POST https://agentrouter.org/api/user/login?turnstile=': {
      status: 200,
      body: { success: false, message: '用户名或密码错误，或用户已被封禁' }
    }
  }
  r = await agentrouter.checkin({ ...EMAIL_AR })
  assert.equal(r.ok, false)
  assert.match(r.msg, /用户名或密码错误/)

  // 登录响应在奖励到账后丢失：POST 不重试，用原 Session 的余额差确认。
  loginCalls = 0
  selfCalls = 0
  routes = {
    'POST https://agentrouter.org/api/user/login?turnstile=': () => {
      loginCalls++
      throw new Error('connection reset after login')
    },
    'GET https://agentrouter.org/api/user/self': () => {
      selfCalls++
      return {
        status: 200,
        body: { success: true, data: { id: 7, quota: selfCalls === 1 ? 5000000 : 17500000, used_quota: 0 } }
      }
    }
  }
  const balanceReconciled = await checkinAccount({ ...EMAIL_AR })
  assert.equal(loginCalls, 1, '登录 POST 响应丢失后不得自动重试')
  assert.equal(balanceReconciled.status, 'ok')
  assert.equal(balanceReconciled.statusText, '余额复核成功')
  assert.equal(balanceReconciled.award, '+$25.00')

  // ---- 2. AgentRouter：Cookie 只能验证 Session，不能冒充重新登录签到 ----
  routes = {
    'GET https://agentrouter.org/api/user/self': { status: 200, body: { success: true, data: { id: 7, username: 'u', quota: 5000000, used_quota: 0 } } }
  }
  r = await agentrouter.checkin(AR)
  assert.equal(r.ok, true)
  assert.equal(r.confirmed, false)
  assert.equal(r.statusTextOverride, 'Session 有效·未重登')
  assert.equal(r.balanceText, '$10.00')

  selfCalls = 0
  routes = {
    'GET https://agentrouter.org/api/user/self': () => { selfCalls++; return { status: 200, body: { success: true, data: { id: 7, quota: 5000000, used_quota: 0 } } } }
  }
  const res = await checkinAccount(AR)
  assert.equal(res.status, 'unknown')
  assert.equal(res.statusText, 'Session 有效·未重登')
  assert.match(res.msg, /无法确认/)
  assert.equal(res.balance, '$10.00')
  assert.equal(selfCalls, 1, 'Session 验证后不应重复查询用户信息')
  assert.equal(AR.lastBalance, '$10.00', '签到后应缓存余额供列表展示')
  assert.equal(AR.lastCheckinConfirmed, false, '仅 Session 有效不得写成已确认签到')
  assert.ok(AR.lastCheckinAttemptAt)

  // ---- 2. AgentRouter：Session 失效 ----
  routes = {
    'GET https://agentrouter.org/api/user/self': { status: 401, body: { success: false, message: '无权进行此操作，未登录且未提供 access token' } }
  }
  r = await agentrouter.checkin(AR)
  assert.equal(r.ok, false)

  // ---- 3.4 人机验证类拦截：browser.enable=false 时不降级，原因原样透出 ----
  // （needsBrowser 覆盖 turnstile 明示与「缺少完整性标记/请刷新页面」等魔改站提示）
  for (const msg of ['Turnstile token 为空', '游戏动作缺少完整性标记，请刷新页面后重试']) {
    routes = {
      'POST https://newapi.test/api/user/checkin': { status: 200, body: { success: false, message: msg } },
      'GET https://newapi.test/api/user/self': { status: 200, body: { success: true, data: { id: 1, quota: 500000, used_quota: 0 } } }
    }
    const res = await checkinAccount({ name: 'newapi.test', baseUrl: 'https://newapi.test', type: 'newapi', token: 't' })
    assert.equal(res.status, 'fail')
    assert.equal(res.balance, '$1.00', '签到失败也应查询余额')
  }


  // ---- 3.5 checkinEntry autoOnly：定时任务只签单账号开关打开的 ----
  routes = {
    'GET https://agentrouter.org/api/user/self': { status: 200, body: { success: true, data: { id: 7, quota: 5000000, used_quota: 0 } } }
  }
  const entryAuto = { accounts: [{ ...AR }, { ...AR, name: 'off.org', auto: false }] }
  const autoRes = await checkinEntry(entryAuto, { autoOnly: true })
  assert.equal(autoRes.length, 1, 'autoOnly 应跳过关闭定时的账号')
  const manualRes = await checkinEntry(entryAuto, {})
  assert.equal(manualRes.length, 2, '手动签到不受单账号定时开关影响')

  // ---- 3.6 refreshBalances：列表刷新余额，HTTP 站实时查、浏览器站保留缓存 ----
  routes = {
    'GET https://agentrouter.org/api/user/self': { status: 200, body: { success: true, data: { id: 7, display_name: 'u7', quota: 2500000, used_quota: 0 } } }
  }
  const entryRB = {
    accounts: [
      { name: 'agentrouter.org', baseUrl: 'https://agentrouter.org', type: 'agentrouter', token: 't', siteUserId: 7, lastBalance: '$0.01' },
      { name: 'anyrouter.top', baseUrl: 'https://anyrouter.top', type: 'anyrouter', token: 't', siteUserId: 1, lastBalance: '$9.99' }
    ]
  }
  await refreshBalances(entryRB)
  assert.equal(entryRB.accounts[0].lastBalance, '$5.00', 'HTTP 站应实时刷新余额')
  assert.equal(entryRB.accounts[0].username, 'u7', '刷新时应同步用户名')
  assert.equal(entryRB.accounts[1].lastBalance, '$9.99', '浏览器站应保留缓存不实时查询')

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

  // ---- 7. Turnstile 站点自动触发浏览器降级链路 ----
  // 站点未配置 site key 时应停在降级入口并给出明确提示（不触碰 puppeteer）
  routes = {
    'POST https://t.com/api/user/checkin': { status: 200, body: { success: false, message: 'Turnstile token 为空' } },
    'GET https://t.com/api/status': { status: 200, body: { success: true, data: {} } },
    'GET https://t.com/api/user/self': { status: 200, body: { success: true, data: { id: 1, quota: 500000, used_quota: 0 } } }
  }
  const ts = await checkinAccount({ name: 't.com', baseUrl: 'https://t.com', type: 'newapi', token: 'T', siteUserId: 1 })
  assert.equal(ts.status, 'fail')
  assert.match(ts.msg, /site key/, '应触发降级并提示缺少 site key')
  assert.equal(ts.balance, '$1.00', '降级失败不影响余额查询')

  // ---- 7.1 NewAPI：本轮前已签到时跳过 POST，并展示站点记录的今日奖励 ----
  let postCalls = 0
  routes = {
    [`GET https://newapi.test/api/user/checkin?month=${month}`]: {
      status: 200,
      body: { success: true, data: { stats: { checked_in_today: true, records: [{ checkin_date: today, quota_awarded: 250000 }] } } }
    },
    'POST https://newapi.test/api/user/checkin': () => {
      postCalls++
      return { status: 200, body: { success: true } }
    },
    'GET https://newapi.test/api/user/self': {
      status: 200,
      body: { success: true, data: { id: 1, quota: 2000000, used_quota: 0 } }
    }
  }
  const already = await checkinAccount({ name: 'newapi.test', baseUrl: 'https://newapi.test', type: 'newapi', token: 'T', siteUserId: 1 })
  assert.equal(postCalls, 0, '状态接口确认已签后不得再发 POST')
  assert.equal(already.status, 'already')
  assert.equal(already.statusText, '本轮前已签到')
  assert.equal(already.award, '今日 +$0.50')

  // ---- 7.2 POST 响应丢失：只发送一次，再由状态接口确认成功 ----
  let statusCalls = 0
  let selfStatusCalls = 0
  postCalls = 0
  routes = {
    [`GET https://newapi.test/api/user/checkin?month=${month}`]: () => {
      statusCalls++
      const checked = statusCalls >= 2
      return {
        status: 200,
        body: {
          success: true,
          data: { stats: { checked_in_today: checked, records: checked ? [{ checkin_date: today, quota_awarded: 500000 }] : [] } }
        }
      }
    },
    'POST https://newapi.test/api/user/checkin': () => {
      postCalls++
      throw new Error('connection reset after write')
    },
    'GET https://newapi.test/api/user/self': () => {
      selfStatusCalls++
      return {
        status: 200,
        body: { success: true, data: { id: 1, quota: selfStatusCalls === 1 ? 1000000 : 1500000, used_quota: 0 } }
      }
    }
  }
  const reconciled = await checkinAccount({ name: 'newapi.test', baseUrl: 'https://newapi.test', type: 'newapi', token: 'T', siteUserId: 1 })
  assert.equal(postCalls, 1, '非幂等 POST 网络失败后不得自动重试')
  assert.equal(reconciled.status, 'ok')
  assert.equal(reconciled.statusText, '状态复核成功')
  assert.equal(reconciled.award, '+$1.00')

  // ---- 7.3 请求重试策略：GET 可重试，POST 始终单次 ----
  let getAttempts = 0
  routes = {
    'GET https://x.com/retry-test': () => {
      getAttempts++
      if (getAttempts < 3) throw new Error('temporary')
      return { status: 200, body: { success: true } }
    }
  }
  const retriedGet = await request('https://x.com/retry-test')
  assert.equal(retriedGet.status, 200)
  assert.equal(getAttempts, 3)

  // ---- 8. AnyRouter：浏览器只负责取 WAF cookie，接口调用走普通 HTTP ----
  const anyrouter = (await import('../models/adapters/anyrouter.js')).default
  const AR2 = { name: 'anyrouter.top', baseUrl: 'https://anyrouter.top', type: 'anyrouter', token: 'S', siteUserId: 8 }
  let sentCookie = null
  routes = {
    'GET https://anyrouter.top/api/user/self': opts => {
      sentCookie = opts.headers?.Cookie
      return { status: 200, body: { success: true, data: { id: 8, username: 'a', quota: 2500000, used_quota: 0 } } }
    }
  }
  const arInfo = await anyrouter.userInfo(AR2)
  assert.equal(arInfo.ok, true, '纯 HTTP 可用时不应启动浏览器')
  assert.equal(arInfo.balanceText, '$5.00')
  assert.equal(sentCookie, 'session=S', '无 WAF cookie 缓存时直接用 session 请求')

  // 被 WAF 拦回（非 JSON）且浏览器方案关闭时，应明确报原因而不是静默卡住
  const savedEnable = cfgNow.browser.enable
  cfgNow.browser.enable = false
  routes = { 'GET https://anyrouter.top/api/user/self': { status: 200, body: null } }
  const arBlocked = await anyrouter.userInfo(AR2)
  assert.equal(arBlocked.ok, false)
  assert.match(arBlocked.msg, /浏览器方案未启用/)
  cfgNow.browser.enable = savedEnable
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
      { name: 'agentrouter.org', status: 'unknown', statusText: 'Session 有效·未重登', award: '', balance: '$25.00', msg: '签到未确认' }
    ] }
  ]
  let html = art(path.join(tplDir, 'result.html'), { title: '中转站定时签到', subtitle: '第 1/2 页', time: '2026-08-03 08:10', users })
  assert.ok(html.includes('用户A') && html.includes('Session 有效·未重登') && html.includes('第 1/2 页'))
  assert.ok(html.includes('badge ok') && html.includes('badge fail'))
  assert.ok(html.includes('凭据无效'))

  html = art(path.join(tplDir, 'result.html'), { title: '中转站签到', subtitle: '', time: 'T', users: [users[0]] })
  assert.ok(!html.includes('subtitle">'), '无副标题时不应输出 subtitle 节点')

  html = art(path.join(tplDir, 'list.html'), {
    nickname: 'N', userId: '111', autoText: '已开启', time: 'T',
    accounts: [{
      index: 1, name: 'a.com (u1)', baseUrl: 'https://a.com', typeLabel: 'new-api', tokenMasked: 'abcd****wxyz',
      balance: '$12.30', checkinText: '今日已签', checkinClass: 'on', autoText: '定时开', autoClass: 'on'
    }]
  })
  assert.ok(html.includes('a.com (u1)') && html.includes('abcd****wxyz') && !html.includes('暂无账号'))
  assert.ok(html.includes('余额 $12.30') && html.includes('今日已签') && html.includes('定时开'), '列表应展示余额与签到/定时状态')
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
