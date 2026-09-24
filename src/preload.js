// 隔离桥：角色由主进程通过 additionalArguments 登记，preload 只暴露对应命名空间。
// 不暴露 ipcRenderer、不读写配置、不执行命令；调用结果由内部捕获，不向页面泄露事件对象。
const { contextBridge, ipcRenderer } = require('electron')

const argv = process.argv || []
const roleArg = argv.find(a => typeof a === 'string' && a.startsWith('--dsh-role='))
const versionArg = argv.find(a => typeof a === 'string' && a.startsWith('--dsh-version='))
const role = roleArg ? roleArg.slice('--dsh-role='.length) : ''
const version = versionArg ? versionArg.slice('--dsh-version='.length) : undefined

let cachedSnapshot = undefined
let cachedStatus = undefined
let cachedFinishRequested = false

/**
 * 安全订阅 IPC 推送：仅接受 (event, payload) 中的 payload，封装 try/catch。
 */
function subscribe(channel, handler) {
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
      subscribe('dsh:splash-status', (p) => { cachedStatus = p?.text ?? cachedStatus; cb(p?.text ?? cachedStatus ?? '') })
    },
    /**
     * 订阅转场确认请求；received 表示主进程已判定门控通过。
     * @param {()=>void} cb
     */
    onFinish(cb) {
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
     * @param {(state:string, data?:object)=>void} cb
     */
    onState(cb) {
      subscribe('dsh:update-state', (ev) => {
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
    if (role === 'splash') {
      cachedStatus = b?.status
      cachedFinishRequested = !!b?.finishRequested
      if (b?.update?.snapshot) cachedSnapshot = b.update.snapshot
    } else if (role === 'update' && b?.update?.snapshot) {
      cachedSnapshot = b.update.snapshot
    }
  }).catch(() => {})
} catch (_) { /* bridge 未就绪：preload 仍可被页面后续调用 */ }

export {}