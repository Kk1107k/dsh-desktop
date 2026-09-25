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
 * @property {{checkManual?:()=>Promise<{ok:boolean, error?:{code:string,message:string}}>, startDownload?:()=>Promise<{ok:boolean, error?:{code:string,message:string}}>, snooze?:()=>{ok:boolean, error?:{code:string,message:string}}, close?:()=>{ok:boolean, error?:{code:string,message:string}}, getInternalEvent?:()=>({revision:number, snapshot:object})}|null} [updater]
 * @property {()=>import('electron').BrowserWindow|null} getSplash
 * @property {()=>import('electron').BrowserWindow|null} getMain
 * @property {()=>import('electron').BrowserWindow|null} [getUpdate] 更新窗口（`dsh:update-state` 的接收方，SPEC §5:174）
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
        // 拒绝要留痕：bridge-ready 被拒会让页面永远停在静态初始 DOM（无状态可渲染），
        // 而这在渲染进程侧几乎不可观测 —— 实测排查该故障时就卡在这里。
        if (!role) {
          logger.warn(`bridge-ready 被拒：页面 URL 不在任何已登记角色内（url=${event?.sender?.getURL?.() ?? '?'}）`)
          return fail('E_FORBIDDEN', 'no role registered')
        }
        if (!authorize(event, role)) {
          logger.warn(`bridge-ready 被拒：页面不在角色 ${role} 的白名单内（url=${event?.sender?.getURL?.() ?? '?'}）`)
          return fail('E_FORBIDDEN', 'page not allowed for role')
        }
        const bootstrap = {
          version: getElectronApp().getVersion(),
          status: deps.lastSplashStatus ?? '',
          finishRequested: !!deps.finishRequested,
          // SPEC §5:156：update 必须是 UpdateEvent（{revision, snapshot}），不是裸快照。
          update: updaterRef?.getInternalEvent?.() ?? { revision: 0, snapshot: { state: 'idle' } },
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
    // 角色由**主进程登记的页面白名单**推导（SPEC §9:272「桥的可用角色由主进程登记，
    // 不能由页面参数自行声明」）。sender.getURL() 由主进程侧报告，页面无法伪造。
    //
    // ⚠ 不要改回读 `senderFrame.processArguments`：真实 Electron 里该字段读不到
    // （实测线上：splash 与 update 页的 bridge-ready 全被拒 ⇒ preload 缓存永远空 ⇒
    // 页面永久停在静态初始 DOM）。它在 mock 里一直"绿"，只因为用例手工伪造了
    // frame.processArguments —— 真实形状是"帧上没有该字段"。
    const url = event?.sender?.getURL?.() ?? ''
    for (const [role, pages] of Object.entries(ALLOWED_ROLE_PAGES)) {
      if (pages.includes(url)) return /** @type {Role} */ (role)
    }
    return null
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
    // SPEC §5:174：`dsh:update-state` 的接收方是 **update 页面**（住在更新窗口里）。
    // 曾发到主窗口 —— 主窗口不挂 preload、没有任何订阅者，推送等于丢掉：页面除了初值之外永不更新。
    const target = deps.getUpdate?.()
    if (!target || target.isDestroyed?.()) return
    target.webContents.send(CHANNELS.UPDATE_STATE, ev)
  }

  function dispose() {
    Object.values(CHANNELS).forEach(c => { try { ipcMain.removeHandler(c) } catch (_) { /* */ } })
  }

  return { register, setUpdater, pushSplashStatus, pushSplashFinish, pushUpdateState, dispose }
}