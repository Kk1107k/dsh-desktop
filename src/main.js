// 启动编排唯一入口：所有退出路径必须经 cleanupAndQuit，禁止在别处直接 app.quit。
import { app, BrowserWindow, dialog, protocol, session } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, copyFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createLogger } from './logger.js'
import { createDshHost } from './dsh-host.js'
import { createMainWindow, LOCAL_PAGE_CSP } from './main-window.js'
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
/** D2 第 2 层：did-finish-load 后仍未 ready-to-show 时，等这么久就把主窗口显示出来推进转场。 */
const SPEC_READY_FALLBACK_MS = 800
/** D2 第 3 层：门控轮询间隔（有界，到期即 E_UI_LOAD）。 */
const SPEC_GATE_POLL_MS = 500

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
  gateTimer: null,
  gateDeadline: 0,
  uiErrorShown: false,
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

/**
 * dsh-app 请求处理器：仅放行白名单页面，并拒绝任何越出 __dirname 的路径。
 * 注意：protocol.handle 只传 request 且要求返回 Response；旧版 registerFileProtocol 的
 * (request, callback) 形态会让 callback 为 undefined（TypeError: callback is not a function，
 * 表现为 splash 以 ERR_UNEXPECTED 加载失败）。文件经 net.fetch 读取以保留 MIME 与流式。
 * @param {Request} request
 * @returns {Promise<Response>}
 */
/** 版本占位符：只在白名单本地页里做精确替换，见 renderLocalPage。 */
const VERSION_PLACEHOLDER = '__APP_VERSION__'
/** 允许经 dsh-app 协议访问的壳页面；同一份名单也限定了版本替换的适用范围。 */
const LOCAL_PAGES = new Set(['splash.html', 'update-dialog.html', 'about.html'])

/**
 * 把本地页文本中的版本占位符替换为给定版本（纯函数，便于直接断言）。
 * 只做精确占位符替换：不含占位符的文本原样返回，不改写任何其他内容。
 * @param {string} html
 * @param {string} version
 * @returns {string}
 */
export function renderLocalPage(html, version) {
  return html.split(VERSION_PLACEHOLDER).join(version)
}

/**
 * 取 HTML 文本里所有 inline `<script>` 的 CSP 哈希源（已带单引号），供 script-src 使用。
 * 三个必须踩准的点：
 *   1. HTML 解析器会把输入流的 CRLF/CR 规范化为 LF，浏览器取哈希用的是规范化后的文本
 *      （生成产物是 CRLF）—— 不规范化则哈希永不匹配，脚本被自己的 CSP 拦住；
 *   2. CSP 的哈希源必须带单引号，裸串会被 Chromium 判为 "invalid source" 整条忽略；
 *   3. **顺序**：哈希必须按"将要发送的文本"算 —— 先替换占位符、再调本函数，不能反。
 * @param {string} html
 * @returns {string[]} 形如 `'sha256-<base64>'`
 */
function inlineScriptHashes(html) {
  /** @type {string[]} */
  const hashes = []
  const re = /<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi
  let m
  while ((m = re.exec(html)) !== null) {
    if (!m[1]) continue
    const text = m[1].replace(/\r\n?/g, '\n')
    hashes.push(`'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`)
  }
  return hashes
}

/**
 * dsh-app 请求处理器：仅放行白名单页面，并拒绝任何越出 __dirname 的路径。
 * 注意：protocol.handle 只传 request 且要求返回 Response；旧版 registerFileProtocol 的
 * (request, callback) 形态会让 callback 为 undefined（TypeError: callback is not a function，
 * 表现为 splash 以 ERR_UNEXPECTED 加载失败）。
 * 响应集中做两件事（都在这里，便于一处审查）：
 *   1. 版本占位符替换为 app.getVersion()（SPEC D4；about 页不挂 preload，故走响应期注入）；
 *   2. 下发本地页 CSP（SPEC §9：协议响应同时携带同一 CSP，script-src 用实际脚本哈希）。
 * @param {Request} request
 * @returns {Promise<Response>}
 */
export async function handleDshAppRequest(request) {
  const url = new URL(request.url)
  if (url.host !== 'ui') return new Response('not found', { status: 404 })
  const rel = url.pathname.replace(/^\/+/, '')
  // 同一份白名单限定两件事：可被协议访问的页面，以及允许做版本替换的范围。
  if (!LOCAL_PAGES.has(rel)) return new Response('not found', { status: 404 })
  const safe = join(__dirname, rel).replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  const base = __dirname.replace(/\\/g, '/').replace(/\/$/, '')
  if (!safe.startsWith(base + '/')) return new Response('forbidden', { status: 403 })
  // 顺序：先替换占位符、再算哈希，CSP 必须与**实际发送的文本**一致（顺序反了脚本会被自己的 CSP 拦掉）。
  const body = renderLocalPage(readFileSync(safe, 'utf8'), app.getVersion())
  const headers = new Headers({ 'content-type': 'text/html; charset=utf-8' })
  headers.set('Content-Security-Policy', LOCAL_PAGE_CSP(inlineScriptHashes(body)))
  return new Response(body, { status: 200, headers })
}

/**
 * SPEC §9:283：权限请求与权限检查一律默认拒绝 —— 不自动授权摄像头、麦克风、定位、通知、
 * 屏幕捕获或任意设备访问。必须在任何窗口加载前装好，否则 Electron 的内置默认会先放行一批。
 * @param {import('electron').Session} ses
 */
function hardenSession(ses) {
  ses.setPermissionRequestHandler((_wc, _permission, cb) => cb(false))
  ses.setPermissionCheckHandler(() => false)
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
    if (state.main?.win && !state.main.win.isDestroyed()) { state.main.show(); return }
    if (state.splash && !state.splash.isDestroyed()) { state.splash.focus(); return }
    // 主窗口已销毁且非退出中：走与托盘同一条重建路径（SPEC §8 第 1 条），而不是静默空转。
    void reopenMainWindow()
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

app.on('window-all-closed', () => {
  // 「关闭 → 隐藏到托盘」的职责已移交给 M06 的窗口 close 拦截（SPEC §4）。
  // 本事件在所有窗口**已销毁之后**才触发，其 preventDefault 在 Windows 上拦不住销毁
  // （那只用于 macOS 阻止退出），故这里只表达"确实没有窗口了"的退出语义：
  // quitting 中 → 退出；托盘未就绪 → 退出，避免无窗口常驻。
  if (state.quitting || !state.tray) app.quit()
})

async function bootstrap() {
  state.config = loadConfig()
  log = await createLogger()
  global.log = log

  // SPEC §9:283：权限默认拒绝，必须在任何窗口加载前装好。
  hardenSession(session.defaultSession)

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

  state.main = createMainWindow({
    config: state.config,
    logger: log,
    // 只注入取值函数：M06 不直接读 main.js 的私有 state。
    isQuitting: () => state.quitting,
    isTrayReady: () => !!state.tray,
    // SPEC §7:248：更新窗口的 X 与页面 close() 同语义 —— M08 在 available 下会转 snooze。
    onUpdateCloseRequest: async () => {
      const res = state.updater?.close?.() ?? { ok: true }
      if (res?.ok) return true
      // 延后失败（E_IO）：与页面按钮路径同语义，不关窗并给原生提示，让用户能重试。
      void dialog.showMessageBox({
        type: 'error',
        title: 'DSH Desktop',
        message: '延后失败：未能写入延后记录。请重试，或改用立即更新。',
      })
      return false
    },
  })

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

  // D2 兜底（SPEC §11.1 登记为"主判据不变、增加兜底路径"）：实测 ready-to-show 在隐藏窗口上
  // 会因 GPU/驱动组合抖动而不到（4 次里 3 次缺），单靠它会把转场永久卡死。
  // did-finish-load 已到但 ready-to-show 未到时，先把主窗口显示出来让首帧得以绘制。
  // 窗口已设 backgroundColor:#0f1419，不会白闪；且早于 2400ms 门控，用户看不到差别。
  state.main.once('loaded', () => {
    log.info(`主窗口 did-finish-load 已到，装配 ${SPEC_READY_FALLBACK_MS}ms 兜底定时器（第 2 层）`)
    setTimeout(() => {
      if (state.quitting) return
      if (!state.main?.win || state.main.win.isDestroyed()) return
      if (state.main.readyToShow) {
        log.info('did-finish-load 兜底到期时 ready-to-show 已到（第 1 层已满足），无需干预')
        return
      }
      log.warn('ready-to-show 未到，按 did-finish-load 兜底显示')
      state.main.show()
    }, SPEC_READY_FALLBACK_MS)
  })

  state.tray = createTray({
    logger: log,
    onOpen: () => { void reopenMainWindow() },
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
    // SPEC §4「splash 保持在上方淡出」：不置顶的话主窗口一 show 就盖住 splash，
    // 被遮挡的渲染进程计时器受节流，页面 300ms 淡出后调 close() 会晚于 1000ms 兜底。
    alwaysOnTop: true,
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
  state.host.on('ready', async ({ generation }) => {
    if (generation !== state.generation) return
    // SPEC §8:264：host 健康 → 绿色徽章（优先级低于 update，由 M07 内部推导）。
    state.tray?.setHostHealthy?.(true)
    state.ipc.pushSplashStatus('就绪')
    // 上游 index 需进程 token 换 cookie 后才可访问（SPEC §11.1）：先在同一 session 内完成
    // 交换，再用干净 URL 加载主窗口，避免落到 401 页面。token 不入日志、不进页面契约。
    await state.host.authorize(session.defaultSession)
    if (generation !== state.generation || state.quitting) return
    state.ipc.pushSplashStatus('正在加载界面…')
    loadMainWindow()
  })
  state.host.on('timeout', ({ generation }) => {
    if (generation !== state.generation) return
    if (state.quitting) return
    // SPEC §6:203：失联/重启期间取消绿色。
    state.tray?.setHostHealthy?.(false)
    state.ipc.pushSplashStatus('服务启动超时')
    promptRetryOrExit('服务启动超时，请重试或退出。')
  })
  state.host.on('crashed', ({ generation }) => {
    if (generation !== state.generation) return
    if (state.quitting) return
    state.tray?.setHostHealthy?.(false)
    state.ipc.pushSplashStatus('服务异常，正在重试…')
  })
  state.host.on('exited', ({ generation }) => {
    if (generation !== state.generation) return
    if (state.quitting) return
    state.tray?.setHostHealthy?.(false)
    state.ipc.pushSplashStatus('服务已退出，正在重试…')
  })
}

function loadMainWindow() {
  if (state.quitting || state.generation !== state.host.currentGeneration()) return
  const url = `http://127.0.0.1:${state.host.port}`
  // 门控第 3 层的起点放在这里而不是 ready-to-show 上：即使 did-finish-load / ready-to-show
  // 两个事件都不来，轮询也会启动并在 10s 后走 E_UI_LOAD，不会永久停在 splash。
  scheduleFinalGate()
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

/**
 * 托盘「打开 DSH 桌面」：窗口还在就显示；已销毁则经 M06 重建，并在重建后重新换取
 * cookie 再加载同一 origin（SPEC §8 第 1 条 + §11.1 的 token 交换）。
 */
async function reopenMainWindow() {
  if (state.quitting) return
  const rebuilt = state.main?.ensure?.() === true
  if (!rebuilt) { state.main?.show?.(); return }
  if (state.host?.isHealthy?.()) await state.host.authorize(session.defaultSession)
  if (state.quitting) return
  try {
    await state.main.loadURL(`http://127.0.0.1:${state.host?.port ?? state.config.port}`)
  } catch (err) {
    // 加载失败也要把窗口显示出来，避免"点了托盘却什么都没出现"。
    log.error('main window reopen load failed', err)
  }
  if (state.quitting) return
  state.main.show()
}

/**
 * 转场门控（D2 修订，登记见 SPEC §11.1）——**三层是兜底关系，不是并列条件**：
 *   第 1 层（主判据）`ready-to-show`：正常情形，主窗口已绘制，转场最平滑。
 *   第 2 层 `did-finish-load` + 800ms 兜底：ready-to-show 因渲染/驱动抖动不来时，
 *          先把主窗口显示出来让首帧得以绘出（见 did-finish-load 处的定时器）。
 *   第 3 层 有界轮询评估：以上都没能把窗口显示出来时，每 500ms 复核一次门控条件；
 *          到 SPEC_MAIN_LOAD_TIMEOUT_MS 仍未通过 → 走 E_UI_LOAD（重试/退出对话框），
 *          **绝不允许无限等**。
 * 任一层让 attemptFinish 通过即完成转场。每次评估都记 gate 日志，便于事后定位卡在哪。
 */
function scheduleFinalGate() {
  if (state.gateTimer) return
  const elapsed = performance.now() - state.t0
  const wait = Math.max(0, SPEC_MIN_SPLASH_MS - elapsed)
  state.gateDeadline = performance.now() + SPEC_MAIN_LOAD_TIMEOUT_MS
  log.info(`转场门控启动：wait=${Math.round(wait)}ms deadline=${SPEC_MAIN_LOAD_TIMEOUT_MS}ms`)
  state.gateTimer = setTimeout(function poll() {
    state.gateTimer = null
    if (state.quitting) return
    if (attemptFinish()) return
    if (performance.now() >= state.gateDeadline) {
      log.error('转场门控到期内未通过，走 E_UI_LOAD')
      onUiLoadError()
      return
    }
    state.gateTimer = setTimeout(poll, SPEC_GATE_POLL_MS)
  }, wait)
}

/**
 * 评估一次转场条件；通过则发起转场并返回 true。
 * @returns {boolean}
 */
function attemptFinish() {
  if (state.quitting) return true
  const hostHealthy = state.host.isHealthy()
  const mainLoaded = !!state.main?.loaded
  const readyToShow = !!state.main?.readyToShow
  const elapsed = Math.round(performance.now() - state.t0)
  // 每次评估都记一行：卡住时这行直接说明是哪个条件为假。
  log.info(`gate: hostHealthy=${hostHealthy} mainLoaded=${mainLoaded} readyToShow=${readyToShow} elapsed=${elapsed}`)
  const ok =
    hostHealthy &&
    mainLoaded &&
    readyToShow &&
    !state.finishRequested &&
    elapsed >= SPEC_MIN_SPLASH_MS
  if (!ok) return false
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
  return true
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
  // 门控轮询与 loadMainWindow 的加载看门狗都可能走到这里，同一代次只弹一次对话框。
  if (state.uiErrorShown) return
  state.uiErrorShown = true
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
        state.uiErrorShown = false
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
    if (state.gateTimer) { clearTimeout(state.gateTimer); state.gateTimer = null }
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