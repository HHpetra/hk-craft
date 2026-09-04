# Docker 功能重构建议

审查范围：列容器 → `ensure running` → `docker exec` → shell 回退 → 静默后注入，以及面板类型在 UI / 配置 / PTY 上的扩散。对应实现见 `ai-docs/docker-bugs.md` 的文件表。本文只谈结构，不重复已修 bug。

结论先说：**行为已经能用，问题是 Docker 启动状态机被拆成一组可选字段，执行逻辑又埋在 Zustand store 里。** 再补功能会继续在 `paneLaunch` / `executePaneLaunch` / `ptyQuiet` 之间打补丁。优先把启动链路收成一个深模块，再收拾 `kind === "docker"` 的散点。

---

## 1. 现在好的部分（不要为了重构而拆）

这些模块已经够深，接口小、测试贴在接口上，保持即可。

| 模块 | 为什么先不动 |
| :--- | :--- |
| `src-tauri/src/docker.rs` | `ensure_step` / `parse_ps_*` / `parse_inspect_state` 纯逻辑可测；CLI 走 argv，Windows 藏 `CREATE_NO_WINDOW`。 |
| `src/lib/dockerSelect.ts` | 失踪容器名的选择规则就几行，已有测试。 |
| `src/lib/ptyWait.ts` | generation 武装、静默、exit 监听是通用 PTY 工具，不是 Docker 专属。 |
| `src/lib/serialQueue.ts` | persist 排队与 Docker 无关，已服务整个 workspace。 |
| TOML 字段形状 | `docker_container` / `docker_auto_exec` / `docker_exec_command` 能 round-trip；不要改成 nested table，除非愿意做配置迁移。 |

Rust 侧继续用本机 `docker` CLI，不要引入 Docker SDK。PTY 仍由现有 `pty_spawn` 拉起 `docker exec`，不要另起一套容器内 PTY 协议。

---

## 2. 核心问题：启动计划是浅接口

`PaneLaunchPlan` 用同一组字段同时表达四种完全不同的故事：

```text
skip | runner spawn | agent resume(+fallback 清 session) | docker ensure + exec sh/bash + 注入
```

Docker 专属行为被摊成可选开关：

- `ensureContainer?: string` — `undefined` / `""` / 非空 三种含义
- `postWrite?: string | null`
- `retryOnExecFail?: boolean`
- `fallbackSpawn` — Agent 表示「resume 失败改全新启动」；Docker 表示「sh 没有再试 bash」

执行端 `executePaneLaunch`（`src/store/workspace.ts`，约 150 行）用这些开关拼出状态机：ensure → spawn+watch → 可能 `ptyKill` → 再 spawn → 注入。Agent 的 `catch { fallbackSpawn }` 和 Docker 的 `retryOnExecFail` 叠在同一条路径上。

这是浅模块的典型症状：**调用方必须理解整张旗标表才能用对**。store 还直接调 `dockerEnsureRunning`、`waitPtyQuiet`、`isPtyExecFailure`，Docker 探测时钟（`PTY_EXEC_PROBE_MS`）和缺解释器启发式（`looksLikeMissingShell`）却放在通用的 `ptyQuiet.ts`。

`executePaneLaunch` 目前几乎没有单测，只能靠 `planPaneLaunch` 的快照测试和手工点 Docker。补丁都堆在这条链上，下一次回归会继续发生在 store 内部。

---

## 3. 建议（按优先级）

### P0 — 把 Docker 启动收成一个深模块

**目标接口**（示意，名字可改）：

```ts
type DockerLaunchInput = {
  sessionId: string;
  container: string;          // trim 后；空则直接失败，不要用 "" sentinel
  shells: string[];           // 默认 ["/bin/sh", "/bin/bash"]
  postWrite: string | null;
  killFirst: boolean;
};

type LaunchDeps = {
  ensureRunning: (name: string) => Promise<void>;
  spawn: (opts: SpawnOpts) => Promise<SpawnResult>;
  write: (sessionId: string, data: string) => Promise<void>;
  clearSession: (sessionId: string) => Promise<void>;
  waitQuiet: typeof waitPtyQuiet;
};

type LaunchOutcome =
  | { ok: true }
  | { ok: false; reason: "empty-container" | "ensure" | "no-shell" | "inject" | "spawn"; detail: string };
```

`planPaneLaunch` 对 Docker 只产出 `DockerLaunchInput`（或带 tag 的 union，见 P1）。`executeDockerLaunch(input, deps)` 吃下 ensure / shell 回退 / 注入。store 只做：调它、把 `outcome` 映射成 toast / `sessionStatus`。

收益：

- Docker 状态机有单一 locality；`ptyQuiet` 里的 Docker 启发式可以挪到这个模块旁边。
- 测试从接口走：fake `ensure` / `spawn` / `waitQuiet`，覆盖「sh 立刻 exit → bash」「静默超时不杀 sh」「已退出不注入」——这些目前只能靠审查。
- Agent resume fallback 不再和 Docker shell fallback 共用 `fallbackSpawn`。

不要在这一步把 Docker 启动塞进 Rust。前端深模块就能删掉 store 里的旗标迷宫；Rust `docker.rs` 继续只负责 list / ensure。

### P1 — `PaneLaunchPlan` 改成可辨识联合

与 P0 一起做。计划层不要再返回「一袋可选字段」：

```ts
type PaneLaunchPlan =
  | { action: "skip"; sessionId: string }
  | { action: "spawn"; kind: "runner"; sessionId: string; killFirst: boolean; spawn: SpawnOpts }
  | { action: "spawn"; kind: "agent"; sessionId: string; killFirst: boolean; spawn: SpawnOpts;
      resumeFallback: SpawnOpts | null; markAgentSeen: boolean }
  | { action: "spawn"; kind: "docker"; sessionId: string; killFirst: boolean; input: DockerLaunchInput };
```

`ensureContainer: ""` 这种 sentinel 消失：空容器是 Docker 分支里的校验，不是「spawn 但 spawn 为 null」。`failNoticePrefix` 也可删，改由 `kind` 映射（与 `sessionKindLabel` 合并，见 P2）。

`planPaneLaunch` 里 skip / runner / 空 Docker 目前复制同一坨默认字段，联合类型会自然逼出 `skipPlan(sessionId)` 这种小构造器。

### P2 — 面板能力表，收掉 `kind === "docker"` 喷雾

每加一种终端面板，现在要改大约这些地方：`types`、`format.isSessionKind`、`panes.terminalPanes` / `paneTitle`、`status.sessionKindLabel`、`termRegistry` 的 fitted size 桶、`dnd`、`WorkspacePanels`、`WorkspaceTabBar` 图标与右键、`paneLaunch`、store 的 `addPane` 签名。Docker 已经演示了这次扩散。

集中成一份能力描述（放 `src/lib/panes.ts` 或独立 `paneCaps.ts`）：

```ts
const SESSION_KINDS = ["agent", "runner", "docker"] as const;

type PaneCaps = {
  terminal: boolean;
  acceptsPathDrop: boolean;
  quickCommands: boolean;
  contextEdit: "docker" | null;
  sizeBucket: SessionKind | null;
};
```

`terminalPanes`、`isSessionKind`、`injectableSession`、是否渲染 `RunnerQuickBar`、是否挂 drop overlay，都读这张表。`termRegistry` 的 `SessionKindKey` 直接复用 `SessionKind`，不要再维护一份平行类型。

`last_agent_size` / `last_runner_size` / `last_docker_size` 可以暂时保留 TOML 字段名（避免迁移），内部用 `Record<SessionKind, FittedSize>` 读写。

`addPane` 与 `addDockerPane` 后半段（persist + `spawnForProject`）几乎相同，收成 `appendPane(pane: WorkspacePane)`；创建规则仍留在 `createPane` / `createDockerPane`。

`RunnerQuickBar` 已给 Docker 用，改名为 `QuickCommandBar`（或 `TerminalQuickBar`），避免下一个读者以为 Docker 不该有这条栏。

### P3 — 数据模型：TS 可辨识，TOML 保持扁平

`WorkspacePane` 现在是所有 kind 共用的可选字段袋：explorer 也能带 `docker_exec_command`。TypeScript 侧改成：

```ts
type WorkspacePane =
  | { id: string; kind: "explorer" }
  | { id: string; kind: "agent"; preset_id?: string | null; agent_session_id?: string | null }
  | { id: string; kind: "runner" }
  | { id: string; kind: "docker"; docker_container?: string | null; docker_auto_exec?: boolean; docker_exec_command?: string };
```

Rust `WorkspacePane` **保持现在的扁平 serde**。TOML 不引入 `[pane.docker]` 嵌套，也不做 tagged enum 迁移。前后端模型本来就不需要 1:1 同构；前端收紧类型，后端继续宽容未知字段。

### P4 — 可选：同名容器的 `ensure` 串行化

`spawnForProject` 已对多面板 `Promise.all`。两个 Docker pane 绑同一容器时，会并行跑两次 `docker_ensure_running`（start / unpause 交错）。`docker start` 大体幂等，`unpause` 两次则可能有一个失败。

在 `docker.rs` 按容器名加一把锁（`Mutex<HashMap<String, Arc<Mutex<()>>>>` 或单飞 `JoinHandle`）成本低，接口不变。不必为此上 tokio Docker API。

### P5 — 更激进的备选：shell 探测下沉到 Rust

若 P0 之后 shell 回退仍继续出回归，再考虑把「选解释器」藏进 Rust，而不是前端看 PTY 输出猜：

```text
ensure running → docker exec … command -v sh/bash 或逐个尝试 → 成功的 argv 交给 pty_spawn
```

前端就不再需要 `retryOnExecFail`、`PTY_EXEC_PROBE_MS`、`looksLikeMissingShell`。这会把 Docker 知识推进 `pty` 或扩展 `docker.rs`，接口变大，**现在不要做**——当前 CLI-in-PTY 模型和 Agent/Runner 一致，P0 的前端深模块已经能测回退。只有当启发式再误杀一次，才值得付这条 seam 的代价。

---

## 4. 建议的目标形状

```text
planPaneLaunch()                纯函数：pane → 可辨识计划
        │
        ├─ runner / agent  → executeAgentOrRunnerLaunch()   现有 spawn + resume fallback
        └─ docker          → executeDockerLaunch()          ensure + shells + postWrite
                                    │
                                    ├─ dockerEnsureRunning          Rust 已有
                                    ├─ waitPtyQuiet / ptyQuiet      通用等待
                                    └─ looksLikeMissingShell        挪到 docker launch 旁
        │
useWorkspace.executePaneLaunch  薄适配：计划 + toast/persist/status
```

`DockerPaneDialog` 继续只负责选容器和编辑；`resolveDockerSelection` 保持独立。不要把 list / 表单状态再拆一层 hook，除非对话框开始被第三处复用。

---

## 5. 明确不建议

- **不要**为 Docker 单独做一套 PTY 会话协议或前端伪终端。
- **不要**把 Agent 预设绑进 Docker pane（产品已否决）；自动执行命令就是当前的扩展点。
- **不要**把 `docker.rs` 拆成多个文件；约 250 行加测试，一个模块刚好。
- **不要**把 `WorkspacePane` 的 TOML 改成 tagged enum / nested table，纯属迁移成本。
- **不要**先抽 `LaunchDeps` 端口再写第二种 adapter。现在只有 Tauri invoke 一种实现；P0 的 `deps` 是为了单测注入，属于模块**内部 seam**，不要暴露成应用级 plugin。
- **不要**在能力表之外再搞插件式 pane registry。四种 kind 是封闭集合，一张表足够。

---

## 6. 建议落地顺序

1. **抽出 `executeDockerLaunch` + 把 `looksLikeMissingShell` / `PTY_EXEC_PROBE_MS` 移出 `ptyQuiet.ts`**，store 改为调用。补 fake deps 测试覆盖回退与注入。行为零变化。
2. **`PaneLaunchPlan` 改联合类型**，删 `ensureContainer: ""` 与 `retryOnExecFail`。`paneLaunch.test.ts` 按新形状改断言。
3. **能力表 + `appendPane` + 改名 QuickCommandBar**。顺手让 `isSessionKind` / fitted size 共用 `SESSION_KINDS`。
4. （可选）Rust 侧同名容器 `ensure` 单飞。
5. （观望）前端启发式再出问题，再评估 P5 的 Rust shell 探测。

第 1 步单独可做、可回滚，也是对 `docker-bugs.md` 里 H/K 那类回归最有效的结构修复。后几步是给「下一种面板」减扩散，不是修当前功能。
