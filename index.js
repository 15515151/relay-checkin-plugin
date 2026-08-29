import chalk from 'chalk'
import { installHost, logger } from './host/index.js'
import { createTrssHost } from './host/trss.js'
import RelayCheckinApp from './apps/trss.js'
import { RelayCheckinUpdate } from './apps/update.js'

// 必须在任何业务代码跑起来之前装好宿主：models/* 全部通过宿主适配层取
// logger / 数据目录 / 配置 / 出图能力
installHost(createTrssHost())

const apps = { RelayCheckinApp, RelayCheckinUpdate }

logger.info(chalk.rgb(120, 180, 255)('[relay-checkin-plugin] 中转站签到插件加载完成'))

export { apps }
