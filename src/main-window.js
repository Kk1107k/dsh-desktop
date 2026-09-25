// 主窗口与受信本地页窗口的创建、安全策略与导航限制。
// 主窗口不挂桌面 preload；上游页面不得获得任何壳桥。
import { app, BrowserWindow, shell, session } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

/**
 * 本地页（壳自己的 dsh-app 页面：splash / update-dialog / about）专用 session 的 partition 名。
 * 无 `persist:` 前缀 = 内存 session，不落盘、不共享 host 的 cookie 罐（SPEC §9:275）。
 * 注意：**host 侧必须留在默认 session** —— 主窗口鉴权用的 token→cookie 换取落在默认 session，
 * 两条链路必须同一个 session，分离不能把鉴权一起隔开。
 */
export const LOCAL_PARTITION = 'dsh-local'

/**
 * host（上游 UI，loopback origin）策略。
 * script-src 的 'unsafe-eval' 是上游强制的放宽：其 bundle 用 `new Function` 动态求值，
 * 缺它会抛 `EvalError: Refused to evaluate a string as JavaScript`，SPA 起不来 → 白屏。
 * 不是壳主动降低标准；登记见 SPEC §11.1。
 * @param {number} port
 * @returns {string}
 */
const HOST_CSP = (port) => [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self' ws://127.0.0.1:${port}`,
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join('; ')

/**
 * 壳自己的页面（`dsh-app://`：splash / update-dialog / about）策略，逐字对齐 SPEC §9。
 * script-src 只认包内**实际 inline script** 的 SHA-256，不用 'unsafe-inline'
 * （本地脚本是我们自己的，不需要也不允许 eval）。
 * @param {string[]} hashes 形如 `sha256-<base64>`
 * @returns {string}
 */
export const LOCAL_PAGE_CSP = (hashes) => [
  "default-src 'self'",
  ['script-src', "'self'", ...hashes].join(' '),
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ')

/**
 * 本地页窗口的统一围栏（SPEC §9:281/282）：
 * 只允许停留在自己的 dsh-app 页面（其余导航与重定向一律拦下），禁开新窗、禁嵌 webview。
 * 本地页的 preload 桥按角色常驻于该窗口，一旦被导航走，新页面会连同桥一起被交出去。
 * @param {import('electron').BrowserWindow} win
 * @param {string} allowedUrl 该窗口唯一允许停留的页面 URL
 */
export function hardenLocalPageWindow(win, allowedUrl) {
  /** @param {import('electron').Event} e @param {string} url */
  const guard = (e, url) => { if (url !== allowedUrl) e.preventDefault() }
  win.webContents.on('will-navigate', guard)
  win.webContents.on('will-redirect', guard)
  win.webContents.on('will-attach-webview', (e) => e.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
}

/**
 * 创建主窗口控制器。
 * @param {{config:{port:number}, logger:import('./logger.js').Logger, isQuitting?:()=>boolean, isTrayReady?:()=>boolean, onUpdateCloseRequest?:()=>Promise<boolean>}} opts
 * @returns {{win:import('electron').BrowserWindow|null, ensure:()=>boolean, loadURL:(url:string)=>Promise<void>, show:()=>void, openUpdateWindow:()=>void, loaded:boolean, readyToShow:boolean, once:(ev:string,fn:()=>void)=>void}}
 */
export function createMainWindow({ config, logger, isQuitting, isTrayReady, onUpdateCloseRequest }) {
  const log = logger
  /** @type {import('electron').BrowserWindow|null} */ let win = null
  /** @type {import('electron').BrowserWindow|null} */ let updateWin = null
  const self = /** @type {{loaded:boolean, readyToShow:boolean, emit?:(ev:string)=>void}} */ ({ loaded: false, readyToShow: false })

  /**
   * @param {boolean} [rebuilt] 是否为重建（销毁后由托盘唤回），重建时页面就绪即显示。
   */
  function create(rebuilt = false) {
    /** @type {import('electron').BrowserWindow} */
    const w = new BrowserWindow({
      width: 1280, height: 800, minWidth: 960, minHeight: 640,
      show: false, backgroundColor: '#0f1419',
      title: 'DSH Desktop',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        webviewTag: false,
        sandbox: true,
        // 不设 preload：上游页面不获得桌面桥。
      },
    })
    win = w
    self.loaded = false
    self.readyToShow = false

    // 默认拒绝任何新窗口；外部链接由主进程白名单打开。
    w.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https:\/\//.test(url)) shell.openExternal(url)
      return { action: 'deny' }
    })

    // 仅允许当前 loopback origin 主框架导航；拦截跨源跳转、重定向、webview 附加。
    /** @param {import('electron').Event} e @param {string} url */
    const guardNav = (e, url) => {
      const allowed = new RegExp(`^http://127\\.0\\.0\\.1:${config.port}/`)
      if (!allowed.test(url)) e.preventDefault()
    }
    w.webContents.on('will-navigate', guardNav)
    w.webContents.on('will-redirect', guardNav)
    w.webContents.on('will-attach-webview', (e) => e.preventDefault())

    // host session 安装统一的 onHeadersReceived；不关闭 webSecurity，不忽略证书错误。
    const hostSession = w.webContents.session
    hostSession.webRequest.onHeadersReceived((details, cb) => {
      // 只管上游 UI。壳自己的 dsh-app:// 页面由协议响应自带 CSP（SPEC §9 要求
      // "协议响应同时携带同一 CSP，禁止依赖页面伪造值"），这里再插一手只会造成双重策略。
      if (!details.url.startsWith(`http://127.0.0.1:${config.port}/`)) return cb({})
      const res = { responseHeaders: { ...details.responseHeaders } }
      // SPEC §9：上游自带的 CSP 保留并与壳策略共同生效（多重 CSP 为合取，更严格者胜出）。
      // 实测 0.1.7-alpha.2 不发 CSP（见 §11.1），故此处通常为空。
      /** @type {string[]} */
      const upstream = []
      for (const key of Object.keys(res.responseHeaders)) {
        if (key.toLowerCase() === 'content-security-policy') {
          upstream.push(.../** @type {string[]} */ ([].concat(res.responseHeaders[key])))
          delete res.responseHeaders[key]
        }
      }
      res.responseHeaders['Content-Security-Policy'] = [...upstream, HOST_CSP(config.port)]
      cb(res)
    })

    // SPEC §4：主窗口关闭且 quitting=false 时 preventDefault + hide（隐藏到托盘）。
    // 必须挂在窗口自身的 'close' 上：'window-all-closed' 在窗口已销毁后才触发，
    // 在 Windows 上拦不住销毁（preventDefault 仅用于 macOS 阻止退出）。
    w.on('close', (e) => {
      if (isQuitting?.()) return          // 真退出：放行
      if (!isTrayReady?.()) return        // 托盘未就绪：放行，避免窗口关不掉（SPEC §4）
      e.preventDefault()
      if (!w.isDestroyed()) w.hide()
    })

    w.once('ready-to-show', () => {
      log.info('主窗口 ready-to-show 到达')
      self.readyToShow = true
      self.emit?.('ready-to-show')
      // 重建场景：页面就绪即显示，避免用户点了托盘却什么都没出现。
      if (rebuilt && !w.isDestroyed()) { w.show(); w.focus() }
    })
    w.webContents.on('did-finish-load', () => {
      log.info('主窗口 did-finish-load 到达')
      self.loaded = true
      self.emit?.('loaded')
    })
    w.webContents.on('render-process-gone', (_e, details) => {
      log.error('renderer gone', details)
      // 显示原生错误提示，禁止静默隐藏。
    })
    w.on('closed', () => { if (win === w) win = null })
  }

  create()

  /**
   * 确保主窗口存在：已销毁时重建（SPEC §8 第 1 条）。
   * @returns {boolean} true = 本次发生了重建
   */
  function ensure() {
    if (win && !win.isDestroyed()) return false
    create(true)
    return true
  }

  /**
   * @param {string} url
   * @returns {Promise<void>}
   */
  function loadURL(url) {
    if (!win) return Promise.reject(new Error('main window not created'))
    return win.loadURL(url)
  }

  function show() {
    if (ensure()) return                 // 重建中：由 ready-to-show 负责显示
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  }

  /**
   * @returns {void}
   */
  function openUpdateWindow() {
    if (updateWin && !updateWin.isDestroyed()) { updateWin.show(); updateWin.focus(); return }
    const newWin = new BrowserWindow({
      width: 560, height: 420, resizable: false,
      parent: win ?? undefined, modal: true, show: false,
      title: '更新',
      webPreferences: {
        preload: join(__dirname, '..', 'build', 'preload.cjs'),
        contextIsolation: true, nodeIntegration: false,
        webSecurity: true, sandbox: true, webviewTag: false,
        partition: LOCAL_PARTITION,
        // 版本统一来自 app.getVersion()（SPEC D4）。曾误传 process.versions.electron：
        // 更新页的 updateAPI 目前没有 getVersion()，故无实际影响，但属活陷阱（谁加上就会拿到 Electron 版本）。
        additionalArguments: [`--dsh-role=update`, `--dsh-version=${app.getVersion()}`],
      },
    })
    updateWin = newWin
    hardenLocalPageWindow(newWin, 'dsh-app://ui/update-dialog.html')
    newWin.loadURL('dsh-app://ui/update-dialog.html')
    newWin.once('ready-to-show', () => newWin.show())
    // SPEC §7:248：available 状态下窗口 X 与页面 close() 同语义（都要走 snooze）。
    // 落盘结果只有 M08 知道，所以这里先拦下、再按注入的回调结果处置：允许才真的销毁。
    if (onUpdateCloseRequest) {
      newWin.on('close', (e) => {
        e.preventDefault()
        void onUpdateCloseRequest().then(allow => {
          if (allow && !newWin.isDestroyed()) newWin.destroy()
        }, () => {
          // 回调异常不得把窗口卡死：按"不允许"处理（保持窗口，用户可重试）。
        })
      })
    }
    newWin.on('closed', () => { updateWin = null })
  }

  // 简易 once：从外部订阅 'ready-to-show'
  /** @type {Map<string, Set<()=>void>>} */
  const listeners = new Map()
  self.emit = (ev) => { listeners.get(ev)?.forEach(fn => { try { fn() } catch (e) { log.error(e) } }) }
  /**
   * @param {string} ev
   * @param {()=>void} fn
   */
  function once(ev, fn) {
    if (!listeners.has(ev)) listeners.set(ev, new Set())
    listeners.get(ev)?.add(fn)
  }

  return { get win() { return win }, ensure, loadURL, show, openUpdateWindow, get loaded() { return self.loaded }, get readyToShow() { return self.readyToShow }, once }
}