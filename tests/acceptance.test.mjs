// SPEC §12 验收测试（A01~A10）。全部为 mock 层：
//   - electron / electron-updater 经 tests/stubs/ 假件替换（module.register 解析钩子）
//   - dsh host 子进程用 tests/helpers/fake-npx.mjs 替身（真实进程 + 真实状态机）
//   - 涉及真实安装、签名、COS 上传、上游 CLI 的断言留给 Phase 2 真实环境，此处只做
//     可执行的结构校验（构建配置、发布脚本纯函数）。
// 运行前提：pnpm build:preload 已生成 build/preload.cjs（package.json 的 build 链保证顺序）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register, createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
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

const fakeLogger = () => ({ info() {}, warn() {}, error() {}, debug() {} })

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

function createFakeHost({ port, stateDir, timings }) {
  // dsh-host 经动态 import 拿到（此时 electron 假件已注册）。
  return import('../src/dsh-host.js').then(({ createDshHost }) => createDshHost({
    config: { port },
    logger: fakeLogger(),
    locateRuntime: () => ({ nodeExe: process.execPath, npxCli: FAKE_NPX }),
    timings,
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
  globalThis.__DSH_TEST_UPDATER__ = {}
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
  await assert.rejects(host.start({ generation: 0 }), err => err.code === 'E_PORT_IN_USE')
  assert.ok(occupier.listening, '占用者必须存活（不杀占者）')
  occupier.close()
  await host.stop()
  restore(); rmSync(stateDir, { recursive: true, force: true })
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
  assert.deepEqual(okRes.data.update, { state: 'idle' })

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
  for (const page of ['splash.html', 'update-dialog.html']) {
    const html = readFileSync(join(root, 'src', page), 'utf8')
    assert.ok(!/0\.1\.0/.test(html), `${page} 不应写死版本号`)
  }
  const preload = readFileSync(join(root, 'src', 'preload.js'), 'utf8')
  assert.ok(preload.includes('--dsh-version='), '版本应来自 additionalArguments')
  // 版本随 package.json 同步：构建产物存在即由 preload 缓存提供。
  assert.ok(existsSync(join(root, 'build', 'preload.cjs')), 'build/preload.cjs 应已生成（先跑 pnpm build:preload）')
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
