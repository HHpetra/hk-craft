import { useEffect, useRef, useState } from "react";
import { Bot, Columns2, FolderTree, Grid2x2, Plus, Square, Terminal, X } from "lucide-react";
import type { WorkspaceLayout, WorkspacePane } from "../../types";
import { cn, sessionId } from "../../lib/format";
import { paneTitle } from "../../lib/panes";
import { DRAG_THRESHOLD, finalIndex, insertSlot, lineForSlot, type DropLine } from "../../lib/reorder";
import { useActiveProject, useWorkspace } from "../../store/workspace";
import { StatusDot } from "../ui/StatusDot";

const layouts: { id: WorkspaceLayout; label: string; shortcut: string; icon: typeof Square }[] = [
  { id: "tabs", label: "Tab 切换", shortcut: "1", icon: Square },
  { id: "row", label: "一行平铺", shortcut: "2", icon: Columns2 },
  { id: "grid", label: "两行平铺", shortcut: "3", icon: Grid2x2 },
];

const PANE_SELECTOR = "[data-pane-id]";

function paneIcon(pane: WorkspacePane) {
  if (pane.kind === "explorer") return FolderTree;
  if (pane.kind === "runner") return Terminal;
  return Bot;
}

export function WorkspaceTabBar() {
  const project = useActiveProject();
  const presets = useWorkspace((s) => s.config?.agent_presets ?? []);
  const status = useWorkspace((s) => s.sessionStatus);
  const addPane = useWorkspace((s) => s.addPane);
  const closePane = useWorkspace((s) => s.closePane);
  const setLayout = useWorkspace((s) => s.setLayout);
  const setActivePane = useWorkspace((s) => s.setActivePane);
  const [menuOpen, setMenuOpen] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropLine, setDropLine] = useState<DropLine | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const idsRef = useRef<string[]>([]);
  const dragRef = useRef<{ id: string; startX: number; startY: number; active: boolean } | null>(null);
  const dragEndedAt = useRef(0);

  const panes = project?.panes ?? [];
  const layout = project?.layout ?? "row";
  const activeId = project?.active_pane_id ?? null;
  idsRef.current = panes.map((pane) => pane.id);

  useEffect(() => {
    if (!menuOpen) return;
    function onDown(event: MouseEvent) {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    }
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  useEffect(() => {
    const clearVisual = () => {
      setDraggingId(null);
      setDropLine(null);
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
    };

    const onMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      if (!drag.active) {
        const dist = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
        if (dist < DRAG_THRESHOLD) return;
        drag.active = true;
        setDraggingId(drag.id);
        document.body.style.cursor = "grabbing";
        document.body.style.userSelect = "none";
      }
      const root = rootRef.current;
      if (!root) return;
      const ids = idsRef.current;
      const slot = insertSlot(root, PANE_SELECTOR, event.clientX, "x");
      const next = lineForSlot(ids, slot, ids.indexOf(drag.id));
      setDropLine((prev) => (prev?.id === next?.id && prev?.place === next?.place ? prev : next));
    };

    const onUp = (event: PointerEvent) => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (!drag) return;
      if (!drag.active) {
        clearVisual();
        return;
      }
      dragEndedAt.current = Date.now();
      const root = rootRef.current;
      const ids = idsRef.current;
      const slot = root ? insertSlot(root, PANE_SELECTOR, event.clientX, "x") : -1;
      const toIndex = slot < 0 ? -1 : finalIndex(slot, ids.indexOf(drag.id));
      clearVisual();
      if (toIndex >= 0) void useWorkspace.getState().reorderPanes(drag.id, toIndex);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, []);

  return (
    <div
      ref={rootRef}
      className="relative z-20 flex h-10 shrink-0 items-center gap-1 border-b border-line bg-surface px-2"
    >
      <div className="flex min-w-0 items-center gap-1">
        <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
        {panes.map((pane) => {
          const Icon = paneIcon(pane);
          const sid = pane.kind === "explorer" ? null : sessionId(project!.id, pane.kind, pane.id);
          const dragging = pane.id === draggingId;
          const line = dropLine?.id === pane.id ? dropLine.place : null;
          return (
            <button
              key={pane.id}
              type="button"
              data-pane-id={pane.id}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                if ((event.target as HTMLElement | null)?.closest("[data-pane-close]")) return;
                dragRef.current = {
                  id: pane.id,
                  startX: event.clientX,
                  startY: event.clientY,
                  active: false,
                };
              }}
              onDragStart={(event) => event.preventDefault()}
              onClick={() => {
                if (Date.now() - dragEndedAt.current < 300) return;
                void setActivePane(pane.id);
              }}
              className={cn(
                "group relative flex shrink-0 cursor-grab touch-none select-none items-center gap-1.5 rounded-md px-2.5 py-1 text-ink-muted hover:bg-hover hover:text-ink",
                activeId === pane.id && "bg-active text-ink",
                dragging && "cursor-grabbing opacity-50",
              )}
            >
              {line === "before" && (
                <span className="pointer-events-none absolute inset-y-1 left-px z-10 w-px bg-ink" />
              )}
              <Icon size={14} className="pointer-events-none" />
              <span className="pointer-events-none max-w-36 truncate">{paneTitle(pane, panes, presets)}</span>
              {sid && <StatusDot status={status[sid]} className="pointer-events-none" />}
              <span
                role="button"
                tabIndex={0}
                data-pane-close=""
                title="关闭面板"
                className="ml-0.5 hidden rounded p-0.5 text-ink-subtle hover:text-ink group-hover:block"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  if (Date.now() - dragEndedAt.current < 300) return;
                  void closePane(pane.id);
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.stopPropagation();
                  void closePane(pane.id);
                }}
              >
                <X size={12} />
              </span>
              {line === "after" && (
                <span className="pointer-events-none absolute inset-y-1 right-px z-10 w-px bg-ink" />
              )}
            </button>
          );
        })}
        </div>
        {project && (
        <div ref={menuRef} className="relative shrink-0">
          <button
            type="button"
            title="新增面板"
            className={cn(
              "flex items-center rounded-md p-1.5 text-ink-muted hover:bg-hover hover:text-ink",
              menuOpen && "bg-active text-ink",
            )}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <Plus size={14} />
          </button>
          {menuOpen && (
            <div className="absolute left-0 top-full z-50 mt-1 min-w-44 rounded-md border border-line bg-surface-elevated py-1 shadow-lg">
              <button
                type="button"
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-ink-muted hover:bg-hover hover:text-ink"
                onClick={() => {
                  setMenuOpen(false);
                  void addPane("explorer");
                }}
              >
                <FolderTree size={14} />
                文件资源管理器
              </button>
              <button
                type="button"
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-ink-muted hover:bg-hover hover:text-ink"
                onClick={() => {
                  setMenuOpen(false);
                  void addPane("runner");
                }}
              >
                <Terminal size={14} />
                运行终端
              </button>
              {presets.length > 0 && <div className="my-1 border-t border-line" />}
              {presets.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-ink-muted hover:bg-hover hover:text-ink"
                  onClick={() => {
                    setMenuOpen(false);
                    void addPane("agent", preset.id);
                  }}
                >
                  <Bot size={14} />
                  {preset.name}
                </button>
              ))}
            </div>
          )}
        </div>
        )}
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1 pl-2">
        {layouts.map(({ id, label, shortcut, icon: Icon }) => (
          <button
            key={id}
            type="button"
            title={`${label} (Ctrl+${shortcut})`}
            disabled={!project}
            onClick={() => void setLayout(id)}
            className={cn(
              "flex items-center rounded-md p-1.5 text-ink-muted hover:bg-hover hover:text-ink disabled:opacity-40",
              layout === id && project && "bg-active text-ink",
            )}
          >
            <Icon size={14} />
          </button>
        ))}
      </div>
    </div>
  );
}
