# DSH Desktop · 效率最大化方案

> **目标**：用 Claude Code（接 DeepSeek V4.1）+ WorkBuddy 国内版（3000 积分）+ WorkBuddy 国际版（440 积分 GPT-5/6）三份 AI 资源协作，给 `deepseek-ai/deepseek-harness`（官方 CLI `dsh`）做一个**独立 Electron 桌面壳**，特性：开机美化、自动检查更新、常驻托盘。

---

## TL;DR · 30 秒结论

| 关键决策 | 选择 |
|---|---|
| 技术栈 | **Electron ≥ 36（内置 Node 22）+ electron-updater + electron-builder**（不选 Tauri 原因见 §7） |
| 与 dsh 的关系 | Electron 壳 `spawn('npx', ['@deepseek-ai/dsh','web'])`，以本地 `127.0.0.1:3080` WebView 为主界面 |
| 核心方法论 | **Spec-Driven 瀑布式外包**：国际版 GPT-6 只产 Spec → 国内版按 Spec 批量生成代码 → Claude Code（**DeepSeek V4.1 + GLM-5.3 双模型**）跑命令/编译/测试/修错 → **本地执行**最终审计（国际版额度已耗尽，改 0 积分） |
| 模型与档位 | 详见 **§4.5**：每阶段用哪个模型、思考强度开几档、花多少钱，都有对照表 |
| 积分预算 | 国际版 **140 积分 / 4 次深度会话**；国内版 **1000 积分**；Claude Code 走 API 按 token 计、边际成本最低 |
| 国内更新兜底 | GitHub Releases 主通道 + **腾讯云 COS（ap-shanghai）镜像** 自动降级（你的环境 GitHub 慢/被墙） |
| 预计总工期 | **6 ~ 9 小时**（三份 AI 并行 + 你 30 分钟评审） |

---

## 1. 三份 AI 资源画像与分工原则

### 1.1 资源对比

| 资源 | 模型 | 额度形态 | 能做什么 | 适合场景 | 不适合 |
|---|---|---|---|---|---|
| **Claude Code + DeepSeek V4.1** | DeepSeek V4.1（API） | 按 token 计（边际成本最低） | 直读直写本地文件、跑 shell、跑 build、跑 test、看 log、自我迭代 | **体力活**：项目脚手架、依赖安装、TypeScript 编译错修、自动更新打包、修 ESM/CJS 兼容、修 Electron API 差异 | 一次性大段架构决策、复杂性能/安全审计 |
| **WorkBuddy 国内版** | 国产主流（DeepSeek/Qwen/GLM/Kimi 任选） | **3000 积分**，对应约 30 ~ 50 次中等 Agent 会话 | Agent 模式、批量文件产出、子任务编排、文档撰写、UI 草图 | **中等代码量生成**：模块文件批量产出、配置模板、测试用例、README | 顶级架构推理、复杂 bug 单点突破 |
| **WorkBuddy 国际版** | GPT-5 ~ GPT-6 系列 | **440 积分 ≈ 10 ~ 15 次深度会话** | 最强推理、长上下文连贯 | **一次性决策**：架构 spec、模块契约、最终安全/性能审计 | 重复模板代码 |

### 1.2 黄金原则（务必记住）

1. **思考与执行分离** —— 最强模型（国际版）只产 spec 和 review，**不写一行实现代码**。
2. **Spec 是唯一真相源** —— Spec 出炉后，所有模型按 Spec 施工，禁止中途改 spec（除非发现致命缺陷）。
3. **失败回路要快** —— 体力活一律交给能直接跑命令的 Claude Code，不要让"思考模型"去干执行。
4. **积分花在刀刃** —— 440 积分只够 4 次硬决策；每 1 积分都要产出"再也无需返工"的成品。
5. **国产模型做量产** —— 重复性强的模块（tray 菜单、preload、autoUpdater、IPC）让国内版批量产，不要浪费 GPT-6 的 context。

---

## 2. 技术架构（已选）

### 2.1 整体形态

```
┌──────────────────────────────────────────────────────────┐
│  DSH Desktop (Electron ≥ 36) — 独立壳，不 fork 上游      │
├──────────────────────────────────────────────────────────┤
│  Main Process (src/main.js, Electron ≥ 36 内置 Node 22)   │
│   ├── app lifecycle + single-instance lock               │
│   ├── splash window (BrowserWindow: false, splash.html)  │
│   ├── dsh host subprocess ──spawn──▶ npx @deepseek-ai/dsh│
│   │   等待 http://127.0.0.1:3080 就绪                    │
│   ├── main BrowserWindow ◀──── loadURL(127.0.0.1:3080)  │
│   ├── Tray (nativeImage, tray.ico)                       │
│   ├── autoUpdater (electron-updater)                     │
│   │   ├─ GitHub Releases (主)                            │
│   │   └─ 腾讯云 COS 镜像 (兜底)                          │
│   └── ipcMain <-> preload (contextBridge)                │
│                                                          │
│  Preload (src/preload.js)                                │
│   └── contextBridge.exposeInMainWorld(...)  【命名待定】  │
│       ⚠ 见 B-AI共享/INTERFACE.md §2 待决项 D1                │
│       页面端实际期待 splashAPI / updateAPI（已实现事实）  │
└──────────────────────────────────────────────────────────┘
```

### 2.2 与 dsh 的三种交互边界

| 边界 | 用什么 | 何时 |
|---|---|---|
| 主界面 | 内嵌 `127.0.0.1:3080` 的 WebView | 默认 |
| 命令 | `child_process.spawn('npx', ['@deepseek-ai/dsh', ...])` | 启动 / 插件管理 / 切模式 |
| 进程健康 | 父进程监听 stdout/stderr/exit，重启 | host 进程崩溃 |

### 2.3 模块拆分（12 个可独立交付的子模块）

| # | 模块 | 文件 | 复杂度 | 主负责 |
|---|---|---|---|---|
| M01 | 项目骨架（package.json、tsconfig、electron-builder） | 根目录 | 低 | 国内版 |
| M02 | 主进程入口 + 单例锁 | `src/main.js` | 中 | 国内版 |
| M03 | splash 窗口（已交付 `src/splash.html`） | `src/splash.html` | 低 | 国内版 |
| M04 | dsh host 子进程管理（spawn/健康/重启） | `src/dsh-host.js` | 中 | 国内版 |
| M05 | preload + contextBridge | `src/preload.js` | 中 | 国内版 |
| M06 | 主窗口 + WebView 接管 + 关窗 → 托盘 | `src/main-window.js` | 中 | 国内版 |
| M07 | Tray 模块（菜单/状态徽章/点击行为） | `src/tray.js` | 中 | 国内版 |
| M08 | autoUpdater（双通道兜底） | `src/updater.js` | **高** | **国际版 + Claude Code** |
| M09 | IPC 协议（窗口控制/重启/查更新/查日志） | `src/ipc.js` | 低 | 国内版 |
| M10 | 错误处理与日志（electron-log） | `src/logger.js` | 低 | 国内版 |
| M11 | electron-builder + NSIS 安装包 + GitHub Actions release | `.github/workflows/release.yml` | **高** | **国际版 + Claude Code** |
| M12 | README + CHANGELOG + 关于页 | `README.md` 等 | 低 | 国内版 |

---

## 3. Spec-Driven 流水线（核心方法论）

### Phase 0 — 架构 Spec（国际版 GPT-6 · **~60 积分**）

**输入**：`C-每一步投喂/step1-架构spec-国际版/prompt-A-国际版-架构spec.md`
**输出**：单文件 `B-AI共享/SPEC.md`（约 200~400 行），含：
- 完整目录树（含每个模块的文件路径）
- 进程模型 + IPC 协议（事件名、payload schema）
- dsh host 子进程的生命周期（启动/就绪/健康检查/重启策略）
- autoUpdater 的双通道降级逻辑（含失败码映射）
- 单实例锁 + 二次启动行为
- 安全约束（contextIsolation、webSecurity、IPC 白名单）
- 验收标准（每条可被测试）

**关键约束**：Spec 必须**可被 Claude Code 直接拿去执行**——不要写"应该"、"大概"、"也许"。

> 💡 为什么要这一阶段：3000 积分的国产模型和 440 积分的 GPT-6 最大的差距是**长期连贯性**。一次性把架构敲定，后面所有人按图施工才不会各干各的。

---

### Phase 1 — 批量代码生成（国内版 · **~600 积分**）

**输入**：`C-每一步投喂/step2-批量实现-国内版/prompt-B-国内版-批量实现.md` + `B-AI共享/SPEC.md`
**输出**：M01、M02、M03、M05、M06、M07、M09、M10、M12 共 **9 个模块**
**执行方式**：把 prompt-B + SPEC.md 完整粘给国内版 Agent，**一次性**产出所有模块文件。

> ⚠️ **不要分多次粘**。国内版 Agent 在一个 session 内能维持 200K context，分多次会丢失模块间一致性。

---

### Phase 2 — 执行/调试（Claude Code + DeepSeek V4.1 · **API 费用最低**）

**输入**：`C-每一步投喂/step4-落地跑通修错-ClaudeCode/prompt-C-ClaudeCode-执行调试.md`
**执行内容**（按顺序自动跑）：
1. `pnpm install` / 装包
2. 拆 Phase 1 输出，逐模块落地到本地仓库
3. 跑 `tsc --noEmit` / `electron .`，修编译错
4. 跑 `electron-builder --dir`，修打包错
5. 反复迭代直到 dev 模式启动成功、托盘出现、splash 播放、更新弹窗触发
6. **不向用户索取积分**

> Claude Code 的核心优势：**直接操作文件系统 + 直接读 log + 自我迭代**。这是 GPT-6 通过聊天做不到的。

---

### Phase 3 — 最终审计（国际版 GPT-6 · **~60 积分**）

**输入**：`C-每一步投喂/step5-最终审计-国际版/prompt-D-国际版-最终审计.md`
**审计点**（每点必须给"通过 / 需修 + 原因"）：
- autoUpdater 的双通道降级逻辑（GitHub 失败 → COS → 手动下载）
- 托盘菜单的所有点击路径（无死链）
- IPC 白名单（无 contextBridge 暴露 Node 全局）
- host 进程崩溃后**最多 30 秒**内自愈
- 单实例锁（第二次启动 → 唤起第一个实例，不开新窗口）
- 关窗 → 托盘 → 真正退出菜单路径（不丢未保存态）

**输出**：`A-我读的/AUDIT.md`（问题清单 + 修复优先级）

---

### Phase 4 — 文档与图标收尾（国内版 · **~100 积分**）

- README.md（含截图、特性、下载链接、开发命令、QA）
- CHANGELOG.md
- 关于页（in-app `dsh:about`）
- 把 `assets/` 下的图片正确嵌入 splash 与托盘
- 把 Electron 体积从 ~180MB 优化到 ~120MB（asar 压缩、剔除 docs）

---

## 4. 任务拆解表（直接照着跑）

| Phase | 任务 | 主负责 | 协做 | 预计耗时 |
|---|---|---|---|---|
| 0 | 写 SPEC.md | 国际版 GPT-6 | 国内版校对 | 20 min |
| 1 | 产出 9 个模块（M01-M12 除 M08/M11） | 国内版 Agent | — | 60 min |
| 2.1 | 落地 M08 autoUpdater（双通道） | 国内版 | Claude Code | 45 min |
| 2.2 | 落地 M11 GitHub Actions release | 国内版 | Claude Code | 30 min |
| 2.3 | npm install + 跑通 dev 模式 | Claude Code | — | 30 min |
| 2.4 | 修编译错 + 修打包错（迭代 N 次） | Claude Code | — | 60 min |
| 3 | 最终审计 AUDIT.md | 国际版 GPT-6 | Claude Code 修 | 30 min |
| 4 | 文档 + 图标收尾 | 国内版 | — | 20 min |
| **总计** | | | | **~5h AI + 30 min 你评审** |

---

## 4.5 模型选型与思考强度（含 GLM-5.3）

> 这一节回答三件事：**每个阶段具体用哪个模型、思考强度开到几档、大概花多少钱。**

### 可用模型清单

| 资源 | 可用模型 | 上下文 | 思考强度怎么调 |
|---|---|---|---|
| **Claude Code** | **DeepSeek V4.1** + **GLM-5.3**（双模型可切） | GLM-5.3 **1M 级长上下文**（以实际接入版本为准） | `/effort` 五档：low · medium · high · **xhigh(显示为 Extra)** · max，外加 Ultracode 模式 |
| **WorkBuddy 国际版** | GPT-5 ~ GPT-6 系列 | 长 | reasoning effort（低/中/高） |
| **WorkBuddy 国内版** | 国产模型全家桶（DeepSeek / GLM / Qwen 等） | 视模型而定 | 多数带"深度思考"开关 |

### 分阶段选型表（照这个配就行）

| 阶段 | 用哪个模型 | 思考强度 | 为什么这么配 |
|---|---|---|---|
| P0 架构 Spec | 国际版 GPT-6 | **high（最高档）** | 一次想错后面全废，这 60 积分是全案最值的一笔 |
| P1 批量出码 | 国内版 · **GLM 最新可用版**（5.3 优先，否则 5.2 / Qwen / DeepSeek） | **medium（关深度思考）** | 按图纸砌砖，不需要深推理；关掉思考能省近一半时间和积分 |
| P2.1 落地 autoUpdater | Claude Code · **DeepSeek V4.1** | **high** | 逻辑密度中等，标准编码档 |
| P2.2 GitHub Actions | Claude Code · **DeepSeek V4.1** | **medium** | YAML 配置，低难度 |
| P2.3 跑通 dev | Claude Code · **GLM-5.3** | **xhigh（Extra）** | 要通读整个项目 + 反复调工具；1M 上下文能一次吃下全部代码，xhigh 正是官方推荐的"长时间代理式任务"档 |
| P2.4 修编译错（迭代 N 轮） | Claude Code · **DeepSeek V4.1** | **medium** | 报错信息明确，不需深想；这步要跑几十轮，**降档最省钱** |
| P2.5 卡壳攻坚 | Claude Code · **两个模型轮流试** | **max** | 同一问题换个模型 = 换个思路，比死磕一个模型快得多 |
| P3 最终审计 | 国际版 GPT-6 | **high（最高档）** | 安全与更新链路，最后一道闸 |
| P4 文档收尾 | 国内版 | **low / 关思考** | 纯体力活 |
| （可选）大规模重构 | Claude Code · GLM-5.3 | **Ultracode** | xhigh + 自动多代理扇出，适合跨几十个文件的重构；**仅当前会话有效** |

### Claude Code 双模型怎么选（你新接的 GLM-5.3 很关键）

- **GLM-5.3 的杀手锏是长上下文（1M 级）+ 长程任务定位** → 凡是"需要通读整个项目"或"跨文件连续改造"的活都给它。
- **DeepSeek V4.1 适合高频短迭代** → 修单个编译错、改一个文件、跑一轮构建。这类活占绝大多数，用它最划算。
- **卡壳时换模型重试**：同一报错在 A 模型上连续 2 轮没解决，就切 B 模型重述问题。两个模型的错误模式不同，交叉验证的命中率明显更高。

### 思考强度速查（Claude Code 五档）

| 档位 | 滑块显示 | 什么时候用 |
|---|---|---|
| low | Low | 样板代码、格式化、改配置 |
| medium | Medium | 常规修错、日常迭代（**省钱主力档**） |
| high | High（默认） | 复杂推理、高难度实现 |
| xhigh | **Extra** | 长时间代理式任务、反复调工具、通读全项目 |
| max | Max | 真正困难的问题（注意：可能过度思考，反而变差） |
| Ultracode | Ultracode | xhigh + 多代理扇出，仅限大重构/审计；仅当前会话 |

**设置方式**：`/effort` 打开滑块；`/effort xhigh` 直接指定；`claude --effort medium` 仅本次会话生效。

> ⚠️ 两个容易踩的坑：
> ① 滑块上的 **"Extra" = xhigh，不是最高档**，最高是它右边的 **Max**；
> ② `ultrathink` 关键字只影响当前一轮，而 **"think" / "think hard" 现在已被当作普通文本，不再起作用**。
> 另外：low/medium/high/xhigh 会跨会话保留，**max 和 Ultracode 仅当前会话有效**。

### 预算明细（按上面档位配）

| 项目 | 用量 | 成本 |
|---|---|---|
| 国际版 GPT-6 · P0 Spec | 1 次，high | ~60 积分 |
| 国际版 GPT-6 · P3 审计 | 1 次，high | ~60 积分 |
| 国际版应急（含失败重试） | 已实际发生 | **已用光** |
| 国内版 · P1 批量出码（GLM 最新可用版, medium） | ~10 个模块 | ~600 积分 |
| 国内版 · P4 文档 | 1~2 次，low | ~100 积分 |
| 国内版应急返工 | — | ~150 积分 |
| Claude Code · DeepSeek V4.1（medium/high 混用） | ~40~60 轮 | ~¥10~25 |
| Claude Code · GLM-5.3（xhigh 通读 + 攻坚） | ~10~15 轮 | ~¥8~20 |
| **合计** | | **国际版 140 / 国内版 1000 / API ¥18~45** |

---

## 5. 积分预算（精准表）

| 阶段 | 国际版积分 | 国内版积分 | Claude Code（API） |
|---|---|---|---|
| Phase 0 架构 spec（**实际**） | **440 已用光** | — | — |
| Phase 1 批量生成 | — | 600 | — |
| Phase 2.1/2.2 autoUpdater + Actions | — | 150 | — |
| Phase 2.3/2.4 跑通 + 修错 | — | — | ≈ 30~80 万 token（按 DeepSeek V4.1 定价约 ¥15~40） |
| Phase 3 审计（**改本地执行**） | **0** | — | — |
| Phase 4 文档收尾 | — | 100 | — |
| 应急缓冲 | 20 | 150 | 不可预测 |
| **小计** | **440（已耗尽）** | **850** | **¥15 ~ 40** |
| **你账户余额** | 440 | 3000 | 按需充值 |
| **剩余** | **0** | **2150** | — |

> **2026-09-24 实际**：国际版 440 在 Phase 0 就用光了 —— 单条大消息扣 ~59 积分，
> 且**失败也扣、重发再扣**，网络抖动导致的两次重试直接把额度打穿。
> 对策：**Phase 3 审计改为本地执行（0 积分）**，后续流程不再依赖国际版。
> 若将来要复跑，先充值或开 Pro 试用（今天 $0 + 500 积分，第 6 天前取消）。

> 国内版**剩余 2150** 积分可用来跑二次迭代、做别的项目、或攒到下一次大改造。
> 国际版剩余 0 —— 后续所有步骤都已改为不依赖国际版额度。

---

## 6. 国内分发兜底（GitHub Releases 拉不动的解法）

**问题**：你的网络环境对 GitHub 慢/被墙，自动更新失败会让用户卡在旧版本。

**方案**：双通道降级。

```
更新请求
   │
   ▼
GitHub Releases (latest.yml + exe)
   │  失败 (超时/404/网络错)
   ▼
腾讯云 COS 镜像 (ap-shanghai, latest-cos.yml + exe)
   │  失败
   ▼
弹窗引导用户手动去官网下载
```

**实现要点**：
- `app-update.yml` 中同时配 `updateConfig.channels: { stable, cn-stable }`
- `updater.js` 里捕获 `error.message` 含 `cloudflare` / `timeout` / `ETIMEDOUT` 时切换 channel
- COS bucket 由你维护，每次 release 同步上传（GitHub Actions rsync/copy）

> 这是你在 §1.2 原则之外**必须做**的一步，否则在中国大陆这个壳等于自带"半年不更新"。

---

## 7. 风险点与对策

| 风险 | 概率 | 影响 | 对策 |
|---|---|---|---|
| **不选 Tauri 的原因** | — | — | Tauri 体积小但需 Rust 工具链；DeepSeek V4.1 对 Tauri 2 API 不熟，Claude Code 修错成本高 |
| GitHub Releases 国内拉不动 | 高 | 更新全失效 | §6 双通道降级 |
| DeepSeek V4.1 长上下文会忘早段 spec | 中 | M08/M11 偏离 spec | Phase 1 一次性给完整 SPEC.md 给 Claude Code；不要分段 |
| dsh 升级后 host API 改 | 中 | 启动失败 | `src/dsh-host.js` 加版本检测 + 友好降级提示 |
| Electron 体积 180MB+ 劝退 | 中 | 用户不愿下载 | asar 压缩 + 剔除 docs + 仅 x64 + 按需剔除 chrome |
| 中国大陆 trademark 风险 | 低 | logo 被改 | 图标是 **DeepSeek 黑色鲸鱼**（用户指定），MIT 不覆盖商标 → **README.md 必须写非官方外壳免责声明**（已成文，见 README §免责声明） |
| Windows 杀软误报 Electron | 中 | 用户首次运行被拦 | 申请代码签名证书（可选 Phase 4+） |

---

## 8. 验收清单（每条都应被测试）

- [ ] 首次启动：splash 在 800ms 内出现，2s 内 host 就绪
- [ ] 启动后系统托盘有图标，右键菜单 6 条
- [ ] 关主窗口 → 进程不退出 → 托盘图标仍在
- [ ] 托盘菜单"退出"→ 进程干净退出（无僵尸 host）
- [ ] 有新版本时：开机后 5s 内弹窗，"稍后"按钮把提醒压到 24h 后
- [ ] GitHub 拉取失败 → 30s 内切到 COS → 再次失败 → 弹窗提示手动下载
- [ ] 二次启动 exe → 只唤起已有窗口，不开新进程
- [ ] 启动后断网 → 启动流程不卡死，最多延迟 3s 给出提示
- [ ] 卸载时 NSIS 安装包不残留 `%APPDATA%\dsh-desktop`
- [ ] 安装包体积 < 130MB

---

## 9. 执行 checklist（你现在就可以照着做）

1. ✅ **本方案 + 图片资源 + Prompt 包**已交付到 `dsh-desktop/`（你现在看到的）
2. ⬜ 把 `C-每一步投喂/step1-架构spec-国际版/prompt-A-国际版-架构spec.md` 复制到国际版 GPT-6，**一次性**粘出 `B-AI共享/SPEC.md`
3. ⬜ 把 `C-每一步投喂/step2-批量实现-国内版/prompt-B-国内版-批量实现.md` + `B-AI共享/SPEC.md` 复制到国内版 Agent，**一次性**粘出 9 个模块
4. ⬜ 在本地 git init `dsh-desktop/`，把上述产出落地
5. ⬜ 启动 Claude Code + DeepSeek V4.1，把 `C-每一步投喂/step4-落地跑通修错-ClaudeCode/prompt-C-ClaudeCode-执行调试.md` 喂给它
6. ⬜ Claude Code 跑通 `pnpm dev` 看到 splash 与托盘
7. ⬜ 把最终代码贴回 `C-每一步投喂/step5-最终审计-国际版/prompt-D-国际版-最终审计.md`，做审计
8. ⬜ GitHub Actions 自动构建 → 发布 release
9. ⬜ GitHub Actions 自动构建 → 发布 release
10. ⬜ 同步把 `dist/` 下产物 rsync 到腾讯云 COS（ap-shanghai）镜像
    （产物名 `<productName>-Setup-<version>.exe`；COS 路径见 `B-AI共享/INTERFACE.md` §6）

> ⚠ 开工前先读 **`B-AI共享/INTERFACE.md`**：渲染层接口的唯一真相源，
> 内含两个**待决项**（preload 命名空间 D1、splash 关闭时序 D2），需由 Phase 0 的 Spec 拍板。

---

## 10. 关键交付物清单（已在 `dsh-desktop/` 下生成）

**图标全部由无头 Chrome 光栅化 `assets/whale.svg` 生成**（见 `tools/gen_whale_icons.py`，
透明底 + 完全透明区 RGB 置白）。重建全部图标：`python tools/gen_whale_icons.py`。

| 文件 | 状态 | 用途 |
|---|---|---|
| `assets/whale.svg` | ✅ | 图标唯一矢量源（与 dsh 官方 favicon 逐字节一致） |
| `assets/icon.ico`（9 帧 16→256） | ✅ | 应用主图标 / 安装包 / 任务栏 |
| `assets/tray.ico`（6 帧）+ `tray.png` | ✅ | 托盘常态 |
| `assets/tray-update.ico/.png` | ✅ | 有可用更新（琥珀徽章） |
| `assets/tray-running.ico/.png` | ✅ | host 就绪（绿色徽章） |
| `assets/logo-{16,32,64,128,256,512}.png`、`tray-{16,32,64,256}.png` | ✅ | 各尺寸备用 |
| `assets/fonts/shelley-allegro.woff2`（+ `.ttf` 源） | ✅ | 品牌花体字，**仅 update-dialog 内联使用** |
| `src/splash.html` | ✅ | 启动美化页：鲸鱼 + 品牌字**逐线条书写动画** + IPC 钩子 |
| `src/update-dialog.html` | ✅ | 自动更新弹窗：5 态状态机（checking/latest/available/downloading/error） |
| `B-AI共享/INTERFACE.md` | ✅ | **渲染层接口契约**（含 2 个待决项）—— 开工前必读 |
| `A-我读的/方案-B-补充实施要点.md` | ✅ | 补充：三功能实施细节与已知坑 |
| `README.md` | ✅ | 项目说明 + **非官方外壳商标免责声明** |
| `tools/gen_whale_icons.py` | ✅ | 图标生成器（Chrome 光栅化 SVG） |
| `tools/gen_brand_script.py` | ✅ | 品牌字轮廓提取（拆成一根根线条，含 kern） |
| `tools/gen_splash.py` / `tools/gen_update_dialog.py` | ✅ | 两个页面生成器 |
| `tools/gen_font_compare.py` | ✅ | 字体候选对比页生成器（候选字体已归档，需用时从 `_archive/` 取回） |
| `C-每一步投喂/` 下各步骤目录里的 prompt 文件 | ✅ | 三份模型各自的可投喂 prompt |

---

**方法论一句话总结**：**让最贵的模型做最稀缺的决策，让最便宜的模型做最重复的体力活，让能跑命令的模型做无限迭代。**

— 瓦力