# relay-checkin-plugin

TRSS-Yunzai 中转站自动签到插件（OneBot v11）。支持主流开源中转站程序（new-api / Veloera 及同源魔改站）与 AnyRouter、AgentRouter 的手动签到、每日定时签到与余额查询，结果以图片发送，数据按用户隔离，群内所有人可用。

## 功能

- 自动识别站点类型（new-api 令牌 / Veloera 令牌 / AnyRouter / AgentRouter / Cookie 通用）
- 群内隐私绑定：群里只发 `#中转添加 地址`，令牌/session 私聊补发，超时/失败/成功都会引用原消息回群提示
- 同一站点支持多个账号（按站点用户ID区分，同一账号重复添加只更新凭据）
- Cloudflare Turnstile 站点自动降级浏览器方案：页面内完成挑战取 token 后签到
- AnyRouter（anyrouter.top）支持：无头浏览器过阿里云 WAF 后页内签到
- AgentRouter（agentrouter.org / *.air-outer.com）保活：无签到接口时查询用户信息即完成续期
- 每日定时签到，触发时间随机抖动、账号间随机间隔；每个账号可单独开关定时（默认开）
- 定时结果推送可配置：群合并转发（白名单制，群管理用 `#中转开启群推送` 启用；每张图最多 N 个用户，超出自动分页）/ 私聊本人 / 关闭
- 按用户隔离：同一 QQ 在任意群/私聊共享一份账号数据，删除/定时只影响自己；定时结果推送到最近使用的群（需该群开启推送且群内仍有绑定用户；仅私聊用过则私聊推送）
- 列表图展示各账号余额、今日签到状态与定时开关；令牌打码；群里发含令牌的指令自动尝试撤回

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
| `#中转添加 地址` | 发起绑定，随后私聊机器人直接发送令牌（推荐群内用法） |
| `#中转添加 地址 令牌` | 直接添加，自动识别类型（建议只在私聊使用） |
| `#中转添加 地址 令牌 用户ID` | Veloera 站点需附加站点用户ID |
| `#中转添加cookie 地址` | 发起 Cookie 绑定，随后私聊发送 `session值 用户ID` |
| `#中转添加cookie 地址 session值 用户ID` | Cookie 方式直接添加（AnyRouter / AgentRouter / 旧版站点，按域名自动识别） |
| `#中转列表` | 我的账号列表（含余额、今日签到状态、定时开关） |
| `#中转删除 序号` | 删除自己的账号（各用户数据隔离，互不影响） |
| `#中转签到` / `#中转签到 序号` | 立即签到全部 / 指定账号 |
| `#中转查询` | 余额查询 |
| `#中转定时 开/关` | 本人每日定时签到总开关 |
| `#中转定时 开/关 序号` | 单个账号的定时签到开关（默认开启） |
| `#中转开启群推送` / `#中转关闭群推送` | 本群是否接收定时签到结果推送（白名单制，默认关；限群主/管理员/机器人主人，在目标群内发送） |
| `#中转插件更新` | 更新插件（主人） |

令牌获取：站点「个人设置 → 系统访问令牌」生成。群里推荐只发 `#中转添加 地址`，机器人会提示你私聊补发令牌，绑定结果引用原消息回群提示；直接在群里发完整指令会尝试撤回消息。

同一站点可添加多个账号：按站点用户ID区分，只有同一站点用户重复添加时才会更新凭据。

AgentRouter 添加示例：浏览器登录 agentrouter.org（或 ps.air-outer.com 等同系域名，自动识别）后按 F12，从请求中复制 `session` cookie 值与 `New-Api-User` 头的用户ID，然后群里发送：

```
#中转添加cookie agentrouter.org
```

再私聊机器人发送 `<session值> <用户ID>` 即可（也可私聊直接发完整指令）。

### 机器人开启了私聊禁用（disablePrivate）怎么办

TRSS-Yunzai 的 `disablePrivate` 是优先级最高的系统插件：开启后，非主人的私聊消息在进入任何插件前就会被拦截（回复 `disableMsg` 提示），私聊补发凭据流程无法工作。插件会在群里发起绑定时自动检测并给出提示。解决方式：

1. 主人在 `config/config/other.yaml` 的 `disableAdopt`（私聊通行字符串）中加入一行 `- 中转`，含该字符串的私聊消息会被放行。之后用户私聊改用 `中转绑定 <凭据>` 格式补发（顺带所有 `#中转` 指令也能私聊使用）；
2. 或直接在群里发送完整添加指令（机器人会尝试撤回消息）。

AnyRouter 同理（`#中转添加cookie anyrouter.top <session值> <用户ID>`），签到时会自动启动无头浏览器过 WAF，耗时比普通站点长一些。

## 配置

首次启动后编辑 `data/config.yaml`（由 `config_default/config.yaml` 生成）：

- `schedule.cron`：定时签到时间（修改后需重启）
- `schedule.jitterMinutes`：触发后随机延迟分钟数
- `push.mode`：`group` 群合并转发（白名单制，见下）/ `private` 私聊本人 / `off` 不推送
- 群推送白名单：`group` 模式下只有用 `#中转开启群推送` 开启过的群才会收到推送（默认全部不推），且推送前会校验群内仍有已绑定的用户（都退群则跳过）；名单存于 `data/push_groups.json`
- `push.usersPerImage`：群合并转发每张图最多展示的用户数（默认 5）
- `browser.enable`：无头浏览器方案开关（AnyRouter 过 WAF、Turnstile 站点降级签到）
- `bind.timeoutSec`：发起绑定后等待私聊补发凭据的超时秒数（默认 300）
- `recallAdd`：群里发含令牌的添加指令后是否尝试撤回消息

## 已知限制

- Turnstile 浏览器方案依赖 Cloudflare 对无头环境的评分，非交互式挑战通常可自动通过；要求点击验证的站点可能失败，会在结果中提示
- AnyRouter 的 WAF 策略可能变化，若持续提示「WAF 未放行」可稍后重试或提 issue
- Cookie 方式的 session 有效期约 1 个月，失效后需重新添加
- 列表图中的余额与「今日已签」为本插件最近一次签到/查询的缓存，站点网页上的操作不会反映进来
- 令牌明文存储于 `data/accounts.json`，请勿将该目录提交到公开仓库（已加入 .gitignore）

## 免责声明

本插件仅用于学习与个人便利用途，请遵守各站点的使用条款。
