import chalk from 'chalk'
import RelayCheckinApp from './apps/checkin.js'
import { RelayCheckinUpdate } from './apps/update.js'

const apps = { RelayCheckinApp, RelayCheckinUpdate }

logger.info(chalk.rgb(120, 180, 255)('[relay-checkin-plugin] 中转站签到插件加载完成'))

export { apps }
