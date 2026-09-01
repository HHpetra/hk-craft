# Terminal 光标逻辑 Review

> 日期：2026-09-01
> 范围：`src/lib/termRegistry.ts`、`src/store/workspace.ts`、`src/components/terminal/TerminalPane.tsx`、`src-tauri/src/pty/mod.rs`
> 重点：transcript 回放 → origin 标记 → CUP 行映射 → 启动自愈 → resize/spawn 时序 的完整光标链路
> 结论：主链路设计成立（wrap-pending 检测、origin 映射、snap timer 自愈均验证无误），但存在 2 个确定性缺陷与若干边角风险。

---

## 1. [高] Runner 重启后 `rowOrigins` 残留 → 提示符错位（同款 bug 第三触发路径）

`restartSession`（`src/store/workspace.ts:388`）走的是 `clearTerminal`，而 `clearTerminal` 只清了 `pending` 和 `term` 本身：

```ts
// src/lib/termRegistry.ts:709
export function clearTerminal(sessionId: string) {
  pending.delete(sessionId);
  const entry = registry.get(sessionId);
  entry?.term.clear();
  entry?.term.reset();
}
```

对比 `disposeTerminal`（`termRegistry.ts:717-722`）会清 `clearRunnerStartup` / `rowOrigins` / `startupMeta`，`clearTerminal` 一个都没清。

**后果链**：

1. 回放过 transcript 的 runner，`rowOrigins` 存着非零 origin（例如 25）；
2. 点"重新启动" → `term.reset()` 把 `baseY` 归零，但 `rowOrigins[sessionId]` 仍是 25；
3. 新 PowerShell 的首批 CUP（PSReadLine 的 row 1–2）进入 `applyRowMap`（`termRegistry.ts:403`），`offset = 25 - 0 = 25`；
4. 提示符被画到屏幕中下部，上方一截空白——与已修复的存盘回放 bug 表现一致；
5. 重启路径不经过 `getOrCreateRunnerTerminal`，没有 `armRunnerStartup`，snap timer 的 `recaptureRunnerOrigin` + `moveCursorToContentEnd` 自愈不会发生；映射要等用户碰巧执行 `cls`（`\x1b[2J`）才解除。

**修复建议**：`clearTerminal` 内补上与 `disposeTerminal` 对齐的三行：

```ts
clearRunnerStartup(sessionId);
rowOrigins.delete(sessionId);
startupMeta.delete(sessionId);
```

---

## 2. [中] generation 竞态：重 spawn 后首批输出/退出事件被静默丢弃

```ts
// src/store/workspace.ts:92
async function spawnPty(opts: SpawnOpts): Promise<SpawnResult> {
  const size = terminalSize(opts.sessionId) ?? (await waitTerminalSize(opts.sessionId));
  const result = await ptySpawn(size ? { ...opts, cols: size.cols, rows: size.rows } : opts);
  setSessionGeneration(opts.sessionId, result.generation); // IPC 返回后才设置
  return result;
}
```

后端 reader 线程在 `spawn_inner` 返回前就开始发 `pty-output`（`src-tauri/src/pty/mod.rs:220`）。重 spawn 场景（runner 手动重启、`setTheme` 批量重启 agent）下，新 generation 的事件到达时前端 map 里还是旧值，`isCurrentGeneration`（`termRegistry.ts:517`）返回 false 直接丢弃；且此时 entry 存在，连 `pending` 缓冲都不进。

**影响**：首屏 prompt 渲染可能整段丢失，屏幕停在空白直到下一次输出。窗口窄（IPC 往返内）但非零，`setTheme` 批量重启时按会话数放大。

**修复建议**：`isCurrentGeneration` 改为接受 `generation >= current` 并顺带更新 map。generation 单调递增，旧 gen 迟到输出仍被拒绝，语义不变但关闭竞态窗口。

---

## 3. [中低] `waitTerminalSize` 800ms 超时回退 80x24 的兜底洞

两个触发场景：

- **单焦模式下新增/切换项目**：如 Ctrl+2 只看 Agent 时，runner 面板被 `layoutFor` 压到 0% 宽（`WorkspacePanels.tsx:9`），`proposeDimensions` 返回空，`fitted` 不亮，800ms 后按 80x24 spawn；
- **大 transcript 回放耗时 > 800ms**：`writeAndWait` 逐段写期间 fit 尚未完成，计时先耗尽。

之后首次 fit 触发 grow-resize，ConPTY 的 erase-line+CRLF 洪流落在回放内容上。当前 `stripScreenWipes`（`termRegistry.ts:311`）已不再剥离 `\x1b[K\r\n`，根治完全依赖"以正确尺寸 spawn"一条腿；此路径下只有 snap timer 的 `moveCursorToContentEnd` 事后把光标拉回，中间有数百 ms 视觉错乱窗口。

**可选加固**（按简单优先原则，可只记录）：

- 超时后使用"该项目上次尺寸"（持久化到 config）代替全局 80x24；
- 或回放完成前不启动超时计时。

---

## 4. [低] 回放在 80x24 下进行，fit 后 reflow 使 origin 失准

`getOrCreateRunnerTerminal`（`termRegistry.ts:615-636`）在 host 未挂 DOM 时 open + 回放 transcript，此时终端是默认 80x24。若 transcript 含超过 80 列的自动换行长行，随后 fit 到真实尺寸触发 reflow，绝对行号整体移位，`markRunnerRowOrigin` 记下的 `absY` 失效 → 启动早期 CUP 映射偏移。

有 snap timer recapture 兜底自愈，仅启动瞬间短暂错位。彻底修法是把回放推迟到首次 fit 之后，但违背当前简化方向，记录即可。

---

## 5. [低] `takeTail` 可能从转义序列/代理对中间切断

`serializeRunner` 末尾 `takeTail(trimmed, 512_000)`（`termRegistry.ts:660`）按字符硬切，可能切在 CSI/OSC 序列或 UTF-16 代理对中间 → 下次回放首行乱码。

**建议**：切完后丢弃到第一个 `\r\n` 为止（首行本来就不完整）。

---

## 6. [低] `stripSerializeWrapHacks` 两处脆弱点

对照 `@xterm/addon-serialize` 源码（`"-".repeat(this._nullCellCount+1)` + `\x1b[1D\x1b[1X`）确认：

- `_nullCellCount === 0` 时 addon 只填 **1 个**连字符，而正则要求 `-{2,}`，单连字符情形不匹配，残留 `-\x1b[1D\x1b[1X`。实测回放效果是写入即擦除，视觉无害——但这是巧合而非设计；
- 剥掉可选的 `\x1b[A…\x1b[B` 定位序列后，紧跟的 wrapped 续行内容落点会改变。需要"行尾 null cell + 样式匹配"才触发，罕见。

建议在注释中写明该启发式的前提条件。

---

## 7. [观察项] 刻意的光标脱钩手段（设计成立，记录风险）

- `moveCursorToContentEnd`（`termRegistry.ts:437`）注入的 CUP 是 ConPTY 不知道的单向矫正。PSReadLine 下次按键用绝对 CUP 自愈；但启动后立刻运行的非 PSReadLine 程序可能在一个错误位置输出一行；
- `finishReplay` 末尾写入的 `\x1b7`（DECSC）改变终端 saved-cursor 状态，若后续程序裸发 `\x1b8` 会跳回 origin。PowerShell 与主流 TUI 不这么干，风险低。

---

## 已验证无问题的点（排除项）

| 检查点 | 结论 |
| :--- | :--- |
| `finishReplay` 的 `cursorX >= cols` wrap-pending 检测 | 无头 xterm 实测：写满最后一列后 `cursorX === cols` 成立，检测正确 |
| `applyRowMap` 随滚动自然失效（`baseY` 增长使 offset ≤ 0） | 设计成立，无累积漂移 |
| `applyRowMap` 检查的是 wipe 后的数据 | 一致：被剥离的 2J 不会误触 origin 解除 |
| 单焦模式 0% 宽面板的 fit | `proposeDimensions` 返回空 → 提前返回，不会发出 0x0 resize；`ptyResize` 后端另有 <2 防护 |
| 非激活项目面板 | 保持挂载仅 `invisible`，尺寸不变，`interactive` 门控阻止误 fit |
| generation=0 特例 | 后端 generation 从 1 开始，仅作缺省兜底，无副作用 |
| `moveCursorToContentEnd` 的列钳制（`cols - 1`） | 正确避免 wrap-pending 导致光标落下一行 |

---

## 修复优先级汇总

| # | 严重度 | 位置 | 工作量 |
| :--- | :--- | :--- | :--- |
| 1 | 高 | `clearTerminal` 补清 runner 状态 | 3 行 |
| 2 | 中 | `isCurrentGeneration` 改 `>=` 并接受时更新 | 2 行 |
| 3 | 中低 | spawn 尺寸兜底策略 | 视方案 |
| 5 | 低 | `takeTail` 切到首个换行 | 2 行 |
| 4/6/7 | 低/观察 | 记录即可 | — |
