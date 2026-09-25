// 验收测试专用的假 npx-cli 子进程（dsh host 替身）。
// dsh-host 以 spawn(nodeExe, [本文件, '--yes', ...]) 启动；行为由环境变量驱动
// （dsh-host 传环境时保留 process.env，测试据此注入）：
//   FAKE_MODE=hang|serve|serve-ignore-shutdown|crash|flaky
//   FAKE_STATE_DIR=<dir>  start-count / die-count / shutdown / pid / listening 状态文件目录
//   FAKE_DIE_TIMES=<n>   flaky：服务就绪后自杀 n 次（模拟 ready 后连续故障），之后稳定
import { createServer } from 'node:http'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const stateDir = process.env.FAKE_STATE_DIR
const mode = process.env.FAKE_MODE || 'serve'
// 对齐上游：端口经命令行 --port 传入（DSH_PORT 环境变量对上游无效，壳侧已不再使用）。
const argPort = (() => {
  const i = process.argv.indexOf('--port')
  return i >= 0 ? Number(process.argv[i + 1]) : undefined
})()
const port = Number(argPort ?? process.env.DSH_PORT ?? 3080)
const dieTimes = Number(process.env.FAKE_DIE_TIMES || 0)
/** 夹具固定假 token：dsh-host 只从 stdout 就绪行实读，不参与任何真实鉴权。 */
const FAKE_TOKEN = 'fake-token-0123456789ABCDEF'

const file = (name) => join(stateDir, name)
const readNum = (name) => (existsSync(file(name)) ? Number(readFileSync(file(name), 'utf8')) || 0 : 0)
const bump = (name) => {
  const n = readNum(name) + 1
  writeFileSync(file(name), String(n))
  return n
}

// dsh shutdown 命令形态：argv 末尾是 'dsh', 'shutdown'。写标记文件后退出；
// serve 模式的服务进程轮询该文件后自行退出（优雅关闭路径）。
if (process.argv.includes('shutdown')) {
  writeFileSync(file('shutdown'), '1')
  process.exit(0)
}

const startCount = bump('start-count')
writeFileSync(file('pid'), String(process.pid))

if (mode === 'crash') process.exit(1)

if (mode === 'hang') {
  // 挂着不服务：模拟 15s 就绪截止超时路径。
  setInterval(() => {}, 60000)
} else {
  const dies = readNum('die-count')
  const srv = createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`)
    // 对齐上游 0.1.7-alpha.2：没有 /api/health；index 需进程 token 换取 cookie。
    if (url.pathname === '/') {
      if (url.searchParams.get('token') === FAKE_TOKEN) {
        res.writeHead(303, { location: './', 'set-cookie': `dsh-auth-fake=v1.fake; Path=/; HttpOnly; SameSite=Strict` })
        res.end()
      } else {
        res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('unauthorized')
      }
      return
    }
    res.writeHead(404); res.end()
  })
  srv.listen(port, '127.0.0.1', () => {
    writeFileSync(file('listening'), String(startCount))
    // 对齐上游就绪行（stdout，含真实端口与进程 token）：dsh-host 以本行 + 带 token 的 index 判就绪。
    process.stdout.write('[hub] routes mounted (profile=web, loader=provided)\n')
    process.stdout.write(`dsh web: http://127.0.0.1:${port}/?token=${FAKE_TOKEN}\n`)
    if (mode === 'flaky' && dies < dieTimes) {
      // 就绪后自杀（约 800ms，晚于 host 的 250ms 轮询命中，确保先进 ready 再故障）。
      setTimeout(() => { bump('die-count'); process.exit(1) }, 800)
    }
  })
  if (mode !== 'serve-ignore-shutdown') {
    // 优雅关闭：shutdown 标记出现即退出；serve-ignore-shutdown 模式故意忽略，
    // 用于验证 3s 超时后的进程树强制回收。
    setInterval(() => { if (existsSync(file('shutdown'))) process.exit(0) }, 50)
  } else {
    setInterval(() => {}, 60000)
  }
}
