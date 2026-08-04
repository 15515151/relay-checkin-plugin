# relay-checkin-plugin

TRSS-Yunzai 中转站自动签到插件（OneBot v11）。支持主流开源中转站程序（new-api / Veloera 及同源魔改站）与 AnyRouter、AgentRouter 的手动签到、每日定时签到与余额查询，结果以图片发送，数据按用户隔离，群内所有人可用。

所有 `#中转...` 指令同时兼容 `#中转站...` 写法（例如 `#中转站签到`、`#中转站列表`）。

## 功能

- 自动识别站点类型（new-api 令牌 / Veloera 令牌 / AnyRouter / AgentRouter / Cookie 通用）
- 群内隐私绑定：群里只发 `#中转添加 地址`，令牌/session 私聊补发，超时/失败/成功都会引用原消息回群提示
- 同一站点支持多个账号（按站点用户ID区分，同一账号重复添加只更新凭据）；添加/更新成功后自动签到一次，未签的顺带签上、已签的正确标记为今日已签
- Cloudflare Turnstile 站点默认直接使用持久可见系统浏览器，等复选框真正可交互后自动点击；升级挑战保留人工接管
- 兼容部分 NewAPI 魔改站的网页 `X-Game-*` 完整性校验：服务端明确拒绝后补齐公开网页所用请求头再试一次
- AnyRouter（anyrouter.top）支持：无头浏览器过阿里云 WAF 后页内签到
- AgentRouter（agentrouter.org / *.air-outer.com）：支持重置站内密码后的邮箱登录签到，依据官方登录响应与余额变化确认 `$25`；旧 Cookie 模式仅验证 Session，不把保活误报为签到
- 每日定时签到，触发时间随机抖动、账号间随机间隔；每个账号可单独开关定时（默认开）
- 定时结果推送可配置：固定群合并转发（群管理用 `#中转开启群推送` 加入目标；每张图最多 N 个用户，超出自动分页）/ 私聊本人 / 关闭
- 并发与防刷：按用户互斥锁（同一用户的签到/查询/添加/删除串行，重复发指令会提示「正在进行中」而不是并发执行），定时任务多用户并发有上限，无头浏览器页面有全局并发闸门，单用户异常不影响其他用户
- 按用户隔离：同一 QQ 在任意群/私聊共享一份账号数据，删除/定时只影响自己；定时签到按用户只执行一次，全部结果分发到每个固定推送群，所有群都推送失败时私聊兜底
- 列表图展示各账号余额（实时刷新，AnyRouter 等浏览器站用缓存）、今日签到状态与定时开关；令牌打码；群里发含令牌的指令自动尝试撤回

## 安装

在 Yunzai 根目录执行：

```bash
git clone https://github.com/Cat-bl/relay-checkin-plugin ./plugins/relay-checkin-plugin
```

重启 Yunzai 即可，无额外依赖（复用 Yunzai 自带的 yaml / chokidar / puppeteer）。

## 指令

| 指令 | 说明 |
|---|---|
| `#中转帮助` | 帮助图 |
| `#中转添加 地址` | 发起令牌绑定；AnyRouter/AgentRouter 会提示改用专用绑定指令 |
| `#中转添加 地址 令牌` | 直接添加，自动识别类型（建议只在私聊使用） |
| `#中转添加 地址 令牌 用户ID` | Veloera 站点需附加站点用户ID |
| `#中转添加cookie 地址` | 发起 Cookie 绑定，随后私聊发送 `session值 用户ID` |
| `#中转添加cookie 地址 session值 用户ID` | Cookie 方式直接添加（AnyRouter / AgentRouter / 旧版站点，按域名自动识别） |
| `#中转添加邮箱 地址` | 发起 AgentRouter 邮箱登录绑定，随后私聊发送 `邮箱 站内密码`（推荐） |
| `#中转添加邮箱 地址 邮箱 站内密码` | AgentRouter 邮箱登录直接添加（仅建议私聊使用） |
| `#中转列表` | 我的账号列表（含余额、今日签到状态、定时开关） |
| `#中转删除 序号` | 删除自己的账号（各用户数据隔离，互不影响） |
| `#中转签到` / `#中转签到 序号` | 立即签到全部 / 指定账号 |
| `#中转查询` | 余额查询 |
| `#中转定时 开/关` | 本人每日定时签到总开关 |
| `#中转定时 开/关 序号` | 单个账号的定时签到开关（默认开启） |
| `#中转开启群推送` / `#中转关闭群推送` | 将本群加入/移出固定推送目标（默认不加入；限群主/管理员/机器人主人，在目标群内发送） |
| `#中转插件更新` | 更新插件（主人） |

令牌获取：站点「个人设置 → 系统访问令牌」生成。群里推荐只发 `#中转添加 地址`，机器人会提示你私聊补发令牌，绑定结果引用原消息回群提示；直接在群里发完整指令会尝试撤回消息。

AnyRouter 请使用 `#中转添加cookie 地址`，随后私聊发送 `session值 用户ID`；AgentRouter 请使用 `#中转添加邮箱 地址`，随后私聊发送邮箱和 AgentRouter 站内密码。误用 `#中转添加 地址` 时插件会先提示正确方式，不会把令牌当作这两类站点的凭据。

同一站点可添加多个账号：按站点用户ID区分，只有同一站点用户重复添加时才会更新凭据。

AgentRouter 添加示例：浏览器登录 agentrouter.org（或 ps.air-outer.com 等同系域名，自动识别）后按 F12，从请求中复制 `session` cookie 值与 `New-Api-User` 头的用户ID，然后群里发送：

```
#中转添加cookie agentrouter.org
```

Cookie 方式只能查询余额，会显示“Session 有效·未重登”。要自动领取每日 `$25`，先在 AgentRouter 重置一个站内登录密码，然后发送：

```
#中转添加邮箱 agentrouter.org
```

再私聊机器人发送 `<邮箱> <AgentRouter站内密码>`。这里不是 GitHub/LinuxDO 密码。插件定时执行时会用不携带旧 Session 的请求重新登录，读取官方响应的 `checked_in` 字段、保存新 Session，并用前后余额复核奖励。

### 机器人开启了私聊禁用（disablePrivate）怎么办

TRSS-Yunzai 的 `disablePrivate` 是优先级最高的系统插件：开启后，非主人的私聊消息在进入任何插件前就会被拦截（回复 `disableMsg` 提示），私聊补发凭据流程无法工作。插件会在群里发起绑定时自动检测并给出提示。解决方式：

1. 主人在 `config/config/other.yaml` 的 `disableAdopt`（私聊通行字符串）中加入一行 `- 中转`，含该字符串的私聊消息会被放行。之后用户私聊改用 `中转绑定 <凭据>` 格式补发（顺带所有 `#中转` 指令也能私聊使用）；
2. 或直接在群里发送完整添加指令（机器人会尝试撤回消息）。

AnyRouter 同理（`#中转添加cookie anyrouter.top <session值> <用户ID>`），签到时会自动启动无头浏览器过 WAF，耗时比普通站点长一些。

## 配置

首次启动后编辑 `data/config.yaml`（由 `config_default/config.yaml` 生成）。插件更新带来的新增配置项会在启动时自动补进该文件，已修改的值与注释都会保留：

- `schedule.cron`：定时签到时间（修改后需重启）
- `schedule.jitterMinutes`：触发后随机延迟分钟数
- `schedule.accountDelay`：同一用户相邻账号之间的随机间隔（默认 5~15 秒）
- `push.mode`：`group` 固定目标群合并转发（见下）/ `private` 私聊本人 / `off` 不推送
- 固定群推送：`group` 模式下，全部用户的签到结果会推送到 `data/push_groups.json` 中的**每一个群**（默认列表为空）。群管理可在目标群发送 `#中转开启群推送` 加入名单，也可直接编辑 JSON；手工修改在下一轮推送时生效，无需重启。推送规则：
  - **签到只执行一次**（按用户，与群数量无关），同一份完整结果分发到每一个固定推送群
  - 同一机器人名下的多个用户合并成一次转发推送，并按 `push.usersPerImage` 自动分页
  - 不再要求签到用户曾在目标群使用插件，也不按目标群成员过滤
  - 一个群都没推成功时（未配置目标群 / 机器人已退群或被禁言）自动**私聊兜底**，不会静默丢结果
- `push.usersPerImage`：群合并转发每张图最多展示的用户数（默认 5）
- `browser.enable`：浏览器方案总开关（AnyRouter 过 WAF、Turnstile 站点降级签到）
- `browser.executablePath`：浏览器程序路径；留空时自动选择版本最高的系统 Chrome/Edge。Turnstile 报 `300*`/`600*` 时应先更新系统浏览器，也可显式填写最新版 Chrome/Edge 路径
- `browser.turnstileTimeoutSec`：关闭可见接管后，Turnstile 无头尝试时间（默认 30 秒，范围 5~120）
- `browser.turnstileInteractive`：是否直接打开可见浏览器处理 Turnstile（默认开启）。可见模式按站点、代理和浏览器内核使用独立持久档案，复选框真正可交互后才自动点击；Cloudflare 未放行时可人工接管
- `browser.turnstileInteractiveTimeoutSec`：可见浏览器等待验证的时间（默认 120 秒，范围 30~600）
- `request.retry`：只读请求网络失败后的重试次数（默认 2）；签到 `POST` 通常只发送一次，响应不确定时改用状态接口复核。仅当站点明确返回缺少 `X-Game-*` 完整性标记时，才会补齐该标记再发一次
- `security.allowHttp`：是否允许添加 HTTP 站点（默认 `false`）
- `security.allowedPrivateHosts`：允许访问的本机/内网站点例外列表，支持精确域名和 `*.example.com`；只应由机器人主人配置
- `bind.timeoutSec`：发起绑定后等待私聊补发凭据的超时秒数（默认 300）
- `bind.groupRecallSec`：群内绑定提示/回执消息自动撤回秒数，防多人使用刷屏（默认 60，0 不撤回；QQ 限制最大 120）。绑定出结果（成功/失败/超时）时提示消息会立即撤回，该秒数是未出结果时的兜底
- `schedule.concurrency`：定时任务同时处理的用户数（默认 3，上限 10）。单用户内部仍逐账号串行，人多可调大，服务器配置低则调小
- `browser.maxConcurrentPages`：全局同时打开的浏览器页面上限（默认 2，上限 10）。每页约数十 MB 内存，超出的任务排队
- `browser.slotWaitSec`：排队等待浏览器空闲的最长时间（默认 120 秒），超时该账号本次判定失败
- `proxy.url`：代理地址（anyrouter.top 等国内无法直连的站点用），如 Clash 的 `http://127.0.0.1:7890`，支持 `http://user:pass@host:port`；留空不使用。无头和可见浏览器均使用同一代理，确保 Turnstile token 与签到提交走同一出口
- `proxy.hosts`：需要走代理的站点域名关键字（包含匹配），默认 `[anyrouter]`；留空数组则配置代理后全部站点走代理
- `recallAdd`：群里发含令牌的添加指令后是否尝试撤回消息

## 已知限制

- Turnstile 默认直接打开持久档案的可见系统浏览器，避免无头挑战先行失败并污染风险评分；关闭 `browser.turnstileInteractive` 后才使用无头模式。token 会在同一页面、同一代理出口下立即提交
- 要求交互时，需在机器人运行设备弹出的窗口内完成验证；Linux 服务器必须有可用的 `DISPLAY` 或 `WAYLAND_DISPLAY`。纯命令行服务器无法显示窗口时会立即返回明确错误，可在配置中关闭 `browser.turnstileInteractive`
- 可见模式只对标准 Turnstile 复选框自动点击一次，不尝试绕过升级后的交互挑战，也不默认接入第三方打码服务，避免向外部服务泄露站点地址、访问上下文或账号相关信息。因此无人值守定时任务遇到必须人工完成的挑战时仍可能失败
- AnyRouter 的 WAF 策略可能变化，若持续提示「WAF 未放行」可稍后重试或提 issue
- anyrouter.top 国内网络无法直连（报「网络请求失败: fetch failed」即是），需在 `data/config.yaml` 配置 `proxy.url` 代理（复用 Yunzai 自带的 https-proxy-agent，无需额外安装）
- Cookie 方式的 session 有效期约 1 个月，失效后需重新添加；AgentRouter 邮箱模式会自动保存每次登录返回的新 Session
- 列表的余额为实时查询（AnyRouter 等浏览器站因耗时长使用缓存）；支持状态接口的 NewAPI/Veloera 会读取站点今日状态，其他站点只展示本插件能够确认的结果；AgentRouter Cookie 账号显示“Session 有效·未重登”
- 默认只接受 HTTPS 站点根地址，并在每次 HTTP/浏览器访问前拦截本机、内网、链路本地及保留地址；确需访问私有部署时使用安全配置显式放行
- 令牌、Session 与 AgentRouter 站内密码明文存储于 `data/accounts.json`，请限制该文件读取权限，且勿将 `data/` 提交到公开仓库（已加入 `.gitignore`）

## 免责声明

本插件仅用于学习与个人便利用途，请遵守各站点的使用条款。
