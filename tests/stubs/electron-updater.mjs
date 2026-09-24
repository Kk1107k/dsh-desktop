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
    this.config = config
    this._channel = config.channel ?? null
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
  set channel(v) { this._channel = v }
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
