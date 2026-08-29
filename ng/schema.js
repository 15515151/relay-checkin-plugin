/**
 * NG 的配置 schema
 *
 * 一份声明同时管三件事：校验、生成带注释的 YAML、在面板上渲染表单 ——
 * 也就是 TRSS 侧 `config_default/config.yaml` + `guoba.support.js` 两个文件的活。
 * 默认值一律取自 models/config.js 的 DEFAULT_CONFIG，避免两边漂移；
 * 说明文案沿用锅巴那份，用户看到的措辞在两个宿主上一致。
 */
import { s } from '@yunzai-ng/core'
import { DEFAULT_CONFIG as D } from '../models/config.js'

const scheduleSchema = s.object({
  enable: s.boolean().default(D.schedule.enable)
    .title('启用定时签到').desc('关闭后只能手动 #中转签到'),
  cron: s.cron().default(D.schedule.cron)
    .title('cron 表达式').desc('6 段（秒 分 时 日 月 周），默认每天 08:10：0 10 8 * * *'),
  jitterMinutes: s.number().int().min(0).max(240).default(D.schedule.jitterMinutes)
    .title('随机延迟（分钟）').desc('触发后随机延迟 0~N 分钟再开始，避免整点并发特征；0 = 不延迟'),
  accountDelay: s.array(s.number().int().min(0).max(600)).default(D.schedule.accountDelay)
    .title('账号间隔（秒）').desc('相邻两个账号签到之间的随机间隔，两项分别是下限与上限'),
  concurrency: s.number().int().min(1).max(10).default(D.schedule.concurrency)
    .title('并发用户数').desc('同时处理的用户数（单用户内部仍逐账号串行）。人多时调大，服务器弱则调小')
}).title('定时签到')

const pushSchema = s.object({
  mode: s.select([
    { value: 'group', label: '固定群合并转发', description: '全部用户结果合并转发到推送目标群（群管理在目标群发 #中转开启群推送 加入）' },
    { value: 'private', label: '私聊本人', description: '只发给账号所属用户' },
    { value: 'off', label: '不推送', description: '仅记录日志' }
  ]).default(D.push.mode).title('推送方式'),
  usersPerImage: s.number().int().min(1).max(50).default(D.push.usersPerImage)
    .title('每张图用户数').desc('群合并转发时每张图最多展示的用户数，超出自动分成多张图')
}).title('结果推送')

const requestSchema = s.object({
  timeout: s.number().int().min(1).max(300).default(D.request.timeout)
    .title('请求超时（秒）').desc('单次 HTTP 请求超时时间'),
  retry: s.number().int().min(0).max(10).default(D.request.retry)
    .title('重试次数').desc('网络错误重试次数。仅 GET/HEAD 等只读请求会重试，签到 POST 固定只发送一次'),
  userAgent: s.text().default(D.request.userAgent)
    .title('User-Agent').desc('接口请求使用的 UA，一般无需修改')
}).title('请求设置')

const securitySchema = s.object({
  allowHttp: s.boolean().default(D.security.allowHttp)
    .title('允许 HTTP 站点').desc('默认只允许 HTTPS。确需使用明文 HTTP 站点时才开启，令牌会以明文传输'),
  allowedPrivateHosts: s.tags().default(D.security.allowedPrivateHosts)
    .title('放行的内网域名').desc('默认禁止本机/内网/链路本地地址。确需访问私有站点时填精确域名或 *.example.com')
}).title('地址安全策略')

const browserSchema = s.object({
  enable: s.boolean().default(D.browser.enable)
    .title('启用浏览器方案')
    .desc('AnyRouter 过阿里云 WAF、Turnstile / POW 站点自动降级签到所需，关闭后这类站点无法自动签到'),
  executablePath: s.string().default(D.browser.executablePath)
    .title('浏览器路径')
    .placeholder('/usr/bin/google-chrome')
    .desc('留空自动选择版本最高的系统 Chrome/Edge，找不到才用 Puppeteer 自带 Chromium。Turnstile 要求浏览器较新'),
  wafTimeoutSec: s.number().int().min(5).max(600).default(D.browser.wafTimeoutSec)
    .title('WAF 等待时长（秒）').desc('等待阿里云 WAF 放行的最长时间，anyrouter 较慢，不够时可加大'),
  turnstileInteractive: s.boolean().default(D.browser.turnstileInteractive)
    .title('可见浏览器过 Turnstile')
    .desc('导航后断开调试连接、由页面自治过码（Cloudflare 会因调试会话直接判定自动化）。无桌面服务器会自动拉起 Xvfb + xdotool'),
  turnstileInteractiveTimeoutSec: s.number().int().min(30).max(600).default(D.browser.turnstileInteractiveTimeoutSec)
    .title('可见接管超时（秒）').desc('等待可见浏览器完成 Turnstile 的最长时间'),
  turnstileTimeoutSec: s.number().int().min(5).max(120).default(D.browser.turnstileTimeoutSec)
    .title('无头 Turnstile 超时（秒）').desc('关闭可见接管后，无头尝试 Turnstile 的最长时间'),
  powTimeoutSec: s.number().int().min(15).max(300).default(D.browser.powTimeoutSec)
    .title('POW 计算超时（秒）').desc('NewAPI POW-Shield 计算并提交签到的最长时间'),
  idleCloseSec: s.number().int().min(30).max(3600).default(D.browser.idleCloseSec)
    .title('空闲关闭（秒）').desc('浏览器空闲多久后自动关闭以释放内存（出图浏览器同样适用）'),
  maxConcurrentPages: s.number().int().min(1).max(10).default(D.browser.maxConcurrentPages)
    .title('并发页面上限').desc('全局同时打开的浏览器页面上限（每页约数十 MB 内存），超出的任务排队'),
  slotWaitSec: s.number().int().min(30).max(600).default(D.browser.slotWaitSec)
    .title('排队等待上限（秒）').desc('排队等待浏览器空闲的最长时间，超时该账号本次判定失败')
}).title('浏览器方案')

const bindSchema = s.object({
  timeoutSec: s.number().int().min(30).max(1800).default(D.bind.timeoutSec)
    .title('私聊补发超时（秒）').desc('只发 #中转添加 地址 后，等待私聊补发凭据的超时时间'),
  groupRecallSec: s.number().int().min(0).max(120).default(D.bind.groupRecallSec)
    .title('群提示撤回（秒）').desc('群内绑定提示消息自动撤回秒数，防多人使用刷屏；0 = 不撤回。平台一般只允许撤回 2 分钟内的消息')
}).title('绑定流程')

const proxySchema = s.object({
  url: s.string().default(D.proxy.url)
    .title('代理地址').placeholder('http://127.0.0.1:7890')
    .desc('anyrouter.top 等站点国内网络无法直连时配置。支持 http 代理，可带账密；留空 = 不使用代理'),
  hosts: s.tags().default(D.proxy.hosts)
    .title('走代理的域名').desc('需要走代理的站点域名关键字（按包含匹配）；留空 = 配置了代理后全部站点走代理'),
  useForBrowser: s.boolean().default(D.proxy.useForBrowser)
    .title('浏览器也走代理')
    .desc('代理软件开启 TUN / 系统代理时，浏览器再显式指定代理可能形成环路导致页面打不开，这种情况请关闭')
}).title('代理设置')

/** 插件配置 schema，交给 definePlugin 的 configSchema */
export const configSchema = s.object({
  schedule: scheduleSchema,
  push: pushSchema,
  request: requestSchema,
  security: securitySchema,
  browser: browserSchema,
  bind: bindSchema,
  proxy: proxySchema,
  recallAdd: s.boolean().default(D.recallAdd)
    .title('撤回添加指令')
    .desc('群里使用 #中转添加 后尝试撤回用户消息（令牌敏感），需机器人有管理员权限')
})

