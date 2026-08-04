import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'
import chokidar from 'chokidar'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export const PLUGIN_PATH = path.join(__dirname, '..')
export const DATA_PATH = path.join(PLUGIN_PATH, 'data')
export const CONFIG_PATH = path.join(DATA_PATH, 'config.yaml')

/**
 * 原子写入用的重命名：Windows 下杀软/同步盘可能短暂锁住文件导致 EPERM，短暂重试
 */
export function renameWithRetry(from, to, tries = 5) {
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(from, to)
      return
    } catch (err) {
      if (i >= tries - 1 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err
      const end = Date.now() + 50
      while (Date.now() < end) { /* 等待锁释放 */ }
    }
  }
}

const DEFAULT_CONFIG = {
  schedule: {
    enable: true,
    cron: '0 10 8 * * *',
    jitterMinutes: 10,
    accountDelay: [5, 15],
    concurrency: 3
  },
  push: {
    mode: 'group',
    usersPerImage: 5
  },
  request: {
    timeout: 15,
    retry: 2,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
  },
  security: {
    allowHttp: false,
    allowedPrivateHosts: []
  },
  browser: {
    enable: true,
    wafTimeoutSec: 60,
    turnstileTimeoutSec: 30,
    idleCloseSec: 300,
    maxConcurrentPages: 2,
    slotWaitSec: 120
  },
  bind: {
    timeoutSec: 300,
    groupRecallSec: 60
  },
  proxy: {
    url: '',
    hosts: ['anyrouter'],
    useForBrowser: true
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
 * 找出用户配置里缺少的默认配置键（点号路径），用于升级后补齐新增配置项
 */
function findMissingKeys(def, user, path = []) {
  const missing = []
  if (def === null || typeof def !== 'object' || Array.isArray(def)) return missing
  if (user === null || typeof user !== 'object' || Array.isArray(user)) return missing
  for (const key of Object.keys(def)) {
    if (!(key in user)) {
      missing.push([...path, key].join('.'))
    } else {
      missing.push(...findMissingKeys(def[key], user[key], [...path, key]))
    }
  }
  return missing
}

/**
 * 插件更新新增配置项时同步到 data/config.yaml：
 * 以 config_default 模板（含注释）为底，写回用户已有的值（含用户自定义键），
 * 用户改过的值全部保留，仅补上缺失的新增项
 */
function syncNewConfigKeys(userConfig) {
  const defaultConfigPath = path.join(PLUGIN_PATH, 'config_default', 'config.yaml')
  if (!fs.existsSync(defaultConfigPath)) return
  const missing = findMissingKeys(DEFAULT_CONFIG, userConfig)
  if (!missing.length) return

  try {
    const doc = YAML.parseDocument(fs.readFileSync(defaultConfigPath, 'utf-8'))
    const apply = (obj, prefix) => {
      for (const [key, value] of Object.entries(obj)) {
        const p = [...prefix, key]
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
          apply(value, p)
        } else {
          doc.setIn(p, value)
        }
      }
    }
    apply(userConfig, [])
    const tmp = CONFIG_PATH + '.tmp'
    fs.writeFileSync(tmp, doc.toString())
    renameWithRetry(tmp, CONFIG_PATH)
    logger.mark(`[relay-checkin-plugin] 配置文件已补充新增项: ${missing.join(', ')}`)
  } catch (err) {
    logger.error(`[relay-checkin-plugin] 配置文件同步新增项失败: ${err.message}`)
  }
}

/**
 * 读取配置（带缓存与热更新）
 */
export function getConfig() {
  if (configCache) return configCache

  ensureConfigFiles()

  let userConfig = {}
  let parseOk = true
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      userConfig = YAML.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) || {}
    }
  } catch (err) {
    parseOk = false
    logger.error(`[relay-checkin-plugin] 配置解析失败，使用默认配置: ${err.message}`)
  }
  // 配置能正常解析时才回写补齐，避免把用户写坏的文件直接覆盖掉
  if (parseOk) syncNewConfigKeys(userConfig)
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
