// 集中定义 channel、白名单、权限、处理器与推送出口；业务能力全部注入。
// 仅本文件操作 ipcMain.handle 和业务 webContents.send。
import { app, ipcMain } from 'electron'

/**
 * IPC channel 名集中常量。
 */
export const CHANNELS = {
  BRIDGE_READY: 'dsh:bridge-ready',
  SPLASH_MINIMIZE: 'dsh:splash-minimize',
  SPLASH_CLOSE: 'dsh:splash-close',
  CHECK_UPDATE: 'dsh:check-update',
  UPDATE_DOWNLOAD: 'dsh:update-download',
  UPDATE_SNOOZE: 'dsh:update-snooze',
  UPDATE_CLOSE: 'dsh:update-close',
  SPLASH_STATUS: 'dsh:splash-status',
  SPLASH_FINISH: 'dsh:splash-finish',
  UPDATE_STATE: 'dsh:update-state',
}

/** @typedef {'splash'|'update'} Role */
const ALLOWED_ROLE_PAGES = {
  splash: ['dsh-app://ui/splash.html'],
  update: ['dsh-app://ui/update-dialog.html'],
}

/**
 * 校验 sender 的角色与精确 URL，子 frame、上游窗口与未知 URL 一律拒绝。
 * @param {import('electron').IpcMainInvokeEvent} event
 * @param {Role} expectedRole
 * @returns {boolean}
 */
function authorize(event, expectedRole) {
  const wc = event.sender
  if (wc.isDestroyed?.()) return false
  const frame = event.senderFrame
  if (!frame || frame !== wc.mainFrame) return false
  const url = wc.getURL()
  return ALLOWED_ROLE_PAGES[expectedRole].includes(url)
}

/** 统一错误返回。 */
/**
 * @param {string} code
 * @param {string} message
 */
function fail(code, message) { return { ok: false, error: { code, message } } }
/** 统一成功返回。 */
/**
 * @param {object} data
 */
function ok(data) { return { ok: true, data } }

/**
 * @param {unknown} err
 * @returns {string}
 */
function errMessage(err) { return err instanceof Error ? err.message : String(err ?? 'internal') }

/**
 * @typedef {object} IpcDeps
 * @property {import('./logger.js').Logger} logger
 * @property {{checkManual?:()=>Promise<{ok:boolean, error?:{code:string,message:string}}>, startDownload?:()=>Promise<{ok:boolean, error?:{code:string,message:string}}>, snooze?:()=>{ok:boolean, error?:{code:string,message:string}}, close?:()=>{ok:boolean, error?:{code:string,message:string}}, getInternalSnapshot?:()=>object}|null} [updater]
 * @property {()=>import('electron').BrowserWindow|null} getSplash
 * @property {()=>import('electron').BrowserWindow|null} getMain
 * @property {()=>number} getGeneration
 * @property {()=>void} setFinishRequested
 * @property {()=>void} onSplashFinishConfirm
 * @property {()=>void} onSplashCloseBeforeFinish
 * @property {string} [lastSplashStatus]
 * @property {boolean} [finishRequested]
 * @property {()=>object|null} tray
 * @property {()=>Promise<boolean>} [closeUpdateWindow] 请求关闭更新窗口（由 M02 注入，内部走 M06 的唯一判据）
 */

/**
 * 创建 IPC 控制器。
 * @param {IpcDeps} deps
 */
export function createIpc(deps) {
  const { logger } = deps
  let updaterRef = deps.updater

  /**
   * @param {IpcDeps['updater']} u
   */
  function setUpdater(u) { updaterRef = u }

  function register() {
    ipcMain.handle(CHANNELS.BRIDGE_READY, async (event) => {
      try {
        const role = readRoleFromEvent(event)
        if (!role) return fail('E_FORBIDDEN', 'no role registered')
        if (!authorize(event, role)) return fail('E_FORBIDDEN', 'page not allowed for role')
        const bootstrap = {
          version: getElectronApp().getVersion(),
          status: deps.lastSplashStatus ?? '',
          finishRequested: !!deps.finishRequested,
          update: updaterRef?.getInternalSnapshot?.() ?? { state: 'idle' },
        }
        return ok(bootstrap)
      } catch (err) {
        logger.error('bridge-ready error', err)
        const msg = err instanceof Error ? err.message : 'internal'
        return fail('E_INTERNAL', msg)
      }
    })

    ipcMain.handle(CHANNELS.SPLASH_MINIMIZE, async (event) => {
      try {
        if (!authorize(event, 'splash')) return fail('E_FORBIDDEN', 'not splash')
        deps.getSplash?.()?.minimize?.()
        return ok({})
      } catch (err) { return fail('E_INTERNAL', errMessage(err)) }
    })

    ipcMain.handle(CHANNELS.SPLASH_CLOSE, async (event) => {
      try {
        if (!authorize(event, 'splash')) return fail('E_FORBIDDEN', 'not splash')
        // finishRequested 之前 = 取消启动；之后 = 转场确认。
        if (deps.finishRequested) deps.onSplashFinishConfirm?.()
        else deps.onSplashCloseBeforeFinish?.()
        return ok({})
      } catch (err) { return fail('E_INTERNAL', errMessage(err)) }
    })

    ipcMain.handle(CHANNELS.CHECK_UPDATE, async (event) => {
      try {
        if (!authorize(event, 'update')) return fail('E_FORBIDDEN', 'not update page')
        if (!getElectronApp().isPackaged) return fail('E_UNPACKAGED', 'dev mode')
        const res = await updaterRef?.checkManual?.()
        return res ?? fail('E_INTERNAL', 'updater unavailable')
      } catch (err) { return fail('E_INTERNAL', errMessage(err)) }
    })

    ipcMain.handle(CHANNELS.UPDATE_DOWNLOAD, async (event) => {
      try {
        if (!authorize(event, 'update')) return fail('E_FORBIDDEN', 'not update page')
        const res = await updaterRef?.startDownload?.()
        return res ?? fail('E_INTERNAL', 'updater unavailable')
      } catch (err) { return fail('E_INTERNAL', errMessage(err)) }
    })

    ipcMain.handle(CHANNELS.UPDATE_SNOOZE, async (event) => {
      try {
        if (!authorize(event, 'update')) return fail('E_FORBIDDEN', 'not update page')
        const res = updaterRef?.snooze?.()
        return res ?? fail('E_INTERNAL', 'updater unavailable')
      } catch (err) { return fail('E_INTERNAL', errMessage(err)) }
    })

    ipcMain.handle(CHANNELS.UPDATE_CLOSE, async (event) => {
      try {
        if (!authorize(event, 'update')) return fail('E_FORBIDDEN', 'not update page')
        // SPEC §7:248：页面 close() 与标题栏 X 同语义。M08 在 available 下把 close() 转成 snooze，
        // **成功才真正关窗**；失败（E_IO）保持窗口并把错误交回页面，让用户能重试。
        // 关窗能力由 M02 注入，内部走 M06 的 requestUpdateClose —— 判据只有那一处，不要在这里另写。
        const res = updaterRef?.close?.() ?? { ok: false, error: { code: 'E_IO', message: 'updater unavailable' } }
        if (!res.ok) return res
        await deps.closeUpdateWindow?.()
        return ok({})
      } catch (err) { return fail('E_IO', errMessage(err)) }
    })
  }

  /**
   * @param {import('electron').IpcMainInvokeEvent} event
   * @returns {Role|null}
   */
  function readRoleFromEvent(event) {
    // processArguments 存在于运行时（Electron 26+），typings 未收录，此处显式补型。
    const frame = /** @type {import('electron').WebFrameMain & {processArguments?:string[]}} */ (event.senderFrame)
    const argv = frame?.processArguments || []
    const arg = argv.find(a => typeof a === 'string' && a.startsWith('--dsh-role='))
    return arg ? /** @type {Role} */ (arg.slice('--dsh-role='.length)) : null
  }

  function getElectronApp() { return app }

  /**
   * @param {string} text
   */
  function pushSplashStatus(text) {
    const win = deps.getSplash?.()
    if (!win || win.isDestroyed?.()) return
    deps.lastSplashStatus = text
    win.webContents.send(CHANNELS.SPLASH_STATUS, { text })
  }
  function pushSplashFinish() {
    // 转场请求已发出：此后 splash 的 close 即「转场确认」而不是「取消启动」（SPEC §4 / D2）。
    deps.finishRequested = true
    deps.setFinishRequested?.()
    const win = deps.getSplash?.()
    if (!win || win.isDestroyed?.()) return
    win.webContents.send(CHANNELS.SPLASH_FINISH, {})
  }
  /**
   * @param {{revision:number, snapshot:object}} ev
   */
  function pushUpdateState(ev) {
    const main = deps.getMain?.()
    if (!main || main.isDestroyed?.()) return
    main.webContents.send(CHANNELS.UPDATE_STATE, ev)
  }

  function dispose() {
    Object.values(CHANNELS).forEach(c => { try { ipcMain.removeHandler(c) } catch (_) { /* */ } })
  }

  return { register, setUpdater, pushSplashStatus, pushSplashFinish, pushUpdateState, dispose }
}