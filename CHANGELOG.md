# Changelog

All notable changes to **HK-Craft** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

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
