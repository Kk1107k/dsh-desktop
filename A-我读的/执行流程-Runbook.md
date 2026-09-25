# DSH Desktop · 实际操作 Runbook

> 照着本文件从上往下执行即可。每一步都写死了四件事：

> 说明：本文档中的文件路径均相对项目根 `dsh-desktop/` 书写。
> **喂什么文件 → 投给谁 → 用哪个模型 → 思考强度开几档**，外加产出物和验收点。
>
> 前置阅读：`README.md`（项目与免责声明）、`B-AI共享/INTERFACE.md`（接口契约，含 D1–D5 待决项）。

---

## 总览

| 步 | 阶段 | 投给谁 | 模型 | 思考强度 | 预算 |
|---|---|---|---|---|---|
| 0 | 本地准备 | — | — | — | 0 |
| 1 | P0 架构 Spec | **国际版 GPT** | GPT-6 系列 | **high（最高）** | 60 积分 |
| 2 | P1 批量出码 | **国内版 Agent** | GLM 5.3 / 5.2（以列表为准） | **medium（关深度思考）** | ~600 积分 |
| 3 | P2.1/2.2 更新链路初稿 | **国内版 Agent** | GLM 系列 / DeepSeek | **medium** | ~150 积分 |
| 4 | P2.1/2.2 落地 | **Claude Code** | DeepSeek V4.1 | **high**（M08）/ **medium**（M11） | API ¥ |
| 5 | P2.3 跑通 dev | **Claude Code** | GLM-5.3 | **xhigh（滑块显示 Extra）** | API ¥ |
| 6 | P2.4 修编译错 | **Claude Code** | DeepSeek V4.1 | **medium** | API ¥ |
| 6b | P2.5 卡壳攻坚 | **Claude Code** | 两模型轮流 | **max** | API ¥ |
| 7 | P3 最终审计 | **本地执行**（见第 7 步） | Claude Code + GLM-5.3 / 我 | **xhigh** | **0 积分** |
| 8 | P4 文档收尾 | **国内版 Agent** | 任选国产 | **low / 关思考** | ~100 积分 |
| 9 | 发布 | GitHub Actions | — | — | — |

**预算实际（2026-09-24 更新）**
- 国际版：**440 → 已用光**（P0 那条消息单条扣 ~59，且失败也扣，重试两次即烧掉大半）
- 国内版：3000，按上表约耗 850，**余量充足**
- Claude Code：API 计费 ¥18~45
- **P3 改由本地执行（0 积分）**，所以后续流程不再依赖国际版额度

> ⚠️ 血的教训：国际版是**按消息条数**计费，不是按字数。一条大消息 ≈ 59 积分，
> 而每重发一次就再扣一遍。所以：一次发全、关掉用不到的技能、禁止联网/工具/子代理。

---

## 第 0 步 · 本地准备（0 积分）

```bash
cd dsh-desktop
git init && git add . && git commit -m "chore: 交付素材与契约（页面/图标/prompt/INTERFACE）"
```

检查必备文件齐全：`README.md`、`B-AI共享/INTERFACE.md`、`A-我读的/方案-DeepSeekHarness-Desktop.md`、
`src/splash.html`、`src/update-dialog.html`、`assets/whale.svg`、`assets/icon.ico`、`C-每一步投喂/` 下各步骤目录里的 prompt 文件。

> ⚠ 必须 git 化：三个 AI 没有共享上下文，**仓库里的文件就是唯一共享内存**。

---

## 第 1 步 · P0 架构 Spec（国际版 GPT · 60 积分）

| 项 | 内容 |
|---|---|
| **投喂** | `C-每一步投喂/step1-架构spec-国际版/prompt-A-国际版-架构spec.md` 全文 + `README.md` + `B-AI共享/INTERFACE.md` |
| **模型** | 国际版 GPT-6 系列 |
| **思考强度** | **high（最高档）** —— 一次想错后面全废，这 60 积分是全案最值的一笔 |
| **产出** | 单文件 `B-AI共享/SPEC.md`（200~400 行，12 节） |
| **验收点** | SPEC 里必须对 **D1–D5** 给出明确选择（不是"可以考虑"）：<br>① preload 命名空间（A 统一 dshApi / B 两个命名空间）<br>② splash 关闭时序（min-display 数值 + finish 语义 + 超时秒数）<br>③ snooze 24h 的存储结构与判定<br>④ 版本号来源<br>⑤ 产物路径 dist/ |
| **不合格** | 让它补写对应章节，**不要自己替它决定**，也不要开新会话（会丢上下文） |

> 完成后把 `B-AI共享/SPEC.md` 落盘并 `git commit`。**Spec 冻结后禁止中途改**。

---

## 第 2 步 · P1 批量出码（国内版 Agent · ~600 积分）

| 项 | 内容 |
|---|---|
| **投喂** | `C-每一步投喂/step2-批量实现-国内版/prompt-B-国内版-批量实现.md` + **完整 SPEC.md**（粘在 prompt 的"附：SPEC.md"处） |
| **模型** | 国内版 · **GLM 最新可用版**（列表里有 5.3 就用 5.3，否则 5.2 / Qwen-Max / DeepSeek） |
| **思考强度** | **medium，关掉深度思考** —— 按图纸砌砖不需要深推理，关掉能省近一半时间和积分 |
| **产出** | M01 / M02 / M04 / M05 / M06 / M07 / M09 / M10 / M12 共 9 个模块 |
| **执行要点** | **一次性粘完，不要分次**（分次会丢模块间一致性） |
| **验收点** | 逐文件 diff 落盘；`package.json` 里 `"type": "module"`；IPC channel 全部集中在 `src/ipc.js`；**splash.html 与 update-dialog.html 没被改写**（它们是"不要动"的） |

---

## 第 3 步 · P2.1/2.2 更新链路初稿（国内版 Agent · ~150 积分）

| 项 | 内容 |
|---|---|
| **投喂** | SPEC.md 第 7 节（双通道状态机）+ 第 11 节（打包发布）+ `B-AI共享/INTERFACE.md` §6 |
| **模型** | GLM 系列或 DeepSeek（以国内版列表为准） |
| **思考强度** | **medium** |
| **产出** | `src/updater.js`（M08）与 `.github/workflows/release.yml`（M11）初稿 |
| **验收点** | 失败判定正则 `/timeout\|ETIMEDOUT\|ENOTFOUND\|cloudflare\|404/i` 在位；COS 同步步骤指向 `dist/` |

---

## 第 4 步 · P2.1/2.2 落地（Claude Code + DeepSeek V4.1）

```bash
claude                 # 或 claude --effort high
/effort high           # 落地 updater.js（逻辑密度中上）
```

- 落地 M08（autoUpdater 双通道）：**high**
- 落地 M11（release.yml，纯 YAML 配置）：**medium**

> 每修完一处 `git commit -m "fix: ..."`，让它回报一行 `git log -1 --oneline`。

---

## 第 5 步 · P2.3 跑通 dev（Claude Code + GLM-5.3 · xhigh）

| 项 | 内容 |
|---|---|
| **投喂** | `C-每一步投喂/step4-落地跑通修错-ClaudeCode/prompt-C-ClaudeCode-执行调试.md` |
| **模型** | **GLM-5.3**（长上下文，能一次吃下全部代码） |
| **思考强度** | **xhigh**（滑块上显示为 **Extra**，不是最高档，最高是右边的 Max） |
| **动作** | `pnpm install` → `npx tsc --noEmit` → `pnpm dev` |
| **验收点** | splash 出现 → 主窗口接管 127.0.0.1:3080 → **托盘出现黑色鲸鱼图标** |

设置方式：`/effort xhigh` 或 `claude --effort xhigh`。

---

## 第 6 步 · P2.4 修编译错迭代（Claude Code + DeepSeek V4.1 · medium）

| 项 | 内容 |
|---|---|
| **模型** | **DeepSeek V4.1**（高频短迭代最划算） |
| **思考强度** | **medium** ⭐ —— 这步要跑几十轮，**降档是最省钱的一步** |
| **动作** | 报错 → 改 → 再报错 的循环，直到 `pnpm dev` 与 `electron-builder --dir` 全绿 |
| **验收点** | 打包产物出现；体积 < 130MB；NSIS 装/卸/启动正常 |

> 💰 这一步若交给国内版积分，会烧掉 1000~1600 积分；交给 Claude Code 走 API 只花几十元。
> **这是整个方案省下最多钱的一步。**

### 6b · 卡壳时（同一问题 2 轮未解）

换模型重述问题（DS V4.1 ⇄ GLM-5.3），思考强度开到 **max**。
两个模型的错误模式不同，交叉验证命中率明显更高。
`max` 与 `Ultracode` **仅当前会话有效**；low/medium/high/xhigh 会跨会话保留。

---

## 第 7 步 · P3 最终审计（**本地执行 · 0 积分**）

> **2026-09-24 改方案**：国际版 440 积分已在 P0 用光（单条 ~59，失败也扣），
> 所以 P3 不再投喂国际版。这不影响质量 —— 审计是"照 SPEC §12 的 A01~A10 清单逐条核对代码"，
> **能直接读代码、跑 grep、看 git 的执行方比对话式模型更可靠**。

| 项 | 内容 |
|---|---|
| **谁来做** | 我（WorkBuddy）或 **Claude Code + GLM-5.3**（xhigh） |
| **输入** | `B-AI共享/SPEC.md` §12 的 A01~A10 + `B-AI共享/INTERFACE.md` + 仓库代码 |
| **产出** | `A-我读的/AUDIT.md`（问题清单 + 修复优先级，每条标注"通过 / 需修 + 原因"） |
| **重点审** | 双通道降级、托盘菜单无死链、IPC 白名单未暴露 Node 全局、host 崩溃与重启预算、单实例锁、关窗到托盘路径 |
| **必审** | **契约一致性**：preload 暴露的命名空间必须与 `B-AI共享/INTERFACE.md` §1 页面实际调用的**完全对得上**（含新增的 `snooze()`） |
| **可复用资产** | `C-每一步投喂/step5-最终审计-国际版/prompt-D-国际版-最终审计.md` 的审计清单仍可当 checklist 用（不投喂给 GPT，本地照着查） |
| **若想二审** | 等充值 / 开 Pro 试用（$0 起 + 500 积分，第 6 天前取消）后再用 GPT-6 复跑一次 |

---

## 第 8 步 · P4 文档收尾（国内版 · ~100 积分）

| 项 | 内容 |
|---|---|
| **模型** | 国产任选 |
| **思考强度** | **low / 关思考**（纯体力活） |
| **产出** | README 补齐截图与下载链接、`CHANGELOG.md`、`src/about.html` |
| **硬要求** | README 必须保留**非官方外壳 + 商标免责声明**（不得删改） |

---

## 第 9 步 · 发布（GitHub Actions）

```bash
git tag v0.1.0 && git push --tags      # 触发 release workflow
```

产物在 `dist/`：`DSH Desktop-Setup-<version>.exe`
→ 上传 GitHub Releases → 同步腾讯云 COS `ap-shanghai`（路径见 `B-AI共享/INTERFACE.md` §6）。

> ⚠ 国内分发别跳：GitHub 在你网络里大概率拉不动，**失败 = 用户永远卡在旧版本**。

---

## 速查：Claude Code 五档

| 档位 | 滑块显示 | 用在哪 |
|---|---|---|
| low | Low | 样板代码、格式化 |
| medium | Medium | **修编译错主力档（省钱）**、日常迭代 |
| high | High（默认） | 复杂实现（M08 updater） |
| xhigh | **Extra** | 通读全项目、反复调工具（P2.3） |
| max | Max | 卡壳攻坚（6b） |

> 两个坑：① **"Extra" = xhigh，不是最高档**；② `ultrathink` 只影响当前一轮，
> **"think" / "think hard" 已被当作普通文本，不起作用**。

---

# 项目状态：已发布完成（2026-09-25 归档）

第 0~9 步全部走完，`v0.1.7-rc.2` 已发布，项目进入**维护态**。

| 项 | 状态 |
|---|---|
| GitHub Release | ✅ `v0.1.7-rc.2`（4 个产物） |
| COS 国内备源 | ✅ `cn-stable.yml` 已同步 |
| 装包实测 | ✅ 下载 → 装 → 启动 → 托盘，全通 |
| 卸载实测 | ✅ NSIS 卸载器，目录清空 |
| 代码层 | ✅ P0 = 0 / P1 = 0，70 条回归全绿 |

- 完整总结、错误盘点、经验 → **`A-我读的/项目总结报告.md`**
- 新终端接手 → **`C-每一步投喂/step4-落地跑通修错-ClaudeCode/接续上下文-维护态.md`**
- 已知限制与后续建议 → 总结报告 §六
