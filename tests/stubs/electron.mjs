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

/**
 * BrowserWindow 假件：够 main-window/tray 顶层引用即可。
 * 记录销毁/最小化/显示状态，供「关闭→隐藏 / 托盘唤回」用例断言；实例经
 * globalThis.__DSH_TEST_WINDOWS__ 暴露给测试。
 */
export class BrowserWindow extends EventEmitter {
  constructor(opts) {
    super()
    this.opts = opts
    this.destroyed = false
    this.minimized = false
    this.shown = false
    this.hidden = false
    this.webContents = Object.assign(new EventEmitter(), {
      session: { webRequest: { onHeadersReceived() {} } },
      setWindowOpenHandler(fn) { this.windowOpenHandler = fn },
      isLoading: () => false,
      getURL: () => 'about:blank',
      send() {},
    })
    ;(globalThis.__DSH_TEST_WINDOWS__ ??= []).push(this)
  }
  loadURL() { return Promise.resolve() }
  show() { this.shown = true }
  focus() {}
  minimize() { this.minimized = true }
  restore() { this.minimized = false }
  hide() { this.hidden = true }
  isMinimized() { return this.minimized }
  isDestroyed() { return this.destroyed }
  /** 模拟点 X：先派发可取消的 'close'，未被 preventDefault 才真正销毁（同 Electron 语义）。 */
  close() {
    const e = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
    this.emit('close', e)
    if (!e.defaultPrevented) this.destroy()
  }
  destroy() { this.destroyed = true; this.emit('closed') }
}

export const protocol = {
  registerSchemesAsPrivileged() {},
  handle() {},
}
/** net 假件：main.js 的 dsh-app 协议处理器经它读包内页面；测试不走该路径，够顶层引用即可。 */
export const net = { fetch: async () => new Response('', { status: 200 }) }
/** 造一个够用的 session 假件：权限钩子 + 协议注册口 + fetch（mock 交换）。 */
function fakeSession() {
  return Object.assign(new EventEmitter(), {
    fetch: async () => ({ status: 303, body: null }),
    setPermissionRequestHandler() {},
    setPermissionCheckHandler() {},
    protocol: { handle() {} },
  })
}

export const session = {
  defaultSession: fakeSession(),
  /** SPEC §9:275：本地页 partition。同名返回同一实例（与 Electron 语义一致）。 */
  fromPartition(name) {
    const key = String(name)
    if (!this._partitions) this._partitions = new Map()
    if (!this._partitions.has(key)) this._partitions.set(key, fakeSession())
    return this._partitions.get(key)
  },
}
/** dialog 假件：记录调用参数（calls），供"必须弹原生提示"这类断言使用。 */
export const dialog = {
  calls: [],
  showMessageBox: async (...args) => { dialog.calls.push(args); return { response: 0 } },
}
export const shell = { openExternal: async () => {} }

/** Tray 假件：记录调用与传入的图标；实例经 globalThis.__DSH_TEST_TRAYS__ 暴露。 */
export class Tray {
  constructor(image) {
    this.toolTips = []
    this.images = image ? [image] : []
    ;(globalThis.__DSH_TEST_TRAYS__ ??= []).push(this)
  }
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
