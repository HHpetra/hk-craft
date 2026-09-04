# Docker 面板已知问题

十次代码审查与修复（2026-09-04）。Docker 面板主路径：列容器 → `docker start` / `unpause` → 等到 Running → `docker exec -it … /bin/sh`（失败再 `/bin/bash`）→ 可选在输出静默后注入命令。

相关实现：

| 层 | 文件 |
| :--- | :--- |
| Rust CLI | `src-tauri/src/docker.rs` |
| 启动计划 | `src/lib/paneLaunch.ts` |
| Docker 启动状态机 | `src/lib/dockerLaunch.ts` |
| 执行与注入 | `src/store/workspace.ts`（`executePaneLaunch`、`spawnForProject`、`persist`） |
| 等待输出静默 | `src/lib/ptyWait.ts`、`src/lib/ptyQuiet.ts` |
| 配置写入队列 | `src/lib/serialQueue.ts` |
| 连接 / 编辑对话框 | `src/components/layout/DockerPaneDialog.tsx` |
| Tab 编辑入口 | `src/components/layout/WorkspaceTabBar.tsx` |
| 启动 in-flight 锁 | `src/lib/paneLaunchLock.ts` |
| 错误遮罩 / 重启 | `src/components/terminal/TerminalPane.tsx` |
| PTY 状态监听 | `src/hooks/usePtyStatusListener.ts` |
| 终端尺寸 / PTY 事件 | `src/lib/termRegistry.ts` |
| 应用启动 | `src/App.tsx` |

---

## 当前未修

无。Q–U 见第十次修复。

---

## 第十次修复（原第九次审查 Q–U）

### Q. daemon / 权限文案若尚未 `pty-exit`，会被当成启动成功 — 已修

`classifyPtyExec` 对 `classifyDockerExecOutput` 的 daemon / permission / not-running 在 `quiet` / `timeout` 时也判失败，不注入、不标 running。挂住的 exec 会 `clearSession`。

### R. in-flight 锁直接丢掉后续 `restartPane`，编辑换容器只改了配置 — 已修

第二次 `restartPane` 会 abort 当前 launch 并记下 pending。当前 launch 结束后按最新 pane 再 restart。编辑换容器后会 exec 进新名字。

### S. 关闭面板 / 项目不会取消 launch，PTY 会被再拉起来 — 已修

`closePane` / `closeProject` 先 `cancelPaneLaunch`（abort + 清 pending），再 `ptyKill`。`executeDockerLaunch` 在 ensure 之后、spawn 前后检查 abort，已 spawn 则清掉。结束后若 pane/项目已不在则再 kill，不标 running。

### T. `ptyWrite` 失败一律 `sessionAlive: true` — 已修

注入失败后用 `ptyList` 确认会话还在。不存在则 `sessionAlive: false`，标 error。

### U. `docker_list_containers` 仍无超时 — 已修

`docker ps -a` 与 ensure 共用 20s deadline；卡住则杀进程并报「列出 Docker 容器超时」。

---

## 第八次修复（原第七次审查 L–P）

### L. 重启过程中不更新 `sessionStatus`，可连点打出两路 launch — 已修

`executePaneLaunch` 按 `sessionId` 加 in-flight 锁，第二次 restart 直接忽略。Docker 一开始就把状态打成 `idle`，错误遮罩收掉。`pty-exit` 在 launch 期间不改状态，`sh → bash` 回退时遮罩不会闪回来。

### M. `docker exec` 立刻退出，一律报「找不到 shell」 — 已修

`classifyPtyExec` 只在缺解释器文案时回退 `/bin/bash`。Daemon / 权限 / 容器已退出 / 无输出的立刻退出走 `exec`，toast 用输出分类，不再假装是缺 shell。

### N. Docker 挂了就改不了自动执行命令 — 已修

编辑态且 `docker ps` 失败时，仍可保存原容器名上的自动执行设置。新建面板、以及列表成功但容器失踪，仍不能保存（C 不变）。

### O. `ensure` 的 20 秒只罩轮询，罩不住卡住的 `docker start` / `inspect` — 已修

`inspect` / `start` / `unpause` 共用同一 deadline；CLI 卡住则杀进程并报「等待容器就绪超时」，不再挂死 `spawn_blocking`。

### P. 注入失败会把整条会话标成 `error` — 已修

`ptyWrite` 失败且会话仍可用时保持 `running`，只 toast「未能执行自动命令」。PTY 已退出才标 error。

---

## 第六次修复（原第五次审查 J–K）

### J. 仍有不少 `persist(整份快照)`，和 updater 混用时还会盖掉 — 已修

布局、焦点面板、常用命令、增删面板、主题、设置保存等改为 `(latest) => …`。`persist` 排队执行时作用在当时最新的 config 上，Docker 探测期间的 `agent_seen` / session 更新不会被改布局盖掉。

### K. 自动执行在「一直无输出直到超时」时会静默跳过 — 已修

无 MOTD、提示符晚于 8 秒的容器：PTY 仍在则超时后照常注入。已退出则 toast「会话已退出，未能执行自动命令」，不再假装自动执行已生效。

---

## 第五次修复（原第四次审查 H–I）

### H. 无输出超时被当成 exec 失败，会误杀慢启动的 `/bin/sh` — 已修（提示缺口见 K，已修）

`isPtyExecFailure` 只认 `pty-exit` 或 Docker/OCI 缺解释器文案。探测仍等 `PTY_EXEC_PROBE_MS`（2s）以便抓住立刻退出的 exec，但单纯静默超时不再 `ptyKill` 去试 bash。Alpine 只有 `/bin/sh`、Windows 上提示符晚于 2 秒时不会被误杀。无输出超时仍注入见 **K**。

### I. `spawnForProject` 并行后，配置 persist 会丢更新 — 已修（快照调用点见 J，已修）

`persist` 经 `createSerialQueue` 串行写入。`executePaneLaunch` 的 `agent_seen` / 清 `agent_session_id` 以 updater 作用在排队时的最新 config 上，两个 Agent 同时 persist 不会互相覆盖。其余调用点见 **J**。

---

## 第四次修复（原第三次审查 E–G）

### E. `pty-exit` 监听没有在启动时挂上，超时又不算 exec 失败 — 已修（无输出超时误杀见 **H**，已修）

`App.tsx` bootstrap 前 `ensurePtyListeners()` 同时挂 `pty-output` 与 `pty-exit`。`waitPtyQuiet` 的探测/静默超时从 `observeGeneration` 之后起算。曾把无输出超时当成 exec 失败并回退 bash，过猛，见 **H**。

### F. 打开项目时，Docker 探测会堵住后面的面板 — 已修（并行 persist 丢更新见 **I**，已修）

`spawnForProject` 对同项目终端面板 `Promise.all` 并行 `executePaneLaunch`。Docker 探测/注入不再挡住 Agent / Runner。并行 persist 丢更新见 **I**。

### G. MOTD 里出现 `no such file` 会误杀正在跑的 sh — 已修

`looksLikeMissingShell` 只认 Docker/OCI 缺解释器（`exec:` / `stat /bin/sh` / `executable file not found`），不再对 MOTD 里普通的 `No such file` 下手。缺 shell 以 `pty-exit` 或上述报错文案为准。

---

## 第三次修复（原第二次审查 A–D）

### A. `/bin/bash` 回退接错了失败方式 — 已修（残留曾见 E / H）

`pty_spawn` 在 Docker CLI 起来时就成功。现在 `retryOnExecFail`：spawn 后等 PTY 退出或 Docker exec 报错，再 `ptyKill` + 等到 session 离开 PTY map，然后才 `docker exec … /bin/bash`。无输出超时误杀见 **H**（已修）。

### B. 容器 start 后立刻退出时，会空等 20 秒 — 已修

`ensure_step`：`already_started` 且 `exited`/`dead` → `Fail`，立刻报「启动后立即退出」。`restarting` 仍 Sleep。

### C. 编辑时若原容器不在列表里，会悄悄换成第一个 — 已修

`resolveDockerSelection` 保留原名并标 missing。保存按钮仅在当前选择存在于 `docker ps -a` 列表时可用。

### D. 自动执行不看 PTY 是否已退出 — 已修

`waitPtyQuiet` 订阅 `pty-exit`。已退出则不 `ptyWrite` 并提示；PTY 仍在则超时后仍注入，见 **K**。监听在 bootstrap 挂上，见 **E**。

---

## 第一次审查 · 已修复

### 1. `docker start` 成功后立刻 `exec` — 已修

现为循环 `inspect`（Status / Running / Paused），Paused 先 `unpause`，未 Running 则 `start`，`restarting` 则轮询，超时 20s。start 后 `exited`/`dead` 见 **B**。

### 2. 同步 Tauri 命令卡住 UI — 已修

`docker_list_containers` / `docker_ensure_running` 改为 `async` + `spawn_blocking`。

### 3. 自动执行命令的注入竞态 — 已修

改为全局 `pty-output` 监听 + `waitPtyQuiet`（默认静默 400ms，超时 8s），在 spawn 前挂上 watcher。PTY 退出见 **D** / **E**。无输出超时仍注入见 **K**。

### 4. Shell 写死成 `/bin/sh` — 已修

`fallbackSpawn` 指向 `/bin/bash`，并在 exec 真正失败后再试。见 **A** / **E** / **H**。

### 5. 空容器名仍会走进启动流程 — 已修

`ensureContainer` 为空时直接报「未指定容器」，不 `spawn`。

### 6. 对话框列表请求没有取消 — 已修

`useEffect` 用 `cancelled` 忽略过期的 `docker ps`。

### 7. 连上之后不能改容器 / 自动执行命令 — 已修

Docker Tab 右键「编辑」打开同一对话框，`updateDockerPane` 后 `restartPane`。原容器失踪见 **C**。

### 8. Docker 面板的终端尺寸记在 runner 桶里 — 已修

独立 `SessionKindKey: "docker"` 与 `last_docker_size`。

---

## 审查确认无问题的部分

- 配置字段能 round-trip；`docker_auto_exec=false` 和空命令不会写进 TOML。
- 拖拽进 Docker 终端明确不注入宿主机路径。
- Runner / Docker 共用底部常用命令。
- 同一项目多个 Docker 面板用不同 `paneId`，PTY id 不会撞。
- Rust 侧容器名走 argv 而不是拼进 shell；Windows 上 PTY 再包一层 `cmd /c` 时，`quote_cmd_arg` 覆盖了 `&|<>^`，常规 Docker 名是安全的。
- 空容器、unpause、异步 Docker CLI 行为符合预期。
- `ensure_step` 的 Fail、对话框保留失踪容器名、退出后不注入：第三次审查确认符合预期。
- `ensurePtyListeners`、探测时钟从 `observeGeneration` 起算：第四次审查确认符合预期。
- 静默超时不回退 bash、启动路径 persist 串行并按最新 config 合并：第五次审查确认 H / I 核心路径符合预期。
- 其余 persist 调用改为 updater、无输出超时仍注入：第六次修复确认 J / K 符合预期。
- 第七次审查未再发现问题的部分：列容器、拖拽不注入、尺寸桶、persist 串行、同名容器 `ensure` 锁、空容器名、失踪容器名保留。当时新问题见 **L–P**，已在第八次修复。
- 第八次修复确认 L–P 核心路径符合预期（in-flight 锁、exec 分类、编辑态 ps 失败仍可保存、ensure CLI 超时、注入失败且会话仍在则保持 running）。当时新问题见 **Q–U**，已在第十次修复。
