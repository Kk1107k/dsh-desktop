# Changelog

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 规则。

## [Unreleased]
### Changed
- 绑定上游版本 `@deepseek-ai/dsh` 升至 `0.1.7-rc.2`（依据官方铁律：Desktop 与 dsh 使用同一精确版本，
  含 rc/alpha/beta 标识）。**壳版本号随之改为与绑定版本完全相同**（原 `0.1.0`）——这是"借用官方
  版本号命名规则表达绑定关系"，我们的运行时组合（壳 + 用户系统 Node + dsh）与官方不同，不代表
  验证了官方组合。详见 `B-AI共享/SPEC.md` §11.1。

## [0.1.0] - 2026-09-24
### Added
- 初始桌面壳骨架：单例锁、splash 转场、主窗口承载 host UI。
- `dsh-host` 子进程管理：固定 `@deepseek-ai/dsh@0.1.7-alpha`，loopback 端口、健康探测、退避重启、进程树强制回收。
- `updater` 双通道状态机：GitHub 主源 + COS 备源，snooze 持久化，加密失败不绕过校验。
- `ipc` 集中协议与 preload 隔离桥，`dsh-app://` 受信协议，本地 CSP 与上游 CSP 共生。
- 托盘六项菜单与三态徽章，`NSIS` 构建产物进入 `dist/`。

### Notes
- 上游 CLI、`/api/health`、`dsh shutdown` 等接口均为 SPEC §11.1 待验证项；壳侧适配仅在 §11.1 列出的边界进行。