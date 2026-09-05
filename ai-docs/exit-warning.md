# 退出前 Agent 运行检测提示（功能实现计划）

需求：软件退出前，若仍有 Agent（及 Runner / Docker）会话在运行，弹出确认提示，避免用户误关导致进行中的任务被中断。

结论先说：**退出流程集中在 `src/hooks/useAgentSessionCapture.ts` 的 `onCloseRequested` 一处，状态判断由 `usePtyStatusListener` 对所有 PTY 统一维护，改动小、可回滚。** 只需新增一个"活跃会话统计"纯函数，在关闭回调里拦截并弹系统原生确认框。

---

## 1. 现状与可行性（已确认）

### 1.1 退出流程唯一入口

`src/hooks/useAgentSessionCapture.ts:34` 的 `onCloseRequested` 是拦截用户点关闭按钮的唯一挂点：

```ts
void getCurrentWindow().onCloseRequested(async (event) => {
  if (closing) return;
  event.preventDefault();
  try { await snapshotOpenedSessions(); }
  finally { closing = true; unlisten?.(); await getCurrentWindow().destroy(); }
});
```

- 关闭前已先 `snapshotOpenedSessions()`（把当前 agent session 写回配置，便于下次恢复），再 `destroy()`。
- `closing` 防重入；`unlisten` 只解绑一次。
- **限制**：只拦截"用户点关闭按钮"。OS 注销、`app.quit()` 强制销毁不经此回调——本功能覆盖交互退出，够用。

### 1.2 状态判断：三种 kind 同等容易（Q1 结论）

`usePtyStatusListener`（`src/hooks/usePtyStatusListener.ts`）对所有 PTY 会话统一维护 `sessionStatus: Record<sessionId, SessionStatus>`，**不区分 kind**：

| 事件 | 状态迁移 |
| :--- | :--- |
| `pty-output` | → `running` |
| 静默超时 `SILENCE_MS`(1.5s) | → `waiting` |
| `pty-exit` | → `exited` / `error` |

`ptyActivity.ts` 的 `decidePtySilence` / `decidePtyExit` 只认 `currentStatus` 参数，不读 kind。因此 **agent、runner、docker 三者的"活跃"判定完全同构**：遍历 `terminalPanes(project)` 取 `paneSessionId()`，查 `sessionStatus[sid]` 是否 `running` / `waiting`。

> 设计决策：**三者在退出时全部纳入统计**。退出会杀掉所有 PTY 子进程，只拦 Agent 会漏掉运行中的 Runner / Docker 任务；判定成本完全相同。若产品只想拦 Agent，删掉遍历时对 `kind !== "agent"` 的过滤即可（见 §5）。

### 1.3 对话框形式（Q2 结论）

项目已依赖 `@tauri-apps/plugin-dialog`（`src/lib/dialog.ts` 用它做目录选择），直接复用其 `confirm()`，改动最小、不引入 UI 状态：

```ts
const ok = await confirm(message, {
  title: "退出确认",
  kind: "warning",
  okLabel: "退出",
  cancelLabel: "取消",
});
if (!ok) return; // 不销毁窗口
```

### 1.4 统计范围（Q3 结论）

只统计**已打开（`openedProjectIds`）**项目下的终端窗格。已收纳 / 未打开项目的 PTY 本已关闭，不纳入。

---

## 2. 修改计划

### 2.1 新增纯函数：活跃会话统计

放 `src/store/workspace.ts`（与 `sessionStatus` 同文件，直接用 `useWorkspace.getState()`），或独立成 `src/lib/` 模块。建议放 `src/lib/panes.ts`（已有 `terminalPanes` / `paneSessionId`），保持纯逻辑可测。

```ts
import { useWorkspace } from "../store/workspace";
import { terminalPanes, paneSessionId } from "./panes";

export type ActiveSession = { projectName: string; kind: SessionKind };

export function activeRunningSessions(): ActiveSession[] {
  const { config, openedProjectIds, sessionStatus } = useWorkspace.getState();
  if (!config) return [];
  const found: ActiveSession[] = [];
  for (const project of config.projects) {
    if (!openedProjectIds.includes(project.id)) continue;
    for (const pane of terminalPanes(project)) {
      const sid = paneSessionId(project.id, pane);
      if (!sid) continue;
      const status = sessionStatus[sid];
      if (status === "running" || status === "waiting") {
        found.push({ projectName: project.name, kind: pane.kind });
      }
    }
  }
  return found;
}
```

说明：
- 状态取 `running`（有输出）与 `waiting`（有对话但静默）为"活跃"；`idle` / `exited` / `error` 不算。
- `paneSessionId` 已过滤非终端窗格（explorer），无需再判 kind；kind 取自 `pane.kind`。

### 2.2 修改退出回调：拦截 + 确认

`src/hooks/useAgentSessionCapture.ts`：

```ts
import { confirm } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { activeRunningSessions } from "../lib/panes";

void getCurrentWindow().onCloseRequested(async (event) => {
  if (closing) return;
  event.preventDefault();
  const running = activeRunningSessions();
  if (running.length > 0) {
    await getCurrentWindow().unminimize(); // 最小化时先还原，确保对话框可见
    const label = running.map((i) => `${i.projectName}·${i.kind}`).join("、");
    const ok = await confirm(
      `还有 ${running.length} 个终端会话正在运行（${label}）。\n退出将终止这些进程，确定退出吗？`,
      { title: "退出确认", kind: "warning", okLabel: "退出", cancelLabel: "取消" },
    );
    if (!ok) return; // 取消：保留窗口，不销毁
  }
  try { await snapshotOpenedSessions(); }
  finally { closing = true; unlisten?.(); await getCurrentWindow().destroy(); }
});
```

### 2.3 消息文案

- 无活跃会话：不弹框，原逻辑直接关闭。
- 有活跃会话：提示数量 + 具体（`项目名·kind`），明确"退出将终止进程"。
- 取消：不置 `closing`，窗口保留，可继续操作。

---

## 3. 边界情况

| 场景 | 处理 |
| :--- | :--- |
| 窗口已最小化 | 弹框前 `unminimize()`，避免原生对话框不显示 |
| 取消退出 | 不置 `closing`，不销毁，后续仍可再点关闭 |
| `snapshotOpenedSessions` 抛错 | 走 `finally` 仍销毁（与现有行为一致） |
| OS 注销 / `app.quit()` | 不经 `onCloseRequested`，本功能不覆盖（接受） |
| 无活跃会话 | 与现行为完全一致，零变化 |

---

## 4. 验证

1. **静态检查**：`pnpm type-check`（EXIT=0）。
2. **单测**（若函数放 `src/lib/panes.ts`）：为 `activeRunningSessions` 补测试——用构造的 `config` + `sessionStatus` 覆盖：
   - 无活跃 → 空数组
   - 仅 `running` / 仅 `waiting` → 各命中
   - `idle` / `exited` / `error` → 不命中
   - 未打开项目 → 不计入
   - explorer 窗格 → 不计入
3. **手动 E2E**（`pnpm dev`）：
   - 打开项目、跑一个运行中任务 → 点关闭 → 弹确认框 → 取消保留 / 确认退出。
   - 无活跃会话 → 直接关闭不弹框。
   - 窗口最小化时点关闭 → 还原并弹框。

---

## 5. 待确认决策

1. **纳入范围**：默认 agent + runner + docker 全纳入（§1.2 理由）。若产品仅想拦 Agent，在 `activeRunningSessions` 遍历处加 `if (pane.kind !== "agent") continue;` 即可。
2. **统计口径**：`running` 与 `waiting` 均视为"活跃"。若只认 `running`，删掉 `|| status === "waiting"`。

---

## 6. 明确不做

- **不做**跨会话注册表 / 新状态机：`sessionStatus` 已够用，不加并行数据。
- **不做**自定义 React 弹窗：原生 `confirm()` 满足需求、改动最小，符合极简原则。
- **不做**Rust 端改动：无需新 Tauri 命令，纯前端拦截。
- **不做**对 `app.quit()` 的兜底拦截：覆盖面与当前退出模型一致。

---

## 7. 落地顺序

1. 新增 `activeRunningSessions`（放 `src/lib/panes.ts`）+ 单测。
2. 改 `useAgentSessionCapture.ts` 的 `onCloseRequested`。
3. `pnpm type-check` + `pnpm test`。
4. 手动 E2E 验证。

每步独立可回滚；核心是一处回调 + 一个纯函数，改动量约 40 行。
