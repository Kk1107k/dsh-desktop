// SPEC §12 验收测试（A01~A10）。全部为 mock 层：
//   - electron / electron-updater 经 tests/stubs/ 假件替换（module.register 解析钩子）
//   - dsh host 子进程用 tests/helpers/fake-npx.mjs 替身（真实进程 + 真实状态机）
//   - 涉及真实安装、签名、COS 上传、上游 CLI 的断言留给 Phase 2 真实环境，此处只做
//     可执行的结构校验（构建配置、发布脚本纯函数）。
// 运行前提：pnpm build:preload 已生成 build/preload.cjs（package.json 的 build 链保证顺序）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register, createRequire } from 'node:module'
import { spawnSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:net'
import { mkdirSync, mkdtempSync, existsSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')

// electron / electron-updater 假件：必须先注册，再动态 import 任何 src 模块。
register('./stubs/hooks.mjs', import.meta.url)

const FAKE_NPX = fileURLToPath(new URL('./helpers/fake-npx.mjs', import.meta.url))

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function waitUntil(fn, ms = 8000, step = 25) {
  const t0 = Date.now()
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() - t0 > ms) throw new Error(`waitUntil 超时（${ms}ms）`)
    await sleep(step)
  }
}

/** 订阅 host 事件并等待满足条件的载荷。 */
function waitEvent(host, ev, pred = null, ms = 20000) {
  const ok = pred ?? (() => true)
  return new Promise((res, reject) => {
    const timer = setTimeout(() => { host.off(ev, fn); reject(new Error(`等待 ${ev} 超时`)) }, ms)
    const fn = (payload) => {
      if (!ok(payload)) return
      clearTimeout(timer); host.off(ev, fn); res(payload)
    }
    host.on(ev, fn)
  })
}

const fakeLogger = () => {
  /** @type {[string,string][]} */
  const calls = []
  const rec = (lvl) => /** @param {...unknown} args */ (...args) => { calls.push([lvl, args.map(a => String(a)).join(' ')]) }
  return { calls, info: rec('info'), warn: rec('warn'), error: rec('error'), debug: rec('debug') }
}

function setEnv(vars) {
  const saved = {}
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

function mktmp(prefix) { return mkdtempSync(join(tmpdir(), prefix)) }

const readNum = (dir, name) => {
  const p = join(dir, name)
  return existsSync(p) ? Number(readFileSync(p, 'utf8')) || 0 : 0
}

/** 进程是否已不存在（Windows 上 kill(pid,0) 对不存在进程抛 ESRCH）。 */
function processGone(pid) {
  try { process.kill(Number(pid), 0); return false } catch (_) { return true }
}

function createFakeHost({ port, stateDir, timings, ownerRecordPath }) {
  // dsh-host 经动态 import 拿到（此时 electron 假件已注册）。
  return import('../src/dsh-host.js').then(({ createDshHost }) => createDshHost({
    config: { port },
    logger: fakeLogger(),
    locateRuntime: () => ({ nodeExe: process.execPath, npxCli: FAKE_NPX }),
    timings,
    ownerRecordPath,
  }))
}

function resetElectronStub(cfg) {
  globalThis.__DSH_TEST_ELECTRON__ = { version: '0.1.0', isPackaged: true, lock: true, quitCalls: 0, ...cfg }
}

function updaterDeps() {
  const d = { states: [], opened: 0, trayStates: [], flashes: [], stopBeforeInstall: 0 }
  const deps = {
    logger: fakeLogger(),
    config: { autoCheckIntervalHours: 6 },
    isPackaged: true,
    // 备源 feed URL 可注入：默认值是 SPEC 允许的占位符（不是合法 URL，见"备源未配置"用例）。
    // 这里给一个合法地址，让 COS 降级相关的用例仍能真实驱动备源实例。
    cosUrl: 'https://cos.test/dsh-desktop',
    onTrayState: () => 'idle',
    onTraySetState: (s) => { d.trayStates.push(s) },
    onTraySetText: (t, ms) => { d.flashes.push([t, ms]) },
    onUpdateState: (ev) => { d.states.push(ev) },
    onUpdateOpen: () => { d.opened++ },
    onHostStopBeforeInstall: () => { d.stopBeforeInstall++ },
    onHostRestartAfterInstall: () => {},
  }
  return { deps, d }
}

async function makeUpdater() {
  // 只在未初始化时兜底，**不得清空**：用例会把 behavior 设在调用之前，
  // 清空会让 stub 找不到 behavior 而不 emit，状态停在 checking 直到 waitUntil 超时。
  // 隔离由每个用例开头「整体替换」__DSH_TEST_UPDATER__ 保证（同时重置 instances）。
  if (!globalThis.__DSH_TEST_UPDATER__) globalThis.__DSH_TEST_UPDATER__ = {}
  const { createUpdater } = await import('../src/updater.js')
  const { deps, d } = updaterDeps()
  return { up: createUpdater(deps), d }
}

// ---------------------------------------------------------------------------
// A0-1 / A0-2 回归：运行时定位与 ESM require
// ---------------------------------------------------------------------------

test('A0-1 locateRuntime 找到真实外部 node.exe 与 npx-cli.js（绝对路径、非 Electron）', async () => {
  const { locateRuntime } = await import('../src/dsh-host.js')
  const { nodeExe, npxCli } = locateRuntime()
  assert.ok(existsSync(nodeExe), `nodeExe 应存在: ${nodeExe}`)
  assert.ok(existsSync(npxCli), `npxCli 应存在: ${npxCli}`)
  assert.ok(/^[A-Za-z]:[\\/]/.test(nodeExe) || nodeExe.startsWith('/'), 'nodeExe 应为绝对路径')
  assert.ok(!/electron/i.test(nodeExe), '禁止把 Electron 可执行文件当 Node')
})

test('A0-2 回归：src 的 ESM 文件不再出现 require()（preload.js 除外，它打成 CJS）', async () => {
  const srcDir = join(root, 'src')
  for (const f of readdirSync(srcDir)) {
    if (!f.endsWith('.js') || f === 'preload.js') continue
    const content = readFileSync(join(srcDir, f), 'utf8')
    assert.ok(!/\brequire\s*\(/.test(content), `${f} 不应再使用 require()（ESM 运行时无 require）`)
  }
  // preload.js 必须保持 CJS 形态：esbuild 会把它打成 build/preload.cjs。
  const preload = readFileSync(join(srcDir, 'preload.js'), 'utf8')
  assert.ok(preload.includes("require('electron')"), 'preload.js 应保持 require（打包为 CJS 的前提）')
})

// ---------------------------------------------------------------------------
// A01 单例与启动
// ---------------------------------------------------------------------------

test('A01 splash 展示门控常量：min-display 2400ms、淡出 300ms（不早于）', async () => {
  const m = await import('../src/main.js')
  assert.equal(m.SPEC_MIN_SPLASH_MS, 2400)
  assert.equal(m.SPEC_FADE_MS, 300)
})

test('A01 未取得单例锁的第二实例立即 app.quit()', async () => {
  resetElectronStub({ lock: false })
  // query 后缀强制重新求值模块（正常 import 已缓存）。
  await import('../src/main.js?second-instance')
  assert.equal(globalThis.__DSH_TEST_ELECTRON__.quitCalls, 1, '第二实例应调用 app.quit()')
})

test('A01 loadConfig：合法配置生效；损坏文件恢复默认并留 .corrupt 副本', async () => {
  const dir = mktmp('dsh-a01-cfg-')
  resetElectronStub({ userData: dir })
  const { loadConfig } = await import('../src/main.js')
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    schemaVersion: 1, port: 3090, theme: 'dark', autoCheckIntervalHours: 12, runMode: 'ptc', skipVersion: null,
  }), 'utf8')
  assert.deepEqual(loadConfig(), {
    schemaVersion: 1, port: 3090, theme: 'dark', autoCheckIntervalHours: 12, runMode: 'ptc', skipVersion: null,
  })
  writeFileSync(join(dir, 'config.json'), '{not json', 'utf8')
  const cfg = loadConfig()
  assert.equal(cfg.port, 3080, '损坏后应恢复默认端口')
  assert.equal(cfg.runMode, 'standard')
  assert.ok(readdirSync(dir).some(f => f.startsWith('config.json') && f.endsWith('.corrupt')), '应保留 .corrupt 副本')
  rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// A02 启动失败与取消（mock host）
// ---------------------------------------------------------------------------

test('A02 端口被占用 → E_PORT_IN_USE，不接管、不杀占用者', async () => {
  const stateDir = mktmp('dsh-a02-port-')
  const restore = setEnv({ FAKE_MODE: 'serve', FAKE_STATE_DIR: stateDir })
  const port = 3181
  const occupier = createServer()
  await new Promise(r => occupier.listen(port, '127.0.0.1', r))
  const host = await createFakeHost({ port, stateDir })
  /** @type {Error & {code?:string}} */
  let portErr = new Error('not thrown')
  await assert.rejects(host.start({ generation: 0 }), err => { portErr = err; return err.code === 'E_PORT_IN_USE' })
  assert.ok(occupier.listening, '占用者必须存活（不杀占者）')
  // 文案按码区分：端口冲突不得挂"装 Node"这类无关提示（会把人带偏），且要给出占用者 PID
  assert.ok(!/安装 Node|环境准备/.test(portErr.message), `端口冲突不该出现环境准备提示：${portErr.message}`)
  assert.match(portErr.message, /占用者 PID=\d+/, '应报出占用者 PID，便于人工核对')
  assert.match(portErr.message, /禁止按进程名或端口批量结束/, '应说明禁止批量结束')
  occupier.close()
  await host.stop()
  restore(); rmSync(stateDir, { recursive: true, force: true })
})

/**
 * 从 OS 取进程身份材料（创建时间 ticks + 命令行哈希）。
 * 测试自行获取，而不是调用被测代码 —— 否则等于自证。
 * @param {number} pid
 */
function processIdentity(pid) {
  const ps = `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { [pscustomobject]@{ t = $p.CreationDate.Ticks; c = $p.CommandLine } | ConvertTo-Json -Compress }`
  const out = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 8000 })
  const parsed = JSON.parse(String(out.stdout ?? '').trim() || 'null')
  return {
    ticks: String(parsed.t),
    cmdSha256: createHash('sha256').update(String(parsed.c ?? ''), 'utf8').digest('hex'),
  }
}

test('§6 错误提示按码区分：环境准备提示只给"环境缺失"两类', async () => {
  const src = readFileSync(join(root, 'src', 'dsh-host.js'), 'utf8')
  const at = src.indexOf('const ERROR_HINTS')
  assert.ok(at > 0, '应存在按码映射的提示表')
  const table = src.slice(at, src.indexOf('\n}', at))
  assert.match(table, /E_RUNTIME_MISSING:\s*RUNTIME_HINT/, 'E_RUNTIME_MISSING 保留环境准备提示')
  assert.match(table, /E_CLI_MISSING:\s*RUNTIME_HINT/, 'E_CLI_MISSING 保留环境准备提示')
  const portRow = table.slice(table.indexOf('E_PORT_IN_USE'))
  assert.ok(!/安装 Node|环境准备/.test(portRow), 'E_PORT_IN_USE 不得挂环境准备提示')
  assert.match(portRow, /PID/, 'E_PORT_IN_USE 提示应给出按 PID 核对的指引')
})

test('§6 端口残留自愈：只回收"记录过 + 身份核对过"的自己人；别人的进程照报 E_PORT_IN_USE', async () => {
  const stateDir = mktmp('dsh-reclaim-')
  const restore = setEnv({ FAKE_MODE: 'serve', FAKE_STATE_DIR: stateDir })
  const port = 3186
  const recordPath = join(stateDir, 'host-owner.json')

  // 造"上次崩溃残留"：直接起一个 fixture 占住端口，命令行带本壳固定包名 pin（与真实形态一致）
  const leftover = spawn(process.execPath, [
    FAKE_NPX, '--yes', '--offline', '--package=@deepseek-ai/dsh@0.1.7-alpha.2', '--', 'dsh', 'web', '--no-open', '--port', String(port),
  ], { env: { ...process.env, FAKE_MODE: 'serve', FAKE_STATE_DIR: stateDir }, stdio: 'ignore', windowsHide: true })
  try {
    await waitUntil(() => existsSync(join(stateDir, 'listening')), 8000)

    // 负例：没有记录 ⇒ 不得回收（哪怕占用者看起来像自己人）
    const hostA = await createFakeHost({ port, stateDir, ownerRecordPath: recordPath })
    await assert.rejects(hostA.start({ generation: 0 }), err => err.code === 'E_PORT_IN_USE', '没有记录时不得回收')
    assert.ok(!processGone(leftover.pid), '不得杀掉身份不明的占用者（§6 禁止按端口批量杀）')
    assert.ok(existsSync(join(stateDir, 'listening')), '占用者必须仍在服务')
    await hostA.stop()

    // 负例 2：PID 对但身份材料不符（模拟 PID 重用/别的进程）⇒ 同样不得回收
    writeFileSync(recordPath, JSON.stringify({ pid: leftover.pid, port, generation: 0, ticks: '1', cmdSha256: 'deadbeef' }), 'utf8')
    const hostC = await createFakeHost({ port, stateDir, ownerRecordPath: recordPath })
    await assert.rejects(hostC.start({ generation: 0 }), err => err.code === 'E_PORT_IN_USE', '身份不符不得回收')
    assert.ok(!processGone(leftover.pid), '身份不符时不得杀')
    await hostC.stop()

    // 正例：记录里存过它（模拟上次就绪时写下的 owner，含身份材料）⇒ 应自愈
    writeFileSync(recordPath, JSON.stringify({
      pid: leftover.pid, port, generation: 0,
      package: '@deepseek-ai/dsh@0.1.7-alpha.2', ...processIdentity(leftover.pid),
    }), 'utf8')
    const hostB = await createFakeHost({ port, stateDir, ownerRecordPath: recordPath })
    const readyP = waitEvent(hostB, 'ready', null, 20000)
    await hostB.start({ generation: 0 })
    await readyP
    assert.equal(hostB.getState().state, 'ready', 'PID 记录匹配且身份核对通过时应回收自己人并正常就绪')
    assert.ok(processGone(leftover.pid), '残留进程应已被回收')
    await hostB.stop()
  } finally {
    try { process.kill(leftover.pid, 'SIGKILL') } catch (_) { /* 已回收 */ }
    restore(); rmSync(stateDir, { recursive: true, force: true })
  }
})

test('A02 mock host 15s 不就绪（压缩为 700ms）→ timeout 事件、终止本次启动、无自动重启、无遗留进程', async () => {
  const stateDir = mktmp('dsh-a02-timeout-')
  const restore = setEnv({ FAKE_MODE: 'hang', FAKE_STATE_DIR: stateDir })
  const host = await createFakeHost({ port: 3182, stateDir, timings: { readyDeadline: 700 } })
  const timeoutP = waitEvent(host, 'timeout', null, 5000)
  await host.start({ generation: 0 })
  await timeoutP
  assert.equal(readNum(stateDir, 'start-count'), 1, '超时后不得自动重启（SPEC §4：交由对话框决定）')
  assert.equal(host.getState().state, 'crashed')
  await host.stop()
  assert.equal(readNum(stateDir, 'start-count'), 1)
  assert.ok(processGone(readNum(stateDir, 'pid')), '超时路径不得遗留 host 进程')
  restore(); rmSync(stateDir, { recursive: true, force: true })
})

test('A02 启动期崩溃 → crashed 事件，不进入自动重启（SPEC §6）', async () => {
  const stateDir = mktmp('dsh-a02-crash-')
  const restore = setEnv({ FAKE_MODE: 'crash', FAKE_STATE_DIR: stateDir })
  const host = await createFakeHost({ port: 3183, stateDir })
  const crashedP = waitEvent(host, 'crashed', null, 5000)
  await host.start({ generation: 0 })
  await crashedP
  await sleep(400)
  assert.equal(readNum(stateDir, 'start-count'), 1, '启动期失败不自动重启')
  await host.stop()
  restore(); rmSync(stateDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// A03 健康与崩溃恢复
// ---------------------------------------------------------------------------

test('A03 退避序列默认值为 1/2/4/8/8 秒（结构断言）', async () => {
  const src = readFileSync(join(root, 'src', 'dsh-host.js'), 'utf8')
  assert.ok(/RESTART_DELAYS_MS = \[1000, 2000, 4000, 8000, 8000\]/.test(src), '退避序列应与 SPEC §6 一致')
})

test('A03 ready 后连续六次故障 → 恰好五次自动重启，第六次 fatal 停止（压缩退避）', async () => {
  const stateDir = mktmp('dsh-a03-')
  const restore = setEnv({ FAKE_MODE: 'flaky', FAKE_STATE_DIR: stateDir, FAKE_DIE_TIMES: '6' })
  const host = await createFakeHost({ port: 3184, stateDir, timings: { restartDelays: [30, 30, 30, 30, 30] } })
  const readyP = waitEvent(host, 'ready')
  const fatalP = waitEvent(host, 'crashed', ev => ev.fatal, 30000)
  await host.start({ generation: 0 })
  await readyP
  await fatalP
  // 初始 1 次 + 5 次重启 = 6 次启动；第六次故障后不再重启。
  assert.equal(readNum(stateDir, 'start-count'), 6)
  await sleep(500)
  assert.equal(readNum(stateDir, 'start-count'), 6, 'fatal 后不得再启动')
  await host.stop()
  restore(); rmSync(stateDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// A04 / A05 / A06 / A08 更新状态机（NsisUpdater 假件）
// ---------------------------------------------------------------------------

test('A04 GitHub 有新版 → available（含版本与说明），不自动下载', async () => {
  globalThis.__DSH_TEST_UPDATER__ = {
    github: { check: (inst) => { inst.emit('update-available', { version: '0.2.0', releaseNotes: '<b>修复</b>若干问题' }) } },
  }
  const { up, d } = await makeUpdater()
  const res = await up.checkOnce({ manual: true })
  assert.equal(res.ok, true)
  await waitUntil(() => d.states.some(s => s.snapshot.state === 'available'))
  const last = d.states.at(-1).snapshot
  assert.equal(last.state, 'available')
  assert.equal(last.version, '0.2.0')
  assert.equal(last.notes, '修复若干问题', '更新说明应转纯文本')
  assert.ok(d.opened >= 1, '有新版应打开更新窗口')
  const instances = globalThis.__DSH_TEST_UPDATER__.instances
  assert.equal(instances.length, 2, '双源两个实例')
  const [gh, cos] = instances
  assert.equal(gh.config.provider, 'github')
  assert.equal(gh.channel, 'stable')
  assert.equal(gh.config.autoDownload, false)
  assert.equal(gh.config.allowDowngrade, false)
  assert.equal(cos.config.provider, 'generic')
  assert.equal(cos.channel, 'cn-stable')
  assert.equal(gh.downloadCalls, 0, 'autoDownload=false：不自动下载')
  up.dispose()
})

test('A05/§7:216 双源实例最终 allowDowngrade=false（channel setter 会把它置 true，必须在赋值后重设）', async () => {
  // 先证明假件忠实复刻了上游副作用（否则下面的断言是空转）。
  const { NsisUpdater } = await import('./stubs/electron-updater.mjs')
  const probe = new NsisUpdater({ provider: 'github', allowDowngrade: false })
  assert.equal(probe.allowDowngrade, false, '构造 options 里的 allowDowngrade 应生效')
  probe.channel = 'stable'
  assert.equal(probe.allowDowngrade, true, '假件必须复刻上游 set channel 置 true 的副作用')

  globalThis.__DSH_TEST_UPDATER__ = {
    github: { check: (inst) => { inst.emit('update-available', { version: '0.2.0', releaseNotes: '' }) } },
  }
  const { up } = await makeUpdater()
  await up.checkOnce({ manual: true })
  const [gh, cos] = globalThis.__DSH_TEST_UPDATER__.instances
  assert.equal(gh.channel, 'stable')
  assert.equal(cos.channel, 'cn-stable')
  assert.equal(gh.allowDowngrade, false, 'channel 赋值之后必须重设 allowDowngrade=false（SPEC §7:216）')
  assert.equal(cos.allowDowngrade, false, '两个实例都要重设')
  up.dispose()
})

test('A04 无新版 → latest + 托盘 5s 文字反馈，不新建弹窗', async () => {
  globalThis.__DSH_TEST_UPDATER__ = {
    github: { check: (inst) => { inst.emit('update-not-available') } },
  }
  const { up, d } = await makeUpdater()
  await up.checkOnce({ manual: true })
  await waitUntil(() => d.states.some(s => s.snapshot.state === 'latest'))
  assert.equal(d.states.at(-1).snapshot.version, '0.1.0', '当前版本来自 app.getVersion()')
  assert.deepEqual(d.flashes.at(-1), ['已检查更新', 5000])
  assert.equal(d.opened, 0, '无新版不新建弹窗')
  up.dispose()
})

test('A05 GitHub 网络失败（ETIMEDOUT）→ 真实转向 COS 实例且不降版本', async () => {
  globalThis.__DSH_TEST_UPDATER__ = {
    github: { check: async () => { throw new Error('Request timed out (ETIMEDOUT)') } },
    cos: { check: (inst) => { inst.emit('update-available', { version: '0.2.0', releaseNotes: 'n' }) } },
  }
  const { up, d } = await makeUpdater()
  await up.checkOnce({ manual: true })
  await waitUntil(() => d.states.some(s => s.snapshot.state === 'available'))
  const [gh, cos] = globalThis.__DSH_TEST_UPDATER__.instances
  assert.equal(gh.checkCalls, 1)
  assert.equal(cos.checkCalls, 1, 'GitHub 失败后应转向 COS 实例')
  assert.equal(cos.config.allowDowngrade, false, '不降版本')
  assert.equal(cos.config.provider, 'generic')
  assert.equal(d.states.at(-1).snapshot.version, '0.2.0')
  up.dispose()
})

test('A05 双源均失败 → error（无法连接更新服务）+ 手动下载入口（打开窗口）', async () => {
  globalThis.__DSH_TEST_UPDATER__ = {
    github: { check: async () => { throw new Error('getaddrinfo ENOTFOUND github.com') } },
    cos: { check: async () => { throw new Error('connect ECONNREFUSED') } },
  }
  const { up, d } = await makeUpdater()
  await up.checkOnce({ manual: true })
  await waitUntil(() => d.states.some(s => s.snapshot.state === 'error'))
  assert.equal(d.states.at(-1).snapshot.message, '无法连接更新服务')
  assert.ok(d.opened >= 1, '双源失败应展示手动下载入口')
  up.dispose()
})

test('A06 snooze 持久化 until = T+86400000；写盘失败返回 E_IO 不伪装成功', async () => {
  const dir = mktmp('dsh-a06-')
  resetElectronStub({ userData: dir, isPackaged: true })
  const { up, d } = await makeUpdater()
  const before = Date.now()
  const res = await up.snooze()
  assert.equal(res.ok, true)
  const saved = JSON.parse(readFileSync(join(dir, 'update-snooze.json'), 'utf8'))
  assert.ok(Math.abs(saved.until - (before + 86400000)) < 2000, 'until = T+24h')
  assert.equal(d.states.at(-1).snapshot.state, 'idle', '成功延后才回 idle')

  // 模拟写盘失败：userData 指向不存在的深层目录。
  resetElectronStub({ userData: join(dir, 'no', 'such', 'dir'), isPackaged: true })
  const { up: up2, d: d2 } = await makeUpdater()
  globalThis.__DSH_TEST_UPDATER__ = { github: { check: () => {} } }
  await up2.checkOnce({ manual: true })
  await waitUntil(() => d2.states.some(s => s.snapshot.state === 'checking'))
  const res2 = await up2.snooze()
  assert.equal(res2.ok, false, '写盘失败不得伪装成功')
  assert.equal(res2.error.code, 'E_IO')
  assert.equal(d2.states.at(-1).snapshot.state, 'checking', '失败后不回 idle')
  up.dispose(); up2.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test('A06 重启后 snooze 未到期 → 自动检查被抑制（不发起网络检查）', async () => {
  const dir = mktmp('dsh-a06b-')
  resetElectronStub({ userData: dir, isPackaged: true })
  globalThis.__DSH_TEST_UPDATER__ = {}
  const { up } = await makeUpdater()
  await up.snooze()
  const { up: up2 } = await makeUpdater()   // 模拟重启后的新实例
  await up2.checkOnce({ manual: false })
  assert.equal((globalThis.__DSH_TEST_UPDATER__.instances ?? []).length, 0, 'snooze 生效期间不创建检查实例')
  up.dispose(); up2.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test('A08 下载中 GitHub 失败 → COS 元数据一致才续接；下载完成先停 host 再安装', async () => {
  globalThis.__DSH_TEST_UPDATER__ = {
    github: {
      check: (inst) => { inst.emit('update-available', { version: '0.2.0', releaseNotes: 'n' }) },
      download: (inst) => {
        inst.emit('download-progress', { percent: 42 })
        inst.emit('error', new Error('read ECONNRESET'))
      },
    },
    cos: {
      metadata: { version: '0.2.0' },
      download: (inst) => {
        inst.emit('download-progress', { percent: 100 })
        inst.emit('update-downloaded')
      },
    },
  }
  const { up, d } = await makeUpdater()
  await up.checkOnce({ manual: true })
  await waitUntil(() => d.states.some(s => s.snapshot.state === 'available'))
  await up.startDownload()
  await waitUntil(() => d.states.some(s => s.snapshot.state === 'downloading' && s.snapshot.progress === 1))
  const [, cos] = globalThis.__DSH_TEST_UPDATER__.instances
  assert.equal(cos.downloadCalls, 1, '镜像一致时应续接到 COS 下载')
  assert.equal(d.stopBeforeInstall, 1, '安装前必须先回收 host')
  assert.equal(cos.quitAndInstallCalled, true, '随后才安装重启')
  up.dispose()
})

test('A08 COS 元数据版本不一致 → E_MIRROR_MISMATCH，不下载不安装', async () => {
  globalThis.__DSH_TEST_UPDATER__ = {
    github: {
      check: (inst) => { inst.emit('update-available', { version: '0.2.0', releaseNotes: 'n' }) },
      download: (inst) => {
        inst.emit('download-progress', { percent: 10 })
        inst.emit('error', new Error('read ECONNRESET'))
      },
    },
    cos: { metadata: { version: '9.9.9' } },
  }
  const { up, d } = await makeUpdater()
  await up.checkOnce({ manual: true })
  await waitUntil(() => d.states.some(s => s.snapshot.state === 'available'))
  await up.startDownload()
  await waitUntil(() => d.states.some(s => s.snapshot.state === 'error'))
  assert.match(d.states.at(-1).snapshot.message, /E_MIRROR_MISMATCH/)
  const [, cos] = globalThis.__DSH_TEST_UPDATER__.instances
  assert.equal(cos.downloadCalls, 0, '镜像不一致不得下载')
  assert.equal(cos.quitAndInstallCalled, false)
  up.dispose()
})

test('A08 COS 下载阶段失败 → error，不安装', async () => {
  globalThis.__DSH_TEST_UPDATER__ = {
    github: {
      check: (inst) => { inst.emit('update-available', { version: '0.2.0', releaseNotes: 'n' }) },
      download: (inst) => {
        inst.emit('download-progress', { percent: 42 })
        inst.emit('error', new Error('read ECONNRESET'))
      },
    },
    cos: {
      metadata: { version: '0.2.0' },
      download: (inst) => {
        inst.emit('download-progress', { percent: 60 })
        inst.emit('error', new Error('bad signature'))
      },
    },
  }
  const { up, d } = await makeUpdater()
  await up.checkOnce({ manual: true })
  await waitUntil(() => d.states.some(s => s.snapshot.state === 'available'))
  await up.startDownload()
  await waitUntil(() => d.states.some(s => s.snapshot.state === 'error'))
  const [, cos] = globalThis.__DSH_TEST_UPDATER__.instances
  assert.equal(cos.quitAndInstallCalled, false, '校验/签名失败不得安装')
  up.dispose()
})

// ---------------------------------------------------------------------------
// A07 IPC 与版本
// ---------------------------------------------------------------------------

test('A07 IPC 授权：host 窗口 / 子 frame / 未知 URL 一律 E_FORBIDDEN，无副作用', async () => {
  resetElectronStub({ isPackaged: false })
  const { createIpc, CHANNELS } = await import('../src/ipc.js')
  let minimized = false
  const deps = {
    logger: fakeLogger(),
    getSplash: () => ({ minimize() { minimized = true } }),
    getMain: () => null,
    getGeneration: () => 0,
    setFinishRequested: () => {},
    onSplashFinishConfirm: () => {},
    onSplashCloseBeforeFinish: () => {},
    updater: null,
    tray: () => null,
  }
  const ipc = createIpc(deps)
  ipc.register()
  // 复用 stub 的 ipcMain（经解析钩子导入的是同一个模块实例）。
  const { ipcMain } = await import('electron')
  const call = (ch, ev) => ipcMain.handlers.get(ch)(ev)

  const frameSplash = { processArguments: ['--dsh-role=splash', '--dsh-version=0.1.0'] }
  const sender = (url, frame) => ({ isDestroyed: () => false, getURL: () => url, mainFrame: frame })

  // splash 页本体：bridge-ready 通过。
  const okRes = await call(CHANNELS.BRIDGE_READY, { sender: sender('dsh-app://ui/splash.html', frameSplash), senderFrame: frameSplash })
  assert.equal(okRes.ok, true)
  assert.equal(okRes.data.version, '0.1.0')
  assert.deepEqual(okRes.data.update, { revision: 0, snapshot: { state: 'idle' } },
    'update 必须是 SPEC §5:156 的 UpdateEvent（{revision, snapshot}），不是裸快照')

  // host 窗口（上游页面）：拒绝。
  const fromHost = await call(CHANNELS.BRIDGE_READY, { sender: sender('http://127.0.0.1:3080/', frameSplash), senderFrame: frameSplash })
  assert.equal(fromHost.ok, false)
  assert.equal(fromHost.error.code, 'E_FORBIDDEN')

  // 子 frame：拒绝。
  const fromSub = await call(CHANNELS.BRIDGE_READY, { sender: sender('dsh-app://ui/splash.html', frameSplash), senderFrame: { processArguments: ['--dsh-role=splash'] } })
  assert.equal(fromSub.ok, false)
  assert.equal(fromSub.error.code, 'E_FORBIDDEN')

  // minimize：授权页可调用且真实生效（getSplash 语义回归）。
  const minRes = await call(CHANNELS.SPLASH_MINIMIZE, { sender: sender('dsh-app://ui/splash.html', frameSplash), senderFrame: frameSplash })
  assert.equal(minRes.ok, true)
  assert.equal(minimized, true)

  // dev 模式手动检查：E_UNPACKAGED。
  const frameUpdate = { processArguments: ['--dsh-role=update'] }
  const updRes = await call(CHANNELS.CHECK_UPDATE, { sender: sender('dsh-app://ui/update-dialog.html', frameUpdate), senderFrame: frameUpdate })
  assert.equal(updRes.ok, false)
  assert.equal(updRes.error.code, 'E_UNPACKAGED')

  // 角色与页面不匹配（splash 页调更新 channel）：拒绝。
  const cross = await call(CHANNELS.UPDATE_DOWNLOAD, { sender: sender('dsh-app://ui/splash.html', frameSplash), senderFrame: frameSplash })
  assert.equal(cross.ok, false)
  assert.equal(cross.error.code, 'E_FORBIDDEN')
  ipc.dispose()
})

test('A07 channel 契约：10 个 channel 名与 preload/页面契约一致', async () => {
  const { CHANNELS } = await import('../src/ipc.js')
  assert.deepEqual(new Set(Object.values(CHANNELS)), new Set([
    'dsh:bridge-ready', 'dsh:splash-minimize', 'dsh:splash-close', 'dsh:check-update',
    'dsh:update-download', 'dsh:update-snooze', 'dsh:update-close',
    'dsh:splash-status', 'dsh:splash-finish', 'dsh:update-state',
  ]))
})

test('A07 preload 契约：splashAPI / updateAPI 方法名逐字对齐 INTERFACE.md §1', async () => {
  const preload = readFileSync(join(root, 'src', 'preload.js'), 'utf8')
  assert.ok(/exposeInMainWorld\('splashAPI'/.test(preload))
  for (const m of ['onStatus', 'onFinish', 'getVersion', 'minimize', 'close']) {
    assert.ok(preload.includes(`${m}(`) || preload.includes(`${m} (`), `splashAPI.${m} 应存在`)
  }
  assert.ok(/exposeInMainWorld\('updateAPI'/.test(preload))
  for (const m of ['onState', 'getState', 'startDownload', 'retry', 'close', 'snooze']) {
    assert.ok(preload.includes(`${m}(`) || preload.includes(`${m} (`), `updateAPI.${m} 应存在`)
  }
  assert.ok(!preload.includes('exposeInMainWorld(\'dshApi\''), 'D1 结论：不新增 dshApi')
})

test('A07 版本来源：页面不写死版本号；preload 从 --dsh-version 读取', async () => {
  for (const page of ['splash.html', 'update-dialog.html', 'about.html']) {
    const html = readFileSync(join(root, 'src', page), 'utf8')
    assert.ok(!/0\.1\.0/.test(html), `${page} 不应写死版本号`)
  }
  // about 页不挂 preload（SPEC §9），版本只能走协议响应期替换：占位符必须在，且不得留脚本。
  const about = readFileSync(join(root, 'src', 'about.html'), 'utf8')
  assert.ok(about.includes('__APP_VERSION__'), 'about 页应保留版本占位符供主进程替换')
  assert.ok(!/<script/i.test(about), 'about 页不应有脚本（其 meta CSP 的 script-src 不含 inline/哈希，脚本必被挡）')
  const preload = readFileSync(join(root, 'src', 'preload.js'), 'utf8')
  assert.ok(preload.includes('--dsh-version='), '版本应来自 additionalArguments')
  // 版本随 package.json 同步：构建产物存在即由 preload 缓存提供。
  assert.ok(existsSync(join(root, 'build', 'preload.cjs')), 'build/preload.cjs 应已生成（先跑 pnpm build:preload）')
})

test('A07 about 页版本：协议响应期替换占位符，不依赖脚本执行（D4）', async () => {
  resetElectronStub({ version: '9.9.9' })
  const { renderLocalPage, handleDshAppRequest } = await import('../src/main.js')

  // 纯函数语义：只做精确占位符替换，其余文本原样。
  assert.equal(renderLocalPage('<span>__APP_VERSION__</span>', '1.2.3'), '<span>1.2.3</span>')
  assert.equal(renderLocalPage('无占位符的文本', '1.2.3'), '无占位符的文本', '不含占位符的文本不得被改写')

  // 走真实处理器：白名单页面 → 替换成 app.getVersion()，并仍带本地页 CSP。
  const res = await handleDshAppRequest(new Request('dsh-app://ui/about.html'))
  assert.equal(res.status, 200)
  const html = await res.text()
  assert.ok(html.includes('9.9.9'), '应替换为 app.getVersion()')
  assert.ok(!html.includes('__APP_VERSION__'), '不得残留占位符')
  assert.match(res.headers.get('content-type') ?? '', /text\/html/, 'Content-Type 应为 text/html')
  const csp = res.headers.get('content-security-policy') ?? ''
  const scriptSrc = csp.split('script-src')[1]?.split(';')[0] ?? ''
  assert.match(scriptSrc, /'self'/, "about 页 script-src 应保留 'self'")
  assert.ok(!/sha256-/.test(csp), 'about 页已无 inline script，哈希列表应为空')
  assert.ok(!/unsafe-(eval|inline)/.test(scriptSrc), '不得为显示版本而放宽 script-src')

  // 非白名单路径：不替换、直接 404（替换范围不外溢）。
  const bad = await handleDshAppRequest(new Request('dsh-app://ui/evil.html'))
  assert.equal(bad.status, 404, '非白名单路径不得被替换或放行')
  assert.equal(await bad.text(), 'not found')
})

test('A07 更新弹窗「稍后」契约：必须按 snooze() 结果决定是否关窗（D3）', async () => {
  // dev 态 isPackaged=false，更新弹窗不会出现 ⇒ 页面行为没有真机可达路径可点，
  // 只能以源码级断言兜底（先例：「页面不写死版本号」）。断言的是契约结构，不是排版。
  const html = readFileSync(join(root, 'src', 'update-dialog.html'), 'utf8')
  const from = html.indexOf('btnS.addEventListener')
  assert.ok(from > 0, '应能找到「稍后」按钮的处理器')
  const handler = html.slice(from, html.indexOf('if (api) {', from))

  assert.match(handler, /async/, '处理器应为异步：必须等待 snooze() 的持久化结果')
  assert.match(handler, /await\s+api\.snooze\(\)/, '必须 await snooze() 的返回值')
  assert.match(handler, /res\s*&&\s*res\.ok\s*===\s*true/, '必须判断返回值的 ok（而非发出请求就完事）')
  assert.match(handler, /ok[\s\S]*api\.close\(\)/, '关窗必须由成功结果控制')
  assert.ok(!/if \(api && api\.close\) api\.close\(\);/.test(handler),
    '不得恢复"无条件关窗"的旧写法 —— 那会把 E_IO 写盘失败伪装成"已延后"（D3 禁止）')

  // 失败分支必须存在、有用户可感知提示、且不关窗（用户要能重试）。
  const failed = html.slice(html.indexOf('function snoozeFailed'), from)
  assert.ok(failed.length > 0, '应有独立的失败处理分支')
  assert.match(failed, /延后失败/, '失败必须给出可感知提示，不得静默')
  assert.ok(!/close/.test(failed), '失败分支不得关窗')
})

// ---------------------------------------------------------------------------
// A09 托盘与真实退出
// ---------------------------------------------------------------------------

test('A09 优雅关闭：shutdown 标记 → host 自行退出，无遗留进程', async () => {
  const stateDir = mktmp('dsh-a09-graceful-')
  const restore = setEnv({ FAKE_MODE: 'serve', FAKE_STATE_DIR: stateDir })
  const host = await createFakeHost({ port: 3185, stateDir })
  await host.start({ generation: 0 })
  await waitEvent(host, 'ready')
  await host.stop()
  assert.equal(host.getState().state, 'stopped')
  assert.ok(existsSync(join(stateDir, 'shutdown')), '应走优雅关闭（dsh shutdown）路径')
  assert.ok(processGone(readNum(stateDir, 'pid')), '退出后无遗留 host 进程')
  restore(); rmSync(stateDir, { recursive: true, force: true })
})

test('A09 host 忽略 shutdown → 3s（压缩）后进程树强制回收，不触发重启', async () => {
  const stateDir = mktmp('dsh-a09-force-')
  const restore = setEnv({ FAKE_MODE: 'serve-ignore-shutdown', FAKE_STATE_DIR: stateDir })
  const host = await createFakeHost({ port: 3186, stateDir, timings: { shutdownWait: 400 } })
  await host.start({ generation: 0 })
  await waitEvent(host, 'ready')
  await host.stop()
  assert.equal(host.getState().state, 'stopped')
  assert.ok(processGone(readNum(stateDir, 'pid')), '超时后必须强制回收进程树')
  await sleep(400)
  assert.equal(readNum(stateDir, 'start-count'), 1, '退出路径不得触发重启')
  restore(); rmSync(stateDir, { recursive: true, force: true })
})

test('A09 托盘菜单六项顺序正确；未实现模式禁用且仅标准可勾选', async () => {
  const { createTray } = await import('../src/tray.js')
  let currentMode = 'standard'
  createTray({
    logger: fakeLogger(),
    onOpen: () => {}, onCheckUpdate: () => {},
    getRunMode: () => currentMode,
    setRunMode: (m) => { currentMode = m },
    onQuit: () => {},
  })
  const menu = globalThis.__DSH_TEST_MENU__
  assert.ok(menu, '菜单模板应被捕获')
  assert.deepEqual(menu.map(m => m.type === 'separator' ? '---' : m.label), [
    '打开 DSH 桌面', '检查更新…', '运行模式', '设置', '---', '退出 DSH Desktop',
  ])
  const modes = menu.find(m => m.label === '运行模式').submenu
  assert.deepEqual(modes.map(m => m.label), ['标准', 'PTC', '极简', '创造'])
  assert.deepEqual(modes.map(m => m.enabled), [true, false, false, false], '首版仅标准模式启用')
  assert.equal(modes[0].checked, true)
  // 勾选切换应写回配置。
  modes[0].click()
  assert.equal(currentMode, 'standard')
})

test('A09 托盘徽章优先级：update > running > idle（host 健康显绿，失联回落）', async () => {
  globalThis.__DSH_TEST_TRAYS__ = []
  const { createTray } = await import('../src/tray.js')
  const tray = createTray({
    logger: fakeLogger(),
    onOpen: () => {}, onCheckUpdate: () => {},
    getRunMode: () => 'standard', setRunMode: () => {}, onQuit: () => {},
  })
  const inst = globalThis.__DSH_TEST_TRAYS__.at(-1)
  /** 当前图标文件名 */
  const icon = () => String(inst.images.at(-1)?.path ?? '').split(/[\\/]/).pop()

  assert.match(icon(), /^tray\.png$/, '启动时为 idle（仅图标本身）')
  tray.setHostHealthy(true)
  assert.match(icon(), /^tray-running\.png$/, 'host 健康应显示 running（SPEC §8:264）')
  tray.setState('update')
  assert.match(icon(), /^tray-update\.png$/, 'update 优先级高于 running')
  tray.setState('idle')
  assert.match(icon(), /^tray-running\.png$/, '更新徽章清除后应按 host 健康度回落 running')
  tray.setHostHealthy(false)
  assert.match(icon(), /^tray\.png$/, 'host 失联/停止应回落 idle（SPEC §6:203）')
})

test('§4:134 主窗口渲染进程崩溃 → 原生错误提示（禁止静默），且同一窗口只提示一次', async () => {
  resetElectronStub({})
  globalThis.__DSH_TEST_WINDOWS__ = []
  const { createMainWindow } = await import('../src/main-window.js')
  const { dialog } = await import('electron')
  dialog.calls = []
  const mw = createMainWindow({ config: { port: 3080 }, logger: fakeLogger(), isQuitting: () => false, isTrayReady: () => true })
  const w = globalThis.__DSH_TEST_WINDOWS__.at(-1)
  const tick = () => new Promise(r => setTimeout(r, 0))

  w.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 })
  await tick()
  assert.equal(dialog.calls.length, 1, '崩溃必须弹原生提示 —— 注释写了"禁止静默隐藏"，代码也必须做')
  assert.match(String(dialog.calls[0][0]?.message ?? ''), /界面进程异常退出/, '提示应说明界面异常退出')
  assert.match(String(dialog.calls[0][0]?.detail ?? ''), /crashed/, '提示应带上崩溃原因')

  w.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 })
  await tick()
  assert.equal(dialog.calls.length, 1, '同一窗口只提示一次，避免崩溃循环弹成串')
})

test('§9:270 三个窗口都显式写明四项安全开关（不依赖 Electron 默认值）', async () => {
  resetElectronStub({})
  globalThis.__DSH_TEST_WINDOWS__ = []
  const { createMainWindow } = await import('../src/main-window.js')
  const mw = createMainWindow({ config: { port: 3080 }, logger: fakeLogger(), isQuitting: () => false, isTrayReady: () => true })
  mw.openUpdateWindow()

  const REQUIRED = { contextIsolation: true, nodeIntegration: false, webSecurity: true, webviewTag: false, sandbox: true }
  for (const [name, win] of [['主窗口', globalThis.__DSH_TEST_WINDOWS__[0]], ['更新窗口', globalThis.__DSH_TEST_WINDOWS__.at(-1)]]) {
    const wp = win?.opts?.webPreferences ?? {}
    for (const [k, v] of Object.entries(REQUIRED)) {
      assert.equal(wp[k], v, `${name}应显式设置 ${k}: ${v}（当前 ${String(wp[k])}）`)
    }
  }

  // splash 窗口由 main.js 的 createSplashWindow 创建（非导出），源码级断言兜底
  const mainSrc = readFileSync(join(root, 'src', 'main.js'), 'utf8')
  const at = mainSrc.indexOf('function createSplashWindow')
  const block = mainSrc.slice(at, mainSrc.indexOf('win.loadURL', at))
  for (const [k, v] of Object.entries(REQUIRED)) {
    assert.match(block, new RegExp(`${k}:\\s*${String(v)}`), `splash 窗口应显式设置 ${k}: ${v}`)
  }
})

test('§9:281/282 本地页围栏：只许停留自己的页面、禁开新窗、禁 webview', async () => {
  resetElectronStub({})
  globalThis.__DSH_TEST_WINDOWS__ = []
  const { createMainWindow } = await import('../src/main-window.js')
  const mw = createMainWindow({ config: { port: 3080 }, logger: fakeLogger(), isQuitting: () => false, isTrayReady: () => true })
  mw.openUpdateWindow()
  const upd = globalThis.__DSH_TEST_WINDOWS__.at(-1)
  /** 造一个可取消的事件 */
  const ev = () => ({ defaultPrevented: false, preventDefault() { this.defaultPrevented = true } })

  const ok = ev()
  upd.webContents.emit('will-navigate', ok, 'dsh-app://ui/update-dialog.html')
  assert.equal(ok.defaultPrevented, false, '本地页自己的 URL 不得被拦')

  for (const bad of ['https://evil.example/', 'dsh-app://ui/about.html', 'file:///C:/windows/win.ini']) {
    const e = ev()
    upd.webContents.emit('will-navigate', e, bad)
    assert.equal(e.defaultPrevented, true, `应拦下导航：${bad}`)
  }
  const redir = ev()
  upd.webContents.emit('will-redirect', redir, 'https://evil.example/')
  assert.equal(redir.defaultPrevented, true, '重定向同样要拦')

  const openHandler = upd.webContents.windowOpenHandler
  assert.ok(openHandler, '应注册 setWindowOpenHandler')
  assert.equal(openHandler({ url: 'https://evil.example/' }).action, 'deny', '本地页默认 deny 新窗')

  // splash 窗口在 main.js 里创建（非导出），无法在 mock 中构造 ⇒ 源码级断言兜底
  const mainSrc = readFileSync(join(root, 'src', 'main.js'), 'utf8')
  assert.match(mainSrc, /hardenLocalPageWindow\(win, 'dsh-app:\/\/ui\/splash\.html'\)/, 'splash 窗口必须装同一围栏')
})

test('§9:283 权限默认拒绝：session 上的权限请求/检查处理器一律返回 false', async () => {
  const src = readFileSync(join(root, 'src', 'main.js'), 'utf8')
  const at = src.indexOf('function hardenSession')
  assert.ok(at > 0, '应存在 hardenSession')
  const fn = src.slice(at, src.indexOf('\n}', at))
  assert.match(fn, /setPermissionRequestHandler\(\([^)]*\)\s*=>\s*cb\(false\)\)/, '权限请求必须一律拒绝')
  assert.match(fn, /setPermissionCheckHandler\(\(\)\s*=>\s*false\)/, '权限检查必须一律拒绝')
  const sites = (src.match(/hardenSession\(/g) ?? []).length - 1   // 减去函数定义本身
  assert.ok(sites >= 2, `每个 session 都要过一遍 hardenSession：host + 本地页 partition（当前 ${sites} 处）`)
})

test('§9:275 session 分离：本地页走独立 partition，host 侧（含鉴权）留在默认 session', async () => {
  const mainSrc = readFileSync(join(root, 'src', 'main.js'), 'utf8')
  const winSrc = readFileSync(join(root, 'src', 'main-window.js'), 'utf8')

  assert.match(mainSrc, /partition:\s*LOCAL_PARTITION/, 'splash 窗口应使用本地 partition')
  assert.match(winSrc, /partition:\s*LOCAL_PARTITION/, '更新窗口应使用本地 partition')
  // partition session 不继承默认 session 的协议处理器，必须单独注册，否则本地页整页加载失败
  assert.match(mainSrc, /session\.fromPartition\(LOCAL_PARTITION\)[\s\S]{0,200}protocol\.handle\('dsh-app'/,
    '本地 partition 必须单独注册 dsh-app 协议')
  // 鉴权不得被一起隔开：token→cookie 换取必须落在主窗口所在的默认 session
  assert.match(mainSrc, /host\.authorize\(session\.defaultSession\)/, 'token→cookie 换取必须用默认 session')
  const mainWin = winSrc.slice(winSrc.indexOf('const w = new BrowserWindow'), winSrc.indexOf('w.webContents.setWindowOpenHandler'))
  assert.ok(!/partition:/.test(mainWin), '主窗口不得使用独立 partition（否则 cookie 落点与窗口 session 错位）')
})

test('A09 更新窗口 X：available 下同按钮语义（先问主进程，只有放行才销毁）', async () => {
  resetElectronStub({})
  globalThis.__DSH_TEST_WINDOWS__ = []
  const { createMainWindow } = await import('../src/main-window.js')
  let allow = false
  let calls = 0
  const mw = createMainWindow({
    config: { port: 3080 }, logger: fakeLogger(),
    isQuitting: () => false, isTrayReady: () => true,
    onUpdateCloseRequest: async () => { calls++; return allow },
  })
  mw.openUpdateWindow()
  const upd = globalThis.__DSH_TEST_WINDOWS__.at(-1)
  assert.ok(upd, '应创建更新窗口')
  const tick = () => new Promise(r => setTimeout(r, 0))

  upd.close()
  await tick()
  assert.equal(calls, 1, '点 X 必须先问主进程（snooze 落盘结果只有 M08 知道）')
  assert.equal(upd.isDestroyed(), false, '延后未成功时必须保留窗口（与按钮路径同语义）')

  allow = true
  upd.close()
  await tick()
  assert.equal(calls, 2)
  assert.equal(upd.isDestroyed(), true, '允许关闭时才销毁')
})

/**
 * 用最小假件执行 src/preload.js 源码（它是 CJS，会被 esbuild 打成 build/preload.cjs）。
 * @param {{role:string, bootstrap:object}} opts
 */
function loadPreload({ role, bootstrap }) {
  const src = readFileSync(join(root, 'src', 'preload.js'), 'utf8').replace(/\bexport \{\}\s*$/, '')
  const listeners = new Map()
  const ipcRenderer = {
    on(ch, fn) { if (!listeners.has(ch)) listeners.set(ch, []); listeners.get(ch).push(fn) },
    removeListener() {},
    invoke(ch) { return Promise.resolve(ch === 'dsh:bridge-ready' ? { ok: true, data: bootstrap } : { ok: true, data: {} }) },
  }
  const exposed = {}
  const contextBridge = { exposeInMainWorld: (ns, api) => { exposed[ns] = api } }
  // 只注入 require / process：源码自己会 `const { contextBridge, ipcRenderer } = require('electron')`，
  // 若再把 contextBridge 作为参数传入就会重名（SyntaxError）。
  const load = new Function('require', 'process', src)
  load(
    (name) => { if (name === 'electron') return { contextBridge, ipcRenderer }; throw new Error(`unexpected require: ${name}`) },
    { argv: [`--dsh-role=${role}`, '--dsh-version=0.1.0'] },
  )
  return { exposed, listeners }
}

test('§9:272/5:165 角色由主进程登记推导：真实帧形状（无 processArguments）也必须放行；伪造参数无效', async () => {
  resetElectronStub({})
  const { createIpc, CHANNELS } = await import('../src/ipc.js')
  const { ipcMain } = await import('electron')
  const ipc = createIpc({
    logger: fakeLogger(), getSplash: () => null, getMain: () => null, getUpdate: () => null, getGeneration: () => 0,
    setFinishRequested: () => {}, onSplashFinishConfirm: () => {}, onSplashCloseBeforeFinish: () => {},
    updater: null, tray: () => null,
  })
  ipc.register()
  const call = (ch, ev) => ipcMain.handlers.get(ch)(ev)
  /** 真实形状：帧上**没有** processArguments（旧实现读它 ⇒ 线上被拒） */
  const realFrame = {}
  const senderOf = (url) => ({ isDestroyed: () => false, getURL: () => url, mainFrame: realFrame })

  // 真实帧 + 登记过的 URL ⇒ 必须放行（这条用例在旧实现下会失败）
  const okRes = await call(CHANNELS.BRIDGE_READY, { sender: senderOf('dsh-app://ui/update-dialog.html'), senderFrame: realFrame })
  assert.equal(okRes.ok, true, '角色必须由主进程登记的 URL 推导，不能依赖帧上的 processArguments')

  // 伪造 processArguments 但 URL 未登记 ⇒ 不得放行（角色不能由参数自行声明）
  const forgedFrame = { processArguments: ['--dsh-role=splash', '--dsh-version=0.1.0'] }
  const forgedSender = { isDestroyed: () => false, getURL: () => 'http://127.0.0.1:3080/', mainFrame: forgedFrame }
  const bad = await call(CHANNELS.BRIDGE_READY, { sender: forgedSender, senderFrame: forgedFrame })
  assert.equal(bad.ok, false)
  assert.equal(bad.error.code, 'E_FORBIDDEN', '未登记 URL 一律拒绝，即使帧上伪造了角色参数')
  ipc.dispose()
})

test('§5:156/5:181 集成：ipc 的 bridge payload 形状必须能让更新页渲染出终态', async () => {
  resetElectronStub({})
  const { createIpc, CHANNELS } = await import('../src/ipc.js')
  const { ipcMain } = await import('electron')
  const ipc = createIpc({
    logger: fakeLogger(), getSplash: () => null, getMain: () => null, getUpdate: () => null, getGeneration: () => 0,
    setFinishRequested: () => {}, onSplashFinishConfirm: () => {}, onSplashCloseBeforeFinish: () => {},
    updater: {
      close: () => ({ ok: true }),
      getInternalEvent: () => ({ revision: 9, snapshot: { state: 'error', message: '无法连接更新服务' } }),
    },
    tray: () => null,
  })
  ipc.register()
  const frame = { processArguments: ['--dsh-role=update', '--dsh-version=0.1.0'] }
  const ev = { sender: { isDestroyed: () => false, getURL: () => 'dsh-app://ui/update-dialog.html', mainFrame: frame }, senderFrame: frame }
  const res = await ipcMain.handlers.get(CHANNELS.BRIDGE_READY)(ev)
  assert.equal(res.ok, true)
  assert.equal(typeof res.data.update.revision, 'number', 'update 必须带 revision（preload 按它丢弃旧快照）')
  assert.equal(res.data.update.snapshot.state, 'error')
  ipc.dispose()

  // 把这份**真实 payload** 喂给 preload：页面侧（以 onState 订阅者代表）必须拿到终态并渲染
  const { exposed } = loadPreload({ role: 'update', bootstrap: res.data })
  const seen = []
  exposed.updateAPI.onState((s) => seen.push(s))
  await new Promise(r => setTimeout(r, 0))
  assert.deepEqual(seen, ['error'], 'ipc 的 payload 形状 + preload 补发，合起来必须把终态送到页面')
  assert.equal(exposed.updateAPI.getState().state, 'error', 'getState() 也应拿到终态')
})

test('§5:174 update-state 推给更新窗口，不得推给主窗口', async () => {
  resetElectronStub({})
  const { createIpc } = await import('../src/ipc.js')
  let mainSends = 0
  let updSends = 0
  const mkWin = (onSend) => ({ isDestroyed: () => false, webContents: { send: onSend } })
  const ipc = createIpc({
    logger: fakeLogger(), getSplash: () => null, getGeneration: () => 0,
    getMain: () => mkWin(() => { mainSends++ }),
    getUpdate: () => mkWin(() => { updSends++ }),
    setFinishRequested: () => {}, onSplashFinishConfirm: () => {}, onSplashCloseBeforeFinish: () => {},
    updater: null, tray: () => null,
  })
  ipc.pushUpdateState({ revision: 1, snapshot: { state: 'latest', version: '0.1.0' } })
  assert.equal(mainSends, 0, '不得推给主窗口 —— 主窗口不挂 preload、没有任何订阅者')
  assert.equal(updSends, 1, '应推给更新窗口（SPEC §5:174 的接收方是 update 页面）')
})

test('§5:181 preload 补发：页面注册早于桥返回时也必须拿到状态（无推送）', async () => {
  const tick = () => new Promise(r => setTimeout(r, 0))

  // update 角色：终态快照只在 bridge-ready 里，此后**不再推送**
  const upd = loadPreload({ role: 'update', bootstrap: { version: '0.1.0', status: '', finishRequested: false, update: { revision: 7, snapshot: { state: 'latest', version: '0.1.0' } } } })
  const seen = []
  upd.exposed.updateAPI.onState((state, data) => seen.push([state, data]))
  assert.deepEqual(seen, [], '桥未返回时缓存尚空')
  assert.equal(upd.exposed.updateAPI.getState(), undefined, 'getState() 同步返回 undefined（§5:177）')
  await tick()
  assert.equal(seen.length, 1, '桥返回后必须补发一次 —— 否则页面永久停在静态初始 DOM')
  assert.equal(seen[0][0], 'latest', '补发的就是终态')
  assert.equal(upd.exposed.updateAPI.getState().state, 'latest', '缓存同步就位')

  // splash 角色：同一条时序窗口（status 与 finish 都可能早于页面注册）
  const sp = loadPreload({ role: 'splash', bootstrap: { version: '0.1.0', status: '即将就绪…', finishRequested: true, update: null } })
  const texts = []
  let finished = 0
  sp.exposed.splashAPI.onStatus((t) => texts.push(t))
  sp.exposed.splashAPI.onFinish(() => { finished++ })
  await tick()
  assert.deepEqual(texts, ['即将就绪…'], 'status 应补发一次')
  assert.equal(finished, 1, '早到的转场请求必须补发，否则 splash 收不到 finish')
})

test('§7:248 更新窗口关闭判据唯一：页面 close() 必须真的销毁窗口，且与 X 同一条路径', async () => {
  resetElectronStub({})
  globalThis.__DSH_TEST_WINDOWS__ = []
  const { createMainWindow } = await import('../src/main-window.js')
  const { createIpc, CHANNELS } = await import('../src/ipc.js')
  const { ipcMain } = await import('electron')

  let allow = true
  let updaterOk = true
  const mw = createMainWindow({
    config: { port: 3080 }, logger: fakeLogger(),
    isQuitting: () => false, isTrayReady: () => true,
    onUpdateCloseRequest: async () => allow,
  })
  const ipc = createIpc({
    logger: fakeLogger(), getSplash: () => null, getMain: () => null, getGeneration: () => 0,
    setFinishRequested: () => {}, onSplashFinishConfirm: () => {}, onSplashCloseBeforeFinish: () => {},
    updater: { close: () => (updaterOk ? { ok: true } : { ok: false, error: { code: 'E_IO', message: '延后写入失败' } }) },
    tray: () => null,
    closeUpdateWindow: () => mw.requestUpdateClose(),
  })
  ipc.register()
  const frame = { processArguments: ['--dsh-role=update', '--dsh-version=0.1.0'] }
  const ev = { sender: { isDestroyed: () => false, getURL: () => 'dsh-app://ui/update-dialog.html', mainFrame: frame }, senderFrame: frame }

  // 成功：必须真的销毁（曾只调 M08 的 close() 而从不关窗）
  mw.openUpdateWindow()
  const w1 = globalThis.__DSH_TEST_WINDOWS__.at(-1)
  const res1 = await ipcMain.handlers.get(CHANNELS.UPDATE_CLOSE)(ev)
  assert.equal(res1.ok, true)
  assert.equal(w1.isDestroyed(), true, '页面 close() 必须真正关窗')

  // 延后失败（E_IO）：保持窗口并把错误交回页面，用户可重试
  updaterOk = false
  mw.openUpdateWindow()
  const w2 = globalThis.__DSH_TEST_WINDOWS__.at(-1)
  const res2 = await ipcMain.handlers.get(CHANNELS.UPDATE_CLOSE)(ev)
  assert.equal(res2.ok, false)
  assert.equal(res2.error.code, 'E_IO')
  assert.equal(w2.isDestroyed(), false, '延后失败必须保留窗口')

  // 判据唯一：X 走的也是同一个 requestUpdateClose（allow=false ⇒ 保留）
  allow = false
  const res3 = await mw.requestUpdateClose()
  assert.equal(res3, false)
  assert.equal(w2.isDestroyed(), false)
  ipc.dispose()
})

test('§8/§9 生产环境移除原生菜单（三窗口一并生效），dev 保留', async () => {
  const src = readFileSync(join(root, 'src', 'main.js'), 'utf8')
  assert.match(src, /import \{[^}]*\bMenu\b[^}]*\} from 'electron'/, '应显式 import Menu')
  assert.match(src, /if \(app\.isPackaged\) Menu\.setApplicationMenu\(null\)/, '打包态应移除应用菜单')
})

test('A05 终态复位：连续两次检查都能开始（第二次不得 E_BUSY）', async () => {
  globalThis.__DSH_TEST_UPDATER__ = { github: { check: (inst) => { inst.emit('update-not-available', {}) } } }
  const { up, d } = await makeUpdater()
  const r1 = await up.checkOnce({ manual: true })
  assert.equal(r1.ok, true)
  await waitUntil(() => d.states.some(s => s.snapshot.state === 'latest'))
  const r2 = await up.checkOnce({ manual: true })
  assert.equal(r2.ok, true, `首检进终态后必须复位在飞标志（实际：${JSON.stringify(r2)}）`)
  up.dispose()
})

test('A05 终态复位：超时→降级走到 error 后，手动检查能重新开始', async () => {
  globalThis.__DSH_TEST_UPDATER__ = {
    github: { check: (inst) => { inst.emit('error', new Error('ETIMEDOUT')) } },
    cos: { check: (inst) => { inst.emit('error', new Error('ECONNRESET')) } },
  }
  const { up, d } = await makeUpdater()
  await up.checkOnce({ manual: true })
  await waitUntil(() => d.states.some(s => s.snapshot.state === 'error'))
  const again = await up.checkManual()
  assert.equal(again.ok, true, '终态之后必须能重新开始')
  up.dispose()
})

test('A05 手动检查被拒必须有托盘可见反馈（E_BUSY / 开发态都不得静默）', async () => {
  // 在飞：fake 的 check 不发任何事件 ⇒ 状态停在 checking
  globalThis.__DSH_TEST_UPDATER__ = { github: { check: () => { /* 保持 checking，模拟仍在飞 */ } } }
  const { up, d } = await makeUpdater()
  const first = await up.checkManual()
  assert.equal(first.ok, true, '首检应能开始')
  d.flashes.length = 0
  const second = await up.checkManual()
  assert.equal(second.ok, false)
  assert.equal(second.error.code, 'E_BUSY')
  assert.ok(d.flashes.length > 0, 'E_BUSY 必须给托盘文字反馈 —— 点了没反应是最难查的故障形态')
  assert.match(String(d.flashes.at(-1)?.[0] ?? ''), /正在检查/, `反馈文案应说明正在检查：${JSON.stringify(d.flashes)}`)
  up.dispose()

  // 开发态被拒：同样不得静默
  const { deps, d: d2 } = updaterDeps()
  deps.isPackaged = false
  const { createUpdater } = await import('../src/updater.js')
  const up2 = createUpdater(deps)
  const devRes = await up2.checkManual()
  assert.equal(devRes.ok, false)
  assert.equal(devRes.error.code, 'E_UNPACKAGED')
  assert.ok(d2.flashes.length > 0, '开发态被拒也要给托盘反馈')
  assert.match(String(d2.flashes.at(-1)?.[0] ?? ''), /开发态/, '文案应说明开发态不执行更新')
  up2.dispose()
})

test('§7 备源占位符 URL：初始化不得抛，按"备源未配置"处理（线上 Invalid URL 回归）', async () => {
  globalThis.__DSH_TEST_UPDATER__ = { github: { check: (inst) => { inst.emit('update-not-available', {}) } } }
  const { createUpdater } = await import('../src/updater.js')
  const { deps } = updaterDeps()
  delete deps.cosUrl                                   // 回到默认占位符 URL（SPEC §11.1 允许的待填形态）
  const up = createUpdater(deps)                        // 构造不得抛

  const res = await up.checkOnce({ manual: true })
  assert.equal(res.ok, true, '备源未配置不得影响主源检查')
  const instances = globalThis.__DSH_TEST_UPDATER__.instances ?? []
  assert.equal(instances.length, 1, '占位符 URL 不得创建备源实例，更不得抛出')
  assert.equal(instances[0].config.provider, 'github', '主源必须照常建立')
  assert.ok(deps.logger.calls.some(([lvl, m]) => lvl === 'warn' && /备源未配置/.test(m)),
    '应记一条"备源未配置"，让缺省状态可观测')
  up.dispose()
})

test('§7 更新模块初始化失败：只影响更新，不影响 host；且其拒绝被分级为可恢复', async () => {
  const stateDir = mktmp('dsh-upfail-')
  const restore = setEnv({ FAKE_MODE: 'serve', FAKE_STATE_DIR: stateDir })
  globalThis.__DSH_TEST_UPDATER__ = { failConstruct: true }

  // 核心链路先起来
  const host = await createFakeHost({ port: 3187, stateDir })
  const readyP = waitEvent(host, 'ready', null, 8000)
  await host.start({ generation: 0 })
  await readyP
  assert.equal(host.getState().state, 'ready')

  // 更新模块整体初始化失败：必须返回业务错误而不是抛，且不得把 host 带走
  const { createUpdater } = await import('../src/updater.js')
  const { deps } = updaterDeps()
  const up = createUpdater(deps)
  const res = await up.checkOnce({ manual: true })
  assert.equal(res.ok, false, '主源也起不来时返回业务错误（E_INTERNAL），不是抛')
  assert.equal(host.getState().state, 'ready', '更新模块失败不得影响已就绪的 host')
  assert.ok(host.isHealthy(), 'host 仍必须健康')

  // 分级判据：更新模块的拒绝可恢复（只记录并继续）；核心链路仍走受控退出
  const { isRecoverableRejection } = await import('../src/main.js')
  const updErr = new Error('Invalid URL')
  updErr.stack = 'Error: Invalid URL\n    at ensureInstances (file:///D:/x/src/updater.js:91:18)'
  assert.equal(isRecoverableRejection(updErr), true, '更新模块的拒绝应判为可恢复')
  const coreErr = new Error('boom')
  coreErr.stack = 'Error: boom\n    at start (file:///D:/x/src/dsh-host.js:353:19)'
  assert.equal(isRecoverableRejection(coreErr), false, '核心链路的拒绝必须仍走受控退出')

  await host.stop()
  up.dispose(); restore(); rmSync(stateDir, { recursive: true, force: true })
})

test('A09 splash 转场确认接线：finish 之前 close = 取消，之后 close = 转场确认', async () => {
  resetElectronStub({ isPackaged: false })
  const { createIpc, CHANNELS } = await import('../src/ipc.js')
  const calls = { cancel: 0, confirm: 0 }
  const deps = {
    logger: fakeLogger(),
    getSplash: () => ({ isDestroyed: () => false, webContents: { send() {} } }),
    getMain: () => null,
    getGeneration: () => 0,
    setFinishRequested: () => {},
    onSplashFinishConfirm: () => { calls.confirm++ },
    onSplashCloseBeforeFinish: () => { calls.cancel++ },
    updater: null,
    tray: () => null,
  }
  const ipc = createIpc(deps)
  ipc.register()
  const { ipcMain } = await import('electron')
  const call = (ch, ev) => ipcMain.handlers.get(ch)(ev)
  const frameSplash = { processArguments: ['--dsh-role=splash', '--dsh-version=0.1.0'] }
  const ev = { sender: { isDestroyed: () => false, getURL: () => 'dsh-app://ui/splash.html', mainFrame: frameSplash }, senderFrame: frameSplash }

  // 发出转场请求之前的 close = 取消启动。
  await call(CHANNELS.SPLASH_CLOSE, ev)
  assert.equal(calls.cancel, 1, 'finish 之前 close 应走取消启动路径')
  assert.equal(calls.confirm, 0)

  // 发出转场请求之后的 close = 转场确认（此前该分支缺失，onSplashFinishConfirm 永不被调用，
  // 导致主进程的 finishTimer 永不清除、1000ms 兜底必然触发）。
  ipc.pushSplashFinish()
  await call(CHANNELS.SPLASH_CLOSE, ev)
  assert.equal(calls.confirm, 1, 'finish 之后 close 应走转场确认')
  assert.equal(calls.cancel, 1, '确认后不得再走取消启动路径')
  ipc.dispose()
})

test('A09 托盘图标按模块位置解析，且图标文件真实存在', async () => {
  const src = readFileSync(join(root, 'src', 'tray.js'), 'utf8')
  assert.ok(!/process\.cwd\(\)/.test(src), '托盘素材路径不得依赖 process.cwd()（安装后 cwd 任意，会静默变空图标）')

  globalThis.__DSH_TEST_TRAYS__ = []
  const { createTray } = await import('../src/tray.js')
  createTray({
    logger: fakeLogger(),
    onOpen: () => {}, onCheckUpdate: () => {},
    getRunMode: () => 'standard', setRunMode: () => {}, onQuit: () => {},
  })
  const tray = globalThis.__DSH_TEST_TRAYS__.at(-1)
  assert.ok(tray?.images.length, '托盘应带上图标')
  assert.ok(existsSync(tray.images[0].path), `托盘图标应真实存在：${tray.images[0].path}`)
})

test('A09 主窗口 close：托盘就绪时 hide 而非 destroy；quitting / 托盘未就绪时放行', async () => {
  resetElectronStub({})
  globalThis.__DSH_TEST_WINDOWS__ = []
  const { createMainWindow } = await import('../src/main-window.js')
  const flags = { quitting: false, tray: true }
  const mw = createMainWindow({
    config: { port: 3080 }, logger: fakeLogger(),
    isQuitting: () => flags.quitting,
    isTrayReady: () => flags.tray,
  })
  const w = globalThis.__DSH_TEST_WINDOWS__.at(-1)
  assert.ok(w, '应创建主窗口')

  w.close()
  assert.equal(w.isDestroyed(), false, '托盘就绪时点 X 不得销毁窗口（SPEC §4）')
  assert.equal(w.hidden, true, '应 hide 到托盘')
  assert.ok(mw.win, '控制器仍持有该窗口')

  flags.tray = false
  w.close()
  assert.equal(w.isDestroyed(), true, '托盘未就绪时必须放行关闭，避免窗口关不掉')
  assert.equal(mw.win, null, '销毁后控制器不再持有窗口')
})

test('A09 托盘唤回：窗口已销毁时经 M06 重建并 show（含最小化还原）', async () => {
  resetElectronStub({})
  globalThis.__DSH_TEST_WINDOWS__ = []
  const { createMainWindow } = await import('../src/main-window.js')
  const mw = createMainWindow({
    config: { port: 3080 }, logger: fakeLogger(),
    isQuitting: () => false,
    isTrayReady: () => true,
  })
  const first = globalThis.__DSH_TEST_WINDOWS__.at(-1)
  first.destroy()
  assert.equal(mw.win, null, '销毁后控制器应释放引用')

  assert.equal(mw.ensure(), true, '窗口已销毁时应重建（SPEC §8 第 1 条）')
  const second = globalThis.__DSH_TEST_WINDOWS__.at(-1)
  assert.notEqual(second, first, '应是一个新的窗口实例')
  assert.equal(mw.ensure(), false, '窗口健在时不得重复重建')

  second.minimize()
  mw.show()
  assert.equal(second.isMinimized(), false, 'show 前应先 restore')
  assert.equal(second.shown, true, '应显示窗口')
})

// ---------------------------------------------------------------------------
// A10 安装与发布一致性（结构 + 纯函数）
// ---------------------------------------------------------------------------

test('A10 after-pack：app-update.yml 源字段规范化为 COS 兜底，保留必要字段', async () => {
  const afterPack = require('../tools/after-pack.cjs')
  const dir = mktmp('dsh-a10-appout-')
  const resources = join(dir, 'resources')
  mkdirSync(resources, { recursive: true })
  writeFileSync(join(resources, 'app-update.yml'), [
    'provider: github',
    'owner: Kk1107k',
    'repo: dsh-desktop',
    'releaseType: release',
    'updaterCacheDirName: dsh-desktop-updater',
    'url: https://github.com/Kk1107k/dsh-desktop/releases',
    '',
  ].join('\n'), 'utf8')

  await afterPack({ electronPlatformName: 'win32', appOutDir: dir })
  const YAML = require('yaml')
  const doc = YAML.parse(readFileSync(join(resources, 'app-update.yml'), 'utf8'))
  assert.equal(doc.provider, 'generic')
  assert.equal(doc.url, 'https://<占位 COS 域名>/dsh-desktop')
  assert.equal(doc.channel, 'cn-stable')
  assert.equal(doc.updaterCacheDirName, 'dsh-desktop-updater', '构建器必要字段保留')
  assert.equal(doc.owner, undefined, 'github 专属字段应移除')
  assert.equal(doc.repo, undefined)

  // 非 Windows：钩子直接跳过。
  await afterPack({ electronPlatformName: 'darwin', appOutDir: dir })
  rmSync(dir, { recursive: true, force: true })
})

test('A10 electron-builder 配置：NSIS 可选目录、产物入 dist/、归档素材排除、双源占位保留', async () => {
  const YAML = require('yaml')
  const cfg = YAML.parse(readFileSync(join(root, 'electron-builder.yml'), 'utf8'))
  assert.equal(cfg.appId, 'com.dshdesktop.app')
  assert.equal(cfg.productName, 'DSH Desktop')
  assert.equal(cfg.directories.output, 'dist')
  assert.equal(cfg.artifactName, '${productName}-Setup-${version}.${ext}')
  assert.equal(cfg.nsis.allowToChangeInstallationDirectory, true, '必须是 allowToChangeInstallationDirectory（写错键会被静默忽略）')
  assert.equal(cfg.nsis.oneClick, false)
  assert.equal(cfg.nsis.perMachine, false)
  assert.ok(cfg.files.includes('!assets/fonts/_archive/**'), '归档字体必须排除')
  assert.ok(cfg.files.some(f => String(f).includes('!assets/_archive-')), '归档素材必须排除')
  assert.deepEqual(cfg.win.target, ['nsis'])
  const generic = cfg.publish.find(p => p.provider === 'generic')
  assert.equal(generic.url, 'https://<占位 COS 域名>/dsh-desktop')
  assert.equal(generic.channel, 'cn-stable')
})

test('A10 发布流水线：v* tag 触发；顺序为构建→GitHub Releases→release.mjs 同步 COS', async () => {
  const YAML = require('yaml')
  const wf = YAML.parse(readFileSync(join(root, '.github', 'workflows', 'release.yml'), 'utf8'))
  assert.deepEqual(wf.on.push.tags, ['v*'])
  const steps = wf.jobs['build-and-release'].steps.map(s => s.name || s.uses || s.run)
  const joinAll = steps.join('|')
  assert.ok(joinAll.includes('校验 tag 等于包版本'), '必须校验 tag == 包版本')
  assert.ok(joinAll.includes('验收测试'), '发布前必须跑验收测试')
  assert.ok(joinAll.includes('GitHub Releases'), '必须上传 GitHub Releases')
  assert.ok(wf.jobs['build-and-release'].steps.some(s => (s.run || '').includes('node tools/release.mjs')), '最后同步 COS')
  assert.ok(wf.jobs['build-and-release'].steps.some(s => (s.run || '').includes('stable.yml')), 'stable.yml 从构建元数据生成')
})

test('A10 release.mjs：上传计划与入口改写（只改路径不改哈希）', async () => {
  const { planUploads, buildCnStableDoc, fileNameOf } = await import('../tools/release.mjs')
  const dist = mktmp('dsh-a10-dist-')
  const exeName = 'DSH Desktop-Setup-0.1.0.exe'
  const exePath = join(dist, exeName)
  const body = 'fake-installer-bytes'
  writeFileSync(exePath, body, 'utf8')
  writeFileSync(`${exePath}.blockmap`, 'blockmap-bytes', 'utf8')
  const sha512 = createHash('sha512').update(body).digest('base64')
  const doc = {
    version: '0.1.0',
    files: [{ url: exeName, sha512, size: Buffer.byteLength(body) }],
    path: exeName, sha512, releaseDate: '2026-09-25T00:00:00.000Z',
  }
  const plan = await planUploads(doc, '0.1.0', dist)
  assert.equal(plan.length, 2, '安装包 + blockmap')
  assert.equal(plan[0].key, 'dsh-desktop/0.1.0/DSH Desktop-Setup-0.1.0.exe')
  assert.equal(plan[0].sha512, sha512)
  assert.equal(plan[1].key, 'dsh-desktop/0.1.0/DSH Desktop-Setup-0.1.0.exe.blockmap')

  // 哈希不一致 → 拒绝（不虚构）。
  await assert.rejects(planUploads({ ...doc, files: [{ url: exeName, sha512: 'AAAA', size: 5 }] }, '0.1.0', dist))

  const cn = buildCnStableDoc(doc, '0.1.0')
  assert.equal(cn.files[0].url, '0.1.0/DSH Desktop-Setup-0.1.0.exe')
  assert.equal(cn.files[0].path, '0.1.0/DSH Desktop-Setup-0.1.0.exe')
  assert.equal(cn.files[0].sha512, sha512, '只改路径不改哈希')
  assert.equal(cn.path, '0.1.0/DSH Desktop-Setup-0.1.0.exe')
  assert.equal(fileNameOf(`https://example.com/v0.1.0/${encodeURIComponent(exeName)}`), exeName, 'URL 形式的文件名应解码')
  rmSync(dist, { recursive: true, force: true })
})

test('A10 release.mjs 缺少 COS 凭据 → 失败退出（CI 标红），不触碰入口', async () => {
  const res = spawnSync(process.execPath, ['tools/release.mjs'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, COS_SECRET_ID: '', COS_SECRET_KEY: '', COS_BUCKET: '', COS_REGION: '' },
  })
  assert.notEqual(res.status, 0, '缺凭据必须非零退出')
  assert.match(res.stderr, /环境变量/)
})
