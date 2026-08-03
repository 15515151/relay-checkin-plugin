import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'
import chokidar from 'chokidar'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export const PLUGIN_PATH = path.join(__dirname, '..')
export const DATA_PATH = path.join(PLUGIN_PATH, 'data')
export const CONFIG_PATH = path.join(DATA_PATH, 'config.yaml')

const DEFAULT_CONFIG = {
  schedule: {
    enable: true,
    cron: '0 10 8 * * *',
    jitterMinutes: 10,
    accountDelay: [5, 15]
  },
  push: {
    mode: 'group',
    usersPerImage: 5
  },
  request: {
    timeout: 15,
    retry: 1,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
  },
  browser: {
    enable: true,
    wafTimeoutSec: 25,
    turnstileTimeoutSec: 30,
    idleCloseSec: 300
  },
  bind: {
    timeoutSec: 300,
    groupRecallSec: 60
  },
  proxy: {
    url: '',
    hosts: ['anyrouter']
  },
  recallAdd: true
}

let configCache = null
let configWatcher = null

/**
 * 首次启动时把 config_default/config.yaml 复制到 data/config.yaml
 */
function ensureConfigFiles() {
  if (!fs.existsSync(DATA_PATH)) {
    fs.mkdirSync(DATA_PATH, { recursive: true })
  }
  const defaultConfigPath = path.join(PLUGIN_PATH, 'config_default', 'config.yaml')
  if (!fs.existsSync(CONFIG_PATH) && fs.existsSync(defaultConfigPath)) {
    fs.copyFileSync(defaultConfigPath, CONFIG_PATH)
    logger.info('[relay-checkin-plugin] 已从 config_default 生成默认配置')
  }
}

/**
 * 深合并：用户配置缺项或类型不符时回落到默认值
 */
function mergeConfig(def, user) {
  if (user === null || user === undefined) return def
  if (Array.isArray(def) || typeof def !== 'object') return user
  if (typeof user !== 'object' || Array.isArray(user)) return def
  const out = { ...def }
  for (const key of Object.keys(user)) {
    out[key] = key in def ? mergeConfig(def[key], user[key]) : user[key]
  }
  return out
}

/**
 * 读取配置（带缓存与热更新）
 */
export function getConfig() {
  if (configCache) return configCache

  ensureConfigFiles()

  let userConfig = {}
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      userConfig = YAML.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) || {}
    }
  } catch (err) {
    logger.error(`[relay-checkin-plugin] 配置解析失败，使用默认配置: ${err.message}`)
  }
  configCache = mergeConfig(DEFAULT_CONFIG, userConfig)

  if (!configWatcher) {
    configWatcher = chokidar.watch(CONFIG_PATH)
    configWatcher.on('change', () => {
      configCache = null
      logger.mark('[relay-checkin-plugin] 配置文件已更新')
    })
  }

  return configCache
}
