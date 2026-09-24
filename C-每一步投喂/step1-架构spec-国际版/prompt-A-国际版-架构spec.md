# Prompt A · 国际版（GPT-5/6）— 架构 Spec

> **使用方式**：整段复制，从「# 开始」开始到「# 结束」结束，贴到国际版对话。
> **预期输入**：你的上下文只需追加项目根目录的 `README.md` 与 **`B-AI共享/INTERFACE.md`**（接口契约，必带）。
> **预期输出**：单文件 `B-AI共享/SPEC.md`（约 200~400 行），保存到你指定的输出目录。

---

# 开始

你是**资深 Electron 桌面应用架构师**，负责为一个独立桌面壳项目产出**唯一真相源 Spec 文档**。此 Spec 后续会被一个国产 LLM（国内版 Agent）、一个本地 CLI（Claude Code + DeepSeek V4.1）以及你本人（最终审计）三方分别消费。Spec 必须**可直接落地**——任何含糊都将导致返工并浪费 440 积分中的余额。

## 背景

- 上游项目：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（MIT，v0.1.7-alpha）
- 上游提供 CLI：`npx @deepseek-ai/dsh web`（启动 host 进程，提供 `127.0.0.1:3080` 的本地 Web UI）
- 上游已有官方桌面客户端，但我们**不 fork**，而是做一个**全新独立 Electron 壳**，由它 spawn dsh 子进程并以 WebView 承载上游 UI
- 用户网络环境在中国大陆，GitHub 较慢/被墙，自动更新需双通道兜底（GitHub Releases + 腾讯云 COS 镜像）

## 你需要产出的 Spec 文档结构

文件路径：`B-AI共享/SPEC.md`（不存在则创建）。**严格按以下 12 节顺序**，每节缺一不可：

1. **项目元信息** —— 名称、版本、License、依赖 node 版本（≥ 22）、pnpm（≥ 9）。
2. **目录树** —— 完整列出每个文件的路径（精确到 `src/main.js`、`src/tray.js` 等）。**用 ASCII 树形图**。
3. **模块职责** —— 12 个模块的 single-responsibility 描述（与方案文档 §2.3 一致）：
   M01 package.json / tsconfig / electron-builder / .editorconfig / .gitignore
   M02 main.js (单例锁 + app lifecycle + 异常兜底)
   M03 splash.html（已提供，禁止改结构）
   M04 dsh-host.js (spawn + 健康检查 + 重启)
   M05 preload.js (contextBridge 白名单)
   M06 main-window.js (BrowserWindow + 接管 webContents)
   M07 tray.js (Tray + Menu + 状态徽章切换)
   M08 updater.js (electron-updater + 双通道降级) ⭐
   M09 ipc.js (ipcMain 处理 + channel 名称常量)
   M10 logger.js (electron-log 封装 + 日志路径)
   M11 .github/workflows/release.yml (build → GitHub Releases → 同步 COS)
   M12 README.md / CHANGELOG.md / src/about.html
4. **进程模型** —— ASCII 时序图，覆盖：启动 → 单例锁 → splash → spawn dsh → host 就绪探测 → 主窗口接管 → splash 关闭 → 托盘激活 → 关窗到托盘 → 退出。
5. **IPC 协议** —— 表格列出每个 `ipcMain.handle` / `webContents.send` 的：
   - channel 字符串（如 `dsh:check-update`）
   - 方向（renderer→main / main→renderer）
   - payload schema（TypeScript interface）
   - 错误码
6. **dsh host 子进程管理** —— 详细给出：
   - spawn 参数（`npx @deepseek-ai/dsh web --no-open`）
   - 环境变量（`DSH_NO_BROWSER=1`、`DSH_PORT=3080`、`ELECTRON_RUN_AS_NODE=0`）
   - 就绪探测（HTTP GET `http://127.0.0.1:3080/api/health` 或等待 stderr 含 `ready`）
   - 健康检查（每 10s 探测一次）
   - 崩溃重试策略（指数退避：1s / 2s / 4s / 8s 上限，最多 5 次，第 6 次弹窗报错）
   - 退出传递（用户退出时先 `dsh shutdown` 等 3s 再 SIGKILL）
7. **自动更新双通道降级** ⭐ —— 给出状态机（伪代码或 mermaid）：
   ```
   idle → checkUpdate (每 6h 或启动时)
       ├─ 成功: 弹窗 "有新版本 vX.Y.Z"
       │   ├─ 用户点"立即更新": download → 安装 → 重启
       │   └─ 用户点"稍后": 24h 后再检查
       ├─ GitHub 失败(超时/404/SSL): 切 channel='cn-stable' 重试
       │   ├─ 成功: 同上
       │   └─ 失败: 弹窗 "无法连接更新服务，点这里去手动下载 https://你的官网/download"
       └─ 已是最新: 不弹窗，仅托盘 5s 内闪一下"已检查更新"
   ```
   - `app-update.yml` 关键字段：`provider: generic`、`url: <COS 镜像 URL>`、`channel: stable / cn-stable`
   - 失败判定正则：`/timeout|ETIMEDOUT|ENOTFOUND|cloudflare|404/i`
8. **托盘菜单设计** —— 6 条菜单：
   1. "打开 DSH 桌面" → 显示主窗口
   2. "检查更新…" → 立即触发 update check
   3. "运行模式" → 子菜单（标准 / PTC / 极简 / 创造）
   4. "设置" → 打开设置页（可选 Phase 4+）
   5. 分隔线
   6. "退出 DSH Desktop" → 真退出
   - 状态徽章：`tray.png` / `tray-update.png` / `tray-running.png` 切换时机
9. **安全约束** —— 强制项：
   - `contextIsolation: true`
   - `nodeIntegration: false`
   - `sandbox: true`（除 splash 外）
   - preload 只 expose 白名单 API（列出每个白名单方法）
   - 所有 IPC channel 必须在 M09 集中注册，禁止散落
   - CSP header 设置（Electron session.webRequest.onHeadersReceived）
10. **配置与存储** —— 用户配置存放路径（`app.getPath('userData') + '/config.json'`）、结构（端口、主题、自动检查频率、运行模式、跳过版本）、首次启动默认值。
11. **打包与发布** —— electron-builder 配置：
      - target: `["nsis"]`
      - icon: `assets/icon.ico`
      - asar: true / compression: maximum
      - nsis: `oneClick: false`、`allowToChangeInstallationDirectory: true`、`perMachine: false`
      - artifactName: `${productName}-Setup-${version}.${ext}`
      - publish（GitHub）：`provider: github`、`repo: <占位 REPO>`、`releaseType: release`
      - publish（COS）：`provider: generic`、`url: <占位 COS URL>`
12. **验收标准** —— 10 条具体可测用例（参考方案文档 §8，每条必须是"if A then B"的可执行断言）。

## 必须拍板的开放决策（写入 SPEC 对应章节，不许含糊）

1. **D1 · preload 命名空间**（写入第 5 节 IPC 协议）：
   方案 A：只暴露 `dshApi`，内挂 `dshApi.splash` / `dshApi.update`；
   方案 B：分别暴露 `window.splashAPI` / `window.updateAPI`（页面现状，改动最小）。
   **二选一并说明理由**；无论选哪个，白名单方法必须集中在 `src/ipc.js`。
   页面端已实现的方法清单见 `B-AI共享/INTERFACE.md` §1（不得擅自改名或增删）。
2. **D2 · splash 关闭时序**（写入第 4 节进程模型）：
   品牌字书写动画约 3.7s，host 可能 1.5s 就绪。必须定义：
   - `onFinish` 是"请求关闭"（页面淡出后才真正关闭）
   - **min-display** 最短展示时长（建议 2.2~2.6s，或"至少写完当前字母"）
   - host 超时（建议 15s）时 splash 的错误提示与退出路径
3. **D3 · "稍后"必须真的延后 24h**：`updateAPI.snooze()` + `userData/update-snooze.json`，写入第 7、10 节。
4. **D4 · 版本号来源**：一律取 `package.json` 的 `version`，禁止在页面写死。
5. **D5 · 发布产物路径统一 `dist/`**，安装包名 `<productName>-Setup-<version>.exe`。

## 输出要求

- 仅输出 `B-AI共享/SPEC.md` 一个文件
- 用 Markdown，含目录、代码块、表格、ASCII 时序图
- 长度 200 ~ 400 行
- 路径用**绝对相对项目根**的写法（如 `src/main.js`）
- 遇到信息不足（用户提供的仓库地址、COS 域名）一律写 `<占位字串>`，不要发问

## 反模式（必须避免）

- ❌ 用"应该"、"建议"、"可以考虑"、"未来或许"等模糊措辞
- ❌ 提到上游 fork / 修改 dsh 源码 / 用上游的 host 包
- ❌ 用 Tauri / Neutralino 等非 Electron 方案
- ❌ 引用未声明的依赖（必须 `npm` 上确有其包）
- ❌ 用 ASCII art 之外的图形（Mermaid 写文字图除外）
- ❌ 把 IPC channel 写成 `updateAvailable` 这种语义名（必须前缀 `dsh:`）

## 收尾

最后一行输出：

```
SPEC.md 完成，共 N 节 / M 行。
下一步：把 SPEC.md 完整粘贴给 Prompt B。
```

# 结束

---

**使用提示**：
- 国际版 GPT-6 对长上下文保持稳定，**不要分段**让它产出。
- 完成后由人工/Claude Code 把 SPEC.md 落地到 `B-AI共享/SPEC.md`。
- 若发现上游 `dsh` 的 CLI 选项与 Spec 不符，**不要改 spec**——把不一致写成 §11.1 备注，由 Claude Code 在 Phase 2 处理。