import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const pluginDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const scriptPath = path.join(pluginDir, 'scripts', 'ocr_captcha.py')

/**
 * 挑选运行 ocr_captcha.py 的解释器。
 * 宿主的 PATH 里往往是别的项目的虚拟环境（本机就是 AstrBot 的 .venv），
 * 装了 ddddocr 也照样 ModuleNotFoundError，所以优先用插件自带的 .venv。
 * 顺序：环境变量 RELAY_CHECKIN_PYTHON → 插件 .venv → PATH 里的 python3/python。
 */
function resolvePython() {
  const fromEnv = process.env.RELAY_CHECKIN_PYTHON?.trim()
  if (fromEnv) return fromEnv
  const candidates = [
    path.join(pluginDir, '.venv', 'bin', 'python'),
    path.join(pluginDir, '.venv', 'Scripts', 'python.exe')
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return process.platform === 'win32' ? 'python' : 'python3'
}

// ddddocr 首次调用要加载两个 onnx 模型，正常几秒内出结果。
// 依赖不全（缺 onnxruntime / 模型文件损坏）时 python 可能卡在 import 不退出，
// 而 captchaFallback 会连试 15 次、定时任务路径又没有 guardHang 兜底，
// 一次挂起就会让 runScheduledCheckin 的 running 永久为 true（此后每天都跳过签到），
// 因此这里必须自带硬超时并杀掉子进程。
const DEFAULT_TIMEOUT_MS = 45000

/**
 * python 的 traceback 直接透传会把整段栈塞进签到结果、再渲染进推送图，
 * 所以缺依赖这类常见错误压成一行可执行的提示，其余只保留最后一行。
 */
function describeStderr(stderr, python) {
  const raw = String(stderr || '').trim()
  if (!raw) return '无输出'
  const missing = raw.match(/ModuleNotFoundError: No module named '([^']+)'/)
  if (missing) {
    return `缺少 python 依赖 ${missing[1]}，请执行：${python} -m pip install ddddocr Pillow`
  }
  return raw.split('\n').filter(Boolean).pop().slice(0, 200)
}

/**
 * 调用 scripts/ocr_captcha.py（ddddocr）识别图形验证码。
 * @param {Buffer} image 验证码图片二进制
 * @param {{timeoutMs?: number}} opts 超时时间（毫秒），到时杀进程并 reject
 * @returns {Promise<string>} 识别出的字符（可能为空串）
 */
export function ocrCaptcha(image, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const python = resolvePython()
    const child = spawn(python, [scriptPath], { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    let settled = false
    const finish = fn => (...args) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn(...args)
    }
    const done = finish(resolve)
    const fail = finish(reject)

    // unref 避免超时后的定时器把 Yunzai 进程留在事件循环里
    const timer = setTimeout(() => {
      // SIGKILL 而非 SIGTERM：卡在 onnxruntime 初始化的 python 可能不响应 TERM
      child.kill('SIGKILL')
      fail(new Error(`OCR 超时（${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} 秒` : `${timeoutMs} 毫秒`}未返回，已终止 python 进程）`))
    }, timeoutMs)
    timer.unref?.()

    child.stdout.on('data', chunk => { out += chunk })
    child.stderr.on('data', chunk => { err += chunk })
    child.on('error', e => {
      fail(e?.code === 'ENOENT'
        ? new Error(`找不到 python 解释器 ${python}，请安装 python3 或用环境变量 RELAY_CHECKIN_PYTHON 指定路径`)
        : e)
    })
    child.on('close', code => {
      if (code === 0) return done(out.trim())
      fail(new Error(`OCR 退出码 ${code}: ${describeStderr(err, python)}`))
    })
    child.stdin.on('error', () => child.kill())
    child.stdin.end(image)
  })
}
