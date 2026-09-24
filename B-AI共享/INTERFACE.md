# DSH Desktop · 渲染层接口契约

> **这份文件的存在理由**：三份 AI（国际版 GPT / 国内版 / Claude Code）并行施工，
> 唯一会让它们合不拢的地方就是**接口名**。名字对不上不会报错，只会**静默失效**——
> 状态行永远停在"正在启动服务"，更新弹窗永远卡在"正在检查更新"，而且极难排查。
>
> - 页面源文件一律 **不要手改**，改 `tools/gen_*.py` 后重新生成
> - 本文档记录两件事：**已实现的事实**（改前必读）与 **待决项**（交给 Phase 0 拍板）

重新生成页面的方式：

```bash
python tools/gen_splash.py
python tools/gen_update_dialog.py
python tools/gen_whale_icons.py
# 调试：splash.html?t=秒 确定性渲染书写动画的任意时刻（?t=99 = 写完）
```

---

## 1. 已实现的事实（页面端真实调用）

### 1.1 `src/splash.html` → `window.splashAPI`

| 成员 | 方向 | 签名 | 说明 |
|---|---|---|---|
| `onStatus` | main → renderer | `(cb: (text: string) => void) => void` | 推送状态文案，页面自己做淡入淡出切换 |
| `onFinish` | main → renderer | `(cb: () => void) => void` | **请求**关闭（见 §3），页面先淡出再回调 |
| `getVersion` | renderer → main | `() => string \| undefined` | 版本号来源，**禁止在页面写死** |
| `minimize` | renderer → main | `() => void` | 自绘最小化按钮 |
| `close` | renderer → main | `() => void` | 自绘关闭按钮 |

- 页面无边框（`frame: false`），右上角的最小化/关闭是页面自绘的
- **无 `splashAPI` 时自动走演示序列**（可双击独立预览），不会白屏

### 1.2 `src/update-dialog.html` → `window.updateAPI`

| 成员 | 方向 | 签名 |
|---|---|---|
| `onState` | main → renderer | `(cb: (state: State, data?: object) => void) => void` |
| `getState` | renderer → main | `() => ({ state, ...data } \| undefined)` |
| `startDownload` | renderer → main | `() => void` |
| `retry` | renderer → main | `() => void` |
| `close` | renderer → main | `() => void` |

**状态枚举（`State`）**：`checking` / `latest` / `available` / `downloading` / `error`

| state | data 结构 | 页面表现 |
|---|---|---|
| `checking` | — | "正在检查更新…"，主按钮禁用 |
| `latest` | `{ version }` | "当前已是最新版本 (vX.Y.Z)"，主按钮=知道了 |
| `available` | `{ version, notes }` | 版本号 + 更新说明，主按钮=立即更新，次按钮=稍后 |
| `downloading` | `{ progress: number /* 0~1 */ }` | 进度条 + 百分比，主按钮禁用 |
| `error` | `{ message }` | 错误原因，主按钮=重试，次按钮=关闭 |

---

## 2. 待决项 D1 — preload 命名空间（**交给 Phase 0 的 GPT 决断**）

现状：两个页面各自期待 `splashAPI` / `updateAPI`，而主方案 §2.1 的架构图写的是
`exposeInMainWorld('dshApi', {...})` —— 三者不一致。

| 方案 | 做法 | 代价 |
|---|---|---|
| **A：统一** | 只暴露 `dshApi`，内挂 `dshApi.splash` / `dshApi.update` | 更干净集中；要改两个页面的取值方式并重跑生成器、重新验证 |
| **B：保持** | 继续暴露 `window.splashAPI` / `window.updateAPI` | 页面零改动；preload 里写两处 expose |

> 无论选哪个，都必须满足：`contextIsolation: true`、`nodeIntegration: false`、
> 白名单方法集中注册在 `src/ipc.js`，禁止散落。

---

## 3. 待决项 D2 — splash 关闭时序（必须写进 SPEC）

**事实**：品牌字的逐线条书写动画约 **3.7s**（0.25s 鲸鱼前置 + 3.71s 书写，可调 `PEN_SPEED`），
而 dsh host 可能 1.5s 就就绪。不定义策略只有两种坏结果：

- 等动画播完才切 → 每次开机白等多 2s+，用户只觉得慢
- host 一就绪就切 → 动画被腰斩，开机美化白做

**必须满足**：

1. `onFinish` 是**请求**而非"立即关闭"：页面加 `.closing` 淡出 0.3s 后才通知主进程真正关闭
2. 定义 **min-display**（建议 2.2~2.6s，或"至少写完当前字母"），短于此值不切走
3. host 超过 N 秒（建议 15s）未就绪 → splash 给出超时提示，**不得永远卡住**
4. 关闭时机仍不得早于主窗口 `ready-to-show`（既有反模式约束保留）

---

## 4. 版本号来源

禁止在页面写死版本号 splash/update 页面的版本号一律取自 `getVersion()`；
取不到时留空，**预览模式下显示"预览模式"**，而不是伪造一个版本号。
真实来源：`package.json` 的 `version`，由 preload 提供。

---

## 5. "稍后"必须真的延后 24h

主方案 §8 验收第 5 条要求"'稍后'按钮把提醒压到 24h 后"，而页面现在只调 `close()` —— **验收与实现不一致**。

要求补齐：`updateAPI.snooze()` + 主进程在 `app.getPath('userData')` 下存
`update-snooze.json`：`{ "until": <epoch ms> }`；启动时与自动检查调度一起判定。

---

## 6. 发布产物路径（已修正）

统一 **dist/**，安装包名 `<productName>-Setup-<version>.exe`，
COS 目标路径 `/dsh-desktop/<version>/<安装包名>`。
> 主方案 §9 原先写的 `assets/release/` 是错的，已改为 `dist/`（与 prompt-C 一致）。
