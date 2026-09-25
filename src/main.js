// 启动编排唯一入口：所有退出路径必须经 cleanupAndQuit，禁止在别处直接 app.quit。
import { app, BrowserWindow, dialog, protocol, session } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, copyFileSync } from 'node:fs'
import { createLogger } from './logger.js'
import { createDshHost } from './dsh-host.js'
import { createMainWindow } from './main-window.js'
import { createTray } from './tray.js'
import { createUpdater } from './updater.js'
import { createIpc, CHANNELS } from './ipc.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const APP_NAME = 'dsh-desktop'
const SPEC_MIN_SPLASH_MS = 2400
const SPEC_FADE_MS = 300
const SPEC_FINISH_TIMEOUT_MS = 1000
const SPEC_HOST_READY_TIMEOUT_MS = 15000
const SPEC_MAIN_LOAD_TIMEOUT_MS = 10000

/**
 * 装载并校验用户配置；损坏文件留 .corrupt 副本后恢复默认。
 * @returns {{schemaVersion:number, port:number, theme:string, autoCheckIntervalHours:number, runMode:string, skipVersion:string|null}}
 */
function loadConfig() {
  const cfgPath = join(app.getPath('userData'), 'config.json')
  const fallback = { schemaVersion: 1, port: 3080, theme: 'system', autoCheckIntervalHours: 6, runMode: 'standard', skipVersion: null }
  if (!existsSync(cfgPath)) return fallback
  try {
    const raw = readFileSync(cfgPath, 'utf8')
    const parsed = JSON.parse(raw)
    const port = Number(parsed.port) | 0
    if (port < 1024 || port > 65535) throw new Error('port out of range')
    if (!['system', 'light', 'dark'].includes(parsed.theme)) throw new Error('theme invalid')
    const h = Number(parsed.autoCheckIntervalHours) | 0
    if (h < 1 || h > 168) throw new Error('interval out of range')
    if (!['standard', 'ptc', 'minimal', 'creative'].includes(parsed.runMode)) throw new Error('runMode invalid')
    return { schemaVersion: 1, port, theme: parsed.theme, autoCheckIntervalHours: h, runMode: parsed.runMode, skipVersion: parsed.skipVersion ?? null }
  } catch (err) {
    try {
      const ts = new Date().toISOString().replace(/[:.]/g, '-')
      renameSync(cfgPath, `${cfgPath}.${ts}.corrupt`)
    } catch (_) { /* 记录即可，不阻塞启动 */ }
    log?.error?.('config corrupted, restored default', err)
    return fallback
  }
}

let log = null
const state = {
  quitting: false,
  generation: 0,                  // 启动代次，重试时自增，旧代次回调一律忽略
  t0: 0,                          // splash 首次 show 的单调时钟
  host: null,
  splash: null,
  main: null,                     // 主窗口控制器
  tray: null,
  updater: null,
  ipc: null,
  config: null,
  finishRequested: false,
  finishTimer: null,
}

/**
 * 注册 dsh-app 受信协议：仅服务固定页面与包内素材，规范化路径并拒绝穿越。
 * 必须在 app ready 前注册，否则 splash 加载会失败。
 */
function registerDshAppProtocol() {
  protocol.registerSchemesAsPrivileged([{
    scheme: 'dsh-app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
  }])
}

function handleDshAppRequest(request, callback) {
  const url = new URL(request.url)
  const host = url.host
  if (host !== 'ui') return callback({ error: -10 })
  const rel = url.pathname.replace(/^\/+/, '')
  const allowed = new Set(['splash.html', 'update-dialog.html', 'about.html'])
  if (!allowed.has(rel)) return callback({ error: -6 })
  const safe = join(__dirname, rel).replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  const base = __dirname.replace(/\\/g, '/').replace(/\/$/, '')
  if (!safe.startsWith(base + '/')) return callback({ error: -8 })
  callback({ path: safe })
}

app.enableSandbox()
app.setName(APP_NAME)
registerDshAppProtocol()

// 单例锁：第二实例聚焦已有窗口后立即退出，不参与任何启动流程。
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (state.quitting) return
    if (state.main?.win && !state.main.win.isDestroyed()) {
      state.main.win.show()
      state.main.win.focus()
    } else if (state.splash && !state.splash.isDestroyed()) {
      state.splash.focus()
    }
  })

  app.whenReady().then(bootstrap).catch(err => {
    console.error('bootstrap fatal', err)
    if (log) log.error('bootstrap fatal', err)
    app.quit()
  })
}

process.on('uncaughtException', err => {
  if (log) log.error('uncaughtException', err)
  else console.error('uncaughtException', err)
  cleanupAndQuit().finally(() => app.exit(1))
})
process.on('unhandledRejection', reason => {
  if (log) log.error('unhandledRejection', reason)
  else console.error('unhandledRejection', reason)
  cleanupAndQuit().finally(() => app.exit(1))
})

app.on('window-all-closed', e => {
  // 关闭按钮走托盘隐藏路径；只有 quitting 时才真正退出。
  if (state.quitting) return
  if (state.tray && state.main?.win && !state.main.win.isDestroyed()) {
    e.preventDefault()
    state.main.win.hide()
    return
  }
  // 托盘未就绪：保持默认退出行为，避免窗口无法关闭的卡死。
})

async function bootstrap() {
  state.config = loadConfig()
  log = await createLogger()
  global.log = log

  protocol.handle('dsh-app', handleDshAppRequest)

  state.host = createDshHost({ config: state.config, logger: log })

  state.splash = createSplashWindow()
  state.t0 = performance.now()
  state.splash.show()

  state.ipc = createIpc({
    logger: log,
    getSplash: () => state.splash,
    getMain: () => state.main?.win ?? null,
    getGeneration: () => state.generation,
    setFinishRequested: () => { state.finishRequested = true },
    onSplashFinishConfirm: () => onSplashFinishConfirm(),
    onSplashCloseBeforeFinish: () => onSplashCloseBeforeFinish(),
    updater: null,
    tray: () => state.tray,
  })
  state.ipc.register()

  state.main = createMainWindow({ config: state.config, logger: log })

  state.updater = createUpdater({
    logger: log,
    config: state.config,
    isPackaged: app.isPackaged,
    onTraySetState: (s) => state.tray?.setState?.(s),
    onTraySetText: (t, ms) => state.tray?.setFlashText?.(t, ms),
    onUpdateState: (ev) => state.ipc.pushUpdateState(ev),
    onUpdateOpen: () => state.main?.openUpdateWindow?.(),
    onHostStopBeforeInstall: () => state.host?.stop(),
    onHostRestartAfterInstall: () => app.relaunch(),
  })
  state.ipc.setUpdater(state.updater)

  await tryStartHost()

  // 首次自动检查在主窗口 ready-to-show 后触发；here 仅预创建实例，不立刻执行。
  state.main.once('ready-to-show', () => {
    if (state.quitting) return
    scheduleFinalGate()
    state.updater.scheduleOnMainWindowReady()
  })

  state.tray = createTray({
    logger: log,
    onOpen: () => state.main?.show(),
    onCheckUpdate: () => state.updater.checkManual(),
    getRunMode: () => state.config.runMode,
    setRunMode: (mode) => persistRunMode(mode),
    onQuit: () => cleanupAndQuit(),
  })
}

function createSplashWindow() {
  const win = new BrowserWindow({
    width: 480, height: 320,
    frame: false, resizable: false, minimizable: true, maximizable: false,
    transparent: false, show: false, center: true, skipTaskbar: false,
    backgroundColor: '#0f1419',
    webPreferences: {
      preload: join(__dirname, '..', 'build', 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [`--dsh-role=splash`, `--dsh-version=${app.getVersion()}`],
    },
  })
  win.loadURL('dsh-app://ui/splash.html')
  return win
}

async function tryStartHost() {
  state.ipc.pushSplashStatus('正在启动服务…')
  try {
    await state.host.start({ generation: state.generation })
  } catch (err) {
    log.error('host start failed', err)
    state.ipc.pushSplashStatus('服务启动失败')
    promptRetryOrExit('服务启动失败，请重试或退出。')
    return
  }
  state.host.on('ready', ({ generation }) => {
    if (generation !== state.generation) return
    state.ipc.pushSplashStatus('就绪')
    state.ipc.pushSplashStatus('正在加载界面…')
    loadMainWindow()
  })
  state.host.on('timeout', ({ generation }) => {
    if (generation !== state.generation) return
    if (state.quitting) return
    state.ipc.pushSplashStatus('服务启动超时')
    promptRetryOrExit('服务启动超时，请重试或退出。')
  })
  state.host.on('crashed', ({ generation }) => {
    if (generation !== state.generation) return
    if (state.quitting) return
    state.ipc.pushSplashStatus('服务异常，正在重试…')
  })
  state.host.on('exited', ({ generation }) => {
    if (generation !== state.generation) return
    if (state.quitting) return
    state.ipc.pushSplashStatus('服务已退出，正在重试…')
  })
}

function loadMainWindow() {
  if (state.quitting || state.generation !== state.host.currentGeneration()) return
  const url = `http://127.0.0.1:${state.config.port}`
  state.main.loadURL(url).then(() => {
    setTimeout(() => {
      if (state.generation !== state.host.currentGeneration()) return
      state.ipc.pushSplashStatus('即将就绪…')
    }, 100)
  }).catch(err => {
    log.error('main window load failed', err)
    state.ipc.pushSplashStatus('界面加载失败')
    onUiLoadError()
  })
  // 10s 内未 ready-to-show 视为 UI 加载失败，禁止 finish。
  setTimeout(() => {
    if (state.main?.loaded) return
    if (state.generation !== state.host.currentGeneration()) return
    if (state.quitting) return
    if (!state.main?.win || state.main.win.isDestroyed()) return
    if (state.main.win.webContents.isLoading()) {
      log.error('ui load timeout')
      onUiLoadError()
    }
  }, SPEC_MAIN_LOAD_TIMEOUT_MS)
}

function scheduleFinalGate() {
  const elapsed = performance.now() - state.t0
  const wait = Math.max(0, SPEC_MIN_SPLASH_MS - elapsed)
  setTimeout(() => attemptFinish(), wait)
}

function attemptFinish() {
  if (state.quitting) return
  const ok =
    state.host.isHealthy() &&
    state.main?.loaded &&
    state.main?.readyToShow &&
    !state.finishRequested &&
    performance.now() - state.t0 >= SPEC_MIN_SPLASH_MS
  if (!ok) return
  state.finishRequested = true
  state.main.show()
  state.ipc.pushSplashFinish()
  // 兜底：1000ms 未收到 splash 确认则强制销毁，避免卡在转场。
  state.finishTimer = setTimeout(() => {
    if (state.splash && !state.splash.isDestroyed()) {
      log.warn('splash finish confirm timeout, force destroy')
      state.splash.destroy()
    }
  }, SPEC_FINISH_TIMEOUT_MS)
}

function onSplashFinishConfirm() {
  if (state.finishTimer) { clearTimeout(state.finishTimer); state.finishTimer = null }
  // splash 页收到 dsh:splash-finish 后用 300ms css 淡出，再调 close。
  // 主进程不主动提前 destroy，避免露出空白桌面。
  if (state.splash && !state.splash.isDestroyed()) {
    setTimeout(() => {
      if (state.splash && !state.splash.isDestroyed()) state.splash.destroy()
    }, SPEC_FADE_MS)
  }
}

function onSplashCloseBeforeFinish() {
  // finishRequested 之前的 close 表示取消启动：必须停止 host，不留下后台进程。
  if (state.finishRequested) return
  log.warn('splash closed before finish, treating as cancel')
  state.quitting = true
  cleanupAndQuit().finally(() => app.exit(0))
}

function onUiLoadError() {
  // E_UI_LOAD：禁止 finish，清空代次，旧探测器作废，提供重试。
  state.generation++
  state.ipc.pushSplashStatus('界面加载失败，请重试')
  promptRetryOrExit('界面加载失败，请重试或退出。')
}

function promptRetryOrExit(message) {
  // 简化实现：原生对话框，默认退出。重试触发下一代次启动。
  state.generation++
  void dialog.showMessageBox({
    type: 'error',
    buttons: ['重试', '退出'],
    defaultId: 1,
    title: 'DSH Desktop',
    message,
  }).then(res => {
    if (res.response === 0) {
      state.host.stop().finally(() => {
        state.finishRequested = false
        tryStartHost()
      })
    } else {
      cleanupAndQuit().finally(() => app.exit(1))
    }
  })
}

function persistRunMode(mode) {
  const next = { ...state.config, runMode: mode }
  const cfgPath = join(app.getPath('userData'), 'config.json')
  const tmp = `${cfgPath}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
    renameSync(tmp, cfgPath)
    state.config = next
  } catch (err) {
    log.error('persist runMode failed', err)
  }
}

async function cleanupAndQuit() {
  if (state.quitting && state._cleaning) return
  state.quitting = true
  state._cleaning = true
  try {
    if (state.finishTimer) { clearTimeout(state.finishTimer); state.finishTimer = null }
    state.updater?.dispose?.()
    state.host?.stop?.()
    state.tray?.destroy?.()
    if (state.splash && !state.splash.isDestroyed()) state.splash.destroy()
    if (state.main?.win && !state.main.win.isDestroyed()) state.main.win.destroy()
    await state.host?.stopped?.()
  } catch (err) {
    log?.error?.('cleanup error', err)
  } finally {
    app.quit()
  }
}

// re-exports for tests and tooling
export { state, loadConfig, cleanupAndQuit, CHANNELS, SPEC_MIN_SPLASH_MS, SPEC_FADE_MS }