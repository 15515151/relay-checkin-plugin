# relay-checkin-plugin

TRSS-Yunzai 中转站自动签到插件（OneBot v11）。支持主流开源中转站程序（new-api / Veloera 及同源魔改站）与 AgentRouter 的手动签到、每日定时签到与余额查询，结果以图片发送，数据按用户隔离，群内所有人可用。

## 功能

- 自动识别站点类型（new-api 令牌 / Veloera 令牌 / AgentRouter / Cookie 通用）
- AgentRouter（agentrouter.org）保活：无签到接口时查询用户信息即完成续期
- 每日定时签到，触发时间随机抖动、账号间随机间隔
- 定时结果推送可配置：群合并转发（每张图最多 N 个用户，超出自动分页）/ 私聊本人 / 关闭
- 按用户隔离：同一 QQ 在任意群/私聊共享一份账号数据，定时结果推送到最近使用的群（仅私聊用过则私聊推送）
- 群里添加账号自动尝试撤回消息，列表中令牌打码

## 安装

在 Yunzai 根目录执行：

```bash
git clone <本仓库地址> ./plugins/relay-checkin-plugin
```

重启 Yunzai 即可，无额外依赖（复用 Yunzai 自带的 yaml / chokidar / puppeteer）。

## 指令

| 指令 | 说明 |
|---|---|
| `#中转帮助` | 帮助图 |
| `#中转添加 地址 令牌` | 添加账号，自动识别类型 |
| `#中转添加 地址 令牌 用户ID` | Veloera 站点需附加站点用户ID |
| `#中转添加cookie 地址 session值 用户ID` | Cookie 方式（AgentRouter / 旧版站点，自动识别） |
| `#中转列表` | 我的账号列表 |
| `#中转删除 序号` | 删除账号 |
| `#中转签到` / `#中转签到 序号` | 立即签到全部 / 指定账号 |
| `#中转查询` | 余额查询 |
| `#中转定时 开/关` | 开关自己的每日定时签到 |
| `#中转插件更新` | 更新插件（主人） |

令牌获取：站点「个人设置 → 系统访问令牌」生成。建议私聊机器人添加账号。

AgentRouter 添加示例：浏览器登录 agentrouter.org 后按 F12，从请求中复制 `session` cookie 值与 `New-Api-User` 头的用户ID，然后发送：

```
#中转添加cookie agentrouter.org <session值> <用户ID>
```

## 配置

首次启动后编辑 `data/config.yaml`（由 `config_default/config.yaml` 生成）：

- `schedule.cron`：定时签到时间（修改后需重启）
- `schedule.jitterMinutes`：触发后随机延迟分钟数
- `push.mode`：`group` 群合并转发 / `private` 私聊本人 / `off` 不推送
- `push.usersPerImage`：群合并转发每张图最多展示的用户数（默认 5）
- `recallAdd`：群里添加账号后是否尝试撤回消息

## 已知限制

- 站点开启 Cloudflare Turnstile 人机验证时无法自动签到（new-api 签到接口强制校验）
- 带阿里云 WAF 的站点（如 AnyRouter 官站）纯 HTTP 请求会被拦截，暂不支持，属后续浏览器方案范围（AgentRouter 无 WAF，可正常使用）
- Cookie 方式的 session 有效期约 1 个月，失效后需重新添加
- 令牌明文存储于 `data/accounts.json`，请勿将该目录提交到公开仓库（已加入 .gitignore）

## 免责声明

本插件仅用于学习与个人便利用途，请遵守各站点的使用条款。
