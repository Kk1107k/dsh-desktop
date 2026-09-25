// 验收测试专用的 electron-updater 假件（NsisUpdater）。
// 行为经 globalThis.__DSH_TEST_UPDATER__ 配置，按 provider 分组：
//   { github?: { check?: (inst)=>Promise, download?: (inst)=>Promise, metadata?: object },
//     cos?:     { check?: (inst)=>Promise, download?: (inst)=>Promise, metadata?: object } }
// check / download 收到实例本身，用 inst.emit(...) 模拟 update-available / error 等事件。
import { EventEmitter } from 'node:events'

const cfg = () => {
  if (!globalThis.__DSH_TEST_UPDATER__) globalThis.__DSH_TEST_UPDATER__ = {}
  return globalThis.__DSH_TEST_UPDATER__
}

export class NsisUpdater extends EventEmitter {
  constructor(config) {
    super()
    if (cfg().failConstruct) throw new Error('mock: 构造失败（模拟 electron-updater 初始化异常）')
    // 复刻上游：GenericProvider 构造时会 `new URL(config.url)`，非法 URL（如占位符
    // `https://<占位 COS 域名>/…`）直接抛 —— 这正是线上那个 unhandledRejection Invalid URL 的源头。
    if (config.provider === 'generic' && config.url) void new URL(String(config.url))
    this.config = config
    this._channel = config.channel ?? null
    // 复刻上游：构造 options 里的 allowDowngrade 生效（AppUpdater.js:138）。
    this.allowDowngrade = config.allowDowngrade ?? false
    this.checkCalls = 0
    this.downloadCalls = 0
    this.quitAndInstallCalled = false
    cfg().instances = (cfg().instances ?? []).concat(this)
  }
  /**
   * behavior 配置键：上面的注释与所有用例都用 cos 分组，
   * 但 COS 实例的 config.provider 是 electron-updater 要求的 'generic'。
   * 不映射会永远查不到 cos 行为（表现为不 emit → 状态停在 checking → 超时）。
   */
  get _cfgKey() { return this.config.provider === 'generic' ? 'cos' : this.config.provider }
  get channel() { return this._channel }
  /**
   * 复刻上游语义：AppUpdater 的 channel setter 会把 allowDowngrade 强制置 true
   * （node_modules/electron-updater/out/AppUpdater.js:44）。此前假件只存 channel、没这个副作用，
   * 导致"赋 channel 后 allowDowngrade 变 true"的真实缺陷在 mock 里完全看不见。
   */
  set channel(v) { this._channel = v; this.allowDowngrade = true }
  async checkForUpdates() {
    this.checkCalls++
    const behavior = cfg()[this._cfgKey]?.check
    if (behavior) await behavior(this)
  }
  async downloadUpdate() {
    this.downloadCalls++
    const behavior = cfg()[this._cfgKey]?.download
    if (behavior) await behavior(this)
  }
  async getUpdateMetadata() {
    return cfg()[this._cfgKey]?.metadata ?? null
  }
  quitAndInstall() { this.quitAndInstallCalled = true }
}

export default { NsisUpdater }
