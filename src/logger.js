// 包装 electron-log：固定位置、5MiB 轮转、自动脱敏。
// 不捕获并吞掉致命错误：fatal 级别会重抛。
import { app } from 'electron'
import { join } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const REDACT_PATTERNS = [
  /((?i)authorization)\s*[:=]\s*[^\s,;]+/g,
  /((?i)api[_-]?key)\s*[:=]\s*[^\s,;]+/g,
  /((?i)token)\s*[:=]\s*[^\s,;]+/g,
  /(\?|%3F|%26)(access_token|token|sig|key)=[^&\s]+/gi,
]

function redact(input) {
  if (!input) return input
  const str = typeof input === 'string' ? input
    : (input?.stack ? `${input.message}\n${input.stack}` : (typeof input === 'object' ? safeStringify(input) : String(input)))
  let out = str
  for (const re of REDACT_PATTERNS) out = out.replace(re, '$1=<redacted>')
  return out
}
function safeStringify(obj) {
  try { return JSON.stringify(obj) } catch { return String(obj) }
}

/**
 * 创建日志实例；日志固定在 userData/logs/main.log。
 * @returns {{info:Function, warn:Function, error:Function, debug:Function, getLogPath:Function}}
 */
export function createLogger() {
  const dir = join(app.getPath('userData'), 'logs')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const file = join(dir, 'main.log')

  let electronLog = null
  try {
    const mod = require('electron-log')
    electronLog = mod.default ?? mod
    electronLog.transports.file.resolvePathFn = () => file
    electronLog.transports.file.maxSize = 5 * 1024 * 1024  // 5MiB 轮转
    electronLog.transports.console.level = 'info'
    electronLog.transports.file.level = 'info'
  } catch (e) {
    // electron-log 缺失时降级到 stderr，仍然保证日志可读、不丢致命错误。
    electronLog = {
      info: (...a) => process.stderr.write(`[INFO] ${redact(a)}\n`),
      warn: (...a) => process.stderr.write(`[WARN] ${redact(a)}\n`),
      error: (...a) => process.stderr.write(`[ERROR] ${redact(a)}\n`),
      debug: (...a) => process.stderr.write(`[DEBUG] ${redact(a)}\n`),
      transports: { file: { level: 'info' }, console: { level: 'info' } },
    }
  }

  const withRedact = (level) => (...args) => electronLog[level](...(args.map(a => redact(a))))

  return {
    info: withRedact('info'),
    warn: withRedact('warn'),
    error: withRedact('error'),
    debug: withRedact('debug'),
    getLogPath: () => file,
  }
}