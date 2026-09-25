// 子进程管理：固定版本、loopback 端口、健康探测、退避重启、进程树强制回收。
// 任何对外状态读取都依赖启动代次，旧代次回调一律忽略，避免竞态。
import { spawn, execFile, execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import { request } from 'node:http'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, isAbsolute, join } from 'node:path'

// 绑定的上游版本。取值依据官方铁律「Electron 与 @deepseek-ai/dsh 始终使用同一精确版本」：
// 官方 Desktop 的 apps/desktop/package.json 为 0.1.7-rc.2（文件 sha cc0ce4f0…，经 GitHub API 直读）
// ⇒ 我们绑定同一版本。⚠ 不要用 `latest`：npm 的 latest 反而更旧（0.1.5-rc.3，见 SPEC §11.1 #1）。
// ⚠ 区别必须写明：官方那条铁律的前提是"壳 + 内置运行时 + pnpm 是一个**验证过的组合**"；我们的组合是
//   "壳 + 用户系统 Node + dsh" —— 是**借用版本号的命名规则**表达"绑定哪个 dsh"，
//   **不是**声称验证了官方那个组合。详见 SPEC §11.1「上游版本升级至 0.1.7-rc.2」。
const TARGET_PKG = '@deepseek-ai/dsh@0.1.7-rc.2'
/**
 * 拉取上游 CLI 用的 npm registry：**由壳固定下发，不读用户环境/项目的 .npmrc**。
 * 依据官方同类开关（`DSH_DESKTOP_NPM_REGISTRY`，默认官方源、可换镜像）。
 * 为什么必须固定：`--offline` 的**元数据缓存键受 registry 影响**，预热与运行时不一致就
 * ENOTCACHED（表现为 host 起不来，§11.1 #7）。固定之后：开发机与装包后行为一致、
 * 预热与运行时一致（缓存必中）、用户机器上有别的 registry 配置也不影响。
 * ⚠ 改这里或换镜像后**必须用同一个 registry 重灌 npx 缓存**（`--offline` 才可能命中）。
 */
const NPM_REGISTRY = process.env.DSH_DESKTOP_NPM_REGISTRY || 'https://registry.npmjs.org'
/**
 * 上游就绪行（stdout）：`dsh web: http://127.0.0.1:<port>/?token=<token>`。
 * 实测该版本没有 `/api/health`（`/api/*` 一律先过浏览器鉴权），就绪以本行 + 带 token 的
 * index 请求为准。token 只从本行实读，不自造、不落日志。详见 SPEC §11.1。
 */
const READY_LINE_RE = /^dsh web: (?:http:\/\/127\.0\.0\.1:(\d+)\/)\?token=([A-Za-z0-9_-]+)\s*$/m
/** 就绪行扫描缓冲上限：用于跨 chunk 拼接匹配，命中后立即丢弃。 */
const READY_SCAN_BYTES = 4096
/** 输出中的 token 一律在入库/写日志前遮蔽（token 绝不许进日志）。 */
const TOKEN_IN_TEXT_RE = /(\?token=)[A-Za-z0-9_-]+/g
const HEALTH_INTERVAL_MS = 10000
const HEALTH_TIMEOUT_MS = 2000
const PROBE_INTERVAL_MS = 250
const PROBE_TIMEOUT_MS = 1000
const READY_DEADLINE_MS = 15000
const RESTART_DELAYS_MS = [1000, 2000, 4000, 8000, 8000]
const STABLE_RESET_MS = 5 * 60 * 1000
const SHUTDOWN_WAIT_MS = 3000
/** 强制 taskkill 后仍收不到 exit 时的兜底等待上限（正常应在数十毫秒内收到）。 */
const FORCE_KILL_GRACE_MS = 2000
const TAIL_BUFFER_BYTES = 64 * 1024

const MIN_NODE_MAJOR = 22
/** 环境准备提示：只适用于"运行环境缺失"两类错误，不要挂到别的错误码上。 */
const RUNTIME_HINT = '环境准备：安装 Node.js ≥ 22（nodejs.org，或 nvm-windows / fnm / volta），'
  + '确保外部 node 在 PATH 可见；npm/npx 随 Node 附带，损坏时重装 Node 即可恢复。'
/**
 * 按错误码给提示。此前所有 host 错误都挂 RUNTIME_HINT，于是"端口被占"也让人去装 Node ——
 * 误导性提示会在排障时浪费用户时间，故按码区分：只有环境缺失类才给环境准备提示。
 * @type {Record<string,string>}
 */
const ERROR_HINTS = {
  E_RUNTIME_MISSING: RUNTIME_HINT,
  E_CLI_MISSING: RUNTIME_HINT,
  E_PORT_IN_USE: '排查：该端口已被占用，壳不会接管、不会杀占用者、也不会静默改端口。'
    + '请先确认占用者是谁；若上面给出的 PID 与本壳上次崩溃残留一致，可在核对身份后按 PID 结束它'
    + '（禁止按进程名或端口批量结束）。',
}

/**
 * @typedef {object} Runtime
 * @property {string} nodeExe
 * @property {string} npxCli
 */

/** 定位成功的缓存：locateRuntime 在 start/stop 中重复调用，避免每次都查注册表。 */
/** @type {Runtime|null} */
let runtimeCache = null

/**
 * node.exe 候选列表：注册表 → where node → 常见安装目录（Program Files、nvm-windows、
 * volta、fnm）。顺序即优先级，先找到版本达标者即用。
 * @returns {string[]}
 */
function nodeCandidates() {
  /** @type {string[]} */
  const out = []
  /** @param {string} p */
  const push = (p) => { if (typeof p === 'string' && p) out.push(p) }
  /** @param {string} dir */
  const tryPushDir = (dir) => {
    try { for (const d of readdirSync(dir)) push(join(dir, d, 'node.exe')) } catch (_) { /* 目录不存在 */ }
  }
  if (process.platform === 'win32') {
    // 1. 注册表 InstallPath（HKLM 与 HKCU 两处）
    for (const hive of ['HKLM\\SOFTWARE\\Node.js', 'HKCU\\SOFTWARE\\Node.js']) {
      try {
        const r = execFileSync('reg.exe', ['query', hive, '/v', 'InstallPath'], {
          encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
        })
        const m = /InstallPath\s+REG_SZ\s+(.+)$/m.exec(r)
        if (m) push(join(m[1].trim(), 'node.exe'))
      } catch (_) { /* 键不存在 */ }
    }
    // 2. where node（可命中 PATH 上的多个安装；WindowsApps 占位 stub 会被后续过滤）
    try {
      const r = execFileSync('where.exe', ['node'], {
        encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
      })
      for (const line of r.split(/\r?\n/)) push(line.trim())
    } catch (_) { /* PATH 无 node */ }
    // 3. 常见安装目录
    if (process.env.ProgramFiles) push(join(process.env.ProgramFiles, 'nodejs', 'node.exe'))
    const pf86 = process.env['ProgramFiles(x86)']
    if (pf86) push(join(pf86, 'nodejs', 'node.exe'))
    if (process.env.NVM_SYMLINK) push(join(process.env.NVM_SYMLINK, 'node.exe'))
    if (process.env.NVM_HOME) tryPushDir(process.env.NVM_HOME)
    if (process.env.APPDATA) tryPushDir(join(process.env.APPDATA, 'nvm'))   // nvm-windows 默认根，v* 子目录
    if (process.env.LOCALAPPDATA) {
      tryPushDir(join(process.env.LOCALAPPDATA, 'Volta', 'tools', 'image', 'node'))       // volta 镜像
      // fnm：node-versions/<ver>/installation/node.exe
      try {
        const fnmRoot = join(process.env.LOCALAPPDATA, 'fnm', 'node-versions')
        for (const d of readdirSync(fnmRoot)) push(join(fnmRoot, d, 'installation', 'node.exe'))
      } catch (_) { /* 目录不存在 */ }
    }
  } else {
    // 非 Windows 测试适配：PATH 上的 node
    for (const dir of (process.env.PATH ?? '').split(':')) {
      if (dir) push(join(dir, 'node'))
    }
  }
  return out
}

/**
 * 排除不可靠候选：Electron 自带可执行文件（禁止当 Node 用）、
 * WindowsApps 商店占位 stub（执行会拉起商店而非 Node）。
 * @param {string} p
 * @returns {boolean}
 */
function looksLikeExternalNode(p) {
  if (!isAbsolute(p)) return false
  const norm = p.replace(/\\/g, '/').toLowerCase()
  return !norm.includes('electron') && !norm.includes('windowsapps')
}

/**
 * 实际校验候选：文件存在且能输出版本号。
 * @param {string} exe
 * @returns {{exe:string, major:number}|null}
 */
function probeNodeCandidate(exe) {
  if (!existsSync(exe)) return null
  let ver = ''
  try {
    ver = execFileSync(exe, ['--version'], {
      encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch (_) { return null }
  const m = /^v(\d+)\./.exec(ver)
  return m ? { exe, major: Number(m[1]) } : null
}

/**
 * npx-cli.js 候选：node 安装根 node_modules/npm（覆盖标准安装、nvm 符号链接、
 * volta/fnm 镜像目录），以及用户全局 npm 根。
 * @param {string} nodeExe
 * @returns {string[]}
 */
function npxCliCandidates(nodeExe) {
  const nodeDir = dirname(nodeExe)
  /** @type {string[]} */
  const out = [join(nodeDir, 'node_modules', 'npm', 'bin', 'npx-cli.js')]
  if (process.env.APPDATA) out.push(join(process.env.APPDATA, 'npm', 'node_modules', 'npm', 'bin', 'npx-cli.js'))
  return out
}

/**
 * @param {string} code
 * @param {string} message
 * @returns {Error & {code:string}}
 */
function runtimeError(code, message) {
  const hint = ERROR_HINTS[code]
  const text = hint ? `${code}: ${message}。${hint}` : `${code}: ${message}`
  const err = /** @type {Error & {code:string}} */ (new Error(text))
  err.code = code
  return err
}

/**
 * 端口占用者 PID：只查询，不杀、不接管（SPEC §6 禁止按进程名或端口批量杀进程）。
 * @param {number} port
 * @returns {number|null}
 */
function findPortOwnerPid(port) {
  try {
    const out = execFileSync('netstat.exe', ['-ano'], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
    const m = out.match(new RegExp(`127\\.0\\.0\\.1:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`))
    return m ? Number(m[1]) : null
  } catch {
    return null
  }
}

/**
 * 取一个进程的**身份材料**：创建时间 ticks + 命令行（两者一起才能确认"就是同一个进程实例"）。
 * 用 PID 单独做身份不够（会重用）；用命令行模式匹配也不够 —— 监听端口的是 dsh 本体（孙进程），
 * 它的命令行是 npx 缓存路径，不含 `--package=…` 那段 pin，按 pin 匹配会永远核不上。
 * @param {number} pid
 * @returns {{ticks:string, cmd:string}|null}
 */
function probeProcess(pid) {
  try {
    const ps = `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { [pscustomobject]@{ t = $p.CreationDate.Ticks; c = $p.CommandLine } | ConvertTo-Json -Compress }`
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 8000 })
    const parsed = JSON.parse(String(out ?? '').trim() || 'null')
    if (!parsed || parsed.t === undefined) return null
    return { ticks: String(parsed.t), cmd: String(parsed.c ?? '') }
  } catch {
    return null
  }
}

/**
 * @param {string} s
 * @returns {string}
 */
function sha256(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex')
}

/**
 * 记录"本壳确认过的端口占用者"，供下次启动回收自己崩溃后残留的孙进程。
 * 只写 PID/端口/代次/包名 pin，不含任何凭据。
 * @param {string|null|undefined} path
 * @param {{pid:number, port:number, generation:number, ticks?:string, cmdSha256?:string}} rec
 */
function writeOwnerRecord(path, rec) {
  if (!path) return
  try {
    writeFileSync(path, JSON.stringify({ ...rec, package: TARGET_PKG }, null, 2), 'utf8')
  } catch {
    // 记录失败不影响运行（下次只是少一次自愈机会）。
  }
}

/**
 * 读回"本壳上次确认过的端口占用者"记录；缺失或损坏一律返回 null。
 * 含身份材料（ticks/cmdSha256），回收前必须逐项核对。
 * @param {string|null|undefined} path
 * @returns {{pid:number, port:number, generation:number, ticks?:string, cmdSha256?:string, package?:string}|null}
 */
function readOwnerRecord(path) {
  if (!path || !existsSync(path)) return null
  try {
    const r = JSON.parse(readFileSync(path, 'utf8'))
    return (r && typeof r.pid === 'number' && typeof r.port === 'number') ? r : null
  } catch {
    return null
  }
}

/**
 * 定位外部 Node 与 npx-cli.js，以绝对路径返回；失败抛带 code 的错误，不静默继续。
 * 禁止把 process.execPath 当作 Node；ELECTRON_RUN_AS_NODE 非可靠开关。
 * @returns {Runtime}
 * @throws {Error & {code:string}} code 为 E_RUNTIME_MISSING / E_CLI_MISSING
 */
export function locateRuntime() {
  if (runtimeCache) return runtimeCache

  /** @type {{exe:string, major:number}|null} */
  let qualified = null    // 版本 ≥ 22 的首个可用 Node
  /** @type {{exe:string, major:number}|null} */
  let anyUsable = null    // 任何能跑起来的 Node（仅用于错误信息）
  const seen = new Set()
  for (const raw of nodeCandidates()) {
    if (seen.has(raw) || !looksLikeExternalNode(raw)) continue
    seen.add(raw)
    const probed = probeNodeCandidate(raw)
    if (!probed) continue
    if (probed.major >= MIN_NODE_MAJOR) { qualified = probed; break }
    anyUsable = anyUsable ?? probed
  }

  if (!qualified) {
    const detail = anyUsable
      ? `检测到外部 Node v${anyUsable.major}，但壳要求 ≥ ${MIN_NODE_MAJOR}`
      : '未找到可用的外部 Node.js 安装'
    throw runtimeError('E_RUNTIME_MISSING', detail)
  }

  const npxCli = npxCliCandidates(qualified.exe).find(p => existsSync(p))
  if (!npxCli) {
    throw runtimeError('E_CLI_MISSING', `在 ${dirname(qualified.exe)} 附近未找到 npx-cli.js`)
  }

  runtimeCache = { nodeExe: qualified.exe, npxCli }
  return runtimeCache
}

/**
 * 端口占用探测：仅检查，不接管、不杀占者、不静默换端口。
 * @param {number} port
 * @returns {Promise<boolean>} true = 端口空闲
 */
function isPortFree(port) {
  return new Promise(resolve => {
    const srv = createServer()
    srv.once('error', () => resolve(false))
    srv.once('listening', () => srv.close(() => resolve(true)))
    srv.listen(port, '127.0.0.1')
  })
}

/**
 * 单次 HTTP GET `/?token=<token>`（上游 index 鉴权入口），禁止重定向。
 * 303 = token 交换成功（上游在该响应上 Set-Cookie）；200 = 已带有效 cookie 的干净 index。
 * 401/403/404/5xx 一律判为未就绪——不接受未鉴权响应，也不把任意 200 页当健康接口。
 * @param {number} port
 * @param {string} token
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
function probeIndex(port, token, timeoutMs) {
  return new Promise(resolve => {
    const req = request({
      host: '127.0.0.1', port, path: `/?token=${token}`, method: 'GET',
      timeout: timeoutMs,
    }, res => {
      res.resume()
      resolve(res.statusCode === 303 || res.statusCode === 200)
    })
    req.on('timeout', () => { req.destroy(); resolve(false) })
    req.on('error', () => resolve(false))
    req.end()
  })
}

/**
 * @typedef {object} HostTimings 仅为测试注入缝隙；生产不传，使用 SPEC 常量。
 * @property {number} [readyDeadline]
 * @property {number[]} [restartDelays]
 * @property {number} [shutdownWait]
 * @property {number} [stableReset]
 */

/**
 * @typedef {object} HostEvent
 * @property {number} generation
 * @property {Error} [error]
 * @property {boolean} [fatal]
 * @property {number|null} [code]
 * @property {string|null} [signal]
 * @property {number} [port]
 */

/**
 * 创建 host 控制器。
 * @param {{config:{port:number}, logger:import('./logger.js').Logger, locateRuntime?:(()=>Runtime), timings?:HostTimings, ownerRecordPath?:string}} [opts]
 *   ownerRecordPath：记录"本壳确认过的端口占用者"的文件路径，供下次启动回收自己崩溃后的残留（可选）。
 */
export function createDshHost({ config, logger, locateRuntime: locate = locateRuntime, timings, ownerRecordPath } = /** @type {{config:{port:number}, logger:import('./logger.js').Logger, ownerRecordPath?:string}} */ ({})) {
  const log = logger
  const T = {
    readyDeadline: timings?.readyDeadline ?? READY_DEADLINE_MS,
    restartDelays: timings?.restartDelays ?? RESTART_DELAYS_MS,
    shutdownWait: timings?.shutdownWait ?? SHUTDOWN_WAIT_MS,
    stableReset: timings?.stableReset ?? STABLE_RESET_MS,
  }
  /** @type {Map<string, Set<(payload:HostEvent)=>void>>} */
  const handlers = new Map()
  /** @type {import('node:child_process').ChildProcess|null} */
  let child = null
  let generation = -1
  /** @type {'idle'|'starting'|'ready'|'stopping'|'stopped'|'crashed'} */
  let state = 'idle'                // idle|starting|ready|stopping|stopped|crashed
  let stopping = false
  let restartCount = 0
  /** @type {NodeJS.Timeout|null} */
  let healthTimer = null
  /** @type {NodeJS.Timeout|null} */
  let backoffTimer = null
  /** @type {NodeJS.Timeout|null} */
  let stableResetTimer = null
  let stderrTail = ''
  let stdoutTail = ''
  /** @type {{port:number, token:string}|null} 就绪行解析结果；token 只存内存，绝不写日志。 */
  let readyInfo = null
  /** 跨 chunk 拼接用的就绪行扫描缓冲（原文），命中后立即丢弃。 */
  let readyScanBuf = ''

  /**
   * @param {string} ev
   * @param {(payload:HostEvent)=>void} fn
   * @returns {()=>void}
   */
  function on(ev, fn) {
    if (!handlers.has(ev)) handlers.set(ev, new Set())
    handlers.get(ev)?.add(fn)
    return () => off(ev, fn)
  }
  /**
   * @param {string} ev
   * @param {(payload:HostEvent)=>void} fn
   */
  function off(ev, fn) { handlers.get(ev)?.delete(fn) }
  /**
   * @param {string} ev
   * @param {HostEvent} payload
   */
  function emit(ev, payload) { handlers.get(ev)?.forEach(fn => { try { fn(payload) } catch (e) { log.error('handler error', e) } }) }

  function currentGeneration() { return generation }
  function getState() { return { state, generation, restartCount } }
  function isHealthy() { return state === 'ready' && !!(child && !child.killed) }

  /**
   * 用本次实例的进程 token 换取 cookie 并落进给定 session（上游 index 的 token 交换）。
   * 主窗口随后用干净 URL 加载即可通过浏览器围栏；token 只在内存中传递，绝不写日志。
   * @param {import('electron').Session} ses
   * @returns {Promise<boolean>} true = 已获得 cookie（非 401/403）
   */
  async function authorize(ses) {
    const info = readyInfo
    if (!info) return false
    // 注意：该 url 含 token，只能作为请求参数使用，不得进入任何日志或错误信息。
    const url = `http://127.0.0.1:${info.port}/?token=${info.token}`
    try {
      // redirect:'follow' 让上游 303 与其 Set-Cookie 在同一 session 内走完。
      const res = await ses.fetch(url, { redirect: 'follow' })
      try { await res.body?.cancel?.() } catch (_) { /* 只关心 cookie 是否落盘 */ }
      if (res.status === 401 || res.status === 403) {
        log.warn(`host authorize rejected status=${res.status}`)
        return false
      }
      return true
    } catch (err) {
      log.warn('host authorize failed', err instanceof Error ? err.message : String(err))
      return false
    }
  }

  /**
   * 尝试回收"本壳自己崩溃后残留"的端口占用者。判据三重，缺一不可
   * （SPEC §6：只杀按 PID 树核对过的自己人，禁止按进程名或端口批量杀）：
   *   1. 记录里存过这个 PID（上次就绪时确认过的端口占用者）；
   *   2. 该 PID 现在确实是这个端口的占用者；
   *   3. 身份核对：**创建时间 ticks 与命令行 SHA-256 与记录逐项一致** —— 即确认「同一个进程实例、
   *      命令行未变」（PID 会被系统重用，单凭 PID 不足以证明身份）。
   * ⚠ 不要退回"命令行里含本壳包名 pin（`--package=@deepseek-ai/dsh@x.y.z`）"这种判据：
   *   实测监听端口的是 dsh **孙进程**，其命令行是 npx 缓存路径
   *   （`"node" "…\_npx\<hash>\…\@deepseek-ai\dsh\lib\bin.js" web --no-open --port <p>`），
   *   **不含** `--package=` 那段 pin —— 按 pin 匹配永远核不上，自愈会静默失效（已证伪过一次）。
   * @param {number} port
   * @returns {Promise<boolean>} true = 已完成回收且端口确认空闲
   */
  async function reclaimOwnLeftover(port) {
    const rec = readOwnerRecord(ownerRecordPath)
    const owner = findPortOwnerPid(port)
    if (!rec || !owner || rec.pid !== owner || rec.port !== port) return false
    // 身份核对：必须是**同一个进程实例**（创建时间 ticks 一致）且命令行未变。
    if (!rec.ticks || !rec.cmdSha256) return false          // 旧记录没有身份材料：不猜，交给上层报占用
    const info = probeProcess(owner)
    if (!info || info.ticks !== String(rec.ticks) || sha256(info.cmd) !== rec.cmdSha256) {
      log.warn(`端口 ${port} 被占用，占用者 PID=${owner} 身份与本壳记录不符，不回收（按 §6 交给上层报 E_PORT_IN_USE）`)
      return false
    }
    log.warn(`端口 ${port} 被上次残留的本壳进程占用（PID=${owner}），按身份核对后回收其进程树`)
    try {
      if (process.platform === 'win32') {
        execFileSync('taskkill.exe', ['/PID', String(owner), '/T', '/F'], { windowsHide: true, timeout: 5000 })
      } else {
        process.kill(owner, 'SIGKILL')
      }
    } catch (e) {
      log.error('回收残留进程失败', e instanceof Error ? e.message : String(e))
      return false
    }
    // 回收后复查端口：最多等 3s，避免"已杀但尚未释放"被误判成占用。
    for (let i = 0; i < 30; i++) {
      if (await isPortFree(port)) return true
      await new Promise(/** @param {(v:void)=>void} r */ (r) => setTimeout(r, 100))
    }
    return false
  }

  /**
   * 启动 host。每次自增代次；包括首次启动都经此入口。
   * @param {{generation?:number}} [opts]
   * @returns {Promise<void>}
   */
  async function start({ generation: gen } = {}) {
    if (gen !== undefined && gen !== generation) generation = gen
    else generation++
    // 每次启动重置就绪行解析结果：旧代次的 token 不得用于确认新实例。
    readyInfo = null
    readyScanBuf = ''
    setState('starting')
    emit('starting', { generation })

    if (!(await isPortFree(config.port))) {
      // SPEC §6：不接管、不杀占用者、不静默换端口。但"本壳上次崩溃残留的自己人"必须先回收 ——
      // 否则重试永远撞自己的残骸（实测线上：崩溃后 dsh 孙进程继续占 3080，两次重试都 E_PORT_IN_USE）。
      if (!(await reclaimOwnLeftover(config.port))) {
        // 报占用时带上占用者 PID：升级过渡期留下的"无身份材料"旧记录无法自愈，
        // 至少要让日志能指出该清哪一个（人工按 PID 清理，不走批量杀）。
        const occupant = findPortOwnerPid(config.port)
        const err = runtimeError('E_PORT_IN_USE', `端口 ${config.port} 已被占用${occupant ? `（占用者 PID=${occupant}）` : ''}`)
        log.error(err.message)
        emit('crashed', { generation, error: err })
        throw err
      }
    }

    const { nodeExe, npxCli } = locate()
    // 端口用上游公开开关 --port 传入：实测 DSH_PORT 环境变量被忽略（见 SPEC §11.1 #2）。
    const args = [npxCli, '--yes', '--offline', `--package=${TARGET_PKG}`, '--', 'dsh', 'web', '--no-open', '--port', String(config.port)]
    // npm_config_registry 由壳固定下发（覆盖用户/项目 .npmrc），保证 --offline 的元数据缓存键
    // 与预热时一致 —— 这是 §11.1 #7 的根源修法，详见 NPM_REGISTRY 处的说明。
    const env = { ...process.env, DSH_NO_BROWSER: '1', ELECTRON_RUN_AS_NODE: '0', npm_config_registry: NPM_REGISTRY }
    log.info(`spawning host gen=${generation} port=${config.port}`)

    child = spawn(nodeExe, args, {
      cwd: process.cwd(),
      env,
      shell: false, windowsHide: true, detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout?.on('data', d => appendTail('stdout', d))
    child.stderr?.on('data', d => {
      appendTail('stderr', d)
      if (/\bready\b/.test(d.toString())) scheduleImmediateProbe()
    })
    child.once('exit', (code, signal) => onChildExit(code, signal))

    scheduleReadyDeadline()
    scheduleProbes()
  }

  /**
   * @param {'idle'|'starting'|'ready'|'stopping'|'stopped'|'crashed'} next
   */
  function setState(next) { state = next }

  /**
   * @param {string} stream
   * @param {unknown} chunk
   */
  function appendTail(stream, chunk) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    const text = buf.toString('utf8')
    // 先用原文解析就绪行（token 只能实读），入库与写日志一律用遮蔽后的文本。
    if (stream === 'stdout') captureReadyLine(text)
    const safeText = text.replace(TOKEN_IN_TEXT_RE, '$1<redacted>')
    const tail = (stream === 'stdout' ? stdoutTail : stderrTail) + safeText
    const trimmed = tail.length > TAIL_BUFFER_BYTES ? tail.slice(-TAIL_BUFFER_BYTES) : tail
    if (stream === 'stdout') stdoutTail = trimmed; else stderrTail = trimmed
    // 脱敏后写日志，由 logger 进一步遮蔽。
    log.debug?.(`host ${stream}`, trimmed.slice(-512))
  }

  /**
   * 从 stdout 实读上游就绪行，取真实端口与进程 token。
   * 端口与配置不一致时明确报错并保持未就绪（SPEC §6：不静默更换端口）。
   * @param {string} text
   */
  function captureReadyLine(text) {
    if (readyInfo) return
    readyScanBuf = (readyScanBuf + text).slice(-READY_SCAN_BYTES)
    const m = READY_LINE_RE.exec(readyScanBuf)
    if (!m) return
    readyScanBuf = ''                      // 原文立即丢弃
    const port = Number(m[1])
    const token = m[2]
    if (port !== config.port) {
      log.error(`host ready line port mismatch: stdout=${port} config=${config.port}（不静默更换端口）`)
      return
    }
    readyInfo = { port, token }
    log.info(`host ready line parsed port=${port} token=<redacted>`)
    scheduleImmediateProbe()
  }

  /**
   * 就绪确认：必须先实读到就绪行（真实端口 + token），再以带 token 的 index 请求确认。
   * 没读到就绪行时不确认——token 不可自造。
   * @param {number} timeoutMs
   * @returns {Promise<boolean>}
   */
  function confirmHost(timeoutMs) {
    const info = readyInfo
    if (!info) return Promise.resolve(false)
    return probeIndex(info.port, info.token, timeoutMs)
  }

  /** @type {NodeJS.Timeout|null} */
  let immediateProbe = null
  function scheduleImmediateProbe() {
    if (immediateProbe) return
    immediateProbe = setTimeout(async () => {
      immediateProbe = null
      if (state === 'starting' && await confirmHost(PROBE_TIMEOUT_MS)) onReady()
    }, 0)
  }

  /** @type {NodeJS.Timeout|null} */
  let readyDeadline = null
  function scheduleReadyDeadline() {
    if (readyDeadline) clearTimeout(readyDeadline)
    readyDeadline = setTimeout(() => {
      if (state !== 'starting') return
      log.error('host ready deadline exceeded')
      // 先离开 starting：kill 触发的 exit 不再走 crashed/自动重启路径，
      // 本次启动终止，由上层弹窗决定重试（SPEC §4 / §6）。
      setState('crashed')
      emit('timeout', { generation })
      killTreeImmediate()
    }, T.readyDeadline)
  }

  /** @type {NodeJS.Timeout|null} */
  let probeLoop = null
  function scheduleProbes() {
    if (probeLoop) clearInterval(probeLoop)
    probeLoop = setInterval(async () => {
      if (state !== 'starting') return
      if (await confirmHost(PROBE_TIMEOUT_MS)) onReady()
    }, PROBE_INTERVAL_MS)
  }
  function stopProbes() {
    if (probeLoop) { clearInterval(probeLoop); probeLoop = null }
    if (readyDeadline) { clearTimeout(readyDeadline); readyDeadline = null }
    if (immediateProbe) { clearTimeout(immediateProbe); immediateProbe = null }
  }

  function onReady() {
    if (state !== 'starting') return
    stopProbes()
    setState('ready')
    // 此时端口占用者已被证明是本壳的子进程（就绪行的 token 就来自它自己的 stdout），
    // 记下它的 PID 供下次启动回收"自己崩溃后残留的孙进程"（见 reclaimOwnLeftover）。
    const ownerPid = findPortOwnerPid(config.port)
    const ownerInfo = ownerPid ? probeProcess(ownerPid) : null
    if (ownerPid && ownerInfo) {
      writeOwnerRecord(ownerRecordPath, {
        pid: ownerPid, port: config.port, generation,
        ticks: ownerInfo.ticks, cmdSha256: sha256(ownerInfo.cmd),
      })
    }
    emit('ready', { generation, port: readyInfo?.port ?? config.port })
    scheduleHealthChecks()
    // 稳定 5 分钟后清零重启预算，避免在 ready 阶段一次性清零形成无限重启。
    if (stableResetTimer) clearTimeout(stableResetTimer)
    stableResetTimer = setTimeout(() => { restartCount = 0 }, T.stableReset)
  }

  let consecutiveFails = 0
  /** @type {NodeJS.Timeout|null} */
  let healthTimerId = null
  function scheduleHealthChecks() {
    if (healthTimerId) clearInterval(healthTimerId)
    healthTimerId = setInterval(async () => {
      if (state !== 'ready' || stopping) return
      const ok = await confirmHost(HEALTH_TIMEOUT_MS)
      if (ok) { consecutiveFails = 0; return }
      consecutiveFails++
      if (consecutiveFails >= 3) {
        log.error('host lost after 3 consecutive failed probes')
        consecutiveFails = 0
        setState('crashed')
        emit('crashed', { generation })
        killTreeImmediate()
        maybeAutoRestart()
      }
    }, HEALTH_INTERVAL_MS)
  }
  function stopHealthChecks() {
    if (healthTimerId) { clearInterval(healthTimerId); healthTimerId = null }
    if (stableResetTimer) { clearTimeout(stableResetTimer); stableResetTimer = null }
  }
  /**
   * @param {number|null} code
   * @param {string|null} signal
   */
  function onChildExit(code, signal) {
    log.warn(`host exited code=${code} signal=${signal} gen=${generation} state=${state} stopping=${stopping}`)
    if (stopping) return finalizeStopped()
    if (state === 'ready') {
      // ready 后的非主动退出视为故障。
      setState('crashed')
      emit('exited', { generation, code, signal })
      stopHealthChecks()
      maybeAutoRestart()
    } else if (state === 'starting') {
      // SPEC §6：启动期失败不自动重启，交由上层"重试/退出"对话框决定。
      emit('crashed', { generation, error: new Error('exited during starting') })
    }
  }

  function maybeAutoRestart() {
    if (stopping) return
    if (restartCount >= T.restartDelays.length) {
      log.error('host continuous start failure, halting auto-restart')
      emit('crashed', { generation, fatal: true, error: new Error('CONTINUOUS_FAILURE') })
      return
    }
    const delay = T.restartDelays[restartCount++]
    log.info(`auto-restart in ${delay}ms (attempt ${restartCount})`)
    backoffTimer = setTimeout(() => start({ generation: generation + 1 }), delay)
  }

  /**
   * 手动重启入口；停止当前实例后重新走 start()，保留 restartCount 自增策略。
   * @returns {Promise<void>}
   */
  async function restart() {
    await stop()
    await start()
  }

  /**
   * 幂等停止：先 stopping，再发 dsh shutdown，超时后进程树强制回收。
   * @returns {Promise<void>}
   */
  function stop() {
    if (stopping) return Promise.resolve()
    stopping = true
    stopProbes()
    stopHealthChecks()
    if (backoffTimer) { clearTimeout(backoffTimer); backoffTimer = null }

    if (!child || child.exitCode !== null) {
      finalizeStopped()
      return Promise.resolve()
    }
    return new Promise(/** @param {(v:void)=>void} resolve */ (resolve) => {
      let done = false
      let graceTimer = null
      const finish = () => {
        if (done) return
        done = true
        if (graceTimer) { clearTimeout(graceTimer); graceTimer = null }
        resolve()
      }
      const onExit = () => { finalizeStopped(); finish() }
      // child 可能在装配监听之前就已退出，只依赖 once('exit') 会永久等待。
      if (child.exitCode !== null) { onExit(); return }
      // 优雅路径与强制路径共用一个成功判据：本次 host 实际退出（SPEC §6）。
      child.once('exit', onExit)
      let shutdown = null
      // 优先优雅关闭：dsh shutdown 末尾参数。运行时定位失败不阻塞回收，直接转强制。
      try {
        const { nodeExe, npxCli } = locate()
        // 与 web spawn 保持一致：DSH_PORT 实测对上游无效（§11.1 #2）已移除；registry 同样由壳固定。
        const env = { ...process.env, DSH_NO_BROWSER: '1', ELECTRON_RUN_AS_NODE: '0', npm_config_registry: NPM_REGISTRY }
        shutdown = spawn(nodeExe, [npxCli, '--yes', '--offline', `--package=${TARGET_PKG}`, '--', 'dsh', 'shutdown'], {
          cwd: process.cwd(), env, shell: false, windowsHide: true, detached: false,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } catch (e) {
        log.warn('runtime unavailable for graceful shutdown, force killing tree', e)
        killTreeImmediate()
      }
      shutdown?.once('exit', () => {
        // 仅靠 shutdown 命令返回 0 不算回收完成，必须以 host 实际退出为准。
      })
      setTimeout(() => {
        if (done) return
        log.warn('graceful shutdown timeout, killing tree')
        killTreeImmediate()
        // 兜底：强制回收后仍长时间收不到 exit 才放弃等待（避免 stop() 永久挂起）。
        // unref，防止这个定时器自己变成"进程不退出"的残留句柄。
        graceTimer = setTimeout(() => {
          if (done) return
          log.error('强制回收后仍未收到 host exit，停止等待')
          finish()
        }, FORCE_KILL_GRACE_MS)
        graceTimer.unref?.()
      }, T.shutdownWait)
    })
  }

  function killTreeImmediate() {
    if (!child || child.exitCode !== null) return
    if (process.platform === 'win32') {
      // Windows 按身份核对的 PID 强制 taskkill /T，禁止按进程名批量杀。
      try {
        execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], () => {})
      } catch (e) { log.error('taskkill failed', e) }
    } else {
      try { child.kill('SIGKILL') } catch (e) { log.error('kill failed', e) }
    }
  }

  function finalizeStopped() {
    setState('stopped')
    stopping = false
    child = null
  }

  /**
   * 让调用方等待 stopped 状态：polling，避免依赖未暴露的事件。
   * @returns {Promise<void>}
   */
  function stopped() {
    return new Promise(/** @param {(v:void)=>void} resolve */ (resolve) => {
      if (state === 'stopped') return resolve()
      const t = setInterval(() => { if (state === 'stopped') { clearInterval(t); resolve() } }, 50)
    })
  }

  return {
    start, stop, restart, isHealthy, getState, currentGeneration, on, off, stopped, authorize,
    /** 就绪行报告的真实端口；未就绪时回落到配置端口。 */
    get port() { return readyInfo?.port ?? config.port },
  }
}
