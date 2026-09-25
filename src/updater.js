// 双通道状态机：GitHub 主源 + COS 备源。
// 内部状态机的 downloaded/installing/snoozed 不出现在页面枚举；安装前保持 downloading 且进度为 1。
import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'

const CHECK_DEADLINE_MS = 15000
const DOWNLOAD_NO_PROGRESS_MS = 30000
const AUTO_INTERVAL_DEFAULT_H = 6
// 更新检查的抖动与退避（对齐官方机制，**不对齐数值**）：官方基础间隔 10 分钟是因为他们有服务端
// 策略轮询；桌面工具用 config.autoCheckIntervalHours（默认 6h）更合理。三者都可用环境变量覆盖
//（命名对齐官方字段表）。
const CHECK_INTERVAL_ENV = 'DSH_DESKTOP_UPDATE_CHECK_INTERVAL_MS'
const MAX_BACKOFF_ENV = 'DSH_DESKTOP_UPDATE_MAX_BACKOFF_MS'
const JITTER_ENV = 'DSH_DESKTOP_UPDATE_JITTER'
const MAX_BACKOFF_DEFAULT_MS = 60 * 60 * 1000     // 退避上限：1 小时
const JITTER_DEFAULT = 0.2                        // 抖动：在延迟上随机增加的比例（0~1）
const MIN_DELAY_MS = 1000                         // 最终延迟下限（官方要求至少 1 秒）

/**
 * 读一个整数环境变量；缺失/非法返回 null（调用方回落默认值）。
 * @param {string} name
 * @returns {number|null}
 */
function envInt(name) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return null
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null
}

/**
 * 读一个 0~1 的浮点环境变量；缺失/非法返回 null。
 * @param {string} name
 * @returns {number|null}
 */
function envRatio(name) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return null
  const n = Number(raw)
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : null
}

/**
 * 计算下一次自动检查的延迟（纯函数，便于直接断言）。
 * - 退避（官方机制）：连续失败各自翻倍，上限 maxBackoffMs，成功后由调用方重置 failures。
 * - 抖动（官方机制）：在延迟上随机增加 jitter 比例（0~1），避免所有客户端同时打点。
 * - 最终延迟下限 MIN_DELAY_MS（1 秒）。
 * @param {{baseMs:number, failures:number, jitter:number, maxBackoffMs:number, random?:()=>number}} o
 * @returns {number}
 */
export function computeCheckDelayMs({ baseMs, failures, jitter, maxBackoffMs, random = Math.random }) {
  // ⚠ 上限必须不低于基础间隔：否则"失败退避"会把间隔**压短**（base 6h + cap 1h ⇒ 失败后反而更频繁），
  // 与退避的意图相反。基础间隔本身大于上限时，退避不生效但绝不缩短。
  // 想要真正的退避增长，把 DSH_DESKTOP_UPDATE_MAX_BACKOFF_MS 设到基础间隔之上（如 24h）。
  const cap = Math.max(baseMs, maxBackoffMs)
  const backoff = Math.min(baseMs * 2 ** Math.max(0, failures), cap)
  const delay = backoff * (1 + random() * Math.max(0, Math.min(1, jitter)))
  return Math.max(MIN_DELAY_MS, Math.round(delay))
}
const SNOOZE_DURATION_MS = 24 * 60 * 60 * 1000
const NETWORK_FAIL_RE = /timeout|ETIMEDOUT|ENOTFOUND|cloudflare|404|ERR_CERT|CERT_|SSL|ECONNRESET|ECONNREFUSED|UNABLE_TO_VERIFY|SELF_SIGNED/i
/**
 * 备源 feed URL 的默认值（真实 COS 桶，域名经可达性实测；桶 ap-shanghai / dsh-desktop-1432719119）。
 * ⚠ 「占位符容忍」分支**必须保留** —— 它是**配置缺失时的兜底**：将来换桶、漏填或注入非法值时，
 *   代码要能记一条"备源未配置"、降级为主源，而不是崩。
 *   历史背景：默认值曾经是**待填的占位形态**（尖括号包住的域名），那种串不是合法 URL ——
 *   electron-updater 构造时 `new URL` 直接抛（unhandledRejection Invalid URL → 壳退出）。
 *   如今默认值合法，但容忍逻辑（`isHttpUrl` + 逐源 try/catch）仍在此处与 ensureInstances 生效。
 * 覆盖顺序：`opts.cosUrl`（注入，测试用）→ 本默认值。
 */
const DEFAULT_COS_URL = 'https://dsh-desktop-1432719119.cos.ap-shanghai.myqcloud.com/dsh-desktop'

/**
 * 是否为可用的 http(s) 地址（占位符与空串都不算）。
 * @param {unknown} u
 * @returns {boolean}
 */
function isHttpUrl(u) {
  if (typeof u !== 'string' || !u) return false
  try {
    const parsed = new URL(u)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

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
    // 不能用 | 0 取整：毫秒时间戳超出 int32，会截断成负数（until 恒小于 now → snooze 失效）。
    const until = Number(parsed.until)
    return Number.isFinite(until) ? until : 0
  } catch {
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    try { renameSync(filePath, `${filePath}.${ts}.corrupt`) } catch (_) { /* */ }
    return 0
  }
}

/**
 * 创建更新控制器。
 * @param {{logger:object, config:object, isPackaged:boolean, cosUrl?:string, onTraySetState:(s:string)=>void, onTraySetText:(t:string, ms?:number)=>void, onUpdateState:(ev:object)=>void, onUpdateOpen:()=>void, onManualDownloadPrompt?:()=>void, onHostStopBeforeInstall:()=>void, onHostRestartAfterInstall:()=>void}} opts
 */
export function createUpdater(opts) {
  const { logger, config, isPackaged } = opts
  const log = logger
  const snoozePath = join(app.getPath('userData'), 'update-snooze.json')
  /** 备源 feed URL：可注入（测试用真实形态的地址），默认是 SPEC §11.1 的占位符。 */
  const cosUrl = opts.cosUrl ?? DEFAULT_COS_URL

  // 两实例独立：同一时刻只存在一个逻辑检查及一个活动下载。
  let githubUpdater = null
  let cosUpdater = null
  /** 初始化只尝试一次：备源缺省是稳定事实，不必每次检查都重试并重复打日志。 */
  let instancesReady = false
  let activeSource = null              // 'github' | 'cos'
  let pageState = 'idle'              // 5 态：checking|latest|available|downloading|error
  let revision = 0
  let snapshot = { state: 'idle' }  // 内部状态含 downloaded/installing/snoozed
  let autoTimer = null
  let checkTimer = null                 // 单源检查逻辑截止计时（SPEC §7：15s）
  let inflight = null
  /** 连续失败次数（退避用）：失败累加、进入 latest/available 清零。 */
  let checkFailures = 0
  let lastProgressAt = 0
  let downloadStartedAt = 0
  let agreedVersion = null             // 用户在 GitHub 上同意的目标版本，COS 降级需校验一致
  let agreedSha512 = null
  let agreedSize = null

  /**
   * 动态加载 NsisUpdater；v6 必须显式 new，不能用单例 autoUpdater 凑双源。
   */
  async function ensureInstances() {
    if (instancesReady) return
    instancesReady = true
    // 差量下载（differential）是**官方策略要求，不是可选优化**：官方铁律③「桌面壳未变化的数据块
    // 不应强制完整传输」。它依赖发布侧产出并上传 `.blockmap`（electron-builder 默认产出；
    // release.yml 与 tools/release.mjs 都必须把 .blockmap 带上）。此处显式写 false 表明**不禁用**，
    // 防止有人为图省事关掉差量（关掉会让每次更新都整包下载）。
    const baseOpts = {
      autoDownload: false,
      autoInstallOnAppQuit: false,
      allowPrerelease: false,
      allowDowngrade: false,
      disableDifferentialDownload: false,
    }
    try {
      const mod = await import('electron-updater')
      const NsisUpdater = mod.NsisUpdater || mod.default?.NsisUpdater
      if (!NsisUpdater) {
        log.error('更新模块不可用：electron-updater 未提供 NsisUpdater，更新功能停用（不影响壳运行）')
        return
      }

      // 主源：构造失败只影响主源。
      try {
        githubUpdater = new NsisUpdater({ provider: 'github', owner: 'Kk1107k', repo: 'dsh-desktop', ...baseOpts })
        githubUpdater.channel = 'stable'
        // SPEC §7:216：channel 赋值之后必须再明确设一次 —— electron-updater 的 channel setter 会把
        // allowDowngrade 强制置 true（out/AppUpdater.js:44，其文档要求"不需要时在赋 channel 后覆盖"）。
        githubUpdater.allowDowngrade = false
        wireEvents(githubUpdater, 'github')
      } catch (err) {
        githubUpdater = null
        log.error('主源初始化失败，更新功能不可用（不影响壳运行）', err instanceof Error ? err.message : String(err))
      }

      // 备源：允许缺省。占位符 URL 不是合法 URL，构造前先判掉，按"备源未配置"处理。
      if (!isHttpUrl(cosUrl)) {
        log.warn(`备源未配置：feed URL 不是合法 http(s) 地址（当前 "${cosUrl}"，占位符待填）—— COS 降级不可用，主源失败将直接进入错误态`)
      } else {
        try {
          cosUpdater = new NsisUpdater({ provider: 'generic', url: cosUrl, channel: 'cn-stable', ...baseOpts })
          cosUpdater.channel = 'cn-stable'
          cosUpdater.allowDowngrade = false
          wireEvents(cosUpdater, 'cos')
        } catch (err) {
          cosUpdater = null
          log.error('备源初始化失败，COS 降级不可用', err instanceof Error ? err.message : String(err))
        }
      }
    } catch (err) {
      // 整体兜底：更新模块的任何初始化异常都不得冒泡（否则 unhandledRejection 会把已就绪的壳带崩）。
      log.error('更新模块初始化失败，已停用更新（不影响壳运行）', err instanceof Error ? err.message : String(err))
    }
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
    // 退避计数只在终态更新：失败累加（下次间隔翻倍）、成功清零。
    if (next === 'error') checkFailures++
    else if (next === 'latest' || next === 'available') checkFailures = 0
    // 终态复位：离开 checking 即清空在飞标志（latest / available / downloading / error / idle 都算），
    // 因为"检查在飞"只可能发生在 checking 期间。
    // ⚠ **复位判据只有这一处**，不要在各条 failSource / 事件回调里各写一遍 —— 本 bug 的成因正是
    //   "只在 dispose() 里复位、路径分散漏了一条"：首检进终态后 inflight 永久非空，
    //   此后所有检查（手动与 6h 自动）都被 E_BUSY 拒掉。
    // ⚠ checking → checking（切源降级）不得复位。
    if (next !== 'checking') inflight = null
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
    // 与 main.js 注入的回调名对齐：onTraySetState / onTraySetText（接口名不匹配会静默失效）。
    // SPEC §8:264：只有"发现未跳过的新版本或正在下载"用 update 徽章；其余状态交回 host 健康度
    // 决定（M07 内部按 update > running > idle 推导），所以这里必须显式发 'idle' 清掉更新徽章，
    // 否则一旦出现过新版本，托盘会永远停在 update 图标、绿色再也不会回来。
    if (next === 'available' || next === 'downloading') {
      opts.onTraySetState?.('update')
    } else {
      opts.onTraySetState?.('idle')
      if (next === 'latest') opts.onTraySetText?.('已检查更新', 5000)
      else if (next === 'error') opts.onTraySetText?.('更新检查失败', 5000)
    }
  }

  /**
   * 开始一轮逻辑检查。
   * @param {{manual?:boolean}} [opt]
   * @returns {Promise<{ok:boolean, error?:{code:string,message:string}}>}
   */
  async function checkOnce({ manual = false } = {}) {
    if (inflight) {
      // 理论上不该发生：进入终态时已在 setPageState 里复位。命中即说明有路径漏了复位，
      // 留警告而不是静默 E_BUSY —— 这类"只有加没有解"的标志位故障几乎不可观测。
      log.warn(`检查被拒（E_BUSY）：仍在飞但页面状态已是 ${pageState}，疑有路径漏复位 inflight`)
      return { ok: false, error: { code: 'E_BUSY', message: '已有检查进行中' } }
    }
    if (!isPackaged) return { ok: false, error: { code: 'E_UNPACKAGED', message: '开发态不执行真实更新' } }

    const snoozeUntil = loadSnooze(snoozePath)
    if (!manual && Date.now() < snoozeUntil) {
      scheduleNext(Math.max(snoozeUntil - Date.now(), 0))
      return { ok: true }
    }

    await ensureInstances()
    // 主源都没起来（更新模块缺失/构造失败）：走既有错误态展示，绝不在 null 上继续调用。
    if (!githubUpdater) {
      setPageState('error', { message: '更新服务不可用' })
      opts.onUpdateOpen()
      return { ok: false, error: { code: 'E_INTERNAL', message: '更新服务不可用' } }
    }
    setPageState('checking')
    activeSource = 'github'

    clearCheckTimer()
    // 单源检查逻辑截止 15s；事件先行到达时由 clearCheckTimer 撤销守卫。
    checkTimer = setTimeout(() => {
      if (pageState === 'checking' && activeSource === 'github') {
        failSource('github', new Error('timeout'))
      }
    }, CHECK_DEADLINE_MS)
    // 先把在飞标志建好、再发起请求：checkForUpdates 可能在返回前就同步派发事件
    // （测试夹具正是同步 emit），那时终态复位会先跑、再被这里的赋值冲掉 —— 标志就永久卡住了。
    /** @type {(v?:unknown)=>void} */
    let settleInflight = () => {}
    inflight = new Promise((resolve) => { settleInflight = resolve })
    githubUpdater.checkForUpdates()
      .then(() => { /* 正常路径由事件回调驱动状态机，标志在进入终态时复位 */ })
      .catch(err => { failSource('github', err).then(() => settleInflight()) })
    return { ok: true }
  }

  function clearCheckTimer() {
    if (checkTimer) { clearTimeout(checkTimer); checkTimer = null }
  }

  async function failSource(source, err) {
    log.warn(`source ${source} failed`, err?.message || err)
    // 晚到或陈旧的失败（检查已结束/已切状态）不再改变状态。
    if (pageState !== 'checking') return
    clearCheckTimer()
    // 只有备源确实可用时才降级；否则直接落到既有的错误态（"备源未配置"不该表现成崩溃或静默）。
    if (source === 'github' && cosUpdater && NETWORK_FAIL_RE.test(String(err?.message || err))) {
      activeSource = 'cos'
      setPageState('checking')
      checkTimer = setTimeout(() => {
        if (pageState === 'checking' && activeSource === 'cos') showNetworkFailure()
      }, CHECK_DEADLINE_MS)
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
    clearCheckTimer()
    setPageState('error', { message: '无法连接更新服务' })
    // 失败必须重新排程，否则退避"算了但没人用"、且失败一次后再无自动检查。
    // setPageState('error') 已把 checkFailures 累加 ⇒ 这里拿到的就是翻倍后的延迟（上限见 computeCheckDelayMs）。
    scheduleNext()
    opts.onUpdateOpen()
    // SPEC §7:251：双源网络失败提供"手动下载 / 关闭"（原生对话框）。
    // 每轮一次：本函数只由 failSource 在 pageState === 'checking' 时走到，故手动重试再失败会再弹一次。
    // 异步弹、**不 await** —— 不把对话框串进状态机（阻塞会让更新流程停住）。
    opts.onManualDownloadPrompt?.()
  }

  function onAvailable(source, info) {
    clearCheckTimer()
    if (source === 'github') {
      agreedVersion = info?.version
      // GitHub 元数据不提供 sha512/size，由 onUpdateDownloaded 之后比对 cos 元数据；保留 null。
    }
    setPageState('available', { version: info?.version, notes: info?.releaseNotes })
    opts.onUpdateOpen()
  }
  function onNotAvailable(source) {
    clearCheckTimer()
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
    // 这里**刻意没有"下载总时长上限"**：官方口径是"HTTP 逐连接空闲超时（无响应头/无后续字节才算失败），
    // 活跃下载不设总时长"。保留总时限会在慢速网络上误杀 80MB 的包（100KB/s 约需 14 分钟 > 原 10 分钟上限），
    // 而真正的卡死已由上面的"30s 无进度"快速发现 —— 因此只留无进度看门狗，去掉总时限。
    // 残余风险：只滴速、从不真正停滞的下载不会被中止（可点"稍后/关闭"退出），可接受。
    setPageState('downloading', { progress: p?.percent ? p.percent / 100 : 0 })
  }
  function onUpdateDownloaded(source) {
    // 安装前保持 downloading 且进度为 1；不新增页面枚举。
    setPageState('downloading', { progress: 1 })
    installAndRestart()
  }
  function onError(source, err) {
    if (pageState === 'downloading') {
      // 下载阶段失败：github → 校验相同镜像版本一致后切 cos；cos → error。
      abortDownload(source, err)
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
    if (!inst) return { ok: false, error: { code: 'E_INVALID_STATE', message: '该更新源未配置' } }
    try {
      await inst.downloadUpdate()
      return { ok: true }
    } catch (err) {
      // catch 的 err 是 unknown：只取 Error.message，其余一律回落固定文案（等价于旧 `err?.message ||`）。
      const message = err instanceof Error && err.message ? err.message : 'download failed'
      return { ok: false, error: { code: 'E_INTERNAL', message } }
    }
  }

  async function tryDownloadCosMirror() {
    // 取消原下载并等待退出，避免并行写入同一缓存。
    try { await githubUpdater?.downloadUpdate?.cancel?.() } catch (_) { /* */ }
    if (!cosUpdater) {
      log.warn('镜像续接不可用：备源未配置')
      setPageState('error', { message: '镜像源未配置' })
      return
    }
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
      if (!inst) throw new Error('该更新源未配置')
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

  /**
   * 手动检查（托盘「检查更新…」）。**不得静默**：被拒时给托盘一条文字反馈，
   * 否则用户点了没有任何反应、也无从判断是"没在检查"还是"被拒了"。
   * @returns {Promise<{ok:boolean, error?:{code:string,message:string}}>}
   */
  async function checkManual() {
    const res = await checkOnce({ manual: true })
    if (!res.ok) {
      const msg = res.error?.code === 'E_BUSY' ? '正在检查中…'
        : res.error?.code === 'E_UNPACKAGED' ? '开发态不执行更新'
          : '更新检查失败'
      opts.onTraySetText?.(msg, 5000)
    }
    return res
  }

  function scheduleOnMainWindowReady() {
    // 主窗口接管后首次自动检查；之后每 6h。
    checkOnce({ manual: false })
    scheduleNext()
  }
  /**
   * 安排下一次自动检查。
   * @param {number|null} [override] 显式延迟（如 snooze 到 until）—— **原样使用**：
   *   退避与抖动只作用于"常规间隔"，否则 snooze 会被抖动成 24h±20%（违反 §7:247 的"不额外等"）。
   */
  function scheduleNext(override = null) {
    if (autoTimer) clearTimeout(autoTimer)
    let ms
    if (override != null) {
      ms = Math.max(MIN_DELAY_MS, Math.round(override))
    } else {
      const base = (envInt(CHECK_INTERVAL_ENV) ?? (config.autoCheckIntervalHours || AUTO_INTERVAL_DEFAULT_H) * 3600 * 1000)
      ms = computeCheckDelayMs({
        baseMs: base,
        failures: checkFailures,
        jitter: envRatio(JITTER_ENV) ?? JITTER_DEFAULT,
        maxBackoffMs: envInt(MAX_BACKOFF_ENV) ?? MAX_BACKOFF_DEFAULT_MS,
      })
    }
    autoTimer = setTimeout(() => checkOnce({ manual: false }), ms)
  }

  function dispose() {
    if (autoTimer) { clearTimeout(autoTimer); autoTimer = null }
    clearCheckTimer()
    inflight = null
  }

  /**
   * 供 preload 补发用的**事件形状**（SPEC §5:156 的 UpdateEvent = {revision, snapshot}）。
   * 不要退化成只返回 snapshot：preload 按 `ev.revision` 丢弃旧快照、按 `b.update.snapshot` 取初值，
   * 形状不对会让更新页永远拿不到状态（实测：页面停在静态初始 DOM）。
   * @returns {{revision:number, snapshot:object}}
   */
  function getInternalEvent() { return { revision, snapshot } }

  return {
    checkOnce, checkManual, startDownload, snooze, close,
    scheduleOnMainWindowReady, dispose,
    getInternalEvent,
  }
}