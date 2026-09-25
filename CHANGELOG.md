# Changelog

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 规则。

## [0.1.7-rc.2] - 2026-09-25

> 版本号规则变更：**壳版本 = 所绑定的 `@deepseek-ai/dsh` 版本**（含 rc/alpha/beta 标识）。
> 依据官方铁律「Desktop 与 dsh 始终使用同一精确版本」，本次绑定由 `0.1.7-alpha.2` 升至 `0.1.7-rc.2`。
> 注意这是**借用官方的版本号命名规则**表达绑定关系；我们的运行时组合（壳 + 用户系统 Node + dsh）
> 与官方不同，不代表验证了官方组合。详见 `B-AI共享/SPEC.md` §11.1。

### Added
- **error 态的手动下载入口**（SPEC §7:251，原生对话框）：双源网络失败时弹出「手动下载 / 关闭」，
  地址取真实发布页并可在 `config.json` 的 `downloadPageUrl` 配置；打开前按「https + host 白名单」校验，
  非法一律拒绝并记日志（不调用 `shell.openExternal`）。
- **更新检查的抖动与退避**（对齐官方机制）：随机抖动默认 0.2、失败退避翻倍、成功重置；
  可用 `DSH_DESKTOP_UPDATE_CHECK_INTERVAL_MS` / `_MAX_BACKOFF_MS` / `_JITTER` 覆盖。
- **产物清单可溯源字段** `dshBuildCommit` / `dshBuildDirty`（写入 `cn-stable.yml`）。
- **端口残留自愈**：就绪时记录"本壳确认过的端口占用者"（PID + 创建时间 + 命令行哈希），
  下次启动遇端口被占且**三条身份判据同时成立**时回收其进程树，否则照报 `E_PORT_IN_USE`。
- 渲染进程崩溃的**原生错误提示**（此前只有日志，注释却声称已提示）。
- 权限默认拒绝、本地页与 host 的 session 分离、本地页导航/开窗围栏（SPEC §9）。

### Changed
- **npm registry 由壳固定下发**（`npm_config_registry`，默认官方源，`DSH_DESKTOP_NPM_REGISTRY` 可覆盖）：
  修掉"`--offline` 缓存键随用户环境漂移"的根源 —— 此前开发机能起、装包后能否起全凭侥幸。
- 去掉**下载总时长上限**（保留 30s 无进度看门狗）：原 10 分钟上限会在慢速网络下误杀 80MB 的包。
- 主窗口 CSP 仅对 **loopback origin** 放宽 `script-src 'unsafe-eval'`（上游 bundle 用 `new Function`，
  否则白屏）；本地页 CSP 不改，且改由**协议响应下发哈希制策略**。
- 打包态移除 Electron 默认原生菜单（dev 保留）。
- 签名可降级为**未签名构建**：缺 `CSC_LINK` 不再拒绝发布，但必须在日志与 Release 说明中留痕
  （附 SmartScreen 提示）。**留痕是强约束，不允许静默跳过**。

### Fixed
- **CSP 白屏**：`dsh-app` 协议处理器用旧版回调式 API 注册在新版 `protocol.handle` 上，
  splash 以 `ERR_UNEXPECTED` 加载失败（启动链路第一环即断）。
- **上游版本固定在一个从未发布的版本上**（`0.1.7-alpha`，npm 404），`--offline` 必 `ENOTCACHED`。
- **7 条 P1**：`allowDowngrade` 被 electron-updater 的 channel setter 静默置真（禁止降版本失效）；
  托盘 `running` 徽章从未接线（host 健康时永不显绿）；渲染进程崩溃静默；更新窗口页面按钮
  `close()` 不关窗（与标题栏 X 各写一遍、漏了一条）；本地页 CSP 哈希因 CRLF 未规范化而永不匹配；
  页面 `close()` 判据未收敛；更新弹窗的"稍后"写盘失败被伪装成已延后（D3）。
- **更新窗口停在静态初始 DOM**（5 层故障链，真根因）：角色检测读 `senderFrame.processArguments` ——
  真实 Electron 里该字段根本不存在 ⇒ splash 与 update 页的 `bridge-ready` **全部被拒** ⇒
  preload 缓存永远为空。改为按主进程登记的 URL 推导角色；并补齐 bridge payload 形状（SPEC §5:156
  的 `UpdateEvent`）、`dsh:update-state` 推给**更新窗口**（原先误推主窗口，主窗口无 preload 无人订阅）、
  preload 补发（§5:181）。
- **`inflight` 标志只有加没有解**：首检进终态后永久非空，此后所有检查（含 6h 自动）都 `E_BUSY`
  ⇒ 托盘点「检查更新」静默无反应。改为终态复位（唯一出口），并给手动检查补可见反馈。
- 更新页 `about.html` 版本写死（违反 D4），改为协议响应期注入 `app.getVersion()`。
- 次要修复：`E_PORT_IN_USE` 误挂"安装 Node"提示、`runtimeError` 的提示按错误码区分、
  托盘图标路径依赖 `process.cwd()`（安装后必然空图标）、托盘唤回时经 M06 重建窗口。

### Security
- 权限请求/检查默认拒绝；本地页使用独立 session；本地页禁止导航离开并禁止开新窗；
  渲染进程崩溃不再静默。均见 `B-AI共享/SPEC.md` §9 与 §11.1。

## [0.1.0] - 2026-09-24
### Added
- 初始桌面壳骨架：单例锁、splash 转场、主窗口承载 host UI。
- `dsh-host` 子进程管理：固定绑定 `@deepseek-ai/dsh`（本次记录时写作 `0.1.7-alpha`，该版本**从未发布**，
  实际绑定线为 alpha/rc —— 见上方 0.1.7-rc.2 条），loopback 端口、健康探测、退避重启、进程树强制回收。
- `updater` 双通道状态机：GitHub 主源 + COS 备源，snooze 持久化，加密失败不绕过校验。
- `ipc` 集中协议与 preload 隔离桥，`dsh-app://` 受信协议，本地 CSP 与上游 CSP 共生。
- 托盘六项菜单与三态徽章，`NSIS` 构建产物进入 `dist/`。

### Notes
- 上游 CLI、`/api/health`、`dsh shutdown` 等接口均为 SPEC §11.1 待验证项；壳侧适配仅在 §11.1 列出的边界进行。
