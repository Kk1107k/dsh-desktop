// 子进程管理：固定版本、loopback 端口、健康探测、退避重启、进程树强制回收。
// 任何对外状态读取都依赖启动代次，旧代次回调一律忽略，避免竞态。
import { spawn, execFile } from 'node:child_process'
import { createServer } from 'node:net'
import { request } from 'node:http'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const TARGET_PKG = '@deepseek-ai/dsh@0.1.7-alpha'
const HEALTH_INTERVAL_MS = 10000
const HEALTH_TIMEOUT_MS = 2000
const PROBE_INTERVAL_MS = 250
const PROBE_TIMEOUT_MS = 1000
const READY_DEADLINE_MS = 15000
const RESTART_DELAYS_MS = [1000, 2000, 4000, 8000, 8000]
const STABLE_RESET_MS = 5 * 60 * 1000
const SHUTDOWN_WAIT_MS = 3000
const TAIL_BUFFER_BYTES = 64 * 1024

/**
 * 定位外部 Node 与 npx-cli.js。
 * 禁止把 process.execPath 当作 Node；ELECTRON_RUN_AS_NODE 非可靠开关。
 * @returns {{nodeExe:string, npxCli:string}}
 */
function locateRuntime() {
  const nodeExe = process.execPath  // 占位：实际查 Node 安装目录，需 §11.1 验证
  // npx-cli.js 通常位于 npm 安装根：占位路径，待 Phase 2 校准
  let npxCli = '<占位 npx-cli.js 绝对路径>'
  const guesses = [
    require.resolve('npm/bin/npx-cli.js'),
    require.resolve('npx-cli.js'),
  ].filter(p => { try { return existsSync(p) } catch { return false } })
  if (guesses.length) npxCli = guesses[0]
  return { nodeExe, npxCli }
}

/**
 * 端口占用探测：仅检查，不接管、不杀占者、不静默换端口。
 * @param {number} port
 * @returns {Promise<boolean>} true = 端口空闲
 */
function isPortFree(port) {
  return new Promise(resolve => {
    const srv = createServer()
    srv.once('error', () => resolve(false))
    srv.once('listening', () => srv.close(() => resolve(true)))
    srv.listen(port, '127.0.0.1')
  })
}

/**
 * 单次 HTTP GET /api/health，禁止重定向。
 * @returns {Promise<boolean>} true = 200
 */
function probeHealth(port) {
  return new Promise(resolve => {
    const req = request({
      host: '127.0.0.1', port, path: '/api/health', method: 'GET',
      timeout: PROBE_TIMEOUT_MS,
    }, res => {
      res.resume()
      resolve(res.statusCode === 200)
    })
    req.on('timeout', () => { req.destroy(); resolve(false) })
    req.on('error', () => resolve(false))
    req.end()
  })
}

/**
 * 创建 host 控制器。
 * @param {{config:{port:number}, logger:object}} opts
 */
export function createDshHost({ config, logger }) {
  const log = logger
  const handlers = new Map()
  let child = null
  let generation = -1
  let state = 'idle'                // idle|starting|ready|stopping|stopped|crashed
  let stopping = false
  let restartCount = 0
  let probeTimer = null
  let healthTimer = null
  let backoffTimer = null
  let stableResetTimer = null
  let stderrTail = ''
  let stdoutTail = ''

  function on(ev, fn) {
    if (!handlers.has(ev)) handlers.set(ev, new Set())
    handlers.get(ev).add(fn)
    return () => off(ev, fn)
  }
  function off(ev, fn) { handlers.get(ev)?.delete(fn) }
  function emit(ev, payload) { handlers.get(ev)?.forEach(fn => { try { fn(payload) } catch (e) { log.error('handler error', e) } }) }

  function currentGeneration() { return generation }
  function getState() { return { state, generation, restartCount } }
  function isHealthy() { return state === 'ready' && child && !child.killed }

  /**
   * 启动 host。每次自增代次；包括首次启动都经此入口。
   * @param {{generation?:number}} [opts]
   */
  async function start({ generation: gen } = {}) {
    if (gen !== undefined && gen !== generation) generation = gen
    else generation++
    setState('starting')
    emit('starting', { generation })

    if (!(await isPortFree(config.port))) {
      const err = new Error(`E_PORT_IN_USE: ${config.port}`)
      err.code = 'E_PORT_IN_USE'
      log.error(err.message)
      emit('crashed', { generation, error: err })
      throw err
    }

    const { nodeExe, npxCli } = locateRuntime()
    const args = [npxCli, '--yes', '--offline', `--package=${TARGET_PKG}`, '--', 'dsh', 'web', '--no-open']
    const env = { ...process.env, DSH_NO_BROWSER: '1', DSH_PORT: String(config.port), ELECTRON_RUN_AS_NODE: '0' }
    log.info(`spawning host gen=${generation} port=${config.port}`)

    child = spawn(nodeExe, args, {
      cwd: process.cwd(),
      env,
      shell: false, windowsHide: true, detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout?.on('data', d => appendTail('stdout', d))
    child.stderr?.on('data', d => {
      appendTail('stderr', d)
      if (/\bready\b/.test(d.toString())) scheduleImmediateProbe()
    })
    child.once('exit', (code, signal) => onChildExit(code, signal))

    scheduleReadyDeadline()
    scheduleProbes()
  }

  function setState(next) { state = next }

  function appendTail(stream, chunk) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    const tail = (stream === 'stdout' ? stdoutTail : stderrTail) + buf.toString('utf8')
    const trimmed = tail.length > TAIL_BUFFER_BYTES ? tail.slice(-TAIL_BUFFER_BYTES) : tail
    if (stream === 'stdout') stdoutTail = trimmed; else stderrTail = trimmed
    // 脱敏后写日志，由 logger 进一步遮蔽。
    log.debug?.(`host ${stream}`, trimmed.slice(-512))
  }

  let immediateProbe = null
  function scheduleImmediateProbe() {
    if (immediateProbe) return
    immediateProbe = setTimeout(async () => {
      immediateProbe = null
      if (state === 'starting' && await probeHealth(config.port)) onReady()
    }, 0)
  }

  let readyDeadline = null
  function scheduleReadyDeadline() {
    if (readyDeadline) clearTimeout(readyDeadline)
    readyDeadline = setTimeout(() => {
      if (state !== 'starting') return
      log.error('host ready deadline exceeded')
      emit('timeout', { generation })
      // 终止本次启动，由上层弹窗决定重试。
      killTreeImmediate()
    }, READY_DEADLINE_MS)
  }

  let probeLoop = null
  function scheduleProbes() {
    if (probeLoop) clearInterval(probeLoop)
    probeLoop = setInterval(async () => {
      if (state !== 'starting') return
      if (await probeHealth(config.port)) onReady()
    }, PROBE_INTERVAL_MS)
  }
  function stopProbes() {
    if (probeLoop) { clearInterval(probeLoop); probeLoop = null }
    if (readyDeadline) { clearTimeout(readyDeadline); readyDeadline = null }
  }

  function onReady() {
    if (state !== 'starting') return
    stopProbes()
    setState('ready')
    emit('ready', { generation })
    scheduleHealthChecks()
    // 稳定 5 分钟后清零重启预算，避免在 ready 阶段一次性清零形成无限重启。
    if (stableResetTimer) clearTimeout(stableResetTimer)
    stableResetTimer = setTimeout(() => { restartCount = 0 }, STABLE_RESET_MS)
  }

  let consecutiveFails = 0
  let healthTimerId = null
  function scheduleHealthChecks() {
    if (healthTimerId) clearInterval(healthTimerId)
    healthTimerId = setInterval(async () => {
      if (state !== 'ready' || stopping) return
      const ok = await probeHealthWithTimeout(HEALTH_TIMEOUT_MS)
      if (ok) { consecutiveFails = 0; return }
      consecutiveFails++
      if (consecutiveFails >= 3) {
        log.error('host lost after 3 consecutive failed probes')
        consecutiveFails = 0
        setState('crashed')
        emit('crashed', { generation })
        killTreeImmediate()
        maybeAutoRestart()
      }
    }, HEALTH_INTERVAL_MS)
  }
  function stopHealthChecks() {
    if (healthTimerId) { clearInterval(healthTimerId); healthTimerId = null }
    if (stableResetTimer) { clearTimeout(stableResetTimer); stableResetTimer = null }
  }
  function probeHealthWithTimeout(timeoutMs) {
    return new Promise(resolve => {
      const req = request({ host: '127.0.0.1', port: config.port, path: '/api/health', method: 'GET', timeout: timeoutMs }, res => {
        res.resume(); resolve(res.statusCode === 200)
      })
      req.on('timeout', () => { req.destroy(); resolve(false) })
      req.on('error', () => resolve(false))
      req.end()
    })
  }

  function onChildExit(code, signal) {
    log.warn(`host exited code=${code} signal=${signal} gen=${generation} state=${state} stopping=${stopping}`)
    if (stopping) return finalizeStopped()
    if (state === 'ready') {
      // ready 后的非主动退出视为故障。
      setState('crashed')
      emit('exited', { generation, code, signal })
      stopHealthChecks()
      maybeAutoRestart()
    } else if (state === 'starting') {
      emit('crashed', { generation, error: new Error('exited during starting') })
      maybeAutoRestart()
    }
  }

  function maybeAutoRestart() {
    if (stopping) return
    if (restartCount >= RESTART_DELAYS_MS.length) {
      log.error('host continuous start failure, halting auto-restart')
      emit('crashed', { generation, fatal: true, error: new Error('CONTINUOUS_FAILURE') })
      return
    }
    const delay = RESTART_DELAYS_MS[restartCount++]
    log.info(`auto-restart in ${delay}ms (attempt ${restartCount})`)
    backoffTimer = setTimeout(() => start({ generation: generation + 1 }), delay)
  }

  async function restart() {
    // 手动重启入口；停止当前实例后重新走 start()，保留 restartCount 自增策略。
    await stop()
    await start()
  }

  /**
   * 幂等停止：先 stopping，再发 dsh shutdown，超时后进程树强制回收。
   * @returns {Promise<void>}
   */
  function stop() {
    if (stopping) return Promise.resolve()
    stopping = true
    stopProbes()
    stopHealthChecks()
    if (backoffTimer) { clearTimeout(backoffTimer); backoffTimer = null }

    if (!child || child.exitCode !== null) {
      finalizeStopped()
      return Promise.resolve()
    }
    return new Promise(resolve => {
      let done = false
      const finish = () => { if (!done) { done = true; resolve() } }
      // 优先优雅关闭：dsh shutdown 末尾参数。
      const { nodeExe, npxCli } = locateRuntime()
      const env = { ...process.env, DSH_NO_BROWSER: '1', DSH_PORT: String(config.port), ELECTRON_RUN_AS_NODE: '0' }
      const shutdown = spawn(nodeExe, [npxCli, '--yes', '--offline', `--package=${TARGET_PKG}`, '--', 'dsh', 'shutdown'], {
        cwd: process.cwd(), env, shell: false, windowsHide: true, detached: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let exited = false
      child?.once('exit', () => { exited = true; finalizeStopped(); finish() })
      shutdown.once('exit', () => {
        if (exited) return
        // 仅靠 shutdown 命令返回 0 不算回收完成，必须以 host 实际退出为准。
      })
      setTimeout(() => {
        if (exited) return
        log.warn('graceful shutdown timeout, killing tree')
        killTreeImmediate()
        setTimeout(finish, 200)
      }, SHUTDOWN_WAIT_MS)
    })
  }

  function killTreeImmediate() {
    if (!child || child.exitCode !== null) return
    if (process.platform === 'win32') {
      // Windows 按身份核对的 PID 强制 taskkill /T，禁止按进程名批量杀。
      try {
        execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], () => {})
      } catch (e) { log.error('taskkill failed', e) }
    } else {
      try { child.kill('SIGKILL') } catch (e) { log.error('kill failed', e) }
    }
  }

  function finalizeStopped() {
    setState('stopped')
    stopping = false
    child = null
  }

  function stopped() {
    // 让调用方等待 stopped 状态：polling，避免依赖未暴露的事件。
    return new Promise(resolve => {
      if (state === 'stopped') return resolve()
      const t = setInterval(() => { if (state === 'stopped') { clearInterval(t); resolve() } }, 50)
    })
  }

  return { start, stop, restart, isHealthy, getState, currentGeneration, on, off, stopped }
}