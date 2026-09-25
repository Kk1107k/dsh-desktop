# DSH Desktop 架构规格

> 目标路径：`B-AI共享/SPEC.md`。本文是桌面壳实现、联调与验收的唯一架构基线。
> 本版仅依据投喂包制定；上游 CLI 的未验证假定集中列入 §11.1，不冒充实测结论。

**目录**

[1. 项目元信息](#1-项目元信息) · [2. 目录树](#2-目录树) · [3. 模块职责](#3-模块职责) · [4. 进程模型](#4-进程模型)
[5. IPC 协议](#5-ipc-协议) · [6. dsh host 子进程管理](#6-dsh-host-子进程管理) · [7. 自动更新双通道降级](#7-自动更新双通道降级) · [8. 托盘菜单设计](#8-托盘菜单设计)
[9. 安全约束](#9-安全约束) · [10. 配置与存储](#10-配置与存储) · [11. 打包与发布](#11-打包与发布) · [12. 验收标准](#12-验收标准)

## 1. 项目元信息

| 项目 | 决定 |
|---|---|
| 名称 | npm 包名 `dsh-desktop`；产品名 `DSH Desktop`；appId `com.dshdesktop.app` |
| 版本 | 桌面壳初始版本 `0.1.0`；上游 CLI 目标版本 `0.1.7-alpha`；两者独立管理 |
| License | 桌面壳 MIT；分发时保留上游许可证及非官方、无隶属或背书关系的声明 |
| 环境 | Node.js ≥22、pnpm ≥9、Electron ≥36；开发与 CI 使用相同 Node 主版本及锁文件 |
| 平台 | 首版仅 Windows x64；仅构建 NSIS；使用 BrowserWindow 的 webContents 承载本地 Web UI |
| 运行依赖 | `electron-updater: ^6.3.0`、`electron-log: ^5.3.0` |
| 开发依赖 | `electron: ^36.0.0`、`electron-builder: ^26.0.0`、`typescript: ^5.8.0`、`@types/node: ^22.0.0`、`esbuild: ^0.25.0` |
| 发布脚本依赖 | `cos-nodejs-sdk-v5: ^2.14.0`、`yaml: ^2.7.0`，均为 devDependencies；不进入渲染器 |
依赖具体解析版本由 `pnpm-lock.yaml` 固定；CI 使用 `pnpm install --frozen-lockfile`；公开发布前完成依赖安全检查。
源码使用 JavaScript ESM，`package.json` 设置 `"type": "module"`、`"main": "src/main.js"`；上游通过外部 CLI 调用，不作为壳的运行依赖导入。

## 2. 目录树

下树定义本规格涉及的文件；既有未列出的素材及投喂资料原样保留。`build/`、`dist/` 为生成目录，不提交。
```text
dsh-desktop/
|-- package.json
|-- pnpm-lock.yaml
|-- tsconfig.json
|-- electron-builder.yml
|-- .editorconfig
|-- .gitignore
|-- LICENSE
|-- README.md
|-- CHANGELOG.md
|-- .github/
|   `-- workflows/
|       `-- release.yml
|-- B-AI共享/
|   |-- INTERFACE.md
|   `-- SPEC.md
|-- assets/
|   |-- icon.ico
|   |-- tray.png
|   |-- tray-update.png
|   `-- tray-running.png
|-- src/
|   |-- main.js
|   |-- dsh-host.js
|   |-- preload.js
|   |-- main-window.js
|   |-- tray.js
|   |-- updater.js
|   |-- ipc.js
|   |-- logger.js
|   |-- contracts.d.ts
|   |-- splash.html
|   |-- update-dialog.html
|   `-- about.html
|-- tools/
|   |-- gen_splash.py
|   |-- gen_update_dialog.py
|   |-- gen_whale_icons.py
|   |-- build-preload.mjs
|   |-- after-pack.cjs
|   `-- release.mjs
|-- tests/
|   `-- acceptance.test.mjs
|-- build/
|   `-- preload.cjs
`-- dist/
    |-- DSH Desktop-Setup-<version>.exe
    |-- DSH Desktop-Setup-<version>.exe.blockmap
    |-- latest.yml
    |-- stable.yml
    `-- cn-stable.yml
```
安装资源内另生成 `resources/app-update.yml`；其构建中间位置为 `dist/win-unpacked/resources/app-update.yml`，不是项目根配置文件。

## 3. 模块职责

| 模块 | 文件 | 单一职责及边界 |
|---|---|---|
| M01 | `package.json`、`tsconfig.json`、`electron-builder.yml`、`.editorconfig`、`.gitignore` | 管理依赖、脚本、类型检查和打包；`allowJs/checkJs/strict/noEmit` 开启；忽略依赖、生成目录及密钥文件 |
| M02 | `src/main.js` | 单例锁、启动编排、配置装载、窗口存活与统一退出；持有 `quitting`，不实现更新下载或 host 探测 |
| M03 | `src/splash.html`、`tools/gen_splash.py` | 保持既有视觉结构，展示状态并执行淡出；仅经生成器补齐生命周期行为，不手改生成页 |
| M04 | `src/dsh-host.js` | CLI 定位、启动、就绪探测、健康检查、重启及进程树回收；对外提供 `start/stop/getState` |
| M05 | `src/preload.js`、`build/preload.cjs` | 将 M09 白名单映射为隔离桥；维护渲染端缓存，不读写配置、不执行命令 |
| M06 | `src/main-window.js` | 创建主窗口及受信本地窗口、注册本地页面协议、维护 session 安全策略与导航限制 |
| M07 | `src/tray.js` | 托盘生命周期、六项菜单和徽章；调用注入的业务函数，不自行注册 IPC |
| M08 | `src/updater.js`、`src/update-dialog.html`、`tools/gen_update_dialog.py` | 更新调度、双源状态机、下载、延后记录与更新页；安装前交由 M02 完成退出清理 |
| M09 | `src/ipc.js`、`src/contracts.d.ts` | 集中定义 channel、白名单、schema、权限、处理器与推送出口；业务能力通过参数注入 |
| M10 | `src/logger.js` | 包装 electron-log，确定日志位置、轮转和脱敏；不捕获后吞掉致命错误 |
| M11 | `.github/workflows/release.yml`、`tools/build-preload.mjs`、`tools/after-pack.cjs`、`tools/release.mjs` | 构建桥、生成发布元数据、签名打包、发布 GitHub Releases 并同步 COS |
| M12 | `README.md`、`CHANGELOG.md`、`src/about.html`、`LICENSE` | 安装说明、版本变更、关于信息、许可与免责声明；不提供额外 Node 权限 |
模块间业务调用使用普通函数或内部事件；仅 M09 操作 `ipcMain.handle` 和业务 `webContents.send`；测试统一位于 `tests/acceptance.test.mjs`。

## 4. 进程模型

**D2：最短展示 2400ms；淡出 300ms；主窗口加载成功且 ready-to-show 后，才发送关闭请求。**
```text
User        Main              Splash          Host             MainWindow / Tray
 |--start--->|
 |           |--acquire single-instance lock
 |           |--create/show---->|
 |           |--spawn-------------------------->|
 |           |--GET /api/health---------------->|
 |           |<---------------------------ready|
 |           |--loadURL(hidden)-------------------------------->MainWindow
 |           |<--------------------------------ready-to-show + loaded
 |           |--onFinish------->|  [all gates passed]
 |           |<--close()--------|  [after 300ms fade]
 |           |--destroy splash; show/focus main; activate tray-->Tray
 |--close main------------------------------------------------->hide
 |--tray quit->|--stop host; release resources; exit
```
`t0` 使用主进程单调时钟，在 splash 首次 `show` 时记录；2400ms 从 `t0` 起算，不从应用进程创建时起算。
转场条件为 `hostReady && mainLoaded && mainReadyToShow && elapsed >= 2400ms && !quitting`；所有条件取当前启动代次的值。
条件满足后先显示已绘制的主窗口，再发送 `dsh:splash-finish`；splash 保持在上方淡出，避免露出空白桌面。
页面收到 `onFinish` 后添加 `.closing`，300ms 后调用既有 `splashAPI.close()`；主进程仅在 `finishRequested` 状态将其解释为转场确认。
转场确认最早在请求后 300ms 生效；1000ms 未收到确认时，主进程兜底销毁 splash，前提仍是主窗口加载成功。
`finishRequested` 之前调用 `splashAPI.close()` 表示取消启动：设置 `quitting`、停止 host、退出，不留下后台进程。
host 在一次 spawn 后 15s 内未就绪：推送“服务启动超时”，终止该次启动，并显示原生“重试 / 退出”对话框，默认选择退出。
host 已就绪但主窗口 10s 内未加载成功，或主框架加载失败：进入 `E_UI_LOAD` 错误路径，禁止发送 finish。
重试创建新的启动代次，清空旧探测与监听；恢复 splash 状态提示，不改其 DOM 结构，不无限播放“正在启动”。
未取得单例锁的第二实例立即退出；已有实例收到 `second-instance` 后恢复并聚焦主窗口，启动未完成时聚焦 splash。
主窗口关闭且 `quitting=false` 时执行 `preventDefault()` 和 `hide()`；仅托盘成功创建后启用此行为，托盘失败时保持可见并提示。
真正退出由 M02 的唯一异步流程执行：停止更新调度、阻止重启、回收 host、销毁托盘与窗口，最后 `app.quit()`。
主进程未处理异常或 Promise 拒绝必须记录并进入受控退出；渲染进程崩溃显示原生错误提示，禁止静默隐藏。

## 5. IPC 协议

**D1：选择方案 B，保留 `window.splashAPI` / `window.updateAPI`；只在各自受信页面暴露对应命名空间，不新增 `dshApi`。**
**D4：当前安装版本统一来自 `app.getVersion()`，其来源为 `package.json.version`；契约 §1 的方法清单优先于 §4 概述，不新增 `updateAPI.getVersion()`。**

```ts
type State = "checking" | "latest" | "available" | "downloading" | "error";
interface Empty {}
interface StatusPayload { text: string }
interface VersionData { version: string }
interface AvailableData { version: string; notes: string }
interface ProgressData { progress: number }
interface ErrorData { message: string }
type Snapshot =
  | { state: "checking" }
  | ({ state: "latest" } & VersionData)
  | ({ state: "available" } & AvailableData)
  | ({ state: "downloading" } & ProgressData)
  | ({ state: "error" } & ErrorData);
interface UpdateEvent { revision: number; snapshot: Snapshot }
interface Bootstrap { version: string; status: string; finishRequested: boolean; update: UpdateEvent }
type ErrorCode = "E_FORBIDDEN" | "E_PAYLOAD" | "E_INVALID_STATE" | "E_BUSY" | "E_IO" | "E_UNPACKAGED" | "E_INTERNAL";
type Result<T> = { ok: true; data: T } | { ok: false; error: { code: ErrorCode; message: string } };
interface SplashAPI { onStatus(cb: (text: string) => void): void; onFinish(cb: () => void): void; getVersion(): string | undefined; minimize(): void; close(): void }
interface UpdateAPI { onState(cb: (state: State, data?: object) => void): void; getState(): Snapshot | undefined; startDownload(): void; retry(): void; close(): void; snooze(): void }
```

| channel | 方向 / 方式 | 请求或推送 schema；返回值 | 授权对象 / 错误码 |
|---|---|---|---|
| `dsh:bridge-ready` | renderer → main / handle | `Empty`；`Result<Bootstrap>` | splash、update；公共错误 |
| `dsh:splash-minimize` | renderer → main / handle | `Empty`；`Result<Empty>` | splash；公共错误、`E_INVALID_STATE` |
| `dsh:splash-close` | renderer → main / handle | `Empty`；`Result<Empty>` | splash；公共错误、`E_INVALID_STATE` |
| `dsh:check-update` | renderer → main / handle | `Empty`；`Result<Empty>` | update 的 `retry()`；公共错误、`E_BUSY`、`E_UNPACKAGED` |
| `dsh:update-download` | renderer → main / handle | `Empty`；`Result<Empty>` | update 的 `startDownload()`；公共错误、`E_INVALID_STATE`、`E_BUSY` |
| `dsh:update-snooze` | renderer → main / handle | `Empty`；`Result<Empty>` | update 的 `snooze()`；公共错误、`E_INVALID_STATE`、`E_IO` |
| `dsh:update-close` | renderer → main / handle | `Empty`；`Result<Empty>` | update 的 `close()`；公共错误、`E_IO` |
| `dsh:splash-status` | main → renderer / send | `StatusPayload`；无返回 | splash；发送失败记录 `E_WINDOW_GONE` |
| `dsh:splash-finish` | main → renderer / send | `Empty`；无返回 | splash；发送失败按 §4 兜底 |
| `dsh:update-state` | main → renderer / send | `UpdateEvent`；无返回 | update；发送失败仅记录，状态保留于 M08 |

`getVersion()` 同步读取 preload 启动时从 `additionalArguments` 获取的版本缓存；禁止改成 Promise，禁止读取渲染页面硬编码值。
`getState()` 同步返回 preload 的最新快照，尚未同步时返回 `undefined`；更新页当前版本经 `latest.version` 传入，目标版本经 `available.version` 传入。
preload 在页面订阅建立后调用内部 `dsh:bridge-ready`，取得状态补发；按 `revision` 丢弃旧更新快照，缓存 splash 状态及 finish 请求，避免早发事件丢失。
`src/ipc.js` 顶层只定义纯数据与函数；主进程能力全部注入。preload 经 esbuild 打包为 `build/preload.cjs`，仅 external `electron`，禁止在 sandbox 中直接 require 本地模块。
白名单描述及 channel 映射只定义在 M09；M05 据此包装调用。全部 `void` 方法内部处理 invoke 的结果和拒绝，不向页面泄露 Electron 事件对象。
`onState` 将快照拆为 `(state, data)`；进度限定 `[0,1]`；订阅在页面卸载时清理，重新注册时补发当前状态；不增加公开取消订阅方法。
公共错误为 `E_FORBIDDEN/E_PAYLOAD/E_INTERNAL`；非法参数拒绝执行，业务失败通过既有状态展示。唯一新增页面方法为 D3 明确要求的 `snooze()`。

## 6. dsh host 子进程管理

```text
npx @deepseek-ai/dsh web --no-open
```
目标版本固定为 `@deepseek-ai/dsh@0.1.7-alpha`；运行前检查外部 Node ≥22、npm/npx 及该版本的缓存；缺失则报 `E_RUNTIME_MISSING` 或 `E_CLI_MISSING` 并提示准备环境。（已被 §11.1 修订：上游从未发布 `0.1.7-alpha`，实取 `0.1.7-alpha.2`。）
Windows 不以 `shell:false` 直接执行 `npx.cmd`，也不拼接 `cmd /c` 命令；定位外部 Node 安装对应的 `node.exe` 与 `npx-cli.js`，传绝对路径。
实际调用为 `spawn(nodeExe, [npxCli, "--yes", "--offline", "--package=@deepseek-ai/dsh@0.1.7-alpha", "--", "dsh", "web", "--no-open"], options)`；此映射的兼容性按 §11.1 验证。（已被 §11.1 修订：版本取 `0.1.7-alpha.2`，args 结尾追加 `"--port", String(config.port)`。）
环境覆盖为 `{ ...process.env, DSH_NO_BROWSER: "1", DSH_PORT: String(config.port), ELECTRON_RUN_AS_NODE: "0" }`；默认端口为 3080。（已被 §11.1 修订：`DSH_PORT` 实测对上游无效，已移除；端口改经 `--port` 传入。）
该环境仅传给外部 Node；禁止把 `process.execPath` 当作 Node。`ELECTRON_RUN_AS_NODE` 的非空值不得被当成 Electron 的可靠“关闭开关”。
`options` 固定 `shell:false`、`windowsHide:true`、`detached:false`、`stdio:["ignore","pipe","pipe"]`；工作目录为已创建的用户工作目录；保存启动代次及进程身份。
启动前检查 `127.0.0.1:<port>` 是否已被占用；占用时返回 `E_PORT_IN_USE`，不接管现有服务、不杀占用者、不静默更换端口。
每 250ms 发起一次 HTTP GET `http://127.0.0.1:<port>/api/health`，单次超时 1000ms；禁止重定向；当前子进程存活且响应 200 后进入 ready。（已被 §11.1 修订：该版本无 `/api/health`，就绪改为「实读 stdout 就绪行 + 带 token 的 index 请求返回 303/200」；250ms 轮询与 15000ms 截止不变。）
stderr 出现独立单词 `ready` 仅触发立即 HTTP 探测，不单独判定成功；接口不存在时不得把任意 HTML 200 页替代为健康接口。（已被 §11.1 修订：实测 stderr 为空、无 `ready` 词；就绪信号在 stdout。原句后半的约束被保留——确认必须由上游自己发的 token 换来，不接受未鉴权 2xx。）
每次 spawn 的就绪截止时间为 15000ms；探测请求、定时器和回调均绑定启动代次，旧代次响应不得改变当前状态。
ready 后每 10s 探测一次，单次超时 2s且禁止重叠；连续三次失败视为失联，先回收本次进程树，再进入重启流程。
首次启动失败走 §4 对话框；首次 ready 后的非主动退出或失联执行最多五次自动重启，等待依次为 `1s / 2s / 4s / 8s / 8s`。
初次故障后重启编号为 1；第 5 次重启仍失败即第 6 次连续故障：停止自动重启，显示“服务连续启动失败”及“重试 / 退出”。
连续稳定健康运行 5 分钟后清零重启预算；不能在进程刚 spawn 或刚 ready 时清零，否则会形成无限重启。
重启期间主窗口保留且托盘取消绿色；健康恢复后重新加载同一 origin；旧实例回收失败时不启动新实例，转为终止错误。
`stop()` 幂等；首先设置 stopping、取消健康探测及退避定时器，随后才发送关闭请求；stopping 状态下忽略所有重启触发。
优雅关闭使用同一固定版本、同一端口环境执行逻辑命令 `dsh shutdown`，Windows 使用上述安全启动器将末尾参数改为 `"dsh", "shutdown"`。
从发出 shutdown 起等待最多 3000ms；以本次 host 实际退出为成功，不能仅以 shutdown 命令返回 0 判定回收完成。
Windows 超时后对本应用仍持有、身份已核对的进程树执行 `taskkill.exe /PID <pid> /T /F`；禁止按进程名称或端口批量杀进程。
非 Windows 的测试适配器使用 `SIGKILL`；不能声称在 Windows 对单个 PID 调用 `kill("SIGKILL")` 就能可靠回收整棵进程树。
上游必须以前台受控进程运行；包装器提前退出或服务脱离进程树属于 §11.1 阻塞项，禁止把未跟踪的后台服务算作启动成功。
stdout/stderr 进入脱敏日志，内存尾部缓冲上限 64KiB；不把原始输出、令牌或工作路径直接推送给页面。

## 7. 自动更新双通道降级

**D3：点击“稍后”必须成功持久化 `until = Date.now() + 86400000`，然后关闭弹窗；未写成功不能伪装为已延后。**
M08 管理两个独立 `NsisUpdater` 实例：GitHub 实例使用 `stable`，generic COS 实例使用 `cn-stable`；同一时刻只存在一个逻辑检查及一个活动下载。
两实例均设置 `autoDownload=false`、`autoInstallOnAppQuit=false`、`allowPrerelease=false`；设置 channel 后再次明确 `allowDowngrade=false`。
单源检查逻辑截止时间 15s；下载连续 30s 无进度视为网络失败，单源下载总时限 10 分钟；记录阶段、源与操作代次。
网络降级匹配错误码及错误消息：`/timeout|ETIMEDOUT|ENOTFOUND|cloudflare|404|ERR_CERT|CERT_|SSL|ECONNRESET|ECONNREFUSED|UNABLE_TO_VERIFY|SELF_SIGNED/i`。

```text
idle --startup / every 6h / manual--> eligibility
eligibility --automatic and now < until--> wait(until)
eligibility --allowed--> checking(github, stable)
checking --new version--> available
checking --no new version--> idle + tray feedback(5s)
checking --network failure--> checking(cos, cn-stable)
checking(cos) --success--> available OR idle
checking(cos) --failure--> error + manual-download dialog
available --update now--> downloading(active source)
available --later--> persist snooze --> wait(24h)
downloading(github) --network failure--> verify same mirror release --> download(cos)
downloading --verified package--> stop host --> install --> restart
downloading --integrity/signature failure--> error
error --retry--> new logical check, github first
```

应用启动且主窗口接管成功后触发首次自动检查；之后默认每 6h 调度；开发态不执行真实更新，手动请求返回 `E_UNPACKAGED`。
主源实例配置 `{ provider:"github", owner:"<占位 OWNER>", repo:"<占位 REPO>" }`；备源配置 `{ provider:"generic", url:"https://<占位 COS 域名>/dsh-desktop", channel:"cn-stable" }`。（已被 §11.1 修订：占位符均已填真实值 —— owner/repo = `Kk1107k/dsh-desktop`；COS url = `https://dsh-desktop-1432719119.cos.ap-shanghai.myqcloud.com/dsh-desktop`。壳内默认源与 electron-builder.yml 必须同源，已加断言防漂移。）
降级必须切换实际 provider 实例；仅把 GitHub 实例的 channel 改成 `cn-stable` 不构成 COS 降级，禁止作为实现。
每轮检查每源最多一次；自动触发与手动触发合并到同一轮，重复点击不创建新窗口、新检查或重复事件监听。
超时使当前源的操作代次失效；晚到的 Promise 与事件全部忽略。旧实例仍未结束时不得在该实例上再发检查，防止交叉回调污染状态。
下载降级前先取消原下载并等待退出；不能并行写入同一个更新缓存。取消无法结束时进入错误，不启动第二个下载。
下载阶段切换 COS 必须重新读取元数据，确认目标版本、安装包 SHA-512 和大小与已获用户同意的 GitHub 版本一致；不一致报 `E_MIRROR_MISMATCH`。
校验和错误、签名错误、非预期降级、无效元数据属于完整性错误，不通过换源或关闭校验绕过；错误记录进入日志。
“已是最新”不新建弹窗，托盘文字显示“已检查更新”5s后恢复；已存在的重试窗口显示契约中的 `latest` 状态。
页面状态严格限于五种；主进程内部的 `downloaded/installing/snoozed` 不新增页面枚举，安装前保持 `downloading` 且进度为 1。
snooze 成功后重排下一次自动检查到 `until`；跨重启继续生效，超过 `until` 后启动则立即检查，不额外再等一个 6h 周期。
生成器将“稍后”按钮改绑 `snooze()`；`available` 状态下的 `close()` 和窗口 X 同样执行 snooze，其他状态关闭只隐藏更新窗口。
手动“检查更新…”绕过 snooze 和 `skipVersion`，但不清除它们；自动检查可获取被跳过版本的信息，但不弹窗、不下载该版本。
更新说明统一转为纯文本并限制为 16KiB；当前安装版本来自包版本，待安装版本来自已校验元数据，禁止混淆二者。
双源网络失败显示“无法连接更新服务”，提供原生“手动下载 / 关闭”按钮；下载地址固定为 `https://<占位官网域名>/download`，由主进程验证后打开。（已被 §11.1 修订：原生对话框已按要求实现；固定地址改取真实发布页 `https://github.com/Kk1107k/dsh-desktop/releases`，并新增可选配置 `downloadPageUrl`；打开前按「https + host 白名单」校验。）

## 8. 托盘菜单设计

| 序号 | 菜单 | 行为 |
|---|---|---|
| 1 | 打开 DSH 桌面 | 恢复、显示并聚焦主窗口；窗口已销毁时通过 M06 重建 |
| 2 | 检查更新… | 调用 M08 手动检查，绕过延后；正在下载或安装时禁用 |
| 3 | 运行模式 | radio 子菜单：标准 / PTC / 极简 / 创造，内部值为 `standard/ptc/minimal/creative` |
| 4 | 设置 | 首版显示且禁用；设置页留到 Phase 4+，不猜测上游设置路由 |
| 5 | 分隔线 | `type:"separator"` |
| 6 | 退出 DSH Desktop | 调用 M02 唯一退出入口；不是隐藏窗口 |

徽章优先级：发现未跳过的新版本或正在下载用 `tray-update.png`；否则 host 健康用 `tray-running.png`；启动、失联及停止用 `tray.png`。
绿色仅表示“服务可用”，不表示正在生成内容；双击托盘等同打开主窗口；检查完成的文字反馈不覆盖更高优先级徽章。
首版仅标准模式启用，其他三项显示但禁用；投喂包没有模式切换协议，必须按 §11.1 验证后另行启用，禁止只改勾选却不改变实际服务行为。

## 9. 安全约束

- 所有窗口均设置 `contextIsolation:true`、`nodeIntegration:false`、`webSecurity:true`、`webviewTag:false`；本规格连 splash 也设置 `sandbox:true`。
- 主窗口直接 `loadURL("http://127.0.0.1:<port>")`，不使用 `<webview>` 标签，不注入桌面 preload，不暴露任何壳桥给上游页面。
- splash、update 使用 `build/preload.cjs`；about 无 preload。桥的可用角色由主进程登记，不能由页面参数自行声明。
- M02 在 ready 前注册标准且安全的 `dsh-app` 协议；M06 在 ready 后提供 `dsh-app://ui/splash.html`、`update-dialog.html`、`about.html`。
- 协议处理器只服务固定页面及包内允许的素材；规范化路径并拒绝 `..`、编码穿越、未知 host、未知扩展名，不映射用户目录。
- 本地页面 session 与 host session 分离；每个 session 的 `webRequest.onHeadersReceived` 只安装一个统一处理器，保留无关响应头。
- 本地页面 CSP：`default-src 'self'; script-src 'self' <实际脚本SHA-256列表>; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`。
- 本地 CSP 哈希从包内实际 inline script 内容计算；协议响应同时携带同一 CSP，禁止依赖页面伪造值，禁止为通过测试加入 `unsafe-eval`。
- host CSP：`default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws://127.0.0.1:<port>; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'`。（已被 §11.1 修订：仅对 loopback origin 的响应，script-src 追加 `'unsafe-eval'`；理由与影响面见 §11.1「host CSP 放宽 unsafe-eval」条。）
- host 原有 CSP 更严格时保留并与壳策略共同生效；资源受阻必须记录并进入兼容性验证，不自动取消 CSP 或关闭 webSecurity。
- 每个 IPC 请求校验登记的 webContents、`senderFrame === sender.mainFrame`、精确页面 URL、角色及 payload；上游窗口、子 frame 和未知窗口一律拒绝。
- 本地页禁止导航到其他 URL；主窗口只允许当前 loopback origin 的主框架导航，拦截跨源跳转、重定向及所有 `will-attach-webview`。
- `setWindowOpenHandler` 默认 deny；外部页面仅由主进程在明确用户操作后打开 HTTPS 白名单地址，禁止 `file:`、`javascript:` 及任意自定义协议。
- 权限请求与权限检查默认拒绝；不自动授权摄像头、麦克风、定位、通知、屏幕捕获或任意设备访问。
- 不调用忽略证书错误开关，不安装“信任所有证书”的处理器；COS 降级不能降低 TLS、安装包完整性或签名要求。
- preload 不暴露 `ipcRenderer`、通用 send/invoke、文件系统、shell、任意 URL 打开器或命令执行器；回调只接收校验后的普通数据。
- 本地 HTTP 服务仅允许绑定 loopback；壳配置、日志和 IPC 不存储或回传 API Key；上游认证材料由上游自行管理。

## 10. 配置与存储

M02 统一读取 `path.join(app.getPath("userData"), "config.json")`；应用名固定为 `dsh-desktop`，默认配置如下。
```json
{
  "schemaVersion": 1,
  "port": 3080,
  "theme": "system",
  "autoCheckIntervalHours": 6,
  "runMode": "standard",
  "skipVersion": null
}
（已被 §11.1 修订：新增**可选**字段 `downloadPageUrl`（手动下载页地址，须 https 且 host 在白名单内；缺失或非法一律回落默认值）。可选字段向后兼容，`schemaVersion` 不变。）
```
M08 单独维护 `path.join(app.getPath("userData"), "update-snooze.json")`，唯一业务字段为 `{ "until": <epoch毫秒整数> }`；首次使用值为 0。
文件缺失使用默认值；损坏文件保留为带时间标记的 `.corrupt` 副本后恢复默认，并记录错误；不删除用户的其他文件。
持久化串行执行，写同目录临时文件、flush、关闭后原子替换；写失败保留旧配置并返回 `E_IO`，不能先更新界面假装成功。
端口限制 1024–65535，主题限定 `system/light/dark`，频率为 1–168 的整数；运行模式使用 §8 枚举，未实现模式启动时回退标准并明确提示。
`skipVersion` 为 `null` 或合法版本字符串；仅影响自动提醒，不表示安装该版本；首版不新增“跳过”按钮。配置由 M02、延后文件由 M08 单一写入。
日志位于 `path.join(app.getPath("userData"), "logs", "main.log")`，单文件上限 5MiB并轮转；统一遮蔽 Authorization、API Key、token 和敏感查询参数。

## 11. 打包与发布

```yaml
appId: com.dshdesktop.app
productName: DSH Desktop
directories:
  output: dist
asar: true
compression: maximum
artifactName: "${productName}-Setup-${version}.${ext}"
files: ["src/**", "build/preload.cjs", "assets/**", "package.json", "LICENSE"]
afterPack: tools/after-pack.cjs
win:
  target: ["nsis"]
  icon: assets/icon.ico
nsis:
  oneClick: false
  allowToChangeInstallationDirectory: true
  perMachine: false
publish:
  - provider: github
    owner: "<占位 OWNER>"
    repo: "<占位 REPO>"
    releaseType: release
  - provider: generic
    url: "https://<占位 COS 域名>/dsh-desktop"
    channel: cn-stable
```
`after-pack.cjs` 保留构建器生成的缓存目录等必要字段，将安装资源内 `app-update.yml` 的源字段规范化为国内兜底：
```yaml
provider: generic
url: "https://<占位 COS 域名>/dsh-desktop"
channel: cn-stable
```
运行时 M08 显式构造 GitHub 主实例并设 `stable`，失败才使用上述 COS 配置；静态 `app-update.yml` 不是自动主备切换器。
脚本顺序固定为 `build:preload → typecheck → test → electron-builder --win nsis --x64 --publish never`；**D5：全部发布产物进入 `dist/`**。
`release.yml` 在 `v*` tag 触发，校验 tag 等于包版本，Windows 构建并签名，然后上传 GitHub Releases，最后由 `tools/release.mjs` 同步 COS。（已被 §11.1 修订：签名允许降级为"未签名构建"，但必须留痕 —— 缺 `CSC_LINK` 不再拒绝发布，改为在日志与 Release 说明中注明，并提示 SmartScreen。）
GitHub 同时上传安装包、blockmap、`latest.yml`、`stable.yml`；`stable.yml` 从构建元数据生成，引用相同已签名产物，禁止虚构哈希。
COS 安装包和 blockmap 上传到 `/dsh-desktop/<version>/<文件名>`；固定入口 `/dsh-desktop/cn-stable.yml` 的 `files[].url` 及兼容 `path` 改为 `<version>/<文件名>`。
同步顺序固定为：上传版本化二进制 → 回读验证 SHA-512 和大小 → 最后更新 `cn-stable.yml`；只改路径不改哈希，失败保留旧入口且 CI 标红。
二进制使用不可变缓存，元数据使用 `Cache-Control:no-cache`；签名证书及 COS 凭据只存 CI Secrets；客户端不携带任何发布密钥，未完成可信签名不得公开自动安装。

### 11.1 上游契约假定与 Phase 2 阻塞项

以下项目仅为输入规定的目标契约，未在本规格阶段实测；发现不一致时在本小节记录实际结果，由 Phase 2 完成壳侧适配与回归。

| 待验证项 | 验证及不一致处理 |
|---|---|
| CLI 参数与包入口 | 验证固定版本接受 `web --no-open` 及 Windows 安全启动器参数；不支持时记录实际公开 CLI 用法，不伪造成功 |
| 环境变量 | 验证 `DSH_NO_BROWSER`、`DSH_PORT` 的效果；`ELECTRON_RUN_AS_NODE=0` 仅为传给外部 Node 的隔离约定，不声称属于 dsh 协议 |
| 健康接口 | 验证 `/api/health`、成功状态及响应语义；接口缺失时记录受支持的替代探测，未经适配不得通过 host 验收 |
| 关闭命令 | 验证 `dsh shutdown` 是否存在及是否仅停止本壳目标实例；存在全局误停风险时禁止执行，记录为发布阻塞 |
| 进程归属与绑定地址 | 验证前台运行、包装器生命周期、完整进程树回收及仅绑定 loopback；任何外部暴露或失去归属均阻止发布 |
| 模式与 UI 兼容性 | 验证模式切换公开能力及 CSP 下的页面功能；缺少模式协议不阻塞标准模式，但其他模式保持禁用 |

#### 实测记录（2026-09-25 · Windows 11 · `@deepseek-ai/dsh@0.1.7-alpha.2` · 外部 Node v24.14.1）

本节只记录实测结果与证据，不修改 §6 冻结文本；壳侧适配是否落到 §6 由后续决策。
标记含义：`✅` = 已适配；`⛔ 原始实测 → ✅ 已适配（见适配表）` = **该行的原始实测结论原样保留**（不改写事实），壳侧适配已完成并记录在下方「壳侧适配记录」，**不再是 host 验收的阻塞项**；仅标 `⛔`（适配表无对应条目）者才按本小节约束不得通过 host 验收。

| # | §6 假定 | 实测 | 证据 |
|---|---|---|---|
| 1 ✅ | 固定版本 `@deepseek-ai/dsh@0.1.7-alpha` | **该版本从未发布**。已发布 `0.1.7-alpha.1/.2`、`0.1.7-rc.1/.2`；dist-tags：`alpha=0.1.7-alpha.2`、`next=0.1.7-rc.2`、`latest=0.1.5-rc.3`（注意 `latest` 反而更旧）。已改为 `0.1.7-alpha.2` | 联网直查 `npm view @deepseek-ai/dsh@0.1.7-alpha` → 404；`@0.1.7-alpha.2` → 正常 |
| 2 ⛔ 原始实测 → ✅ 已适配（见适配表） | `DSH_PORT` 注入端口 | **被忽略**。设 `DSH_PORT=3099` 仍绑 `3080`。⇒ `config.port` 对上游无效；改端口即探测错端口。上游公开开关是 `--port` | 探测日志固定打印 `http://127.0.0.1:3080/` |
| 3 ⛔ 原始实测 → ✅ 已适配（见适配表） | `GET /api/health` → 200 即就绪 | **该路由不存在**。整棵上游包树无 health 路由；`/api/*` 一律先过鉴权：未鉴权 401、鉴权后该路径 404。⇒ 现有 `probeHealth` 永远拿不到 200，必然 15s 超时 | 全树 grep `api/health`/`health` 无命中；`curl /api/health` → 401，带 token → 404 |
| 4 ⛔ 原始实测 → ✅ 已适配（见适配表） | stderr 出现独立单词 `ready` | **stderr 全空**；无 `ready` 单词。就绪信号在 **stdout**：`[hub] routes mounted (profile=web, loader=provided)` 与 `dsh web: http://127.0.0.1:<port>/?token=<43 位>`（该行同时给出真实端口与进程 token） | stdout/stderr 分流实测 |
| 5 ⛔ 原始实测 → ✅ 已适配（见适配表） | 主窗口加载 `http://127.0.0.1:<port>/` | `/` 无 token → **401**；`/?token=<t>` → 303。⇒ 按现 URL 加载会得到 401 而非 UI | 同 #3 实测 |
| 6 ✅ | `dsh web --no-open` | 可用（`[hub] routes mounted` 后正常服务），但 `dsh web --help` 的公开用法写作 `dsh --profile web` | `dsh web --help` 输出 |
| 7 ✅ | `--offline` + 预置缓存 | `--offline` 需**元数据**缓存命中，其键受 registry 影响：种子与运行时 registry 不一致即 `ENOTCACHED`（表现为 host 起不来）。⇒ 预置缓存必须用运行时同一个 registry | 同 spec/同缓存，项目目录（`.npmrc` 指 npmmirror）失败、换目录（默认 registry）成功 |
| 8 ⛔ 原始实测 → ✅ 已适配（见适配表） | 完整进程树回收 | 实测：杀掉外层包装进程后，由 `node` 直接跑 `dsh` 的孙进程仍存活并继续占用 3080（复现 `EADDRINUSE: address already in use 127.0.0.1:3080`）。⇒ 回收必须覆盖整棵树 | 二次启动报 `startup failed: 2 required plugins did not activate` |

另记录两条上游可用信息：上游启动失败时**在 stderr 输出多行诊断**（`dsh: startup failed: N required plugins did not activate` + 具体插件错误）后退出，可作失败态识别依据；鉴权模型为「进程 token → 换 cookie」（`authorizeIndex`），token 由上游在启动时自行打印，壳侧无需也不应自造凭据。

#### 壳侧适配记录

| 日期 | 项 | 适配内容 | 落点 |
|---|---|---|---|
| 2026-09-25 | #1 版本 | `TARGET_PKG` 取 `0.1.7-alpha.2`（上游真实存在的版本，与 `alpha` tag 及 npx 缓存一致） | `src/dsh-host.js` |
| 2026-09-25 | #3+#4 就绪判据 | 弃用 `/api/health`；改为实读 stdout 就绪行 `dsh web: http://127.0.0.1:<port>/?token=<token>` 取真实端口与 token，再以带 token 的 `GET /` 返回 303/200 确认就绪。收紧条件：仅 loopback、端口必须与 stdout 一致（不一致即明确报错、不静默换端口）、token 只能实读不得自拼、token 在入库与写日志前一律遮蔽。250ms 轮询 / 15000ms 截止 / ready 后 10s 巡检语义不变 | `src/dsh-host.js`（`READY_LINE_RE`、`captureReadyLine`、`confirmHost`、`probeIndex`） |
| 2026-09-25 | 夹具同步 | `tests/helpers/fake-npx.mjs` 改为**对齐上游形态**：不再提供 `/api/health`，改吐 stdout 就绪行 + 带 token 的 index（303 + Set-Cookie，无 token 401）。夹具此前编码的是 §6 的错误假定，属"mock 通过不等于 host 通过"的实例 | `tests/helpers/` |
| 2026-09-25 | #5 主窗口鉴权 | 主进程在 ready 后先用本次实例的**进程 token 换取 cookie**（`ses.fetch(url, {redirect:'follow'})`，让上游 303 与其 `Set-Cookie` 在同一 session 内走完），主窗口随后仍加载**干净 URL** `/`。加载用端口取就绪行实读值；因 #3 已强制「stdout 端口 === config.port」，与 M06 的导航白名单 / CSP 端口保持一致。**未放宽任何安全约束**：围栏继续生效、cookie 由上游签发（`HttpOnly` + `SameSite=Strict`，30 天），壳不自造凭据、token 不入日志。§6 无对应冻结句（§5 仅要求"同一 origin"），故不加 §6 标注 | `src/dsh-host.js`（`authorize`）、`src/main.js`（ready 处理、`loadMainWindow`） |
| 2026-09-25 | #2 端口注入 | 弃用 `DSH_PORT` 环境变量（实测无效），改为 args 追加 `--port <config.port>`。就绪仍以 stdout 实读端口为准并与 `config.port` 比对，不一致即明确报错（不静默换端口） | `src/dsh-host.js`、`tests/helpers/fake-npx.mjs`（改从 argv 读 `--port`） |
| 2026-09-25 | #8 进程树 | 复现结论：**外部强杀且不带 `/T`** 时，孙进程（`node …@deepseek-ai/dsh`）会存活并继续占 3080；壳自身的 `taskkill /PID <child> /T /F` 能清掉全链（实测 `node(npx) → cmd.exe shim → node(dsh)` 三层）。App 正常退出与强制回收路径均已验证干净。⇒ 降为 P2，不阻塞 | —（无代码改动） |
| 2026-09-25 | `spawning host gen=1` 结案 | 该行出自 #0/#A 修复前那次运行的 stdout 抓取（`/tmp/dev.log`，现已随会话临时目录过期）。复核：`tryStartHost` 全仓仅 3 处引用（定义、bootstrap 首次调用、`promptRetryOrExit` 的"重试"回调），**不存在自动重启路径**；`maybeAutoRestart` 两处调用点均被 `state === 'ready'` 把守，而超时先置 `crashed` 使 `onChildExit` 两个分支都不进。当前代码 70s 实测（覆盖 15s 超时 + 4 轮以上退避）`spawning host` 计数 = 1。⇒ 判定为对话框"重试"被点击所致（+5.0s），非 bug，结案 | —（无代码改动） |
| 2026-09-25 | host CSP 放宽 `'unsafe-eval'` | 上游 UI bundle 用 `new Function` 动态求值，被壳注入的 host CSP 挡掉：控制台 `Uncaught EvalError: Refused to evaluate a string as JavaScript because 'unsafe-eval' is not an allowed source of script in the following CSP directive: "script-src 'self' 'unsafe-inline'"`（`index-bRich_x8K.js:13`）→ SPA 起不来、主窗口白屏。⇒ **仅对 loopback origin** 的响应把 script-src 放宽为 `'self' 'unsafe-inline' 'unsafe-eval'`；**壳自己的 `dsh-app://` 页面不允许 eval**（§9 明令本地页不得加 unsafe-eval）——其策略改由协议响应下发，见下方「本地页 CSP 下发」条。影响面限定为"仅上游页面、仅 loopback"，且沿用 `nodeIntegration:false` + `contextIsolation:true` + `sandbox:true`；`object-src 'none'`、`base-uri`、`frame-ancestors 'none'`、`connect-src` 白名单全部保留。**这是上游强制的放宽，不是壳主动降低标准**。另：实测上游 0.1.7-alpha.2 **不发任何 CSP 头**（401/303/静态资源三处均无），故按 §9「更严格者保留并共同生效」把覆盖改为**保留上游头 + 追加壳策略**（今天无对象，防将来被静默丢弃） | `src/main-window.js`（`buildCsp` / `HOST_CSP` / `LOCAL_CSP` / session hook 按 origin 分支） |
| 2026-09-25 | 本地页 CSP 下发（原"未按 §9 实现"已修复） | §9 要求本地页用**实际脚本 SHA-256 列表**的 CSP，且"协议响应同时携带同一 CSP"。原状：splash/update-dialog 内无任何 CSP、全仓无 `sha256-`、协议响应不加头。⇒ 已实现：`handleDshAppRequest` 读盘计算页面内**每个 inline `<script>`** 的 `sha256-<base64>`，把 §9 原文策略（`script-src 'self' <hashes>`、`connect-src 'none'`、`base-uri 'none'`）作为响应头下发；session hook 改为**只处理 loopback origin**，壳自己的页面不再被 hook 插手（避免双重策略）。三页各只含 1 个 inline script、0 个内联事件处理器，实测哈希制可用。备注：`about.html` 自带 meta CSP 为 `script-src 'self'`（无哈希、无 'unsafe-inline'），与该页唯一的内联脚本相抵触 —— 该脚本在本次改动前即已被自身 meta 挡住，未动它 | `src/main.js`（`inlineScriptHashes` / `handleDshAppRequest`）、`src/main-window.js`（`LOCAL_PAGE_CSP`、hook 收窄） |
| 2026-09-25 | **D2 修订：转场增加兜底路径** | 实测 `ready-to-show` 在隐藏窗口上因 GPU/驱动组合抖动而不到（4 次里 3 次缺失），而 `attemptFinish` 是单次判定、只在 `ready-to-show` 里调度一次且不重试 ⇒ **转场永久死锁**（splash 停在"即将就绪…"，主窗口永不 `show()`）。修法（**主判据不变**）：`did-finish-load` 后 800ms 仍无 `ready-to-show` 时，先把主窗口显示出来让首帧得以绘制、`ready-to-show` 随之到达；窗口已设 `backgroundColor:#0f1419` 故不会白闪，且早于 2400ms 门控。触发时打 warn`ready-to-show 未到，按 did-finish-load 兜底显示`便于统计频率 | `src/main.js`（`SPEC_READY_FALLBACK_MS`、`state.main.once('loaded')` 兜底）、`src/main-window.js`（`did-finish-load` 额外 emit `loaded`） |
| 2026-09-25 | **§4 补充：splash 置顶** | §4 原文"splash 保持在上方淡出，避免露出空白桌面"在代码里没有实现（`createSplashWindow` 无 `alwaysOnTop`）。后果：`attemptFinish` 先 `state.main.show()` ⇒ 主窗口盖住 splash ⇒ 被遮挡的渲染进程计时器受节流 ⇒ 页面 300ms 淡出后调 `close()` 晚于 1000ms 兜底（实测 1015ms，差 15ms 输掉竞态），日志每轮出现 `splash finish confirm timeout, force destroy`。修法：splash 窗口加 `alwaysOnTop: true`（**只给 splash，主窗口不加**）；1000ms 兜底保持原样不动，仍作为真兜底 | `src/main.js`（`createSplashWindow`） |
| 2026-09-25 | **about 页版本改协议响应期替换（D4 满足）** | 原状：`src/about.html` 写死 `0.1.0`，违反 D4；§9 又规定该页**不挂 preload**，无法照抄 splash 的 `getVersion()` 路径；且该页 meta CSP 为 `script-src 'self'`（无 inline、无哈希），原有的注入脚本**必被挡死**（渲染控制台实测 `Refused to execute inline script`），版本只会显示兜底字面量。⇒ 按 A1 落地：占位符 `__APP_VERSION__` 放进 **HTML 文本**（不是脚本——HTML 文本里 `<…>` 形状会被当标签解析），主进程在 `handleDshAppRequest` 里以 `app.getVersion()` 精确替换；删掉那段被挡死的冗余脚本（该页哈希列表随之变空，`script-src 'self'` 保持不放宽）。替换抽成**纯函数 `renderLocalPage(html, version)` 并导出**（便于 mock 直接断言），替换范围由同一份白名单 `LOCAL_PAGES` 限定、不外溢。**顺序约束**：先替换、再按替换后文本算 CSP 哈希（本页无脚本暂不受影响，约束已写进注释防回退）。另登记现状：**about 页当前无任何入口可达**（全仓只有协议白名单提到它，§8 冻结的托盘六项里没有"关于"），故该 D4 违反一直是潜伏的；是否加入口留给 P4（文档收尾）决策，**本轮不动 §8 菜单** | `src/about.html`、`src/main.js`（`renderLocalPage` / `handleDshAppRequest`）、`tests/acceptance.test.mjs` |
| 2026-09-25 | 更新页 `--dsh-version` 误传 Electron 版本（1 行隐患） | `main-window.js` 给更新窗口传的是 `--dsh-version=${process.versions.electron}`，而 splash 传的是 `app.getVersion()`。当前**无实际影响**（更新页 `updateAPI` 没有 `getVersion()`，页面显示的版本全部来自快照：`latest` 态由 updater 用 `app.getVersion()` 构造、`available` 态用远端版本），但属**活陷阱**——谁给更新页加上 `getVersion()` 就会拿到 Electron 版本，正是 D4 要防的漂移。已改为 `app.getVersion()`。同类问题今日第三例（前两例：`onTraySetText` 名字漂移、CSP 哈希计算顺序） | `src/main-window.js` |
| 2026-09-25 | **升级至 `0.1.7-rc.2` · 8 条重验结果** | 官方称"壳 + 运行时 + pnpm 是一个验证过的组合"，换版本 = 换组合 ⇒ 逐条重验（命令 → 结果 → 判定）：<br>**① 版本存在性与 tag**：`npm view @deepseek-ai/dsh@0.1.7-rc.2 version` → `0.1.7-rc.2`；`dist-tags.next=0.1.7-rc.2`（`latest=0.1.5-rc.3` 更旧，禁用）；官方 `apps/desktop` 绑定 rc.2 ⇒ **一致**<br>**② `--port`**：`dsh web --no-open --port 3099` → 就绪行报 `127.0.0.1:3099` 且该端口在服务 ⇒ **仍有效，一致**（未改回 `DSH_PORT` 等其它开关）<br>**③ 就绪行**：stdout 仍为 `[hub] routes mounted (profile=web, loader=provided)` + `dsh web: http://127.0.0.1:<port>/?token=<43 位>` —— 端口与 token 仍在同一行 ⇒ **一致**<br>**④ stderr**：健康启动 stderr **0 字节**；失败诊断仍走 **stderr**（1034 字节，`dsh: startup failed: N required plugins did not activate` + 具体插件错误）⇒ **一致**<br>**⑤ 主窗口鉴权**：无 token `/` → **401**；`/?token=` → **303** + `set-cookie: dsh-auth-…=v1.…`（authority 含端口、HttpOnly、SameSite=Strict、Max-Age=2592000）⇒ **一致**<br>**⑥ CLI 用法**：`dsh web --help` 仍打印 `Usage: dsh --profile web [options]`，而 `dsh web --no-open` 位置参数形式仍可用 ⇒ **一致**（"文档用法与实现不同形"维持原判）<br>**⑦ `--offline` + registry**：**不一致 ⇒ 已按根源修法适配**（见下条）<br>**⑧ 进程树**：仍为 `node(npx) → cmd.exe shim → node(dsh)` 三层（实测 19652 → 28164 → 31432）⇒ **一致**（`/T` 覆盖不变）<br>**附**：上游仍**不发 CSP 头**（`content-security-policy` 命中 0）⇒ §9「保留上游 CSP + 追加壳策略」仍无对象 ⇒ **一致**<br>**真机证据（门禁）**：`pnpm dev` → `host ready line parsed port=3080` → `gate: hostHealthy=true mainLoaded=true readyToShow=true elapsed=4312`（转场完成）→ 主窗口加载出 UI；`splash finish 兜底 0 / main window load failed 0 / CSP 违规 0`。托盘图标需人眼确认（我无观测通道） | 本轮仅改版本与 registry，其余无适配 |
| 2026-09-25 | **⑦ 根源修法：registry 由壳固定下发** | 原实现依赖用户/项目 `.npmrc`：开发机（cwd = 项目根，读到我们的 npmmirror）与**装包后**（cwd 任意、读不到项目 `.npmrc`）行为不一致，能否命中 `--offline` 缓存纯属侥幸。改为壳固定：`NPM_REGISTRY = process.env.DSH_DESKTOP_NPM_REGISTRY \|\| 'https://registry.npmjs.org'`，web 与 shutdown 两处 spawn 都下发 `npm_config_registry`（env 优先级高于 `.npmrc` ⇒ 不读用户配置）。**实测**（项目目录**之外**、带运行时 registry + `--offline`，即装包后的形状）：**0 次 ENOTCACHED**，host 正常就绪 ⇒ 根因消除。⚠ 改此值或换镜像后**必须用同一个 registry 重灌 npx 缓存**。顺带清掉 shutdown spawn 里残留的无效 `DSH_PORT` | `src/dsh-host.js`、`tests/acceptance.test.mjs` |
| 2026-09-25 | **填入真实 COS 域名（发布前收尾）** | 桶由凯哥提供：**桶名 `dsh-desktop-1432719119`、地域 `ap-shanghai`、域名 `dsh-desktop-1432719119.cos.ap-shanghai.myqcloud.com`**（域名可达性由他实测验证：返回 404 NoSuchKey ⇒ 桶名与地域正确）。⇒ `electron-builder.yml` 的 generic publish url 与 `src/updater.js` 的 `DEFAULT_COS_URL` 都改为 `https://dsh-desktop-1432719119.cos.ap-shanghai.myqcloud.com/dsh-desktop`。**两处必须同源**：已加断言（壳内默认源 == 打包配置 url，且必须是 https + `*.cos.<region>.myqcloud.com`），两处漂移会让客户端与服务端指向不同的桶（静默失效）。⚠ **"占位符容忍"分支保留**（`isHttpUrl` 判定 + 逐源 try/catch + 记"备源未配置"）：那是将来换桶/漏填时的兜底，不因现在填了域名就删。⚠ 启动期合法性自检（`isHttpUrl`）对真实域名通过；构建产物中不得再残留占位符（源码 grep `占位 COS 域名` 命中 0，SPEC 冻结句里的占位符按机制保留并标注） | `electron-builder.yml`、`src/updater.js`、`tests/acceptance.test.mjs` |
| 2026-09-25 | **官方三条铁律登记（①②③）** | ①**版本绑定**：「Electron 与 `@deepseek-ai/dsh` 始终使用同一精确版本」+「即使桌面壳代码不变，升级 dsh 也必须发布新 Desktop 版本」⇒ 已落为"壳版本 = 绑定版本"（见本表「版本号规则」条）。<br>②**更新单元**：「壳、匹配的 dsh 运行时与 pnpm 组成一个**已签名更新单元**」+「运行时版本选择绝不脱离 Desktop 发布」⇒ 我们的对应做法：`TARGET_PKG` 把 dsh 版本**编译期钉死**在壳内（不运行时挑版本、不跟随 dist-tag），壳与所绑定 dsh **同版同发**（tag 必须是 `v<壳版本>`，release.yml 会校验 tag == 包版本）。⚠ **但"已签名"这一半我们不满足**：本版按发布决策**未签名**（见本表「§11 修订：签名可降级」条）⇒ 与铁律②存在**有意差异**，两条并存登记，不得含糊。<br>③**差分**：「桌面壳未变化的数据块不应强制完整传输」⇒ 壳侧不得禁用 `disableDifferentialDownload`、打包侧必须产出 `.blockmap`、发布侧**两路都上传** `.blockmap`（GitHub Releases + COS），四条断言见 `tests/acceptance.test.mjs` | `src/dsh-host.js`、`src/updater.js`、`.github/workflows/release.yml`、`tools/release.mjs`、`tests/acceptance.test.mjs` |
| 2026-09-25 | **已知偏离①·运行时（架构级，非缺陷）** | 官方 Desktop **内置 Node/pnpm/Python**，并以 `ELECTRON_RUN_AS_NODE=1` 跑 dsh；我们**依赖用户系统 Node**（`locateRuntime`：注册表 → `where node` → 常见目录，校验 ≥22）。注意这与 **§6 两句原文相反**（§6 写着"禁止把 `process.execPath` 当作 Node""`ELECTRON_RUN_AS_NODE` 的非空值不得被当成 Electron 的可靠'关闭开关'"）—— 那两句站在"不内置运行时"的立场，而官方做法是内置。**取舍理由**：① 不内置运行时 ⇒ 安装包体积小（实测 80.79 MiB，验收线 130 MB）② 不与上游 Node 版本绑定，用户可自行升级 ③ 代价：依赖环境准备，§6 已用 `E_RUNTIME_MISSING`/`E_CLI_MISSING` 明确提示。⇒ 登记为已知偏离，**SPEC §6 冻结文本不改** | —（架构说明） |
| 2026-09-25 | **已知偏离②·通信层（架构级，非缺陷）** | 官方**不使用本地 Web 端口**：`dsh://` 自定义协议 + 分帧管道 + Node IPC；我们走 **`127.0.0.1:<port>` + 进程 token→cookie 围栏**。**影响面**：§11.1 的 8 条偏差（就绪判据、鉴权、CSP、registry 约束、进程树形态……）**几乎全部源于"走 web 模式"这条路径** —— 若将来改走官方通信层，这 8 条可整体作废。⇒ 登记为已知偏离 | —（架构说明） |
| 2026-09-25 | **上游版本升级至 `0.1.7-rc.2`；版本号规则改为"壳版本 = 绑定的 dsh 版本"** | 依据官方铁律（经 GitHub API 直读 `apps/desktop/package.json`：`version = 0.1.7-rc.2`，文件 sha `cc0ce4f0…`；npm `next` dist-tag 亦为 `0.1.7-rc.2`）：「production Desktop 使用与 dsh 完全相同的版本，包括 alpha/beta/rc 标识」「即使桌面壳代码不变，升级 dsh 也必须发布新 Desktop 版本」。⇒ `TARGET_PKG` 由 `0.1.7-alpha.2` 升至 `0.1.7-rc.2`；`package.json.version` 由 `0.1.0` 改为 **`0.1.7-rc.2`**（安装包名随之变为 `DSH Desktop-Setup-0.1.7-rc.2.exe`，`app.getVersion()`、发布 tag `v0.1.7-rc.2` 同步）。⚠ **必须写明的区别**：官方该铁律的前提是"壳 + 内置运行时 + pnpm 是一个**验证过的组合**"，而我们的组合是"壳 + **用户系统 Node** + dsh" —— 我们**只是借用官方版本号的命名规则**来表达"绑定哪个 dsh"，**不声称**验证了官方那个组合。⚠ 禁止改用 `latest`（§11.1 #1 已记录：latest 反而更旧）。8 条重验结果见本表「升级至 `0.1.7-rc.2` · 8 条重验结果」条 | `src/dsh-host.js`、`package.json`、`CHANGELOG.md`、`README.md`、`tests/acceptance.test.mjs` |
| 2026-09-25 | **§7:251 修订：手动下载入口（原生对话框）+ 真实地址 + host 白名单** | §7:251 原文要求"提供**原生**'手动下载 / 关闭'按钮"——**已按原文用原生对话框实现**（`promptManualDownload`，在进入"无法连接更新服务"时弹出：`detail` 里给出明文网址 + 两个按钮）。两处有意偏离原文：①原址 `https://<占位官网域名>/download` 是占位符 ⇒ 默认改取真实可用的发布页，并新增**可选**配置 `downloadPageUrl`（§10 字段，缺失/非法一律回落默认，构成读侧第一道闸）；②校验口径定为「**https + host 白名单**」而非泛化的公共域名（依据 §9:282"外部页面仅由主进程在明确用户操作后打开 **HTTPS 白名单地址**"）：白名单常量 `DOWNLOAD_HOST_ALLOWLIST` 默认 `['github.com']`，改配置域名必须同步常量，A10 用例断言"默认地址 host ∈ 白名单"以防两边漂移。**校验失败一律拒绝打开 + 记日志，绝不 `shell.openExternal`**。弹窗**异步弹、不 await**（不把对话框串进更新状态机），且由 `showNetworkFailure` 承载 ⇒ 每轮失败一次、手动重试再失败会再弹（不额外去重，因为该点仅由 `pageState === 'checking'` 路径到达）。明文网址在 MessageBox 的 `detail` 里（Windows 不可选中复制），但有"手动下载"按钮直接拉起浏览器 ⇒ 需求满足；页面内显示网址属"页面按钮"方案（B），本轮未做、登记为缓做 | `src/main.js`（`isAllowedDownloadUrl`/`promptManualDownload`/`loadConfig`/`onManualDownloadPrompt` 注入）、`src/updater.js`（`showNetworkFailure`）、`tests/acceptance.test.mjs` |
| 2026-09-25 | **§11 修订：签名可降级为未签名构建（发布决策）** | §11 原文要求"Windows 构建并签名"且"未完成可信签名不得公开自动安装"。按发布决策，本版**不签名发布** ⇒ `release.yml` 的"缺 CSC_LINK 即拒绝发布"硬门槛改为**可降级**：缺证书时不再 `exit 1`，而是输出 `signed=false` 并在日志中明确记为"未签名构建"；Release 说明无论签与未签都写入签名状态（未签名时附 SmartScreen 提示与"更多信息 → 仍要运行"的引导），用 `gh release edit` 写回。**留痕是强约束**：绝不允许"缺证书=静默跳过"，否则将来分不清哪一版签了。签名分支完整保留（配了 `CSC_LINK`/`CSC_KEY_PASSWORD` 仍照常签名，构建步骤的透传未改）。⚠ 该决定只解除 CI 的硬门槛，不改变 §11:348 对"公开自动安装"的要求 —— 未签名构建在获得签名前仍属**预发布**性质 | `.github/workflows/release.yml`、`tests/acceptance.test.mjs` |
| 2026-09-25 | 备源 URL 占位符容忍（装包首启崩溃） | 线上：装包后首启即崩 —— `new NsisUpdater({provider:'generic', url:'https://<占位 COS 域名>/dsh-desktop'})` 的 URL 含尖括号，electron-updater 构造时 `new URL` 直接抛（`unhandledRejection Invalid URL`）。占位符是 §11.1 允许的待填形态，故**代码必须容忍它**：构造前 `isHttpUrl` 判定 + 逐源 try/catch；不合法或构造失败 ⇒ 记一条"备源未配置"并按缺省处理（不建该实例、COS 各调用点加 null 守卫、主源失败直接进既有 error 态）。feed URL 改为可注入（默认仍是占位符），使 COS 降级用例仍能真实驱动备源 | `src/updater.js`、`tests/stubs/electron-updater.mjs`（补上游 URL 校验） |
| 2026-09-25 | unhandledRejection 分级处置 | 同一次崩溃的放大链：updater 构造的 rejection 冒泡到 `process.on('unhandledRejection')` → `cleanupAndQuit()` + `app.exit(1)` → 杀掉已就绪的 host、主窗口 `ERR_FAILED`。⇒ 分级：更新模块（可选功能）的拒绝只记录并继续运行；核心链路（main/host/window）才走受控退出。源头另有 `ensureInstances` 整体 try/catch | `src/main.js`（`isRecoverableRejection`） |
| 2026-09-25 | **§6 修订：端口残留自愈（只回收身份核对过的自己人）** | 线上两次重试均 `E_PORT_IN_USE`：上次崩溃残留的 dsh **孙进程**继续占 3080（孙进程已脱离包装器，`/T` 从旧 PID 追不到）。⇒ 就绪时记录"本壳确认过的端口占用者"（PID + 创建时间 ticks + 命令行哈希 → `host-owner.json`；此刻该 PID 已被就绪行的 token 证明属于本壳子进程），启动遇端口占用时**三条同时成立才回收**其进程树并复查端口：① 记录里存过该 PID；② 它确实是当前占用者；③ 身份材料逐项一致（同一进程实例、命令行未变）。**不改变 §6:195 的对外语义** —— 回收对象仅限本壳自己崩溃后的残留，他人进程一律照报 E_PORT_IN_USE（走 §6:207 允许的身份核对路径，仍禁止按名/按端口批量杀）。⚠ 过渡限制：只有 pid+port 的旧格式记录无法自愈，错误信息会给出占用者 PID 供人工清理；自下一次干净启动起记录即带身份材料 | `src/dsh-host.js`（`reclaimOwnLeftover`/`probeProcess`/`writeOwnerRecord`）、`src/main.js`（`ownerRecordPath`） |
| 2026-09-25 | 构建环境依赖：electron-builder 两类归档的镜像 | `pnpm build` 在无镜像时失败：`connect ETIMEDOUT 20.205.243.166:443`（github.com 不可达）。**`.npmrc` 里的 `electron_mirror` / `electron_builder_binaries_mirror` electron-builder 都不读**，只认同名环境变量，且**两个都必须设**：漏掉 `ELECTRON_BUILDER_BINARIES_MIRROR` 会在拉 winCodeSign/NSIS/7zip 时失败；漏掉 `ELECTRON_MIRROR` 会在打包阶段拉 Electron 归档/校验和时失败（2026-09-25 复验时实测踩到，两次都在 `packaging` 那一步超时）。⇒ 已写入 README「安装与开发」（给 Git Bash 与 PowerShell 两种写法）并在 `.github/workflows/release.yml` 构建步骤加同名 env（留空 = 官方源）。换机器 / 新 CI 照 README 设即可 | `README.md`、`.github/workflows/release.yml` |
| 2026-09-25 | **D2 修订：attemptFinish 由单次判定改为有界轮询（三层兜底）** | 原实现是**单次判定**且只在 `ready-to-show` 里调度一次，失败即永久停在 splash。改为**三层兜底关系**（非并列条件）：第 1 层主判据 `ready-to-show` 不变；第 2 层 `did-finish-load` + 800ms 兜底显示窗口让首帧绘出；第 3 层**有界轮询**（每 500ms 复核一次，起点挂在 `loadMainWindow()` 而非事件上——两个事件都不来也会启动），到 `SPEC_MAIN_LOAD_TIMEOUT_MS`(10s) 仍未通过 → 走 `E_UI_LOAD`（重试/退出对话框），**绝不无限等**。每次评估记 `gate: hostHealthy=… mainLoaded=… readyToShow=… elapsed=…`；另记 did-finish-load / ready-to-show 到达时刻、800ms 兜底定时器是否装配、兜底到期时第 1 层是否已满足——下次卡住时日志直接指出"哪个条件为假 / 哪个事件没来"。门控轮询与 loadMainWindow 的加载看门狗共用同一代次只弹一次错误框（`uiErrorShown`） | `src/main.js`（`scheduleFinalGate` / `attemptFinish` / `SPEC_GATE_POLL_MS`）、`src/main-window.js`（两个事件的到达日志） |
适配仅发生于 M04 的启动、探测和关闭边界；D1–D5、页面方法名、更新源语义及安全约束不得被联调人员静默改写。
Mock 测试通过只证明壳状态机成立；§12 中涉及真实 host、安装、签名及更新下载的用例必须在目标 Windows 环境通过后才能标记发布完成。

## 12. 验收标准

| 编号 | 可执行断言 |
|---|---|
| A01 单例与启动 | **if** 连续启动两个实例且 host 在 1500ms 就绪、主窗口加载成功，**then** 只存在一个受控 host，第二实例退出，finish 不早于 splash 展示 2400ms，关闭不早于淡出 300ms |
| A02 启动失败与取消 | **if** mock host 超过 15s 不就绪或用户提前关闭 splash，**then** 前者出现超时文案及重试/退出选择，后者退出；两条退出路径均无遗留 host、探测器或重启定时器 |
| A03 健康与崩溃恢复 | **if** ready 后连续制造六次故障且期间未稳定运行 5 分钟，**then** 只发生五次自动重启，退避依次为 1/2/4/8/8 秒，第六次故障弹窗并停止自动重试 |
| A04 主源更新与最新 | **if** GitHub 提供高于包版本的有效 stable 元数据，**then** 展示五态契约中的 available 且不自动下载；**if** 无新版，**then** 不新建弹窗并在 5s 后恢复托盘文字 |
| A05 双源降级 | **if** GitHub 检查发生超时、404 或证书错误且 COS 有合法 cn-stable 元数据，**then** 真实请求转向 COS 且不降版本；**if** 两源均失败，**then** 展示手动下载入口 |
| A06 延后持久化 | **if** 在时间 T 点击稍后并重启应用，**then** `until=T+86400000`，T+24h 前无自动检查或提醒，到期触发；手动检查仍有效，模拟写盘失败时不得关闭为成功状态 |
| A07 IPC 与版本 | **if** 从 host 窗口、子 frame 或未知 URL 调用任意壳 channel，**then** 返回拒绝且无副作用；**if** 修改包版本后重新构建，**then** splash 和更新页当前版本同步改变，方法签名保持契约 |
| A08 下载与安装 | **if** 用户立即更新且下载中主源失败，**then** 仅在 COS 版本/哈希/大小一致时续接；包校验或签名失败不安装；成功则先回收 host，再安装重启进入目标版本 |
| A09 托盘与真实退出 | **if** 主窗口点击 X 且托盘可用，**then** 窗口隐藏、服务存活、菜单六项顺序正确；**if** 点击退出且 host 忽略 shutdown，**then** 3s 后启动进程树强制回收且不触发重启 |
| A10 安装与发布一致性 | **if** 对合法版本 tag 执行发布流水线，**then** NSIS 允许选择安装目录并以当前用户安装，`dist/` 文件名符合 D5，GitHub/COS 二进制哈希相同，COS 元数据最后发布且实际下载成功 |

验收记录必须区分 mock 与真实环境；任一安全、进程回收、签名或更新完整性用例失败，都不得以“界面正常”替代通过结论。
SPEC.md 完成，共 12 节 / 376 行。
下一步：把 SPEC.md 完整粘贴给 Prompt B。
