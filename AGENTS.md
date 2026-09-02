# Agent Guidelines for HK-Craft

本项目是一个专为 CLI AI Agent 研发流（Agent-Centric Workflow）设计的多项目轻量级三位一体桌面工作台（HK-Craft）。
本项目整合了 **GUI 文件资源管理器**、**Agent 专属 CLI 终端** 与 **常规运行/调试终端（Runner Terminal）**。

---

## 1. 技术栈规范 (Tech Stack)

### 前端 (Frontend)
- **核心框架**: React 18 / 19 + TypeScript + Vite
- **构建与包管理**: Vite + TypeScript + `pnpm`
- **UI & 样式**: Tailwind CSS + Lucide React (图标)
- **布局分屏**: `react-resizable-panels` (支持自由拖拽调节分屏比例与本地记忆)
- **终端模拟器**: `@xterm/xterm` + `@xterm/addon-fit` + `@xterm/addon-webgl`
- **状态管理**: Zustand 或 React Context (轻量集中式状态管理)

### 后端 (Backend - Rust)
- **应用框架**: Tauri v2
- **终端进程与 PTY**: `portable-pty` (跨平台 PTY 管理，Windows 默认使用 PowerShell / ConPTY，Unix 使用默认 Shell)
- **配置序列化**: `toml` + `serde` / `serde_derive`
- **异步与并发**: `tokio` (Tauri 异步命令支持)

### 配置存储 (Config & Storage)
- **配置文件**: 本地单文件 TOML，默认路径 `~/.hk-craft/config.toml`

---

## 2. 核心架构与设计模式 (Core Architecture)

### 2.1 三位一体（The Trinity）视图模型
每个项目（Project）在工作区内拥有独立的上下文。打开项目时默认三个面板 Tab：
1. **📂 文件资源管理器 (File Explorer)**：主流详细列表视图（名称/修改时间/类型/大小）、路径面包屑导航、快速搜索过滤及常用外部目录书签栏。
2. **🤖 Agent 终端 (Agent CLI)**：专用于运行 `cursor-agent`、`opencode`、`claude`、`dsh-tui` 等 CLI 交互；默认使用项目绑定的 Agent 预设，也可再开与默认不同的 Agent 面板。
3. **⚡ 运行终端 (Runner Terminal)**：纯净的系统 Shell，用于本地测试、编译、开发服务器运行。

同一项目可同时打开多个资源管理器、多个 Agent、多个运行终端。每个终端面板对应独立的 PTY（`{projectId}:{kind}:{paneId}`）。

### 2.2 面板 Tab 与三种布局
顶栏为当前项目的面板 Tab 列表，末尾 `+` 新增面板（资源管理器 / 运行终端 / 任意 Agent 预设），最右侧为布局切换：
- **Tab 切换** (`Ctrl+1`)：只显示焦点面板，其余保持挂载。
- **一行平铺** (`Ctrl+2`)：全部面板横排分屏，可拖动分界。
- **两行平铺** (`Ctrl+3`)：两个及以上面板时分成两行（`cols = ceil(n/2)`），单数时留空一格；仅 1 个面板时退化为整页。

布局与打开的面板按项目写入 `config.toml`。切换 Tab / 布局 / 左侧项目只改变可见性，**不可销毁后台 PTY 或丢失终端输出缓冲区**。

### 2.3 PTY 会话常驻与生命周期 (Session Persistence)
- PTY 进程完全运行并驻留在 Rust 后端。
- 前端切换左侧项目、切换 Tab/布局仅改变 DOM 挂载或可见性，**绝对不可销毁后台 PTY 进程或丢失终端输出缓冲区**。
- 左侧项目可收纳：收纳会关闭该项目本轮 PTY，但保留布局、Agent session 与 Runner 历史；彻底移除只从收纳区执行。
- Runner 底部可保存项目常用命令：左键写入当前 PTY（末尾 Enter），顺序与正文按项目写入 `config.toml`。

### 2.4 内部拖拽注入协议 (Drag-to-Inject Protocol)
- 从内部文件管理器拖拽文件至终端时：
  - **拖入 Agent 终端**：自动格式化并带上前缀（如 `@C:\path\to\file.ts`，支持在配置中自定义前缀）。
  - **拖入 Runner 终端**：自动格式化为标准双引号转义绝对路径（如 `"C:\path\to\file.ts"`）。

---

## 3. UI 设计原则 (UI Design Principles)

- **极简克制 (Minimalism)**：界面必须保持极其干净、清爽、克制，去除一切非必要的装饰性元素、复杂边框与视觉噪音。
- **低认知负担 (Low Cognitive Load)**：信息层级与布局扁平直观，避免繁杂的层级嵌套或过度拥挤的控件堆叠，让用户专注代码与 Agent 交互。
- **聚焦与高信噪比 (Focus & High Signal-to-Noise Ratio)**：仅高亮关键信息（当前激活项目、当前焦点面板、后台运行状态指示灯），弱化非核心辅助元素。

---

## 4. 规划目录结构 (Project Directory Structure)

```text
.
├── ai-docs/                    # 需求与设计文档
│   └── agent-workbench-design.md
├── AGENTS.md                   # Agent 指南与规范 (本文件)
├── src-tauri/                  # Tauri Rust 后端
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   └── src/
│       ├── main.rs
│       ├── lib.rs
│       ├── pty/                # PTY 会话管理与进程保活
│       ├── fs/                 # 文件系统读取、元数据解析
│       └── config/             # TOML 配置读写与持久化
├── src/                        # 前端 React 应用
│   ├── main.tsx
│   ├── App.tsx
│   ├── components/
│   │   ├── layout/             # 侧边栏与主区布局、面板 Tab 栏、分屏容器
│   │   ├── sidebar/            # 左侧项目切换栏 (项目列表、状态灯、添加与设置)
│   │   ├── explorer/           # 文件资源管理器 (列表视图、面包屑、书签)
│   │   ├── terminal/           # xterm.js 终端封装与拖拽目标处理
│   │   └── settings/           # 设置弹窗与模板管理
│   ├── hooks/                  # PTY 通信、拖拽、快捷键 hooks
│   ├── store/                  # 工作区与项目状态 (Zustand)
│   └── types/                  # TypeScript 类型定义
├── package.json
└── vite.config.ts
```

---

## 5. 关键开发与构建命令 (Development Commands)

| 场景 | 命令 | 说明 |
| :--- | :--- | :--- |
| **依赖安装** | `pnpm install` | 安装前端依赖 |
| **开发调试** | `pnpm tauri dev` | 启动 Tauri 桌面端与 Vite HMR 前端 |
| **前端检查** | `pnpm lint` / `pnpm type-check` | TypeScript 类型检查与 ESLint |
| **Rust 检查** | `cargo check` / `cargo clippy` | Rust 静态分析与规范检查 |
| **单元测试** | `cargo test` / `pnpm test` | 后端与前端逻辑测试 |
| **生产打包** | `pnpm tauri build` | 构建可分发的安装包/二进制 |

---

## 6. Agent 编码与协作规范 (Coding Guardrails)

1. **不可破坏 PTY 保活机制**：任何前端 UI 重构不得导致 Rust 端 PTY 会话异常重置。
2. **轻量与性能第一**：保持内存占用在 100MB 以下，避免引入沉重的 UI 依赖，终端统一使用 WebGL 加速。
3. **坚守极简 UI 风格**：界面设计与组件开发务必保持简洁直观，严禁增加繁琐臃肿的视觉元素与复杂嵌套交互。
4. **配置安全性与幂等性**：所有对配置的写入必须保证 TOML 格式完好无损，且对未知字段保持兼容或优雅降级。
5. **统一错误处理**：Rust 端命令使用统一的 `Result<T, AppError>` 返回，前端通过标准化 Toast/提示通知用户。
