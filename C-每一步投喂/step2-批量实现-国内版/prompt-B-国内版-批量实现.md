# Prompt B · 国内版（DeepSeek/Qwen/GLM Agent）— 批量实现

> **使用方式**：整段复制，从「# 开始」到「# 结束」，贴到国内版 Agent 对话。
> **前置条件**：必须先准备好 `B-AI共享/SPEC.md`（由 Prompt A 产出）。把 SPEC.md 完整粘贴在本 prompt 的"附：SPEC.md"之后。
> **预期输出**：12 个模块对应的所有源文件，按 SPEC.md 的目录树一次性产出。

---

# 开始

你是一位**资深 Electron 桌面应用工程师**，任务是**严格按照 SPEC.md** 一次性产出所有模块代码。不要发挥想象、不要补充 SPEC.md 没要求的功能、不要修改目录结构。

## 项目背景

- 项目名：`dsh-desktop`，独立 Electron 壳，包装官方 CLI `npx @deepseek-ai/dsh web`
- Node ≥ 22、pnpm ≥ 9、**Electron ≥ 36**（必须内置 Node 22；⚠ Electron 28 内置的是 Node 18，会导致 Node 20+ API 直接崩）、electron-builder 24、electron-updater 6、electron-log 5
- 中文用户，国内网络，需要 GitHub Releases + COS 镜像双通道更新
- 已有资源（不要重新生成）：
  - `assets/icon.ico` / `assets/tray.ico` / `assets/tray-update.ico` / `assets/logo-512.png` 等
  - `src/splash.html`（已完整提供，不要改）、`src/update-dialog.html`
- **接口契约以 `B-AI共享/INTERFACE.md` 为准**；若 SPEC.md 与它冲突，以 SPEC.md 的决策为准，
  但在产出说明里明确指出差异（接口名对不上会静默失效，是最难查的一类 bug）

## 你要产出的文件

按 SPEC.md 第 2 节"目录树"列出**全部**路径文件，逐个产出。模块清单：

| 模块 | 文件 |
|---|---|
| M01 | `package.json`, `tsconfig.json`, `.gitignore`, `.editorconfig`, `electron-builder.yml` |
| M02 | `src/main.js` |
| M03 | **不要动** `src/splash.html`（已存在） |
| M04 | `src/dsh-host.js` |
| M05 | `src/preload.js` |
| M06 | `src/main-window.js` |
| M07 | `src/tray.js` |
| M08 | `src/updater.js` |
| M09 | `src/ipc.js` |
| M10 | `src/logger.js` |
| M12 | `README.md`, `CHANGELOG.md`, `src/about.html` |

## 代码规范（强约束）

1. **ESM only** —— `package.json` 必须 `"type": "module"`，所有 `.js` 用 ES Module 语法（`import` / `export`），不要 CJS
2. **JSDoc 完整** —— 每个导出的函数必须含中文 JSDoc（用途、参数、返回、异常）
3. **错误处理** —— 所有 IPC handler 必须 `try/catch` 并返回 `{ ok: false, error: { code, message } }`；成功返回 `{ ok: true, data }`
4. **常量集中** —— IPC channel 名必须集中在 `src/ipc.js` 顶部 `const CHANNELS = { ... }`，禁止散落
5. **日志规范** —— 用 `logger.info/warn/error`，不要 `console.log`（除 splash.html 内）
6. **不写注释说什么** —— 写**为什么**（WHY），不写**做了什么**（WHAT）
7. **类型严谨** —— 所有跨边界数据（IPC payload）必须用 JSDoc typedef 定义
8. **路径安全** —— `path.join(__dirname, ...)`；禁止 `path.resolve(userInput)`、`fs.readFile(userInput)` 不带白名单

## 重点模块的额外要求

### M02 `src/main.js`
- 启动顺序：`app.requestSingleInstanceLock()` → 若失败 `app.quit()` 立即退出
- 异常兜底：`process.on('uncaughtException')` + `process.on('unhandledRejection')` 写日志并优雅退出
- 关闭 splash 的时机：必须在主窗口 `ready-to-show` 之后

### M04 `src/dsh-host.js`
- spawn 必须用 `{ shell: false, stdio: ['ignore', 'pipe', 'pipe'] }`
- 监听 stdout/stderr 写 logger
- 暴露 `start()` / `stop()` / `restart()` / `isHealthy()` / `on(event, fn)`
- 事件：`starting / ready / crashed / exited`

### M08 `src/updater.js` ⭐
- 必须实现 SPEC.md 第 7 节的状态机，逐条翻译为代码
- 失败判定正则：`/timeout|ETIMEDOUT|ENOTFOUND|cloudflare|404/i`
- `autoUpdater.checkForUpdates()` 必须在主窗口 ready 之后才能调用（避免和 dsh host 抢端口）

### M07 `src/tray.js`
- 6 条菜单，菜单文案用中文
- 状态徽章切换函数：`setState('idle' | 'update' | 'running')`
- 托盘图标用 `assets/tray.png` / `assets/tray-update.png` / `assets/tray-running.png`，用 `nativeImage.createFromPath` 加载
- 双击托盘 = 打开主窗口

### M11 `.github/workflows/release.yml`
- **不要在本 prompt 产出**（SPEC.md 已规定完整结构）。M11 由 Claude Code 在 Phase 2.2 单独产出，避免国内版 Agent 注意力分散。

## 输出格式

每个文件输出用如下格式，**严格顺序**：

```text
=== FILE: <相对项目根的路径> ===
<完整文件内容>
=== END FILE ===
```

最后一行：

```
全部模块产出完毕，共 N 个文件。下一步：把本会话所有文件落地后跑 Prompt C（Claude Code 执行调试）。
```

## 反模式（必须避免）

- ❌ 写错 `electron-updater` API（旧版用 `autoUpdater.on('update-downloaded', ...)`，v6 用 `autoUpdater.on('update-downloaded', cb)` 同时新增 `autoUpdater.on('download-progress')`）
- ❌ 把 splash 关闭时机放到 `webContents.on('did-finish-load')`（应放在主窗口 `ready-to-show`）
- ❌ 让托盘菜单出现"重启"却没实现重启逻辑
- ❌ `electron-builder.yml` 写 `mac.target: dmg`（我们只 Windows）
- ❌ README 里写"克隆后 `npm install`"（必须用 `pnpm`）
- ❌ 用 `any` 类型 / TypeScript（项目是 JS + JSDoc，不是 TS）

## 附：SPEC.md

```
<这里粘贴 SPEC.md 完整内容>
```

# 结束

---

**使用提示**：
- 国内版 Agent 通常一次能撑 100K~200K context。如果 SPEC.md 太长（> 100K），可以分两次：先产出 M01-M07，再产出 M08-M12。但**M08 updater.js 必须连同 SPEC.md 第 7 节状态机一起产出**，不要让它猜。
- 完成后**逐文件落地**到 `dsh-desktop/` 目录对应路径。落地前用 `diff` 或 `cat` 检查一下。
- 若某个文件超过 300 行（如 `src/updater.js`），让 Agent 拆成 `updater.js` + `updater-channels.js` 两个文件，但**目录树保持与 SPEC.md 一致**。