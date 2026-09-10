# Changelog

All notable changes to **HK-Craft** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added
- 文件资源管理器列表列宽可拖拽调整；所有资源管理器共用同一组列宽，重启后保持。

## [0.4.0] - 2026-09-09

### Added
- 文件资源管理器支持 Ctrl/Shift 多选，可批量复制、剪切、删除与拖拽注入。
- 删除文件前弹出应用内确认框；右键删除与 Delete 快捷键均会二次确认。
- 设置中可按项目查看各终端进程树的内存与 CPU 占用。
- Agent 面板注入 `HK_CRAFT_KIND=agent`，便于 Starship 等工具在 Agent 子 shell 中跳过初始化。
- 关项目后再开时按项目目录只读扫描 OpenCode SQLite，把未绑定的根会话填进空面板并续跑。

### Fixed
- dsh-tui 面板短按与滚轮交给 TUI 操作，拖选文字松手即复制；其它 Agent 鼠标逻辑不变。

## [0.3.0] - 2026-09-05

### Added
- Docker 面板：按 Tab 连接本机容器，支持启动已停止容器、自动执行命令与快捷命令栏。
- 文件资源管理器右键菜单：打开、复制路径、内部复制/剪切/粘贴、重命名、删除与新建。
- OpenCode 通过全局插件上报 session id，关项目后再开可续跑。
- 退出前若仍有进行中的终端任务，弹出确认以免误关中断。
- 深色主题改用 gruvbox，浅色主题改用 Melange；项目状态改为整行背景色提示。

### Changed
- 浅色主题的文件面板、对话框与终端背景改为暖米白。

### Fixed
- 同种 Agent 按面板分别恢复会话；终端选中文字复制、Ctrl+Enter 换行。
- 退出确认一次即可关闭，且不再把空闲 Agent TUI 当成正在运行。
- 快捷命令栏不再遮挡终端最后一行。
- 打开项目时扫描 dsh-tui 会话并带 `--resume`；无法加载则回退新会话，避免面板直接退出。
- Windows 上为嵌入式 xterm.js 注入终端身份，修复 dsh-tui 上下键。
- cursor-agent 会话恢复不再被 dsh-tui 的失败回退逻辑清掉。

## [0.2.0] - 2026-09-02

### Added
- Codex CLI preset with session resume (`resume <id>`).
- Settings page update check that opens the GitHub Releases page when a newer version exists.

### Changed
- Prefer installed system terminal fonts and remove bundled extra font assets.
- Consolidate pane launch, Agent protocol lookup, and PTY live-status checks.

### Fixed
- Agent terminal paste, IME composition, and false “task completed” notifications.

## [0.1.0] - 2026-09-02

### Added
- **Trinity Workspace Architecture**:
  - Integrated GUI File Explorer with breadcrumbs, bookmarks, quick filter, and detail/icon views.
  - Dedicated Agent CLI terminal supporting `cursor-agent`, `opencode`, `claude`, `codex`, `dsh-tui`, and customizable presets.
  - Runner terminal with project-scoped Quick Command Bar for rapid test and build execution.
- **PTY Session Persistence**:
  - Native cross-platform PTY background lifecycle powered by Rust `portable-pty`.
  - Zero-kill architecture: project/tab/layout switching never terminates background tasks or drops terminal buffer history.
  - Smart encoding fallback for Windows (UTF-8 and GBK) and conda/venv environment isolation.
- **Drag-to-Inject Protocol**:
  - Dragging files into Agent terminal injects formatted references (`@path`).
  - Dragging files into Runner terminal injects escaped absolute paths (`"path"`).
- **Flexible Layout Engine**:
  - Support for Tab Single Focus (`Ctrl+1`), Row Tile (`Ctrl+2`), and Grid Tile (`Ctrl+3`) layouts with smooth resizing.
- **Local-First Configuration**:
  - Single-file TOML configuration located at `~/.hk-craft/config.toml`.
  - Automatic migration from legacy configuration paths.
- **UI & System Integration**:
  - Dark/Light theme switching and automatic Nerd Font discovery.
  - Real-time PTY status badges (running, waiting, exit) and system desktop notification toasts on long task completion.
