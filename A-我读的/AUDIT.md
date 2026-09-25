# AUDIT.md · DSH Desktop 终审（P3）

| 项 | 内容 |
|---|---|
| 审计基线 | `B-AI共享/SPEC.md`（12 节 / 376 行）+ `B-AI共享/INTERFACE.md` |
| 对照清单 | SPEC §12 的 **A01~A10** 十条可执行断言 |
| 审计方式 | 逐条读代码取证 + 独立复跑测试（`node --test`，36 用例）+ 交叉核 §11.1 实测记录 |
| 审计日期 | 2026-09-25 |

> **结论摘要**：A01~A09 代码层**通过**；A10 代码层通过、**真机发布未验**；发现 **1 个必修项（P1，属 SPEC D3 违约）—— 已于同日修复并经独立复核**（commit `9a8dcf2`）。
> 当前代码层面**无未决必修项**；剩余均为"需真机 / 需发布环境"的验证（见 §三）。
> 审计前测试状态：**36/36 通过**（本机独立复跑为 35/36，那条失败已证明是审计环境假象，见文末）。

---

## 一、逐条核对

| 编号 | SPEC §12 断言 | 证据 | 判定 |
|---|---|---|---|
| **A01** 单例与启动 | 两实例 → 只有一个受控 host、第二实例退出；finish 不早于 2400ms；关闭不早于淡出 300ms | `main.js` 常量 `SPEC_MIN_SPLASH_MS=2400` / `SPEC_FADE_MS=300`；`app.requestSingleInstanceLock()`；`attemptFinish()` 门控 + `onSplashFinishConfirm()` 等 300ms 再 destroy；用例「A01 splash 展示门控常量」「A01 未取得单例锁的第二实例立即 app.quit()」。真机：splash 展示 4.1s、finish→close 303/309/313/316ms | ✅ 通过 |
| **A02** 启动失败与取消 | 15s 不就绪 → 超时文案 + 重试/退出；提前关 splash → 退出；两条路径无遗留 host/探测器/定时器 | host 15s 就绪截止 → `promptRetryOrExit`（原生对话框，默认退出）；`onSplashCloseBeforeFinish` → 取消路径；`cleanupAndQuit()` 清 `finishTimer`/`gateTimer` + `updater.dispose()` + `host.stop()` + `host.stopped()`；用例 3 条（端口占用 / 15s 超时 / 启动期崩溃不自动重启） | ✅ 通过 |
| **A03** 健康与崩溃恢复 | 六次故障 → 恰好五次自动重启，退避 1/2/4/8/8；第六次弹窗停止 | 退避序列 `[1000,2000,4000,8000,8000]`；第 6 次 → `fatal` → 停止自动重试；稳定 5 分钟清零重启预算；用例「A03 退避序列」「A03 连续六次故障」 | ✅ 通过（真机未造故障） |
| **A04** 主源更新与最新 | 有新版 → available 且不自动下载；无新版 → 不新建弹窗 + 托盘 5s 文字 | `autoDownload:false` / `autoInstallOnAppQuit:false`；`latest` → `onTraySetText('已检查更新', 5000)`；用例 2 条 | ✅ 通过 |
| **A05** 双源降级 | GitHub 超时/404/证书错误 + COS 合法 → 真实转向 COS 且不降版本；两源失败 → 手动下载入口 | `NETWORK_FAIL_RE` 命中 → 切换**实际 provider 实例**（非仅改 channel）；`allowDowngrade:false`；两源失败 → `setPageState('error')` + `onUpdateOpen()`（手动下载入口）；用例 2 条 | ✅ 通过（真实 CDN 未验） |
| **A06** 延后持久化 | `until=T+86400000`；24h 前不检查；到期触发；手动检查仍有效；**写盘失败不得关闭为成功状态** | updater 层：`persistSnooze` 失败返回 `E_IO`、`snooze()` 不伪装成功；automatic 路径受 `until` 抑制、`manual` 绕过；用例 2 条。**页面层：❌ 见 §二 P1-1** | ⚠️ **需修** |
| **A07** IPC 与版本 | host 窗口/子 frame/未知 URL 调用 → 拒绝且无副作用；改包版本后 splash 与更新页版本同步；签名保持契约 | `ipc.js` `authorize()`：`frame !== wc.mainFrame` 或 URL 不在角色白名单 → `E_FORBIDDEN`；10 个 channel 名与契约一致；`preload` 从 `--dsh-version` 读、页面不写死版本；about 页改为协议响应期替换；用例 4 条 | ✅ 通过 |
| **A08** 下载与安装 | 下载中主源失败 → 仅 COS 版本/哈希/大小一致时续接；校验/签名失败不安装；成功先回收 host 再安装重启 | 续接前比对 `version` / `sha512` / `size`，不一致 → `E_MIRROR_MISMATCH`；完整性错误不换源绕过；成功路径 `await onHostStopBeforeInstall()` → `quitAndInstall()`；用例 3 条 | ✅ 通过（真实下载未验） |
| **A09** 托盘与真实退出 | X + 托盘可用 → 隐藏、服务存活、六项顺序正确；退出且 host 忽略 shutdown → 3s 后强制回收进程树且不重启 | 菜单六项 + 顺序；`taskkill /PID /T /F` + 不触发重启；托盘图标按模块位置解析（不再依赖 cwd）；窗口 `close` 拦截 → `hide()`；托盘唤回含重建与最小化还原；用例 6 条 + 真机（托盘唤回 ✓、退出后 3080 释放 ✓） | ✅ 通过 |
| **A10** 安装与发布一致性 | 合法 tag 发布 → NSIS 可选目录、按当前用户安装；`dist/` 命名符合 D5；GitHub/COS 二进制哈希相同；COS 元数据最后发布且实际下载成功 | `electron-builder.yml`（NSIS 可选目录、`output: dist`、归档素材排除、双源占位）；`release.yml` 顺序 = 构建 → GitHub Releases → `release.mjs`；`release.mjs` 只改路径不改哈希、缺凭据非零退出；用例 5 条 | ⚠️ **代码层通过，真机发布未验** |

---

## 二、需修项

### P1-1 · 「稍后」未检查 snooze 结果即关窗 —— 违反 SPEC D3

**位置**：`tools/gen_update_dialog.py:200-203`（生成物 `src/update-dialog.html:150-153`）

```js
btnS.addEventListener('click', function () {
  if (state === 'available' && api && api.snooze) api.snooze();   // 不 await、不看返回值
  if (api && api.close) api.close();                              // 无条件关闭
});
```

**问题**：`updateAPI.snooze()` 是异步且返回 `Result`（写盘失败时 `ok:false, error.code='E_IO'`）。
页面既不等待也不检查结果，**立即关窗** —— 于是"写盘失败"与"延后成功"在用户侧**无法区分**，
正是 D3 明确禁止的"伪装为已延后"。副作用：用户以为已延后 24h，实际 `until` 未落盘，24h 内仍会被提醒。

**取证**：`grep -c "await|res.ok|\.ok" src/update-dialog.html` → **0**。
updater 层的 `E_IO` 分支是对的（`updater.js:318`），缺口只在页面侧。

**修法**（改生成器，不手改页面）：
1. 处理函数改 `async`，`await api.snooze()` 后**仅在 `res.ok === true` 时** `close()`
2. 失败（`E_IO` 等）→ **不关窗**，在按钮文案或状态区给出可感知提示（如"延后失败，请重试"），让用户可重试
3. 找不到 `snooze` 时：不能假装已延后 —— 保持现有"直接关闭"语义并在注释说明理由
4. 改完重跑 `python tools/gen_update_dialog.py`
5. 补一条**源码级契约断言**（沿用已 A07「页面不写死版本号」的先例）：
   断言 `src/update-dialog.html` 中「稍后」处理函数引用了 `snooze()` 的返回值并据此决定是否 `close()`

**责任说明**：该缺口由 P2 阶段（本审计方）落地 D3 到生成器时引入 ——
当时只实现了"先 snooze 再 close"的顺序，未处理异步结果，且 mock 用例只覆盖了 updater 层，
故 36/36 全绿也没能发现。**这也是"mock 通过 ≠ 页面行为通过"的又一实例。**

**✅ 修复状态（2026-09-25 · commit `9a8dcf2`）**

修法与上列要求一致，已独立复核：

| 复核项 | 结果 |
|---|---|
| 处理函数 | 改为 `async`；`await api.snooze()` 后**仅 `res.ok === true` 时** `close()` |
| 失败分支 | 抽出 `snoozeFailed()`：**不关窗** + 改按钮文案"延后失败，请重试" + `msgEl` 说明；`catch` 同样走该分支 |
| 边界分支 | 非 `available` → 只关闭（语义保持）；`!api.snooze` → 直接关闭且**不发出延后请求、不上报成功态**，注释写明由 A07 契约断言拦截 |
| 取证变化 | `grep -c "await\|res.ok" src/update-dialog.html`：**0 → 2** |
| 断言 | 新增 1 条**源码级契约断言**：必须 `async` / 必须 `await api.snooze()` / 必须判 `res.ok === true` / 关窗受成功条件控制 / 不得恢复旧的 `if (api && api.close) api.close();`；另单独断言失败分支存在、含可感知提示、不含 `close`。**已做非空转验证**：把旧处理器原文喂进该组断言 → 全部被拒 |
| 测试 | `pnpm test` **37/37**、`tsc --noEmit` 0 错 |
| 真机可达性 | ⚠️ **本项仅静态验证**：dev 态 `isPackaged=false`，更新弹窗不会出现，无人肉路径；未放宽 `isPackaged`、未造假更新源 |

> 附带记录：修复过程中发现 P2 阶段一次**文档静默覆盖** —— `§11.1` 的「构建环境依赖」整行
> 曾被当作替换锚点而丢失，已于 `fc2eb84` 补回。本轮审计已独立核对 `§11.1` 完整性
> （实测记录 8 条齐全、适配记录在、D 项已补回），**未见第二处丢失**。

---

## 三、无法在代码层验证的项（需真机 / 需发布环境）

| 项 | 缺什么 | 何时能验 |
|---|---|---|
| A10「GitHub/COS 二进制哈希相同、COS 元数据最后发布且实际下载成功」 | 需 COS 桶 + 真实域名 + 一次真实 `v*` tag 发布 | 建好 COS 桶、填入域名后 |
| A05 / A08「真实 CDN 降级与续接」 | mock 已覆盖状态机；真实侧需可达的 GitHub 与 COS | 同上 |
| A03「真机连续故障恢复」 | 需人为制造 6 次 host 故障 | 可选，非阻塞 |
| A06「重启后 snooze 真的拦住提醒」 | 需装包后跨重启实测（dev 态不执行真实更新） | 装包测试时顺带 |
| A09「NSIS 安装/卸载/启动」 | 需真实安装一次 | 装包测试时 |
| about 页运行时效果 | **该页全仓无入口**，无法端到端验证；已用"真实处理器 + 真实文件"的 mock 覆盖替换/白名单/CSP | 入口加入后（已登记 P4） |

---

## 四、交叉核对 §11.1

§11.1 的 8 条上游假定，全部已适配并登记（版本 `0.1.7-alpha.2`、`--port`、stdout 就绪行判据、
进程 token 换 cookie、进程树回收降 P2），另有 2 条本轮新增记录（about 页版本替换、更新页
`--dsh-version` 误传 Electron 版本）。**与 SPEC 冻结条款无冲突**：§6/§9 的冻结文本未被直接改写，
适配集中在 M04 边界与本地页 CSP，D1–D5、preload 契约、更新源语义、安全约束均未被动。

---

## 五、审计环境说明（避免误判）

本审计环境的 Bash 沙箱有两条限制，会让**部分用例无辜失败**，已知两条并已用最小实验确证：

1. **`spawnSync` 返回 `EBUSY`** → A10 的 `release.mjs` 用例（需 spawn 子进程）必然失败
   （最小实验：`spawnSync(process.execPath, ['-e', ...])` → `error.code='EBUSY'`，`stderr=undefined`）
2. **`reg.exe` 被拦** → 涉及注册表探测的路径受限

因此本机复跑结果为 `35/36`，**那 1 条不构成代码缺陷**；目标环境（开发机 / CI）为 `36/36`。

---

# 二审（交叉审查 · 2026-09-25 15:40）

一审对照的是 §12 的 A01~A10；二审换三个视角：**SPEC §3~§10 逐节承诺扫描**（CC 执行，
规则：只准报偏差、不准自评通过）、**静默失效形状专项**与**SPEC 数值对照**（审计方执行）。

## 一、二审方独立专项（3 项）

| 专项 | 结果 |
|---|---|
| SPEC 28 项数值/标识符对照 | ✅ 全命中 |
| 死接口扫描（9 个导出） | ✅ 全部有调用方 |
| 逐节抽查 | ⚠️ 1 个 P2：runMode 非法时 throw → 整套配置恢复默认（SPEC §10:304 承诺"仅回退 runMode 并提示"）；实现比 SPEC 更保守、`.corrupt` 留底，**不阻塞** |

## 二、CC 交叉审查（24 条偏差）

**P0：0 条 · P1：9 条 · P2：15 条。** 审计方已逐条独立核验，**9 条 P1 全部成立**（含最关键的 #1：
已亲查 `node_modules/electron-updater/out/AppUpdater.js` 的 channel setter 源码确认）。

### P1 终裁（9 条 → 7 修 2 缓）

| # | 偏差 | 裁定 |
|---|---|---|
| 1 | **allowDowngrade 被 channel setter 静默置 true**（electron-updater 源码：`set channel(){ this.allowDowngrade = true }`；代码"先设 false 再赋 channel"恰好踩中；SPEC §7:216 明确要求"channel 之后再次设置"） | **本轮必修** —— 更新安全硬条款被静默撤销，且 A05 用例因假件未实现该 setter 而照常全绿（mock 盲区） |
| 4 | 托盘 running 徽章从未接线（tray.js 分支在，唯一调用点只发 'update'） | **本轮必修**（一行接线） |
| 5 | 渲染进程崩溃静默（注释写"显示原生错误提示"，实际只有 log.error） | **本轮必修** |
| 6 | 权限未默认拒绝（无 setPermissionRequestHandler / CheckHandler） | **本轮必修** —— §9 安全章节硬要求 |
| 7 | session 未分离（无 partition，本地页与上游页共享 cookie 罐） | **本轮必修** —— §9 硬要求 |
| 8 | splash / update 窗口无 will-navigate 拦截（本地页可被导航且保留受信桥） | **本轮必修** —— §9 硬要求 |
| 9 | 更新窗口点 X 直接销毁、不落 snooze（按钮路径 ✓，X 是兄弟路径漏洞，与已修的 P1-1 同类） | **本轮必修** |
| 2 | skipVersion 无消费者 | **降 P2 缓修**：首版无"跳过"按钮（SPEC §10:305），该字段永远为 null，实际不触发——是死字段而非功能缺失 |
| 3 | 双源失败缺"原生手动下载/关闭"对话框与固定下载地址 | **缓至发布准备期**：触发条件（双源真失败）需 COS 桶配好后才存在；届时连同 `<占位官网域名>` 一起填 |

### P2（15 条 + 二审方 1 条 = 16 条）

#10 推送失败不记录 / #11 订阅退订未接线 / #12 托盘"检查更新"下载中不禁用 / #13 协议职责在 M02 不在 M06 /
#14 工作目录用 process.cwd() / #15 探测回调不复核代次 / #16 就绪不校验子进程存活 / #17 shutdown 不带端口 /
#18 snooze 损坏无日志 / #19 持久化无 fsync / #20 更新日志无操作代次 / #21 重试监听器累积 / #22 splash/update 无 setWindowOpenHandler /
#23 splash 未显式 webSecurity/webviewTag / #24 SPEC 占位符与实现字面量不一致 —— **全部登记不阻塞**，择期清理。

## 三、二审结论

- 一审结论（A01~A09 代码层通过）**仍然成立**——二审发现的是 §3~§10 散落承诺的欠账，不推翻 §12 验收面。
- 但"代码层终审通过"**暂缓**：待 7 条 P1 修复并复核后改判。
- **今天累计抓获的"静默失效"共 8 例**（onTraySetText / CSP 哈希 ×2 / 文档锚点覆盖 / snooze 不查结果 / allowDowngrade /
  running 徽章未接线 / 渲染崩溃静默）——该形状已成为本项目最重要的质量主题。

---

# 二审修复复核（2026-09-25 15:54）

7 条必修全部落地，审计方逐条独立复核通过（含亲验 `src/updater.js:85-89/97-99` 的
channel 后重设、`tests/stubs/electron-updater.mjs:37` 复刻 setter 副作用、
partition 双注册、`hardenSession` 双 session 安装、托盘双输入 derive）。
独立复跑 43/44（唯一失败 = A10 release.mjs，系本审计环境沙箱拦 `spawnSync` 的已知假象，见 §五）。

| # | commit | 复核要点 |
|---|---|---|
| 1 allowDowngrade | `555b7b6` | 两实例均在 `channel=` 之后重设 `allowDowngrade=false`，注释引源码行号；假件复刻 setter 副作用 + 防空转用例（先证明假件会置 true） |
| 4 running 徽章 | `5c63873` | 托盘拆 `hasUpdate`/`hostHealthy` 双输入 + `derive()`（消灭"后写者胜"）；连带修复"更新结束后永远回不到绿色"（updater 补发 idle） |
| 9 更新窗口 X | `db58d78` | M06 只拦下等注入裁决；`onUpdateCloseRequest` 返回 ok 才放行，`E_IO` 保留窗口 + 原生提示 |
| 6 权限默认拒绝 | `44d11c1` | `hardenSession` 双 handler 一律 false；默认与 local 两个 session 均装 |
| 7 session 分离 | `81db36c` | `LOCAL_PARTITION` 内存 partition；**关键补救：partition 不继承 protocol.handle，单独注册 dsh-app**（漏掉则本地页整页挂）；cookie 换取链路真机确认未隔离（主窗口仍加载 UI） |
| 8 本地页围栏 | `0beb467` | `hardenLocalPageWindow`：精确放行自身 dsh-app URL + webview 拦截 + openHandler deny（连带清掉 P2 #22） |
| 5 崩溃提示 | `81aca31` | `render-process-gone` 补 `dialog.showMessageBox`，同窗口只提示一次 |

测试从 38 → **44/44**（新增 6 条，其中含 2 条"假件补全后才成立"的回归防线）。
真机两组均过：转场完成、CSP 违规 0、托盘徽章轨迹 idle→running、主窗口仍为 UI 标题（#7 专项确认鉴权未被隔离）。

## 终审判定

- **二审 9 条 P1：7 修（全部复核通过）+ 2 缓（#2 降 P2、#3 缓至发布准备期）—— 闭环。**
- **代码层终审：通过**（§12 验收面 A01~A09 + §3~§10 承诺面 P1 全清）。
- 遗留为 P2 清单（16 条，已列 §二）与"需真实环境"清单（§三）——不阻塞、择期清理。
- ⚠️ `dist/` 安装包落后于源码（不含这 7 笔修复），**发布或装机前必须重新构建**（带
  `ELECTRON_MIRROR` 与 `ELECTRON_BUILDER_BINARIES_MIRROR` 两个环境变量）。

---

# 三审 / 改判（2026-09-25 15:56）

## 一、7 条 P1 修复复核（审计方独立核验）

| # | 复核点 | 结果 |
|---|---|---|
| 1 | channel 赋值**之后**重设 `allowDowngrade=false`（两个实例） | ✅ `updater.js:85-87`、`:97-99`（注释引 electron-updater 源码行号） |
| 4 | 托盘 running 徽章接线 | ✅ 拆两输入（hasUpdate/hostHealthy）+ `derive()`，避免"后写者胜"；并补上 updater 从不发 `'idle'` 的连带缺口 |
| 5 | 渲染崩溃原生提示 | ✅ `main-window.js:168-173` 补 `dialog.showMessageBox`，且"同一窗口只提示一次"防弹窗风暴 |
| 6 | 权限默认拒绝 | ✅ `main.js:165-168` `hardenSession()`：RequestHandler + CheckHandler 均返回 false |
| 7 | **session 分离（最高风险项）** | ✅ **主窗口留在默认 session**（token→cookie 未被隔离）；本地页走 `dsh-local`；**partition 内额外注册了一次 `dsh-app` 协议**（`main.js:226` + `:228`）——这个连带坑已处理，否则本地页整页加载失败 |
| 8 | 本地页导航围栏（含 P2 #22） | ✅ `hardenLocalPageWindow()` 应用到 splash（`main.js:339`）与更新窗口（`main-window.js:234`），含 will-navigate/will-redirect/webview/window-open deny |
| 9 | 更新窗口 X 落 snooze | ✅ 拦截后按注入结果处置：`close()` 返回 ok 才放行，`E_IO` 保留窗口 + 原生提示 |

**测试**：新增 6 条，**44/44**（本机复跑 43/44，失败项仍为 A10 —— 已确证的本机 `spawnSync` 假象）。
**tsc**：0 错。
**真机**：两组均转场完成、CSP 违规 0、控制台 ERROR 0、主窗口加载正常（非 401）。

## 二、改判结论

> ✅ **代码层终审通过**（P0 = 0，P1 = 0）。
>
> 剩余 16 条 P2 全部登记、不阻塞；其中 #2 / #3 按终裁缓至发布准备期。
> **仍需真实环境的验证**（非代码缺陷）：NSIS 安装卸载、真实 CDN 降级、A10 发布一致性、
> 装包后跨重启的 snooze 行为、about 页（无入口）。

## 三、审计环境声明（沿用）

本机 Bash 沙箱会拦 `spawnSync`（EBUSY）与 `reg.exe`，导致 A10 的 `release.mjs` 用例**必然失败**。
该失败**不构成代码缺陷**，已用最小实验确证；目标环境（开发机 / CI）为 44/44。

---

# 收尾（2026-09-25 16:02 · 审计方复核）

| 项 | 结果 |
|---|---|
| **#23** splash 补 `webSecurity` / `webviewTag` | ✅ `main.js:332-333`；三个窗口（主窗口 `main-window.js:99-100`、更新窗 `:226`、splash）**五项开关全部齐备**，注释点明"不依赖默认值" |
| 断言 | ✅ 新增 1 条覆盖三个窗口（主/更新窗走假件记录的 `webPreferences` 行为断言，splash 走源码级断言），缺任一项即失败 |
| 构建复验 | ✅ `dist/DSH Desktop-Setup-0.1.0.exe` = **84,709,029 B（80.78 MiB）** < 130MB；`.blockmap` 89,800 B；构建内测试 45/45；0 错误、0 警告 |
| **包内确认为新代码** | ✅ 审计方独立在 `dist/win-unpacked/resources/app.asar` 中核验标志串：`dsh-local` 1、`hardenSession` 3、`hardenLocalPageWindow` 4、`setPermissionRequestHandler` 1、`延后失败` 4、`界面进程异常退出` 1 —— **七条安全/行为修复确已在包内，装包测试不会验到旧包** |
| 测试 | ✅ **45/45**（本机复跑 44/45，失败项仍为 A10 的 `spawnSync` 环境假象） |
| 工作区 | 干净 |

## 最终状态

> **代码层终审通过**：P0 = 0、P1 = 0；tsc 0 错、测试 45/45；安装包 80.78 MiB 且已确认为最新代码。
>
> **16 条 P2 全部登记、不阻塞**（#2 / #3 缓至发布准备期，其余择期清理）。

## 仍需真实环境（非代码缺陷）

| 项 | 需要 |
|---|---|
| NSIS 安装 / 卸载 / 启动 | 装一次 `dist/DSH Desktop-Setup-0.1.0.exe`（**先停 dev 实例**，否则被单例锁挡） |
| 真实 CDN 降级、A10 发布一致性 | COS 桶 + 真实域名 + 一次 `v*` tag 发布 |
| 装包后跨重启的 snooze 行为 | 装包后实测（dev 态不执行真实更新） |
| about 页 | 无入口，需 P4 决定是否加入口 |
| 更新检查的 dev 态可观测性 | 凯哥已决定延至正式安装时处理 |
| Git | 本地领先远端若干提交，需推送 |
