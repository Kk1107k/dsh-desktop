// 集中定义 channel、白名单、权限、处理器与推送出口；业务能力全部注入。
// 仅本文件操作 ipcMain.handle 和业务 webContents.send。
import { ipcMain } from 'electron'

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
function fail(code, message) { return { ok: false, error: { code, message } } }
/** 统一成功返回。 */
function ok(data) { return { ok: true, data } }

/**
 * 创建 IPC 控制器。
 * @param {object} deps
 */
export function createIpc(deps) {
  const { logger } = deps
  let updaterRef = deps.updater

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
        return fail('E_INTERNAL', err?.message || 'internal')
      }
    })

    ipcMain.handle(CHANNELS.SPLASH_MINIMIZE, async (event) => {
      try {
        if (!authorize(event, 'splash')) return fail('E_FORBIDDEN', 'not splash')
        deps.getSplash()?.()?.minimize?.()
        return ok({})
      } catch (err) { return fail('E_INTERNAL', err?.message) }
    })

    ipcMain.handle(CHANNELS.SPLASH_CLOSE, async (event) => {
      try {
        if (!authorize(event, 'splash')) return fail('E_FORBIDDEN', 'not splash')
        // finishRequested 之前 = 取消启动；之后 = 转场确认。
        deps.onSplashCloseBeforeFinish?.()
        return ok({})
      } catch (err) { return fail('E_INTERNAL', err?.message) }
    })

    ipcMain.handle(CHANNELS.CHECK_UPDATE, async (event) => {
      try {
        if (!authorize(event, 'update')) return fail('E_FORBIDDEN', 'not update page')
        if (!getElectronApp().isPackaged) return fail('E_UNPACKAGED', 'dev mode')
        const res = await updaterRef?.checkManual?.()
        return res ?? fail('E_INTERNAL', 'updater unavailable')
      } catch (err) { return fail('E_INTERNAL', err?.message) }
    })

    ipcMain.handle(CHANNELS.UPDATE_DOWNLOAD, async (event) => {
      try {
        if (!authorize(event, 'update')) return fail('E_FORBIDDEN', 'not update page')
        const res = await updaterRef?.startDownload?.()
        return res ?? fail('E_INTERNAL', 'updater unavailable')
      } catch (err) { return fail('E_INTERNAL', err?.message) }
    })

    ipcMain.handle(CHANNELS.UPDATE_SNOOZE, async (event) => {
      try {
        if (!authorize(event, 'update')) return fail('E_FORBIDDEN', 'not update page')
        const res = updaterRef?.snooze?.()
        return res ?? fail('E_INTERNAL', 'updater unavailable')
      } catch (err) { return fail('E_INTERNAL', err?.message) }
    })

    ipcMain.handle(CHANNELS.UPDATE_CLOSE, async (event) => {
      try {
        if (!authorize(event, 'update')) return fail('E_FORBIDDEN', 'not update page')
        const res = updaterRef?.close?.()
        return res ?? fail('E_IO', err?.message)
      } catch (err) { return fail('E_IO', err?.message) }
    })
  }

  function readRoleFromEvent(event) {
    const argv = event.senderFrame?.processArguments || []
    const arg = argv.find(a => typeof a === 'string' && a.startsWith('--dsh-role='))
    return arg ? arg.slice('--dsh-role='.length) : null
  }

  function getElectronApp() { return require('electron').app }

  function pushSplashStatus(text) {
    const win = deps.getSplash?.()
    if (!win || win.isDestroyed?.()) return
    deps.lastSplashStatus = text
    win.webContents.send(CHANNELS.SPLASH_STATUS, { text })
  }
  function pushSplashFinish() {
    const win = deps.getSplash?.()
    if (!win || win.isDestroyed?.()) return
    win.webContents.send(CHANNELS.SPLASH_FINISH, {})
  }
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