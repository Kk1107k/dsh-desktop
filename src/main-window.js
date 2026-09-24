// 主窗口与受信本地页窗口的创建、安全策略与导航限制。
// 主窗口不挂桌面 preload；上游页面不得获得任何壳桥。
import { BrowserWindow, shell, session } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

/**
 * @param {number} port
 * @returns {string}
 */
const HOST_CSP = (port) => [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
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
 * 创建主窗口控制器。
 * @param {{config:{port:number}, logger:import('./logger.js').Logger}} opts
 * @returns {{win:import('electron').BrowserWindow|null, loadURL:(url:string)=>Promise<void>, show:()=>void, openUpdateWindow:()=>void, loaded:boolean, readyToShow:boolean, once:(ev:string,fn:()=>void)=>void}}
 */
export function createMainWindow({ config, logger }) {
  const log = logger
  /** @type {import('electron').BrowserWindow|null} */ let win = null
  /** @type {import('electron').BrowserWindow|null} */ let updateWin = null
  const self = /** @type {{loaded:boolean, readyToShow:boolean, emit?:(ev:string)=>void}} */ ({ loaded: false, readyToShow: false })

  function create() {
    win = new BrowserWindow({
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

    // 默认拒绝任何新窗口；外部链接由主进程白名单打开。
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https:\/\//.test(url)) shell.openExternal(url)
      return { action: 'deny' }
    })

    // 仅允许当前 loopback origin 主框架导航；拦截跨源跳转、重定向、webview 附加。
    /** @param {import('electron').Event} e @param {string} url */
    const guardNav = (e, url) => {
      const allowed = new RegExp(`^http://127\\.0\\.0\\.1:${config.port}/`)
      if (!allowed.test(url)) e.preventDefault()
    }
    win.webContents.on('will-navigate', guardNav)
    win.webContents.on('will-redirect', guardNav)
    win.webContents.on('will-attach-webview', (e) => e.preventDefault())

    // host session 安装统一的 onHeadersReceived；不关闭 webSecurity，不忽略证书错误。
    const hostSession = win.webContents.session
    hostSession.webRequest.onHeadersReceived((details, cb) => {
      const res = { responseHeaders: { ...details.responseHeaders } }
      res.responseHeaders['Content-Security-Policy'] = [HOST_CSP(config.port)]
      cb(res)
    })

    win.once('ready-to-show', () => {
      self.readyToShow = true
      self.emit?.('ready-to-show')
    })
    win.webContents.on('did-finish-load', () => { self.loaded = true })
    win.webContents.on('render-process-gone', (_e, details) => {
      log.error('renderer gone', details)
      // 显示原生错误提示，禁止静默隐藏。
    })
    win.on('closed', () => { win = null })
  }

  create()

  /**
   * @param {string} url
   * @returns {Promise<void>}
   */
  function loadURL(url) {
    if (!win) return Promise.reject(new Error('main window not created'))
    return win.loadURL(url)
  }

  function show() {
    if (win && !win.isDestroyed()) { win.show(); win.focus() }
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

  return { get win() { return win }, loadURL, show, openUpdateWindow, get loaded() { return self.loaded }, get readyToShow() { return self.readyToShow }, once }
}