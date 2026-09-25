# DSH Desktop

给 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）做一个
**独立的 Electron 桌面壳**：开机美化、自动检查更新、常驻托盘。

> 状态：**素材与契约阶段**（页面 + 图标 + 方案已就绪，Electron 骨架待 Phase 1/2 产出）。
> 开工前请先读 [`B-AI共享/INTERFACE.md`](B-AI共享/INTERFACE.md)（渲染层接口契约，含 2 个待决项）。

---

## 免责声明（重要，分发前不得删改）

- 本项目是**独立的非官方外壳**，与 DeepSeek（杭州深度求索人工智能基础技术研究有限公司）
  **无任何隶属、合作或背书关系**。
- 项目中出现的 **"DeepSeek" 名称与鲸鱼标识均为 DeepSeek 的商标**。上游 `deepseek-harness`
  仓库以 MIT 许可证开源，但 **MIT 只覆盖代码，不覆盖商标**。
- 本壳仅在"确实作为 DeepSeek Harness 前端使用"的场景下复用该标识；若包装成其他产品，
  **必须替换图标与产品名**。
- 使用本软件产生的任何风险与责任由使用者自行承担。

---

## 目录说明

```
dsh-desktop/
├─ assets/              图标与字体资源
│  ├─ whale.svg         图标唯一矢量源（与 dsh 官方 favicon 逐字节一致）
│  ├─ icon.ico          应用主图标（9 帧 16→256）
│  ├─ tray*.ico/.png    托盘图标（常态 / 有更新琥珀 / 运行中绿色）
│  ├─ logo-*.png        各尺寸 PNG
│  └─ fonts/
│     ├─ shelley-allegro.woff2   品牌花体字（仅 update-dialog 使用）
│     └─ _archive/               选字体阶段的候选字体 + 对比页（已归档）
├─ src/
│  ├─ splash.html          开机美化页（鲸鱼 + 品牌字逐线条书写动画）
│  └─ update-dialog.html   自动更新弹窗（5 态状态机）
├─ A-我读的/            ★ 凯哥本人阅读：方案 / Runbook / 审计结论
│  ├─ 执行流程-Runbook.md           ← 实际操作时照这份走
│  ├─ 方案-DeepSeekHarness-Desktop.md
│  ├─ 方案-B-补充实施要点.md
│  └─ AUDIT.md（step5 产出位）
├─ B-AI共享/            ★ 每份 AI 都要带的公共上下文
│  ├─ INTERFACE.md                  接口契约（含 D1–D5 待决项）
│  └─ SPEC.md                       step1 产出位（唯一真相源）
├─ C-每一步投喂/        ★ 按执行顺序，一个目录 = 一步
│  ├─ step0-本地准备/
│  ├─ step1-架构spec-国际版/         国际版 GPT-6 · high
│  ├─ step2-批量实现-国内版/         国内版 GLM（5.3/5.2）· medium
│  ├─ step3-更新链路初稿-国内版/     国内版 · medium
│  ├─ step4-落地跑通修错-ClaudeCode/ GLM-5.3 xhigh → DS V4.1 medium
│  ├─ step5-最终审计-国际版/         国际版 GPT-6 · high
│  └─ step6-文档收尾与发布-国内版/    国内版 · low
└─ tools/               可复现生成器（改生成器后重跑，不要手改 src/*.html）
```

### 三类文件夹的分工

| 文件夹 | 放什么 | 给谁 |
|---|---|---|
| `A-我读的/` | 方案、执行手册、审计结论 | **人**（投喂 AI 时不要整篇粘，白费积分） |
| `B-AI共享/` | 接口契约、架构 Spec | **每一份 AI 都要带**（短、硬、不引发歧义） |
| `C-每一步投喂/` | prompt + 该步投喂清单 | 按步骤取用，含模型与思考强度 |

## 重新生成资源

```bash
python tools/gen_whale_icons.py     # 全部图标（依赖本机 Chrome/Edge 光栅化 SVG）
python tools/gen_splash.py          # src/splash.html
python tools/gen_update_dialog.py   # src/update-dialog.html
```

调试技巧：在浏览器打开 `src/splash.html?t=1.5` 可定格书写动画到 1.5 秒那一刻
（`?t=99` = 直接看写完状态）。

## 环境要求

Node ≥ 22（系统级、外部可见，供壳查找 `npx-cli.js`）、pnpm ≥ 9、**Electron ≥ 36**（内置 Node 22）。
Windows 10/11 x64；全局缓存目录需可读写以访问 `@deepseek-ai/dsh@0.1.7-alpha.2`。

## 安装与开发

```bash
git clone <repo>
cd dsh-desktop
pnpm install          # 必须用 pnpm，不要 npm install
pnpm build:preload    # 重新生成 build/preload.cjs
pnpm dev
```

`build` 顺序固定：`build:preload → typecheck → test → electron-builder --win nsis --x64 --publish never`，
全部发布产物进入 `dist/`。

> ⚠ **国内网络打包前必须设镜像环境变量**：`electron-builder` 要下载它自己的构建二进制
> （winCodeSign / NSIS / 7zip），默认走 GitHub，国内会 `connect ETIMEDOUT 20.205.243.166:443`。
> 注意 `.npmrc` 里的 `electron_builder_binaries_mirror` **electron-builder 不读**，只认同名环境变量：
>
> ```bash
> # Git Bash
> ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ pnpm build
> ```
> ```powershell
> # PowerShell
> $env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"; pnpm build
> ```
> 境外网络可不设（走官方源）。

## 双通道更新

- 主源：GitHub Releases（`stable`）
- 备源：腾讯云 COS（`cn-stable`，国内网络降级使用）
- 开发态不执行真实更新，手动检查返回 `E_UNPACKAGED`

## 已知待决项

开工前必读 `B-AI共享/INTERFACE.md`（Claude Code 会通过根目录 `CLAUDE.md` 自动加载到这两份共享文件）。

见 `B-AI共享/INTERFACE.md`：D1 preload 命名空间、D2 splash 关闭时序、D3 更新"稍后"延后 24h。
这三项由 Phase 0 的架构 Spec 拍板。
