// 主窗口与受信本地页窗口的创建、安全策略与导航限制。
// 主窗口不挂桌面 preload；上游页面不得获得任何壳桥。
import { BrowserWindow, shell, session } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

/**
 * 策略文本。`allowEval` 只对上游 UI（loopback origin）开：
 * 上游 bundle 用 `new Function` 动态求值，脚本源缺 'unsafe-eval' 会抛
 * `EvalError: Refused to evaluate a string as JavaScript`，SPA 起不来 → 白屏。
 * 这是上游强制的放宽，不是壳主动降低标准；登记见 SPEC §11.1。
 * @param {number} port
 * @param {boolean} allowEval
 * @returns {string}
 */
const buildCsp = (port, allowEval) => [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${allowEval ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self' ws://127.0.0.1:${port}`,
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join('; ')

/** host（上游 UI）策略。 */
const HOST_CSP = (port) => buildCsp(port, true)
/**
 * 非 host origin（壳自己的 dsh-app:// 页面：splash / update-dialog / about）策略。
 * 与加 'unsafe-eval' 之前逐字一致：这些页面的脚本是我们自己写的，不需要也不允许 eval
 * （SPEC §9：本地页面禁止为通过测试加入 unsafe-eval）。
 */
const LOCAL_CSP = (port) => buildCsp(port, false)

/**
 * 创建主窗口控制器。
 * @param {{config:{port:number}, logger:import('./logger.js').Logger, isQuitting?:()=>boolean, isTrayReady?:()=>boolean}} opts
 * @returns {{win:import('electron').BrowserWindow|null, ensure:()=>boolean, loadURL:(url:string)=>Promise<void>, show:()=>void, openUpdateWindow:()=>void, loaded:boolean, readyToShow:boolean, once:(ev:string,fn:()=>void)=>void}}
 */
export function createMainWindow({ config, logger, isQuitting, isTrayReady }) {
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
      // 只按 origin 放宽：上游 UI 用 HOST_CSP（含 'unsafe-eval'），壳自己的页面保持原策略。
      const isHostOrigin = details.url.startsWith(`http://127.0.0.1:${config.port}/`)
      res.responseHeaders['Content-Security-Policy'] = [...upstream, isHostOrigin ? HOST_CSP(config.port) : LOCAL_CSP(config.port)]
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
      self.readyToShow = true
      self.emit?.('ready-to-show')
      // 重建场景：页面就绪即显示，避免用户点了托盘却什么都没出现。
      if (rebuilt && !w.isDestroyed()) { w.show(); w.focus() }
    })
    w.webContents.on('did-finish-load', () => { self.loaded = true })
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
        additionalArguments: [`--dsh-role=update`, `--dsh-version=${process.versions.electron}`],
      },
    })
    updateWin = newWin
    newWin.loadURL('dsh-app://ui/update-dialog.html')
    newWin.once('ready-to-show', () => newWin.show())
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