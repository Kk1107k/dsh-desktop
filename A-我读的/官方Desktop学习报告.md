# 官方 DeepSeek Harness Desktop 学习报告

> 来源：`github.com/deepseek-ai/deepseek-harness` → `apps/desktop`（commit `477b4f4`）
> 包的自我描述：**"Electron desktop shell for a bundled dsh runtime and external plugins"**
> 版本：`0.1.7-rc.2`（与 dsh 同版本）；Electron ^44 / TS 6 / tsdown / React 18 + Vite 6
> 调研日期：2026-09-25

---

## 一、三条最重要的确认（我们的方向是对的）

### 1. 版本绑定是**铁律**，比我们说的更严

官方"关键技术决策"表第一行原文：

> **发布身份** — 原因：桌面壳 API、Web 客户端、后端与插件依赖图作为**一个组合完成验证**；
> **独立版本会产生未经验证的组合，并让更新可用性含糊不清**。
> 直接结果：**Electron 与 `@deepseek-ai/dsh` 始终使用同一精确版本**。
> **即使桌面壳代码不变，升级 dsh 也必须发布新 Desktop 版本。**

⇒ 我们"壳固定 `TARGET_PKG`、上游升级通过壳的发布分发"**完全一致**。
但官方口径更硬：**不是"评估后决定跟不跟"，而是"dsh 变了就必须发新壳"**。

### 2. 更新单元是"壳 + 运行时 + 包管理器"一个整体

> **更新决策** — 桌面壳与 dsh 独立更新会重新产生版本分裂，而桌面壳未变化的数据块不应强制完整传输。
> 结果：**Electron 壳、匹配的 dsh 运行时与 pnpm 组成一个已签名更新单元**。
> 平台更新产物可以复用未变化的数据块，但**运行时版本选择绝不脱离 Desktop 发布**。

⇒ 与我们"手动下载地址指向壳自己的仓库"一致（上游不该有独立更新通道）。

### 3. 版本号规则可直接借鉴

| dsh 基础版本 | production Desktop | test Desktop |
|---|---|---|
| `0.1.6-alpha.1` | `0.1.6-alpha.1` | `0.1.6-alpha.1.20260916.1` |
| `0.1.6-rc.3` | `0.1.6-rc.3` | `0.1.6-rc.3.20260916.1` |
| `0.1.6` | `0.1.6` | `0.1.6-test.20260916.1` |

- production **用与 dsh 完全相同的版本号**（含 alpha/beta/rc 标识）
- SemVer 排序：`0.1.6-alpha.1 < 0.1.6-alpha.1.20260916.1 < 0.1.6-alpha.2`
- **客户端只接受更高版本**（与我们 `allowDowngrade=false` 一致）
- test 分发的 `--build-version auto` 读**已发布对象**推导当天序号，**绝不复用已发布版本**

---

## 二、可借鉴项（按性价比排序）

| # | 官方做法 | 我们的现状 | 建议 |
|---|---|---|---|
| **1** | **更新检查带抖动与退避**：基础间隔 10 分钟，每次 **±20% 随机抖动**；失败**基础延迟翻倍**，上限 1 小时，成功重置 | 固定 6h，无抖动无退避 | ⭐ **建议采纳**（防服务端雪崩；我们用户量小但机制便宜） |
| **2** | **HTTP 逐连接空闲超时**（默认 60s 未收到响应头/后续字节则失败），但**活跃下载没有总时长限制** | 单源检查 15s 截止；下载 30s 无进度视为失败 + **总时限 10 分钟** | ⭐ **值得复核**：官方"活跃下载不限总时长"对大包更友好；我们的 10 分钟总时限可能误杀慢速下载 |
| **3** | **`publisherName` 绑定**：从签名证书的 CN/O/C 生成，写入已安装应用的 `app-update.yml`；**下载的清单不能选择该身份** | 未签名（该机制不生效） | ⭐ **安全记录项**：见 §四 |
| **4** | **产物可溯源**：所有清单记录 `dshBuildCommit` 与 `dshBuildDirty`；production 上传后打 `desktop-v<版本>` 标签，**来自有改动工作区的构建不打标签** | 无 | 建议采纳（release.mjs 里加两个字段，成本极低） |
| **5** | **test / prod 完全分离**：不同 origin、不同 COS 凭据（`DOWNLOAD_TEST_*` / `DOWNLOAD_PROD_*`） | 只有一套 | 建议：至少把"测试发布"与"正式发布"的 COS 前缀分开 |
| **6** | **目标构建隔离**：每个目标在 `targets/<target>/` 持有独立输入与状态，**绝不读其他目标的可变状态** | 单平台，暂无需求 | 知道即可 |
| **7** | **状态归属隔离**：Electron 取进程单实例锁并**独占 `$DSH_HOME/profiles/desktop` 及包管理器状态**；CLI 与 Desktop **共享会话/设置/凭据/工作区**，但**绝不共享**可执行包、插件激活、锁文件、`node_modules` | 我们与 CLI 共用同一套 npx 缓存与 npm 缓存 | ⭐ **风险项**：若用户同时用 CLI，可能互相改坏依赖（见 §四） |

---

## 三、官方级复杂度（知道即可，**不建议照搬**）

| 模块 | 官方做法 | 为什么我们不做 |
|---|---|---|
| **强制更新（mandatory）** | 独立的策略 API（`/api/v0/check_client_update`）；`origin`/`allowedPageOrigins`/`authentication` 策略字段；飞书鉴权（test）/匿名（prod）；`40005` 触发阻塞式蒙层；**两次用户批准**才安装；Windows 用隔离 preload 在主窗口内挂 frame（不建新原生窗口） | 需要服务端策略服务 + 鉴权体系，远超"壳"的范围 |
| **Windows 签名** | **EV 证书 + SafeNet USB Token**；自定义 `windows-sign.cmd`（含 `/kc` 容器与 PIN）；**不用 electron-builder 内置 SignTool**；隔离副本上做 DigiCert RFC 3161 时间戳；**签名缓存**（跨 worktree 复用，上限 1 GiB）；**尝试锁** `attempt.json`（PIN 输错 5 次锁 Token、立即停止不重试）；**预检**（C# 编译探针签名一次验证，探针绝不执行） | 需采购 EV 证书 + 硬件 Token；我们已决定不签名 |
| **macOS 公证** | `CSC_LINK` 必须是**本地 p12**（不支持 URL/Base64）+ 临时私人钥匙串 + **并行公证**（App 一路、DMG 一路，两路都成功才落地） | 无 macOS 发布目标 |
| **内置运行时** | 携带独立的 **Python（numpy/pandas/python-docx/pptx/openpyxl/Pillow/lxml/XlsxWriter）+ Node + pnpm**；`runtime.json` 记录版本与锁定哈希；首次使用**离线安装**到 `$DSH_HOME/dsh-runtimes/dsh-primary-runtime` | 见 §四：这是与我们的**根本架构差异** |
| **崩溃上报 / 更新日志 / 后台提醒** | `crash-report.ts` / `update-journal.ts` / `update-attention.ts`（任务栏闪烁、Dock 弹跳、无声通知） | 可选增强，非必需 |

---

## 四、暴露出的架构差异（需要你判断）

### 差异 1 · 运行时：官方**内置**，我们**依赖系统 Node**（根本差异）

官方做法（两处并存）：
- **携带独立 Node 分发包**：`resources/runtime/primary-runtime/dependencies/node/bin/`
- **用 Electron 自身跑 dsh**：`ELECTRON_RUN_AS_NODE=1` + `--expose-internals`
- dsh 资源在 `resources/app.asar/dsh/`，**含完整生产依赖树**；`desktop-runtime.json` 绑定
  shell 版本 + Electron Node 版本 + 平台 + 架构 + 文件哈希

我们的做法：定位**用户系统的 Node ≥22** + `npx`（SPEC §6 的刻意设计）。

⚠️ **注意一处矛盾**：SPEC §6 写着"**禁止把 `process.execPath` 当作 Node**；`ELECTRON_RUN_AS_NODE` 非可靠开关"，
而**官方正是用 `ELECTRON_RUN_AS_NODE=1` 跑 dsh**。这不代表我们错了（官方同时带了独立 Node 二进制，
且我们当初选择"外部 Node"是为了避免打包运行时），但**值得作为已知偏离登记**。

**判断**：改成内置运行时的收益是"用户免装 Node"，代价是包体积暴涨（Python + Node + pnpm + 完整依赖树，
估计 +200~400 MB）与全套准备脚本。**建议维持现状**（我们的定位是轻壳），但要知道差距在哪。

### 差异 2 · 通信层：官方**不用本地 Web 端口**

官方：`dsh://` 协议 + `dsh-app://` 加载界面 + **分帧数据管道**（有 `ws` 依赖）+ **Node IPC** 管理后台进程。
> "少了端口占用，也减少了本地服务暴露、鉴权和跨域带来的麻烦。"

我们：起 `dsh web` → 连 `127.0.0.1:3080` → stdout 就绪行取端口/token → token 换 cookie。

**我们的 §11.1 那 8 条偏差，几乎全部源于走"web 模式"这条路径**（health 不存在、DSH_PORT 无效、
就绪信号在 stdout、需要 token→cookie……）。

**判断**：改成分帧管道 = 重写整个 host 通信层，且我们依赖的上游公开 CLI 是 `dsh web`。
**建议维持**，但**这是我们"复杂度最高、最脆弱"的一层**——这是选择 web 模式的固有代价。

### 差异 3 · ⚠️ 未签名带来的真实安全代价

官方机制：**`publisherName` 从证书生成并写入 `app-update.yml`；下载的清单不能选择该身份** ——
即"更新包必须由同一发布者签名"，防伪装与防降级。

我们：不签名 ⇒ `verifySignature` 返回 null（不校验）⇒ **更新链路的完整性只剩 HTTPS + sha512 保护**。
而 sha512 写在 `latest.yml` / `cn-stable.yml` 里 —— **若元数据文件被替换，哈希校验形同虚设**。

**风险量化**：需要能篡改 GitHub/COS 的 HTTPS 响应（中间人 / 被攻陷的 CDN / 企业代理）。
不是高危，但**与我们"已签名更新单元"的官方口径有实质差距** ——
这正是"未签名构建仍属预发布性质"那条备注的意义。

**判断**：自用/小范围分发可接受；**正式公开分发前建议补签名**（与你已做的决定一致）。

### 差异 4 · 依赖隔离

官方：CLI 与 Desktop **共享** `$DSH_HOME` 下的会话/设置/凭据/工作区，但**绝不共享**可执行包、
插件激活、锁文件、`node_modules`（Desktop 独占 `profiles/desktop`）。

我们：完全共用同一套 npx / npm 缓存。

**判断**：如果用户同时用 `npx dsh` 命令行与我们的壳，**存在互相改坏依赖的风险**。
建议至少在 README 里提示"本壳使用共享的 npm 缓存目录"。

---

## 五、结论与建议

**结论**：我们的架构方向与官方一致（固定版本 + 整体更新 + 差分传输），
差异集中在"**重量级**"（内置运行时、签名、强制更新）与"**通信层**"（web 端口 vs 分帧管道）两处，
二者都是**当初方案的刻意取舍**，不是实现缺陷。

**建议动作（按优先级）**：

1. ⭐ **把官方三条策略原文登记进 §11.1**（版本绑定铁律 / 更新单元整体 / 运行时版本不脱离发布）
   —— 给未来的人一个权威依据，以后有人问"为什么固定版本"直接引这条
2. ⭐ **采纳更新检查的抖动 + 退避**（官方：10min ±20%、失败翻倍上限 1h）
3. ⭐ **复核下载总时限**（官方"活跃下载不限总时长"，我们 10 分钟可能误杀慢速下载）
4. **产物清单加 `dshBuildCommit` / `dshBuildDirty`**（可溯源）
5. **登记两处架构偏离**：外部 Node（vs 内置运行时）、web 端口（vs 分帧管道）—— 写进 §11.1
6. **补一条防倒退断言**：`disableDifferentialDownload` 不得为 true；release 必须带 blockmap
7. **README 提示**：本壳与 CLI 共用 npm 缓存目录（依赖隔离差异）
