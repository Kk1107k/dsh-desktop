// 包装 electron-log：固定位置、5MiB 轮转、自动脱敏。
// 不捕获并吞掉致命错误：fatal 级别会重抛。
// ESM 里不用 require：electron-log 经动态 import 加载，缺失时降级到 stderr。
import { app } from 'electron'
import { join } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'

/**
 * @typedef {object} Logger
 * @property {(...args:unknown[])=>void} info
 * @property {(...args:unknown[])=>void} warn
 * @property {(...args:unknown[])=>void} error
 * @property {(...args:unknown[])=>void} debug
 * @property {()=>string} getLogPath
 */

// 注意：JS 正则不支持 (?i) 内联分组（语法错误，模块加载即崩），
// 大小写不敏感一律用 i 标志。
const REDACT_PATTERNS = [
  /(authorization)\s*[:=]\s*[^\s,;]+/gi,
  /(api[_-]?key)\s*[:=]\s*[^\s,;]+/gi,
  /(token)\s*[:=]\s*[^\s,;]+/gi,
  /(\?|%3F|%26)(access_token|token|sig|key)=[^&\s]+/gi,
]

/**
 * @param {unknown} input
 * @returns {string}
 */
function redact(input) {
  if (!input) return String(input ?? '')
  const str = typeof input === 'string' ? input
    : (typeof input === 'object' && input !== null && 'stack' in input && 'message' in input
      ? `${String(/** @type {{message:string}} */ (input).message)}\n${String(/** @type {{stack?:string}} */ (input).stack ?? '')}`
      : (typeof input === 'object' ? safeStringify(input) : String(input)))
  let out = str
  for (const re of REDACT_PATTERNS) out = out.replace(re, '$1=<redacted>')
  return out
}

/**
 * @param {object} obj
 * @returns {string}
 */
function safeStringify(obj) {
  try { return JSON.stringify(obj) } catch { return String(obj) }
}

/**
 * 创建日志实例；日志固定在 userData/logs/main.log。
 * @returns {Promise<Logger>}
 */
export async function createLogger() {
  const dir = join(app.getPath('userData'), 'logs')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const file = join(dir, 'main.log')

  /** @type {Logger|null} */
  let electronLog = null
  try {
    // electron-log/main 是主进程确定入口（根入口靠 process.type 分流）。
    const mod = await import('electron-log/main')
    const raw = mod?.default ?? mod
    const logApi = /** @type {import('electron-log/main')} */ (raw)
    logApi.transports.file.resolvePathFn = () => file
    logApi.transports.file.maxSize = 5 * 1024 * 1024  // 5MiB 轮转
    logApi.transports.console.level = 'info'
    logApi.transports.file.level = 'info'
    electronLog = /** @type {Logger} */ (/** @type {unknown} */ (logApi))
  } catch {
    // electron-log 缺失时降级到 stderr，仍然保证日志可读、不丢致命错误。
    /**
     * @param {string} level
     * @returns {(...args:unknown[])=>void}
     */
    const write = (level) => (...args) => process.stderr.write(`[${level}] ${args.map(a => redact(a)).join(' ')}\n`)
    electronLog = {
      info: write('INFO'), warn: write('WARN'), error: write('ERROR'), debug: write('DEBUG'),
      getLogPath: () => file,
    }
  }

  /** @param {'info'|'warn'|'error'|'debug'} level */
  const withRedact = (level) =>
    /** @param {unknown[]} args */
    (...args) => {
      const fn = electronLog?.[level]
      if (typeof fn === 'function') fn(...args.map(a => redact(a)))
    }

  return {
    info: withRedact('info'),
    warn: withRedact('warn'),
    error: withRedact('error'),
    debug: withRedact('debug'),
    getLogPath: () => file,
  }
}
