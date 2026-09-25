// 验收测试专用的 electron 假件。行为经 globalThis.__DSH_TEST_ELECTRON__ 配置：
//   { userData?: string, version?: string, isPackaged?: boolean, lock?: boolean, quitCalls?: number }
// whenReady 永不 resolve：main.js 的 bootstrap 不会在测试里被触发，
// 测试只覆盖模块级逻辑（单例锁、loadConfig、IPC 注册等）。
import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const cfg = () => {
  if (!globalThis.__DSH_TEST_ELECTRON__) {
    globalThis.__DSH_TEST_ELECTRON__ = { userData: null, version: '0.1.0', isPackaged: true, lock: true, quitCalls: 0 }
  }
  return globalThis.__DSH_TEST_ELECTRON__
}

class FakeApp extends EventEmitter {
  enableSandbox() {}
  setName() {}
  requestSingleInstanceLock() { return cfg().lock !== false }
  getPath(_name) {
    if (!cfg().userData) cfg().userData = mkdtempSync(join(tmpdir(), 'dsh-stub-userdata-'))
    return cfg().userData
  }
  getVersion() { return cfg().version ?? '0.1.0' }
  get isPackaged() { return cfg().isPackaged !== false }
  whenReady() { return new Promise(() => { /* 不触发 bootstrap */ }) }
  quit() { cfg().quitCalls = (cfg().quitCalls ?? 0) + 1 }
  exit(_code) {}
  relaunch() {}
}

export const app = new FakeApp()

/** ipcMain 假件：把 handler 收进 Map 供测试直接调用与校验。 */
export const ipcMain = {
  handlers: new Map(),
  handle(channel, fn) { this.handlers.set(channel, fn) },
  removeHandler(channel) { this.handlers.delete(channel) },
}

/** BrowserWindow 假件：够 main-window/tray 顶层引用即可，测试不构造真实窗口。 */
export class BrowserWindow extends EventEmitter {
  constructor(_opts) {
    super()
    this.webContents = Object.assign(new EventEmitter(), {
      session: { webRequest: { onHeadersReceived() {} } },
      setWindowOpenHandler() {},
      isLoading: () => false,
      getURL: () => 'about:blank',
      send() {},
    })
  }
  loadURL() { return Promise.resolve() }
  show() {}
  focus() {}
  minimize() {}
  hide() {}
  isDestroyed() { return false }
  destroy() {}
}

export const protocol = {
  registerSchemesAsPrivileged() {},
  handle() {},
}
/** net 假件：main.js 的 dsh-app 协议处理器经它读包内页面；测试不走该路径，够顶层引用即可。 */
export const net = { fetch: async () => new Response('', { status: 200 }) }
export const session = { defaultSession: new EventEmitter() }
export const dialog = { showMessageBox: async () => ({ response: 0 }) }
export const shell = { openExternal: async () => {} }

/** Tray 假件：只记录调用。 */
export class Tray {
  constructor(_image) { this.toolTips = []; this.images = [] }
  setToolTip(t) { this.toolTips.push(t) }
  setContextMenu(_m) {}
  setImage(img) { this.images.push(img) }
  on() {}
  destroy() {}
}

/** Menu 假件：透传 template 并挂到 globalThis 供测试断言。 */
export const Menu = {
  buildFromTemplate(template) {
    globalThis.__DSH_TEST_MENU__ = template
    return template
  },
}
export const nativeImage = { createFromPath: (p) => ({ path: p }) }
