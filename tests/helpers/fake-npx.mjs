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
const port = Number(process.env.DSH_PORT || 3080)
const dieTimes = Number(process.env.FAKE_DIE_TIMES || 0)

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
    if (req.url === '/api/health') { res.writeHead(200); res.end('ok') }
    else { res.writeHead(404); res.end() }
  })
  srv.listen(port, '127.0.0.1', () => {
    writeFileSync(file('listening'), String(startCount))
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
