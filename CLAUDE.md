# CLAUDE.md

> Claude Code 启动时会自动加载本文件（官方规则：从当前工作目录**向上逐级遍历**每一级的 CLAUDE.md）。
> 所以**在项目根目录 `dsh-desktop/` 启动 Claude Code 即可**，不需要 cd 到 `B-AI共享/`。

## 项目是什么

给 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）做的
**独立 Electron 桌面壳**（不 fork 上游）：主进程 spawn `npx @deepseek-ai/dsh web`，
主界面承载 `127.0.0.1:3080` 的 Web UI，外加开机美化页、自动检查更新、常驻托盘。

## 开工前必读（按顺序）

1. `B-AI共享/INTERFACE.md` —— **渲染层接口契约**：页面端真实调用的 `splashAPI` / `updateAPI`
   方法清单与状态枚举，以及 D1–D5 待决项。**接口名对不上会静默失效**（状态不动、弹窗不出），
   这是本项目最难查的一类 bug。
2. `B-AI共享/SPEC.md` —— 架构 Spec（若 step1 已产出）。**冻结后不得中途改**；
   若与 INTERFACE.md 冲突，以 SPEC 的决策为准，但必须在产出说明里明示差异。
3. `README.md` —— 项目说明与目录结构。

## 硬性约束（不要违反）

- **不要手改 `src/splash.html` / `src/update-dialog.html`** —— 它们是生成产物。
  要改就改 `tools/gen_splash.py` / `tools/gen_update_dialog.py` 后重跑：
  ```bash
  python tools/gen_splash.py && python tools/gen_update_dialog.py
  ```
- **不要擅自改接口名** —— preload 暴露的命名空间必须与 `B-AI共享/INTERFACE.md` §1 完全一致。
  需要改命名时，先改契约再同步改页面与生成器。
- **Electron ≥ 36**（必须内置 Node 22；Electron 28 内置 Node 18，会让 Node 20+ API 直接崩）。
- **Windows only**，只出 NSIS 安装包，不要加 macOS 配置。
- 包管理器用 **pnpm**（不是 npm）；JS 用 **ESM + JSDoc**，不要 TS、不要 `any`。
- 图标是 **DeepSeek 黑色鲸鱼**（`assets/whale.svg` 是唯一矢量源），
  重建图标：`python tools/gen_whale_icons.py`（依赖本机 Chrome/Edge 光栅化 SVG）。
  ⚠ 不要用 Pillow 的多边形填充自己画——它不懂 nonzero 填充规则，会把鲸鱼身
  上的镂空涂黑、糊成圆团。
- **发布产物路径统一 `dist/`**（不是 `assets/release/`）。
- `README.md` 里的**非官方外壳 + 商标免责声明段落不得删改**。

## 目录

```
A-我读的/        人看的：方案、Runbook、AUDIT.md
B-AI共享/        每份 AI 都要带：INTERFACE.md、SPEC.md
C-每一步投喂/    step0…step6，每步的 prompt 与投喂说明
assets/ src/ tools/
```

## 调试技巧

- 浏览器打开 `src/splash.html?t=1.5` 可定格品牌字书写动画到 1.5 秒那一刻（`?t=99` = 写完）。
- 无头浏览器不会推进 rAF/CSS 动画（读到的是起始值），这是环境假象，不是 bug；
  验证要用 `?t=` 定格，或读取 class / 绑定状态而非动画推进值。
