import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, Plus, X } from "lucide-react";
import { ptyWrite } from "../../lib/api";
import { cn } from "../../lib/format";
import { commandPayload } from "../../lib/quickCommands";
import { DRAG_THRESHOLD, finalIndex, insertSlot, lineForSlot, type DropLine } from "../../lib/reorder";
import { useActiveProject, useWorkspace } from "../../store/workspace";
import type { QuickCommand } from "../../types";

const CMD_SELECTOR = "[data-quick-id]";
const SCROLL_STEP = 96;
const EMPTY_COMMANDS: QuickCommand[] = [];

type DialogState =
  | { mode: "add" }
  | { mode: "edit"; id: string; name: string; command: string };

type MenuState = { id: string; x: number; y: number };

function isLive(status: string | undefined) {
  return status === "running" || status === "waiting";
}

function runCommand(sessionId: string, command: string) {
  const status = useWorkspace.getState().sessionStatus[sessionId];
  if (!isLive(status)) return;
  void ptyWrite(sessionId, commandPayload(command)).catch(() => undefined);
}

export function QuickCommandBar({ sessionId }: { sessionId: string }) {
  const project = useActiveProject();
  const addQuickCommand = useWorkspace((s) => s.addQuickCommand);
  const updateQuickCommand = useWorkspace((s) => s.updateQuickCommand);
  const removeQuickCommand = useWorkspace((s) => s.removeQuickCommand);
  const reorderQuickCommands = useWorkspace((s) => s.reorderQuickCommands);
  const commands = project?.quick_commands ?? EMPTY_COMMANDS;

  const listRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const idsRef = useRef<string[]>([]);
  const dragRef = useRef<{ id: string; startX: number; startY: number; active: boolean } | null>(null);
  const dragEndedAt = useRef(0);

  const [overflow, setOverflow] = useState(false);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropLine, setDropLine] = useState<DropLine | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);

  idsRef.current = commands.map((item) => item.id);

  useEffect(() => {
    const root = listRef.current;
    if (!root) return;

    function sync() {
      const el = listRef.current;
      if (!el) return;
      const extra = el.scrollWidth > el.clientWidth + 1;
      setOverflow(extra);
      setCanLeft(el.scrollLeft > 1);
      setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
    }

    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(root);
    root.addEventListener("scroll", sync, { passive: true });
    return () => {
      ro.disconnect();
      root.removeEventListener("scroll", sync);
    };
  }, [commands]);

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
        setMenu(null);
        document.body.style.cursor = "grabbing";
        document.body.style.userSelect = "none";
      }
      const root = listRef.current;
      if (!root) return;
      const ids = idsRef.current;
      const slot = insertSlot(root, CMD_SELECTOR, event.clientX, "x");
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
      const root = listRef.current;
      const ids = idsRef.current;
      const slot = root ? insertSlot(root, CMD_SELECTOR, event.clientX, "x") : -1;
      const toIndex = slot < 0 ? -1 : finalIndex(slot, ids.indexOf(drag.id));
      clearVisual();
      if (toIndex >= 0) void reorderQuickCommands(drag.id, toIndex);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [reorderQuickCommands]);

  useEffect(() => {
    if (!menu) return;
    function onDown(event: MouseEvent) {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(null);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setMenu(null);
    }
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  function openMenu(event: ReactMouseEvent, id: string) {
    event.preventDefault();
    const width = 112;
    const x = Math.min(event.clientX, window.innerWidth - width - 8);
    const y = Math.min(event.clientY, window.innerHeight - 72);
    setMenu({ id, x: Math.max(8, x), y: Math.max(8, y) });
  }

  function scrollByDir(delta: number) {
    listRef.current?.scrollBy({ left: delta, behavior: "smooth" });
  }

  return (
    <div className="flex h-8 shrink-0 items-center gap-0.5 border-t border-line bg-surface px-1">
      <button
        type="button"
        title="添加常用命令"
        className="flex size-6 shrink-0 items-center justify-center rounded text-ink-muted hover:bg-hover hover:text-ink"
        onClick={() => {
          setMenu(null);
          setDialog({ mode: "add" });
        }}
      >
        <Plus size={14} />
      </button>
      {overflow && (
        <button
          type="button"
          title="向左"
          disabled={!canLeft}
          className="flex size-6 shrink-0 items-center justify-center rounded text-ink-muted hover:bg-hover hover:text-ink disabled:opacity-30"
          onClick={() => scrollByDir(-SCROLL_STEP)}
        >
          <ChevronLeft size={14} />
        </button>
      )}
      <div
        ref={listRef}
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-hidden whitespace-nowrap"
      >
        {commands.map((item) => {
          const dragging = item.id === draggingId;
          const line = dropLine?.id === item.id ? dropLine.place : null;
          return (
            <button
              key={item.id}
              type="button"
              data-quick-id={item.id}
              title={item.command}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                dragRef.current = {
                  id: item.id,
                  startX: event.clientX,
                  startY: event.clientY,
                  active: false,
                };
              }}
              onDragStart={(event) => event.preventDefault()}
              onClick={() => {
                if (Date.now() - dragEndedAt.current < 300) return;
                runCommand(sessionId, item.command);
              }}
              onContextMenu={(event) => openMenu(event, item.id)}
              className={cn(
                "relative max-w-40 shrink-0 cursor-grab touch-none select-none truncate rounded px-2 py-0.5 text-xs text-ink-muted hover:bg-hover hover:text-ink",
                dragging && "cursor-grabbing opacity-50",
              )}
            >
              {line === "before" && (
                <span className="pointer-events-none absolute inset-y-0.5 left-px z-10 w-px bg-ink" />
              )}
              {item.name}
              {line === "after" && (
                <span className="pointer-events-none absolute inset-y-0.5 right-px z-10 w-px bg-ink" />
              )}
            </button>
          );
        })}
      </div>
      {overflow && (
        <button
          type="button"
          title="向右"
          disabled={!canRight}
          className="flex size-6 shrink-0 items-center justify-center rounded text-ink-muted hover:bg-hover hover:text-ink disabled:opacity-30"
          onClick={() => scrollByDir(SCROLL_STEP)}
        >
          <ChevronRight size={14} />
        </button>
      )}
      {menu &&
        createPortal(
          <div
            ref={menuRef}
            className="fixed z-50 min-w-28 rounded-md border border-line bg-surface-elevated py-1 shadow-xl"
            style={{ left: menu.x, top: menu.y }}
          >
            <button
              type="button"
              className="flex w-full px-3 py-1.5 text-left text-xs text-ink-muted hover:bg-hover hover:text-ink"
              onClick={() => {
                const item = commands.find((cmd) => cmd.id === menu.id);
                setMenu(null);
                if (!item) return;
                setDialog({ mode: "edit", id: item.id, name: item.name, command: item.command });
              }}
            >
              编辑
            </button>
            <button
              type="button"
              className="flex w-full px-3 py-1.5 text-left text-xs text-ink-muted hover:bg-hover hover:text-ink"
              onClick={() => {
                const id = menu.id;
                setMenu(null);
                void removeQuickCommand(id);
              }}
            >
              删除
            </button>
          </div>,
          document.body,
        )}
      {dialog &&
        createPortal(
          <QuickCommandDialog
            initial={dialog}
            onClose={() => setDialog(null)}
            onSave={(name, command) => {
              if (dialog.mode === "add") void addQuickCommand(name, command);
              else void updateQuickCommand(dialog.id, name, command);
              setDialog(null);
            }}
          />,
          document.body,
        )}
    </div>
  );
}

function QuickCommandDialog({
  initial,
  onClose,
  onSave,
}: {
  initial: DialogState;
  onClose: () => void;
  onSave: (name: string, command: string) => void;
}) {
  const [name, setName] = useState(initial.mode === "edit" ? initial.name : "");
  const [command, setCommand] = useState(initial.mode === "edit" ? initial.command : "");
  const canSave = Boolean(name.trim() && command.trim());

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50">
      <form
        className="w-[440px] max-w-[90vw] rounded-lg border border-line bg-surface-elevated p-4 shadow-xl"
        onSubmit={(event) => {
          event.preventDefault();
          if (!canSave) return;
          onSave(name, command);
        }}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-medium text-ink">{initial.mode === "add" ? "添加常用命令" : "编辑常用命令"}</h2>
          <button type="button" onClick={onClose} className="text-ink-subtle hover:text-ink">
            <X size={16} />
          </button>
        </div>
        <label className="mb-3 block">
          <div className="mb-1 text-xs text-ink-subtle">名称简写</div>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="w-full rounded-md bg-field px-2 py-1.5 text-ink outline-none"
            placeholder="build"
            autoFocus
          />
        </label>
        <label className="mb-5 block">
          <div className="mb-1 text-xs text-ink-subtle">命令</div>
          <textarea
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            className="h-32 w-full resize-y rounded-md bg-field px-2 py-1.5 font-mono text-xs text-ink outline-none"
            placeholder="pnpm tauri build"
            spellCheck={false}
          />
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" className="rounded-md px-3 py-1.5 text-ink-muted hover:text-ink" onClick={onClose}>
            取消
          </button>
          <button
            type="submit"
            disabled={!canSave}
            className="rounded-md bg-btn px-3 py-1.5 text-btn-fg hover:opacity-90 disabled:opacity-40"
          >
            保存
          </button>
        </div>
      </form>
    </div>
  );
}
