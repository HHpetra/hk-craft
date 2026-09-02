import { useEffect, useRef, useState } from "react";
import { CircleStop, Folder, Plus, Settings, X } from "lucide-react";
import { cn } from "../../lib/format";
import { paneSessionId, terminalPanes } from "../../lib/panes";
import { DRAG_THRESHOLD, finalIndex, insertSlot, lineForSlot, type DropLine } from "../../lib/reorder";
import { projectBadge } from "../../lib/status";
import { useWorkspace } from "../../store/workspace";
import { StatusDot } from "../ui/StatusDot";

export function ProjectSidebar() {
  const projects = useWorkspace((s) => s.config?.projects ?? []);
  const activeId = useWorkspace((s) => s.activeProjectId);
  const openedProjectIds = useWorkspace((s) => s.openedProjectIds);
  const status = useWorkspace((s) => s.sessionStatus);
  const selectProject = useWorkspace((s) => s.selectProject);
  const closeProject = useWorkspace((s) => s.closeProject);
  const removeProject = useWorkspace((s) => s.removeProject);
  const setProjectDialogOpen = useWorkspace((s) => s.setProjectDialogOpen);
  const setSettingsOpen = useWorkspace((s) => s.setSettingsOpen);

  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropLine, setDropLine] = useState<DropLine | null>(null);
  const rootRef = useRef<HTMLElement | null>(null);
  const idsRef = useRef<string[]>([]);
  const dragRef = useRef<{ id: string; startX: number; startY: number; active: boolean } | null>(null);
  const dragEndedAt = useRef(0);

  idsRef.current = projects.map((project) => project.id);

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
      const slot = insertSlot(root, "[data-project-id]", event.clientY, "y");
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
      const slot = root ? insertSlot(root, "[data-project-id]", event.clientY, "y") : -1;
      const toIndex = slot < 0 ? -1 : finalIndex(slot, ids.indexOf(drag.id));
      clearVisual();
      if (toIndex >= 0) void useWorkspace.getState().reorderProjects(drag.id, toIndex);
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
    <aside
      ref={rootRef}
      className="flex w-56 shrink-0 flex-col border-r border-line bg-surface-sidebar"
    >
      <div className="px-3 py-3 text-[11px] uppercase tracking-wide text-ink-subtle">
        项目
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {projects.length === 0 && (
          <div className="px-3 text-ink-subtle">暂无项目</div>
        )}
        {projects.map((project) => {
          const badge = projectBadge(
            ...terminalPanes(project).map((pane) => status[paneSessionId(project.id, pane) ?? ""]),
          );
          const active = project.id === activeId;
          const opened = openedProjectIds.includes(project.id);
          const dragging = project.id === draggingId;
          const line = dropLine?.id === project.id ? dropLine.place : null;
          return (
            <div
              key={project.id}
              data-project-id={project.id}
              className={cn(
                "group relative flex cursor-grab touch-none select-none items-center gap-2 px-3 py-2 hover:bg-hover",
                active && "bg-active",
                dragging && "cursor-grabbing opacity-50",
              )}
              tabIndex={0}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                if ((event.target as HTMLElement | null)?.closest("button")) return;
                dragRef.current = {
                  id: project.id,
                  startX: event.clientX,
                  startY: event.clientY,
                  active: false,
                };
              }}
              onDragStart={(event) => event.preventDefault()}
              onClick={() => {
                if (Date.now() - dragEndedAt.current < 300) return;
                void selectProject(project.id);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                void selectProject(project.id);
              }}
            >
              {line === "before" && (
                <span className="pointer-events-none absolute inset-x-2 top-px z-10 h-px bg-ink" />
              )}
              <Folder size={14} className="pointer-events-none shrink-0 text-ink-subtle" />
              <span
                className={cn(
                  "pointer-events-none min-w-0 flex-1 truncate",
                  active ? "text-ink" : "text-ink-muted",
                )}
              >
                {project.name}
              </span>
              <StatusDot status={badge} className="pointer-events-none" />
              {opened && (
                <button
                  type="button"
                  className="hidden shrink-0 text-ink-subtle hover:text-ink group-hover:block"
                  title="关闭会话"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    void closeProject(project.id);
                  }}
                >
                  <CircleStop size={13} />
                </button>
              )}
              <button
                type="button"
                className="hidden shrink-0 text-ink-subtle hover:text-ink group-hover:block"
                title="移除项目"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  void removeProject(project.id);
                }}
              >
                <X size={13} />
              </button>
              {line === "after" && (
                <span className="pointer-events-none absolute inset-x-2 bottom-px z-10 h-px bg-ink" />
              )}
            </div>
          );
        })}
      </div>
      <div className="border-t border-line p-2">
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-ink-muted hover:bg-hover hover:text-ink"
          onClick={() => setProjectDialogOpen(true)}
        >
          <Plus size={14} />
          新建项目
        </button>
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-ink-muted hover:bg-hover hover:text-ink"
          onClick={() => setSettingsOpen(true)}
        >
          <Settings size={14} />
          软件设置
        </button>
      </div>
    </aside>
  );
}
