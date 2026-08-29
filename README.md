# relay-checkin-plugin

> **本仓库是 Fork。** 上游原作者仓库：[Cat-bl/relay-checkin-plugin](https://github.com/Cat-bl/relay-checkin-plugin)。
> 本 fork 在上游基础上继续开发，新增内容见 [本 Fork 新增的功能](#本-fork-新增的功能)。
>
> 本 fork 的两个仓库同步更新，任选其一：
> - GitHub：<https://github.com/cchanlan/relay-checkin-plugin>
> - GitCode：<https://gitcode.com/ccxhan/relay-checkin-plugin>（国内直连更快）

TRSS-Yunzai 中转站自动签到插件（OneBot v11），同时支持 [Yunzai NG](https://github.com/Yunzai-NG/yunzai-ng)（见 [装在 Yunzai NG 上](#装在-yunzai-ng-上)）。支持主流开源中转站程序（new-api / Veloera 及同源魔改站）与 AnyRouter、AgentRouter、Sub2API 的手动签到、每日定时签到与余额查询，结果以图片发送，数据按用户隔离，群内所有人可用。

所有 `#中转...` 指令同时兼容 `#中转站...` 写法（例如 `#中转站签到`、`#中转站列表`）。

## 本 Fork 新增的功能

相对上游 [Cat-bl/relay-checkin-plugin](https://github.com/Cat-bl/relay-checkin-plugin) 的增量：

- **同时支持 Yunzai NG**：同一份代码在 TRSS-Yunzai 与 [Yunzai NG](https://github.com/Yunzai-NG/yunzai-ng) 上都能跑。做法是把对宿主的依赖（日志、账号、数据目录、配置、出图）收进一层适配器（`host/`），指令逻辑一份不动；NG 侧另有 `configSchema` 面板配置、`ctx.cron` 定时任务（改 cron 立即生效）、出图走内核 `ctx.render` 交给渲染器插件。详见 [装在 Yunzai NG 上](#装在-yunzai-ng-上)。
- **新增 Sub2API 站点支持**（自建 Go 网关，前端标题 `Sub2API - AI API Gateway`，域名任意）。接口体系与 new-api 系完全不同（前缀 `/api/v1`、响应统一 `{ code, message, data }`、余额字段本身就是美元），插件靠公开配置接口自动识别，无需用户指定类型。鉴权是 JWT：优先用未过期的 access_token，过期则纯 HTTP 续期，都失效时才开浏览器过码重登；一次性的 refresh_token 轮换后立即落盘，避免续期与超时竞争把令牌写丢。
- **新增 `#中转添加刷新令牌` 指令**：登录人机验证等级过高、本机过不去码的 Sub2API 站点，可直接用浏览器里抓到的 refresh_token 绑定，全程不开浏览器。
- **图形验证码自动识别（ddddocr）**：部分 NewAPI 魔改站签到要填图形验证码，插件自动取码 → 本地 OCR → 带答案重提，答错自动换新码，最多重试 15 次。解释器按「环境变量 → 插件自带 `.venv` → PATH」顺序解析，缺依赖时把 `ModuleNotFoundError` 压成一行安装提示，不再把整段 traceback 渲染进推送图。
- **Turnstile 改为「断开调试连接后由页面自治过码」**：实测只要 CDP 调试会话还连着，Cloudflare 一律回 `600010` 判定自动化。现在主进程在导航后主动断开 CDP，过码、重试、签到提交全由注入的页内脚本自己完成，结束后再重连取回结果。
- **无桌面 Linux 服务器可无人值守过码**：自动拉起 Xvfb 虚拟屏，并用 xdotool 驱动 X server 的真实指针去勾选复选框（CDP 注入的点击会被判为自动化）；点击坐标取自 X server 实测的窗口几何，不信 Chrome 自报的 `outerHeight - innerHeight`（Xvfb 无窗口管理器时该值为 0，会让点击整体偏上、点了毫无反应）。有真实桌面时同样复用这条路径。
- **失败可观测性**：断连状态下的失败原本没有任何现场，现在超时收尾时会重连 CDP 留档（页内脚本步骤日志、Turnstile 组件实际位置、token 是否签发、指针最终落点、截图）。另外 TRSS-Yunzai 内置的 Puppeteer 13 在启动失败时会吞掉 Chrome 的 stderr，只剩一句 `Failed to launch the browser process!`，插件改为亲手跑一次 Chrome 抓回真实错误行。
- **浏览器档案占用自愈**：Chrome 遇到同一 `--user-data-dir` 已有实例会把命令行交给旧实例后静默退出。插件现在会找出占用档案的进程，一次性档案直接清理，池化档案只回收父进程已消失的孤儿（避免动到同机另一个 Yunzai 实例正在用的窗口）。
- **支持只认网页会话的 new-api 魔改站**：新增 `authMode: 'session'`，用 `#中转添加cookie` 绑定的 session 会以 Cookie 方式鉴权并补齐 `Origin` / `Referer`，站点回「请打开网站」时也会明确提示改用 cookie 绑定。
- **锅巴（Guoba-Plugin）配置面板支持**：新增 `guoba.support.js`，可在网页面板改全部配置项。写回以现有 `data/config.yaml` 为底逐项覆盖并原子落盘，保留用户注释与自定义键，保存后立即让缓存失效、无需重启。
- **美元制站点的奖励文本直通**：Sub2API 这类余额本身就是美元的站点由适配器直接给出奖励文本，不再经 new-api 的 quota 换算。

## 功能

- 自动识别站点类型（new-api 令牌 / new-api 网页会话 / Veloera 令牌 / AnyRouter / AgentRouter / Sub2API / Cookie 通用）
- 群内隐私绑定：群里只发 `#中转添加 地址`，令牌/session 私聊补发，超时/失败/成功都会引用原消息回群提示
- 同一站点支持多个账号（按站点用户ID区分，同一账号重复添加只更新凭据）；添加/更新成功后自动签到一次，未签的顺带签上、已签的正确标记为今日已签
- Cloudflare Turnstile 站点默认使用可见系统浏览器：导航后主动断开调试连接（Cloudflare 会因调试会话直接判定自动化），再由页面自己完成挑战并提交签到；无桌面服务器上用 Xvfb 虚拟屏 + xdotool 真实指针自动勾选，升级挑战仍保留人工接管
- 兼容部分 NewAPI 魔改站的网页 `X-Game-*` 完整性校验：服务端明确拒绝后补齐公开网页所用请求头再试一次
- AnyRouter（anyrouter.top）支持：无头浏览器过阿里云 WAF 后页内签到
- AgentRouter（agentrouter.org / *.air-outer.com）：支持重置站内密码后的邮箱登录签到，依据官方登录响应与余额变化确认 `$25`；旧 Cookie 模式仅验证 Session，不把保活误报为签到
- Sub2API 站点：按公开配置接口自动识别（域名任意），支持邮箱密码绑定与刷新令牌绑定；access_token 过期走纯 HTTP 续期，不必要时不开浏览器
- 部分 NewAPI 魔改站的图形验证码自动识别（ddddocr，需可选依赖），答错自动换码重试
- 每日定时签到，触发时间随机抖动、账号间随机间隔；每个账号可单独开关定时（默认开）
- 定时结果推送可配置：固定群合并转发（群管理用 `#中转开启群推送` 加入目标；每张图最多 N 个用户，超出自动分页）/ 私聊本人 / 关闭
- 并发与防刷：按用户互斥锁（同一用户的签到/查询/添加/删除串行，重复发指令会提示「正在进行中」而不是并发执行），定时任务多用户并发有上限，无头浏览器页面有全局并发闸门，单用户异常不影响其他用户
- 按用户隔离：同一 QQ 在任意群/私聊共享一份账号数据，删除/定时只影响自己；定时签到按用户只执行一次，全部结果分发到每个固定推送群，所有群都推送失败时私聊兜底
- 列表图展示各账号余额（实时刷新，AnyRouter 等浏览器站用缓存）、今日签到状态与定时开关；令牌打码；群里发含令牌的指令自动尝试撤回

## 安装

在 Yunzai 根目录执行（二选一，两个仓库内容相同）：

```bash
# GitHub
git clone https://github.com/cchanlan/relay-checkin-plugin ./plugins/relay-checkin-plugin

# GitCode（国内直连更快）
git clone https://gitcode.com/ccxhan/relay-checkin-plugin ./plugins/relay-checkin-plugin
```

重启 Yunzai 即可，Node 侧无额外依赖（复用 Yunzai 自带的 yaml / chokidar / puppeteer）。

### 无桌面 Linux 服务器上的人机验证（推荐安装）

Turnstile 站点需要一个能显示窗口的环境。没有图形桌面时插件会自己拉起 Xvfb 虚拟屏，
并用 xdotool 驱动真实指针去勾选复选框（CDP 注入的点击会被 Cloudflare 判为自动化）：

```bash
apt install -y xvfb xdotool          # Debian/Ubuntu
```

缺 `xvfb` 时这类站点会返回「需要显示环境」的明确错误；缺 `xdotool` 时窗口仍会打开，
但没人点复选框，只能在有真实桌面的机器上人工完成。

### 图形验证码识别（可选）

部分 NewAPI 魔改站签到要求填图形验证码，插件会调 `scripts/ocr_captcha.py`（ddddocr）自动识别。
不装则这类站点签到失败并提示缺少依赖，其余站点不受影响。在插件目录执行：

```bash
python3 -m venv .venv
.venv/bin/pip install ddddocr Pillow      # Windows: .venv\Scripts\pip install ddddocr Pillow
```

插件会自动优先使用插件目录下的 `.venv`（约 420MB，含 onnxruntime）。
装在别处时用环境变量 `RELAY_CHECKIN_PYTHON` 指定解释器路径 —— 不要指望 PATH 里的 `python3`，
宿主进程的 PATH 常被其它项目的虚拟环境占据。

### 装在 Yunzai NG 上

同一份代码也能作为 [Yunzai NG](https://github.com/Yunzai-NG/yunzai-ng) 插件运行（NG 是另一套内核：
TypeScript、零全局变量、插件可装可卸可热重载）。把仓库放进 NG 主目录的 `plugins/` 下即可：

```bash
# 在 NG 主目录（默认就是 NG 的启动目录）执行
git clone --depth=1 https://github.com/cchanlan/relay-checkin-plugin ./plugins/relay-checkin-plugin
# NG 侧不像 TRSS 那样有现成依赖可蹭，要自己装。puppeteer 只用于过 WAF / Turnstile，
# 出图不需要它（走内核渲染器），插件也会自动找系统 Chrome/Edge，所以可以跳过 Chromium 下载
PUPPETEER_SKIP_DOWNLOAD=1 npm install --prefix ./plugins/relay-checkin-plugin
```

**出图需要一个渲染器插件。** NG 的内核不自带渲染实现（`ctx.render` 会去找已注册的渲染器），
本插件也不自带、更不自己注册 —— 模板在插件里编译成 HTML，截图交给内核选中的渲染器。
没装渲染器时所有指令都会退化成文本回复，并在日志里说明原因。

重启 NG（或在面板里装载插件）后：

- 配置在面板上直接改（`configSchema` 一份声明同时用于校验、生成带注释的 YAML、渲染表单），
  文件在 `$YZNG_HOME/config/plugin/relay-checkin.yaml`
- 数据落在 `$YZNG_HOME/data/plugin/relay-checkin/`（accounts.json、push_groups.json、浏览器档案），
  不再写进插件安装目录
- 指令、绑定流程、定时推送、浏览器过码、验证码识别与 TRSS 侧完全一致

两个宿主的差异只有四处：

| | TRSS-Yunzai | Yunzai NG |
|---|---|---|
| 改 `schedule.cron` | 需重启 Yunzai | **立即生效**（插件监听配置变更后重建定时任务） |
| `#中转插件更新` | 可用（走 Yunzai 自带更新） | 不提供，用 NG 面板/插件市场更新 |
| 配置界面 | 锅巴（`guoba.support.js`） | NG 自带面板（`configSchema`） |
| 出图 | Yunzai 自带的 `lib/puppeteer` | 内核 `ctx.render` → 你装的渲染器插件 |

> NG 目前还没有官方 QQ 适配器与渲染器插件（`adapter-napcat`、`renderer-puppeteer` 两个仓库尚未公开），
> 所以在 NG 上收发消息与出图都要等这两类插件放出来。本插件在 NG 内核上的加载、指令分发、
> 配置生成、定时任务重建、出图通路与卸载回收均已用内核自带的 mock 适配器实测通过。

## 指令

| 指令 | 说明 |
|---|---|
| `#中转帮助` | 帮助图 |
| `#中转添加 地址` | 发起令牌绑定；AnyRouter/AgentRouter 会提示改用专用绑定指令 |
| `#中转添加 地址 令牌` | 直接添加，自动识别类型（建议只在私聊使用） |
| `#中转添加 地址 令牌 用户ID` | Veloera 站点需附加站点用户ID |
| `#中转添加cookie 地址` | AnyRouter/旧版站点发起 Cookie 绑定，随后私聊发送 `session值 用户ID` |
| `#中转添加cookie 地址 session值 用户ID` | Cookie 方式直接添加（AnyRouter / 旧版站点；AgentRouter 会引导邮箱绑定） |
| `#中转添加邮箱 地址` | 发起邮箱登录绑定（AgentRouter / Sub2API），随后私聊发送 `邮箱 站内密码`（推荐） |
| `#中转添加邮箱 地址 邮箱 站内密码` | 邮箱登录直接添加（AgentRouter / Sub2API；仅建议私聊使用） |
| `#中转添加刷新令牌 地址` | 发起 Sub2API 刷新令牌绑定，随后私聊发送 `刷新令牌`（登录过不去码时用） |
| `#中转添加刷新令牌 地址 刷新令牌` | 刷新令牌直接添加（仅 Sub2API；仅建议私聊使用） |
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

AgentRouter 自动签到请使用邮箱登录绑定：先在 agentrouter.org（或 ps.air-outer.com 等同系域名）重置站内密码，然后发送：

```
#中转添加邮箱 agentrouter.org
```

随后私聊机器人发送邮箱和 AgentRouter 站内密码。AgentRouter 的 Cookie 方式不用于自动签到；误用 `#中转添加cookie` 时插件会直接提示改用邮箱绑定。
这里不是 GitHub/LinuxDO 密码。插件定时执行时会用不携带旧 Session 的请求重新登录，读取官方响应的 `checked_in` 字段、保存新 Session，并用前后余额复核奖励。

### Sub2API 站点

Sub2API 是自建网关、域名任意，插件会在添加时问一次站点的公开配置接口自动识别，它没有「系统访问令牌」，所以用 `#中转添加 地址 令牌` 会被提示改用邮箱绑定：

```
#中转添加邮箱 站点地址
```

随后私聊发送「邮箱 登录密码」。站点通常对登录开启 Turnstile、对签到不开，因此绑定时可能拉起一次浏览器过码，之后的定时签到只走 HTTP。

如果该站登录的人机验证等级过高、本机始终过不去，可以自己在浏览器登录后从 `localStorage` 取出 refresh_token，用刷新令牌绑定（全程不开浏览器）：

```
#中转添加刷新令牌 站点地址
```

随后私聊发送该令牌。注意 refresh_token 是一次性的，每次续期都会轮换，插件会自动保存新值；若同一账号在别处重新登录导致令牌被作废，需要重新绑定。

### 机器人开启了私聊禁用（disablePrivate）怎么办

TRSS-Yunzai 的 `disablePrivate` 是优先级最高的系统插件：开启后，非主人的私聊消息在进入任何插件前就会被拦截（回复 `disableMsg` 提示），私聊补发凭据流程无法工作。插件会在群里发起绑定时自动检测并给出提示。解决方式：

1. 主人在 `config/config/other.yaml` 的 `disableAdopt`（私聊通行字符串）中加入一行 `- 中转`，含该字符串的私聊消息会被放行。之后用户私聊改用 `中转绑定 <凭据>` 格式补发（顺带所有 `#中转` 指令也能私聊使用）；
2. 或直接在群里发送完整添加指令（机器人会尝试撤回消息）。

AnyRouter 同理（`#中转添加cookie anyrouter.top <session值> <用户ID>`），签到时会自动启动无头浏览器过 WAF，耗时比普通站点长一些。

## 配置

首次启动后编辑 `data/config.yaml`（由 `config_default/config.yaml` 生成）。插件更新带来的新增配置项会在启动时自动补进该文件，已修改的值与注释都会保留。装了 [Guoba-Plugin](https://github.com/guoba-yunzai/guoba-plugin) 的话，也可以直接在锅巴网页面板里改（写回时保留注释，保存即生效，无需重启）：

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
- `browser.turnstileInteractive`：是否直接打开可见浏览器处理 Turnstile（默认开启）。按站点、代理和浏览器内核使用独立持久档案，导航后断开调试连接再自动勾选复选框；Cloudflare 未放行时可人工接管
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

- Turnstile 默认打开可见系统浏览器，并在导航完成后断开调试连接，让页面在无调试会话的状态下完成挑战、直接提交签到（实测同一环境下只要调试连接还在，Cloudflare 一律回 `600010`）；关闭 `browser.turnstileInteractive` 后才使用无头模式。token 会在同一页面、同一代理出口下立即提交
- 需要显示环境：有桌面时直接弹窗，纯命令行 Linux 服务器会自动拉起 Xvfb 虚拟屏（需 `xvfb` 包），并用 `xdotool` 自动勾选复选框；两者都缺时返回明确错误，可在配置中关闭 `browser.turnstileInteractive`
- 自动勾选后如果挑战失败，页面会自行复位重试最多 2 次；不尝试绕过升级后的交互挑战，也不默认接入第三方打码服务，避免向外部服务泄露站点地址、访问上下文或账号相关信息。因此无人值守定时任务遇到必须人工完成的挑战时仍可能失败
- AnyRouter 的 WAF 策略可能变化，若持续提示「WAF 未放行」可稍后重试或提 issue
- anyrouter.top 国内网络无法直连（报「网络请求失败: fetch failed」即是），需在 `data/config.yaml` 配置 `proxy.url` 代理（复用 Yunzai 自带的 https-proxy-agent，无需额外安装）
- Cookie 方式的 session 有效期约 1 个月，失效后需重新添加；AgentRouter 邮箱模式会自动保存每次登录返回的新 Session
- Sub2API 的 refresh_token 是一次性的（每次续期都轮换、旧值立刻作废）：在别处重新登录会使插件保存的令牌失效，需要重新绑定
- 图形验证码走本地 OCR，单次识别并非 100% 准确（实测约 1/3 一次过），靠自动换码重试兜底；识别耗时约 2 秒/次
- 列表的余额为实时查询（AnyRouter 等浏览器站因耗时长使用缓存）；支持状态接口的 NewAPI/Veloera 会读取站点今日状态，其他站点只展示本插件能够确认的结果；AgentRouter Cookie 账号显示“Session 有效·未重登”
- 默认只接受 HTTPS 站点根地址，并在每次 HTTP/浏览器访问前拦截本机、内网、链路本地及保留地址；确需访问私有部署时使用安全配置显式放行
- 令牌、Session 与 AgentRouter 站内密码明文存储于 `data/accounts.json`，请限制该文件读取权限，且勿将 `data/` 提交到公开仓库（已加入 `.gitignore`）

## 仓库

本 fork 的两个仓库同步推送，内容一致：

| 平台 | 地址 |
|---|---|
| GitHub | <https://github.com/cchanlan/relay-checkin-plugin> |
| GitCode | <https://gitcode.com/ccxhan/relay-checkin-plugin> |

上游原作者仓库：<https://github.com/Cat-bl/relay-checkin-plugin>，感谢原作者。本 fork 的改动与问题请提到上面两个仓库，不要打扰上游。

## 免责声明

本插件仅用于学习与个人便利用途，请遵守各站点的使用条款。
