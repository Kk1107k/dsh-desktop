// 隔离桥：角色由主进程通过 additionalArguments 登记，preload 只暴露对应命名空间。
// 不暴露 ipcRenderer、不读写配置、不执行命令；调用结果由内部捕获，不向页面泄露事件对象。
const { contextBridge, ipcRenderer } = require('electron')

const argv = process.argv || []
const roleArg = argv.find(a => typeof a === 'string' && a.startsWith('--dsh-role='))
const versionArg = argv.find(a => typeof a === 'string' && a.startsWith('--dsh-version='))
const role = roleArg ? roleArg.slice('--dsh-role='.length) : ''
const version = versionArg ? versionArg.slice('--dsh-version='.length) : undefined

/** @typedef {{state?:string, [key:string]:unknown}} Snapshot */
/** @type {Snapshot|undefined} */ let cachedSnapshot = undefined
/** @type {string|undefined} */ let cachedStatus = undefined
/** @type {boolean} */ let cachedFinishRequested = false

// 已注册的订阅者。用途见 §5:181「订阅…重新注册时补发当前状态」：
// 页面在 DOMContentLoaded 注册订阅时，bridge-ready 的 invoke 往往还没返回，getState() 读到 undefined；
// 若此后状态不再变化（已是终态），handler 就永远不会被触发 —— 页面永久停在静态初始 DOM。
const splashStatusSubs = []
const splashFinishSubs = []
const updateStateSubs = []

/**
 * 逐个调用订阅者；单个回调异常不得影响其它订阅者与桥本身。
 * @param {Array<Function>} subs
 * @param {...unknown} args
 */
function replay(subs, ...args) {
  for (const cb of subs) {
    try { cb(...args) } catch (_) { /* 页面回调异常自行处理 */ }
  }
}

/**
 * 安全订阅 IPC 推送：仅接受 (event, payload) 中的 payload，封装 try/catch。
 * payload 来自 IPC，主进程契约之外的内容一律忽略。
 * @param {string} channel
 * @param {(payload:any)=>void} handler
 * @returns {()=>void}
 */
function subscribe(channel, handler) {
  /** @param {unknown} _event @param {any} payload */
  const wrapper = (_event, payload) => handler(payload)
  ipcRenderer.on(channel, wrapper)
  return () => ipcRenderer.removeListener(channel, wrapper)
}

if (role === 'splash') {
  contextBridge.exposeInMainWorld('splashAPI', {
    /**
     * 订阅启动状态文本。
     * @param {(text:string)=>void} cb
     */
    onStatus(cb) {
      splashStatusSubs.push(cb)
      if (cachedStatus !== undefined) replay([cb], cachedStatus)      // 重新注册时补发（§5:181）
      subscribe('dsh:splash-status', /** @param {{text?:string}} p */ (p) => { cachedStatus = p?.text ?? cachedStatus; cb(p?.text ?? cachedStatus ?? '') })
    },
    /**
     * 订阅转场确认请求；received 表示主进程已判定门控通过。
     * @param {()=>void} cb
     */
    onFinish(cb) {
      splashFinishSubs.push(cb)
      // 转场请求可能早于页面注册到达（主进程按 finishRequested 缓存）：补发，否则页面收不到。
      if (cachedFinishRequested) replay([cb])
      subscribe('dsh:splash-finish', () => { cachedFinishRequested = true; cb() })
    },
    /** @returns {string|undefined} */
    getVersion() { return version },
    async minimize() { return ipcRenderer.invoke('dsh:splash-minimize') },
    async close() { return ipcRenderer.invoke('dsh:splash-close') },
  })
} else if (role === 'update') {
  contextBridge.exposeInMainWorld('updateAPI', {
    /**
     * 订阅更新状态；按 revision 丢弃旧快照。
     * @param {(state?:string, data?:object)=>void} cb
     */
    onState(cb) {
      updateStateSubs.push(cb)
      if (cachedSnapshot) replay([cb], cachedSnapshot.state, cachedSnapshot)   // 重新注册时补发（§5:181）
      subscribe('dsh:update-state', /** @param {{revision?:number, snapshot?:Snapshot}} ev */ (ev) => {
        if (!ev || typeof ev.revision !== 'number') return
        cachedSnapshot = ev.snapshot ?? cachedSnapshot
        cb(ev.snapshot?.state, ev.snapshot)
      })
    },
    /** @returns {object|undefined} */
    getState() { return cachedSnapshot },
    async startDownload() { return ipcRenderer.invoke('dsh:update-download') },
    async retry() { return ipcRenderer.invoke('dsh:check-update') },
    async snooze() { return ipcRenderer.invoke('dsh:update-snooze') },
    async close() { return ipcRenderer.invoke('dsh:update-close') },
  })
}

// 桥就绪后立即调 bridge-ready，主进程据此补发当前状态，避免早发事件丢失。
try {
  ipcRenderer.invoke('dsh:bridge-ready').then((res) => {
    if (!res?.ok) return
    const b = res.data
    // 桥返回后**补发一次**：此前的注册者（页面早已订阅）此刻才拿到当前状态。
    // 没有这一步，页面会永久停在各页面自己的静态初始 DOM（实测：更新窗口不渲染任何状态）。
    if (role === 'splash') {
      cachedStatus = b?.status
      cachedFinishRequested = !!b?.finishRequested
      if (cachedStatus !== undefined) replay(splashStatusSubs, cachedStatus)
      if (cachedFinishRequested) replay(splashFinishSubs)
      if (b?.update?.snapshot) cachedSnapshot = b.update.snapshot
    } else if (role === 'update' && b?.update?.snapshot) {
      cachedSnapshot = b.update.snapshot
      replay(updateStateSubs, cachedSnapshot.state, cachedSnapshot)
    }
  }).catch(() => {})
} catch (_) { /* bridge 未就绪：preload 仍可被页面后续调用 */ }

export {}