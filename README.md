<div align="center">

<img src="./public/favicon.svg" alt="HK-Craft Logo" width="108" height="108" />

# HK-Craft

**专为 CLI AI Agent 研发流打造的多项目轻量级三位一体桌面工作台**

*A Lightweight Trinity Desktop Workbench for CLI AI Agents by Hongshan Tech (宏山科技)*

[![Release](https://img.shields.io/github/v/release/hongshan-tech/hk-craft?label=Release&color=38bdf8)](https://github.com/hongshan-tech/hk-craft/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-6366f1.svg)](./LICENSE)
[![Tauri v2](https://img.shields.io/badge/Tauri-v2-24c8db.svg)](https://tauri.app/)
[![React 19](https://img.shields.io/badge/React-19-61dafb.svg)](https://react.dev/)

</div>

---

## 💡 为什么需要 HK-Craft？

在日常使用 `cursor-agent`、`opencode`、`claude`、`codex`、`dsh-tui` 等现代 AI 编程 CLI 时，开发者常常面临两个痛点：
1. **不想为了简单交互开一整套沉重繁琐的 IDE**；
2. **在杂乱的系统终端标签页里，经常分不清哪个是正在思考的 Agent、哪个是跑着测试的 dev server**，且经常因为不小心切错窗口或误关终端中断会话。

**HK-Craft** 为解决此痛点而生：**给每个本地项目一套永不丢失的专属工作台**。

---

## ✨ 核心特性

### 1. 🏛️ 三位一体（The Trinity）工作区
每个纳管项目拥有独立的工作上下文，打开项目即刻拥有黄金三角面板：
- **📂 GUI 文件资源管理器**：详细列表/图标视图、面包屑导航、即时搜索过滤与常用外部路径书签。
- **🤖 Agent 专属终端**：专用于运行各种 CLI Agent，支持项目绑定预设与会话自动续跑（`--resume`）。
- **⚡ 运行与调试终端 (Runner)**：纯净的系统 Shell，自带常用命令快捷栏（Quick Bar），一键执行测试与编译。

### 2. 🎯 拖拽注入协议 (Drag-to-Inject)
- 从内部文件管理器拖动任意文件或文件夹：
  - **拖入 Agent 终端**：自动转换为格式化引用（如 `@C:\path\to\file.ts`，前缀可自定义）。
  - **拖入 Runner 终端**：自动格式化为双引号转义的标准绝对路径（如 `"C:\path\to\file.ts"`）。

### 3. 🛡️ PTY 会话常驻与全天候保活
- **切换不中断**：PTY 进程运行并常驻于 Rust 后端。无论是左侧切换项目、切换顶部 Tab、还是切换平铺布局，**绝不销毁后台 PTY 进程，绝不丢失终端缓冲区**。
- **状态感知指示灯**：实时感知终端状态（🟢 运行中 / 🔵 等待输入 / 🔴 异常退出），后台长任务执行完毕后触发系统级 Toast 通知。
- **Windows 深度适配**：内置 UTF-8 与 GBK 双向智能转码，启动时自动剥离 conda/venv PATH 污染。

### 4. 🎛️ 自由布局与单文件配置
- 支持 **Tab 单焦模式** (`Ctrl+1`)、**一行平铺** (`Ctrl+2`)、**两行平铺** (`Ctrl+3`) 自由切换与平滑拖拽分屏。
- 采用本地单文件 TOML 配置（`~/.hk-craft/config.toml`），无数据库、无黑盒，配置透明易迁移。

### 5. 🔒 隐私安全与本地优先
- **100% 本地运行**：无云端中转，无任何遥测与数据收集。
- 本地 Transcript 仅在用户开启“自动续跑”时单向扫描本地会话用于生成恢复参数。

---

## 🚀 快速开始

### 系统要求
- **Windows**: Windows 10 / 11 (已内置 WebView2)
- **依赖工具**: 本机已安装您常用的 Agent CLI（如 `cursor-agent`、`opencode`、`claude`、`codex`、`dsh-tui` 等）

### 下载安装
前往 [GitHub Releases](https://github.com/hongshan-tech/hk-craft/releases) 下载最新版本的安装包：
- **Windows 安装向导**: `HK-Craft_0.1.0_x64-setup.exe` (NSIS)
- **Windows MSI 安装包**: `HK-Craft_0.1.0_x64_en-US.msi`

> 💡 *个人开发者未购买昂贵签名证书时，Windows SmartScreen 可能会弹出提示，点击「更多信息」→「仍要运行」即可正常安装。*

---

## 🛠️ 本地开发与构建

### 1. 克隆代码与安装依赖
```bash
git clone https://github.com/hongshan-tech/hk-craft.git
cd hk-craft
pnpm install
```

### 2. 启动桌面端调试
```bash
pnpm dev
```

### 3. 构建发布安装包
```bash
pnpm build
```
构建生成的安装包将存放于 `src-tauri/target/release/bundle/`。

---

## ⌨️ 常用快捷键

| 快捷键 | 功能 |
| :--- | :--- |
| `Ctrl + 1` | 切换为 **Tab 单焦模式** (仅显示当前焦点面板) |
| `Ctrl + 2` | 切换为 **一行平铺模式** (横向平铺所有面板) |
| `Ctrl + 3` | 切换为 **两行平铺模式** (网格式平铺所有面板) |
| `Ctrl + +` / `Ctrl + -` | 放大 / 缩小终端字体 |

---

## 📄 开源许可证

本项目基于 [MIT License](./LICENSE) 开源。

Copyright (c) 2026 **宏山科技 (Hongshan Tech)**
