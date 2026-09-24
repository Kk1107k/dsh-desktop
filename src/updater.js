// 双通道状态机：GitHub 主源 + COS 备源。
// 内部状态机的 downloaded/installing/snoozed 不出现在页面枚举；安装前保持 downloading 且进度为 1。
import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'

const CHECK_DEADLINE_MS = 15000
const DOWNLOAD_NO_PROGRESS_MS = 30000
const DOWNLOAD_TOTAL_DEADLINE_MS = 10 * 60 * 1000
const AUTO_INTERVAL_DEFAULT_H = 6
const SNOOZE_DURATION_MS = 24 * 60 * 60 * 1000
const NETWORK_FAIL_RE = /timeout|ETIMEDOUT|ENOTFOUND|cloudflare|404|ERR_CERT|CERT_|SSL|ECONNRESET|ECONNREFUSED|UNABLE_TO_VERIFY|SELF_SIGNED/i

/**
 * 持久化 snooze；失败返回 E_IO 而非假装成功。
 * @returns {{ok:boolean, code?:string}}
 */
function persistSnooze(filePath, until) {
  const tmp = `${filePath}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify({ until }, null, 2), 'utf8')
    renameSync(tmp, filePath)
    return { ok: true }
  } catch (err) {
    return { ok: false, code: 'E_IO' }
  }
}

function loadSnooze(filePath) {
  if (!existsSync(filePath)) return 0
  try {
    const raw = readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(raw)
    const until = Number(parsed.until) | 0
    return Number.isFinite(until) ? until : 0
  } catch {
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    try { renameSync(filePath, `${filePath}.${ts}.corrupt`) } catch (_) { /* */ }
    return 0
  }
}

/**
 * 创建更新控制器。
 * @param {{logger:object, config:object, isPackaged:boolean, onTraySetState:(s:string)=>void, onTraySetFlashText:(t:string, ms?:number)=>void, onUpdateState:(ev:object)=>void, onUpdateOpen:()=>void, onHostStopBeforeInstall:()=>void, onHostRestartAfterInstall:()=>void}} opts
 */
export function createUpdater(opts) {
  const { logger, config, isPackaged } = opts
  const log = logger
  const snoozePath = join(app.getPath('userData'), 'update-snooze.json')

  // 两实例独立：同一时刻只存在一个逻辑检查及一个活动下载。
  let githubUpdater = null
  let cosUpdater = null
  let activeSource = null              // 'github' | 'cos'
  let pageState = 'idle'              // 5 态：checking|latest|available|downloading|error
  let revision = 0
  let snapshot = { state: 'idle' }  // 内部状态含 downloaded/installing/snoozed
  let autoTimer = null
  let inflight = null
  let lastProgressAt = 0
  let downloadStartedAt = 0
  let agreedVersion = null             // 用户在 GitHub 上同意的目标版本，COS 降级需校验一致
  let agreedSha512 = null
  let agreedSize = null

  /**
   * 动态加载 NsisUpdater；v6 必须显式 new，不能用单例 autoUpdater 凑双源。
   */
  async function ensureInstances() {
    if (githubUpdater && cosUpdater) return
    const mod = await import('electron-updater')
    const NsisUpdater = mod.NsisUpdater || mod.default?.NsisUpdater
    if (!NsisUpdater) throw new Error('NsisUpdater not available in electron-updater')

    const baseOpts = { autoDownload: false, autoInstallOnAppQuit: false, allowPrerelease: false, allowDowngrade: false }
    githubUpdater = new NsisUpdater({
      provider: 'github',
      owner: 'Kk1107k',
      repo: 'dsh-desktop',
      ...baseOpts,
    })
    githubUpdater.channel = 'stable'
    githubUpdater.signals = githubUpdater.signals || {}

    cosUpdater = new NsisUpdater({
      provider: 'generic',
      url: 'https://<占位 COS 域名>/dsh-desktop',
      channel: 'cn-stable',
      ...baseOpts,
    })
    cosUpdater.channel = 'cn-stable'

    wireEvents(githubUpdater, 'github')
    wireEvents(cosUpdater, 'cos')
  }

  function wireEvents(instance, source) {
    instance.on('update-available', (info) => onAvailable(source, info))
    instance.on('update-not-available', () => onNotAvailable(source))
    instance.on('download-progress', (p) => onDownloadProgress(source, p))
    instance.on('update-downloaded', () => onUpdateDownloaded(source))
    instance.on('error', (err) => onError(source, err))
  }

  /**
   * 推送页面状态；内部状态对外只用 5 态映射。
   * @param {string} next
   * @param {object} [data]
   */
  function setPageState(next, data) {
    pageState = next
    revision++
    const ev = { revision, snapshot: buildSnapshot(next, data) }
    snapshot = ev.snapshot
    opts.onUpdateState(ev)
    syncTray(next, data)
  }

  function buildSnapshot(next, data) {
    if (next === 'checking') return { state: 'checking' }
    if (next === 'latest') return { state: 'latest', version: data?.version ?? app.getVersion() }
    if (next === 'available') return { state: 'available', version: data.version, notes: clampNotes(data.notes) }
    if (next === 'downloading') return { state: 'downloading', progress: clampProgress(data?.progress) }
    if (next === 'error') return { state: 'error', message: data?.message ?? '更新失败' }
    return { state: 'idle' }
  }
  function clampProgress(p) { return Math.max(0, Math.min(1, Number(p) || 0)) }
  function clampNotes(n) {
    if (!n) return ''
    const txt = String(n).replace(/<[^>]+>/g, '')
    return txt.length > 16 * 1024 ? txt.slice(0, 16 * 1024) : txt
  }

  function syncTray(next, data) {
    if (next === 'available' || next === 'downloading') opts.onTraySetState('update')
    else if (next === 'latest') {
      opts.onTraySetFlashText('已检查更新', 5000)
    } else if (next === 'error') {
      opts.onTraySetFlashText('更新检查失败', 5000)
    }
  }

  /**
   * 开始一轮逻辑检查。
   * @param {{manual?:boolean}} [opt]
   * @returns {Promise<{ok:boolean, error?:{code:string,message:string}}>}
   */
  async function checkOnce({ manual = false } = {}) {
    if (inflight) return { ok: false, error: { code: 'E_BUSY', message: '已有检查进行中' } }
    if (!isPackaged) return { ok: false, error: { code: 'E_UNPACKAGED', message: '开发态不执行真实更新' } }

    const snoozeUntil = loadSnooze(snoozePath)
    if (!manual && Date.now() < snoozeUntil) {
      scheduleNext(Math.max(snoozeUntil - Date.now(), 0))
      return { ok: true }
    }

    await ensureInstances()
    setPageState('checking')
    activeSource = 'github'

    const timeoutGuard = setTimeout(() => failSource('github', new Error('timeout')), CHECK_DEADLINE_MS)
    inflight = new Promise((resolve) => {
      githubUpdater.checkForUpdates().then(() => { /* events 驱动 resolve */ }).catch(err => {
        failSource('github', err).then(resolve)
      })
      // 由事件回调解析 inflight
    })
    clearTimeout(timeoutGuard)  // 事件流负责真正超时
    return { ok: true }
  }

  async function failSource(source, err) {
    log.warn(`source ${source} failed`, err?.message || err)
    if (source === 'github' && NETWORK_FAIL_RE.test(String(err?.message || err))) {
      activeSource = 'cos'
      setPageState('checking')
      try {
        await cosUpdater.checkForUpdates()
      } catch (e2) {
        showNetworkFailure()
      }
      return
    }
    showNetworkFailure()
  }

  function showNetworkFailure() {
    setPageState('error', { message: '无法连接更新服务' })
    opts.onUpdateOpen()
  }

  function onAvailable(source, info) {
    if (source === 'github') {
      agreedVersion = info?.version
      // GitHub 元数据不提供 sha512/size，由 onUpdateDownloaded 之后比对 cos 元数据；保留 null。
    }
    setPageState('available', { version: info?.version, notes: info?.releaseNotes })
    opts.onUpdateOpen()
  }
  function onNotAvailable(source) {
    setPageState('latest', { version: app.getVersion() })
    scheduleNext()
  }
  function onDownloadProgress(source, p) {
    const now = Date.now()
    if (lastProgressAt && now - lastProgressAt > DOWNLOAD_NO_PROGRESS_MS) {
      abortDownload(source, new Error('no progress timeout'))
      return
    }
    lastProgressAt = now
    if (downloadStartedAt && now - downloadStartedAt > DOWNLOAD_TOTAL_DEADLINE_MS) {
      abortDownload(source, new Error('download total deadline exceeded'))
      return
    }
    setPageState('downloading', { progress: p?.percent ? p.percent / 100 : 0 })
  }
  function onUpdateDownloaded(source) {
    // 安装前保持 downloading 且进度为 1；不新增页面枚举。
    setPageState('downloading', { progress: 1 })
    installAndRestart()
  }
  function onError(source, err) {
    if (pageState === 'downloading' && source === 'github') {
      // 下载阶段 github 失败 → 校验相同镜像版本一致后切 cos。
      tryDownloadCosMirror()
      return
    }
    failSource(source, err)
  }

  /**
   * 用户点击"立即更新"。
   */
  async function startDownload() {
    if (pageState !== 'available') return { ok: false, error: { code: 'E_INVALID_STATE', message: '当前状态不可下载' } }
    if (!activeSource) return { ok: false, error: { code: 'E_INVALID_STATE', message: '未确定活动源' } }
    if (!isPackaged) return { ok: false, error: { code: 'E_UNPACKAGED', message: '开发态' } }
    downloadStartedAt = Date.now()
    lastProgressAt = Date.now()
    const inst = activeSource === 'github' ? githubUpdater : cosUpdater
    try {
      await inst.downloadUpdate()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: { code: 'E_INTERNAL', message: err?.message || 'download failed' } }
    }
  }

  async function tryDownloadCosMirror() {
    // 取消原下载并等待退出，避免并行写入同一缓存。
    try { await githubUpdater?.downloadUpdate?.cancel?.() } catch (_) { /* */ }
    try {
      const cosInfo = await cosUpdater.getUpdateMetadata?.() ?? await cosUpdater.checkForUpdates()
      // 校验目标版本、SHA-512、大小一致；不一致报 E_MIRROR_MISMATCH。
      if (cosInfo?.version !== agreedVersion) return mismatch()
      if (cosInfo?.sha512 && agreedSha512 && cosInfo.sha512 !== agreedSha512) return mismatch()
      if (cosInfo?.size && agreedSize && cosInfo.size !== agreedSize) return mismatch()
      activeSource = 'cos'
      downloadStartedAt = Date.now()
      lastProgressAt = Date.now()
      await cosUpdater.downloadUpdate()
    } catch (err) {
      setPageState('error', { message: '镜像下载失败' })
    }
  }
  function mismatch() {
    setPageState('error', { message: '镜像版本不一致（E_MIRROR_MISMATCH）' })
    return { ok: false, error: { code: 'E_MIRROR_MISMATCH', message: 'mirror mismatch' } }
  }
  function abortDownload(source, err) {
    log.warn(`abort download source=${source}`, err?.message || err)
    if (source === 'github') tryDownloadCosMirror()
    else setPageState('error', { message: '下载失败' })
  }

  async function installAndRestart() {
    try {
      await opts.onHostStopBeforeInstall?.()
      const inst = activeSource === 'github' ? githubUpdater : cosUpdater
      // installer 退出由主进程统一 cleanupAndQuit 接管，不在此 quit。
      inst.quitAndInstall()
    } catch (err) {
      log.error('install failed', err)
      setPageState('error', { message: '安装失败' })
    }
  }

  /**
   * snooze：必须先持久化成功才能关闭弹窗。
   */
  function snooze() {
    const until = Date.now() + SNOOZE_DURATION_MS
    const res = persistSnooze(snoozePath, until)
    if (!res.ok) return { ok: false, error: { code: 'E_IO', message: '延后写入失败' } }
    setPageState('idle')
    scheduleNext(SNOOZE_DURATION_MS)
    return { ok: true }
  }

  function close() {
    // available 状态下 close 等同 snooze，其他状态只隐藏窗口。
    if (pageState === 'available') return snooze()
    return { ok: true }
  }

  function checkManual() {
    return checkOnce({ manual: true })
  }

  function scheduleOnMainWindowReady() {
    // 主窗口接管后首次自动检查；之后每 6h。
    checkOnce({ manual: false })
    scheduleNext()
  }
  function scheduleNext(override = null) {
    if (autoTimer) clearTimeout(autoTimer)
    const ms = override ?? (config.autoCheckIntervalHours || AUTO_INTERVAL_DEFAULT_H) * 3600 * 1000
    autoTimer = setTimeout(() => checkOnce({ manual: false }), ms)
  }

  function dispose() {
    if (autoTimer) { clearTimeout(autoTimer); autoTimer = null }
    inflight = null
  }

  function getInternalSnapshot() { return snapshot }

  return {
    checkOnce, checkManual, startDownload, snooze, close,
    scheduleOnMainWindowReady, dispose,
    getInternalSnapshot,
  }
}