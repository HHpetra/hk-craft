import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Archive, ArchiveRestore, ChevronDown, ChevronRight, CircleStop, Folder, Plus, Settings, X } from "lucide-react";
import { cn } from "../../lib/format";
import { paneSessionId, terminalPanes } from "../../lib/panes";
import { stowedProjects, workingProjects, type ProjectGroup } from "../../lib/projects";
import { DRAG_THRESHOLD, finalIndex, insertSlot, lineForSlot, type DropLine } from "../../lib/reorder";
import { projectBadge, statusRowClass } from "../../lib/status";
import { useWorkspace } from "../../store/workspace";
import type { Project } from "../../types";
import { StatusDot } from "../ui/StatusDot";

const WORKING_SELECTOR = "[data-working-id]";
const STOWED_SELECTOR = "[data-stowed-id]";

type DropHit = { dest: ProjectGroup; slot: number; onHeader: boolean };

export function ProjectSidebar() {
  const projects = useWorkspace((s) => s.config?.projects ?? []);
  const activeId = useWorkspace((s) => s.activeProjectId);
  const openedProjectIds = useWorkspace((s) => s.openedProjectIds);
  const status = useWorkspace((s) => s.sessionStatus);
  const selectProject = useWorkspace((s) => s.selectProject);
  const closeProject = useWorkspace((s) => s.closeProject);
  const stowProject = useWorkspace((s) => s.stowProject);
  const unstowProject = useWorkspace((s) => s.unstowProject);
  const removeProject = useWorkspace((s) => s.removeProject);
  const setProjectDialogOpen = useWorkspace((s) => s.setProjectDialogOpen);
  const setSettingsOpen = useWorkspace((s) => s.setSettingsOpen);

  const working = workingProjects(projects);
  const stowed = stowedProjects(projects);

  const [stowOpen, setStowOpen] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropLine, setDropLine] = useState<DropLine | null>(null);
  const [dropOnHeader, setDropOnHeader] = useState(false);

  const asideRef = useRef<HTMLElement | null>(null);
  const workingListRef = useRef<HTMLDivElement | null>(null);
  const stowedListRef = useRef<HTMLDivElement | null>(null);
  const stowHeaderRef = useRef<HTMLButtonElement | null>(null);
  const workingIdsRef = useRef<string[]>([]);
  const stowedIdsRef = useRef<string[]>([]);
  const dragRef = useRef<{ id: string; startX: number; startY: number; active: boolean } | null>(null);
  const dragEndedAt = useRef(0);

  workingIdsRef.current = working.map((project) => project.id);
  stowedIdsRef.current = stowed.map((project) => project.id);

  useEffect(() => {
    const clearVisual = () => {
      setDraggingId(null);
      setDropLine(null);
      setDropOnHeader(false);
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
    };

    const hitDest = (clientX: number, clientY: number): DropHit | null => {
      const aside = asideRef.current;
      if (aside) {
        const bounds = aside.getBoundingClientRect();
        if (clientX < bounds.left || clientX > bounds.right || clientY < bounds.top || clientY > bounds.bottom) {
          return null;
        }
      }
      const header = stowHeaderRef.current;
      if (header) {
        const rect = header.getBoundingClientRect();
        if (clientY >= rect.top && clientY <= rect.bottom) {
          return { dest: "stowed", slot: stowedIdsRef.current.length, onHeader: true };
        }
      }
      const stowedRoot = stowedListRef.current;
      if (stowedRoot) {
        const rect = stowedRoot.getBoundingClientRect();
        if (clientY >= rect.top && clientY <= rect.bottom) {
          return { dest: "stowed", slot: insertSlot(stowedRoot, STOWED_SELECTOR, clientY, "y"), onHeader: false };
        }
      }
      const workingRoot = workingListRef.current;
      if (workingRoot) {
        const rect = workingRoot.getBoundingClientRect();
        if (clientY >= rect.top && clientY <= rect.bottom) {
          return { dest: "working", slot: insertSlot(workingRoot, WORKING_SELECTOR, clientY, "y"), onHeader: false };
        }
      }
      return null;
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
      const hit = hitDest(event.clientX, event.clientY);
      if (!hit) {
        setDropOnHeader(false);
        setDropLine((prev) => (prev ? null : prev));
        return;
      }
      if (hit.onHeader) {
        setDropOnHeader(true);
        setDropLine((prev) => (prev ? null : prev));
        return;
      }
      setDropOnHeader(false);
      const ids = hit.dest === "working" ? workingIdsRef.current : stowedIdsRef.current;
      const next = lineForSlot(ids, hit.slot, ids.indexOf(drag.id));
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
      const hit = hitDest(event.clientX, event.clientY);
      clearVisual();
      if (!hit) return;
      const ids = hit.dest === "working" ? workingIdsRef.current : stowedIdsRef.current;
      const toIndex = finalIndex(hit.slot, ids.indexOf(drag.id));
      void useWorkspace.getState().moveProject(drag.id, hit.dest, toIndex);
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

  const showStow = stowed.length > 0 || Boolean(draggingId);

  return (
    <aside
      ref={asideRef}
      className="flex w-52 shrink-0 flex-col border-r border-line bg-surface-sidebar"
    >
      <div className="px-3 pt-3 pb-1.5 text-[10px] font-medium uppercase tracking-widest text-ink-subtle/70">
        项目
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        <div ref={workingListRef} className="min-h-0 flex-1 overflow-auto py-0.5">
          {working.length === 0 && (
            <div className="px-3 py-2 text-[12px] text-ink-subtle">
              {stowed.length > 0 ? "暂无工作项目" : "暂无项目"}
            </div>
          )}
          {working.map((project) => (
            <ProjectRow
              key={project.id}
              project={project}
              group="working"
              active={project.id === activeId}
              opened={openedProjectIds.includes(project.id)}
              dragging={project.id === draggingId}
              line={dropLine?.id === project.id ? dropLine.place : null}
              badge={projectBadge(
                ...terminalPanes(project).map((pane) => status[paneSessionId(project.id, pane) ?? ""]),
              )}
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
              onClick={() => {
                if (Date.now() - dragEndedAt.current < 300) return;
                void selectProject(project.id);
              }}
              onStop={() => void closeProject(project.id)}
              onStow={() => void stowProject(project.id)}
            />
          ))}
        </div>
        {showStow && (
          <div className="shrink-0 border-t border-line">
            <button
              ref={stowHeaderRef}
              type="button"
              className={cn(
                "flex w-full items-center gap-1 px-3 py-1.5 text-[10px] font-medium uppercase tracking-widest text-ink-subtle/70",
                stowed.length > 0 && "hover:bg-hover hover:text-ink-subtle",
                dropOnHeader && "bg-hover text-ink-subtle",
              )}
              onClick={() => {
                if (stowed.length === 0) return;
                setStowOpen((open) => !open);
              }}
            >
              {stowed.length > 0 &&
                (stowOpen ? (
                  <ChevronDown size={11} className="pointer-events-none" />
                ) : (
                  <ChevronRight size={11} className="pointer-events-none" />
                ))}
              <span className="pointer-events-none">
                {stowed.length > 0 ? `收纳 (${stowed.length})` : "放到收纳"}
              </span>
            </button>
            {stowed.length > 0 && stowOpen && (
              <div ref={stowedListRef} className="max-h-48 overflow-auto">
                {stowed.map((project) => (
                  <ProjectRow
                    key={project.id}
                    project={project}
                    group="stowed"
                    active={false}
                    opened={false}
                    dragging={project.id === draggingId}
                    line={dropLine?.id === project.id ? dropLine.place : null}
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
                    onRestore={() => void unstowProject(project.id, true)}
                    onRemove={() => {
                      if (
                        !window.confirm(
                          `彻底移除「${project.name}」？布局与会话记录将删除。`,
                        )
                      ) {
                        return;
                      }
                      void removeProject(project.id);
                    }}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="border-t border-line p-1.5 space-y-0.5">
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-[12px] text-ink-subtle hover:bg-hover hover:text-ink"
          onClick={() => setProjectDialogOpen(true)}
        >
          <Plus size={13} />
          新建项目
        </button>
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-[12px] text-ink-subtle hover:bg-hover hover:text-ink"
          onClick={() => setSettingsOpen(true)}
        >
          <Settings size={13} />
          软件设置
        </button>
      </div>
    </aside>
  );
}

function ProjectRow({
  project,
  group,
  active,
  opened,
  dragging,
  line,
  badge,
  onPointerDown,
  onClick,
  onStop,
  onStow,
  onRestore,
  onRemove,
}: {
  project: Project;
  group: ProjectGroup;
  active: boolean;
  opened: boolean;
  dragging: boolean;
  line: DropLine["place"] | null;
  badge?: ReturnType<typeof projectBadge>;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onClick?: () => void;
  onStop?: () => void;
  onStow?: () => void;
  onRestore?: () => void;
  onRemove?: () => void;
}) {
  const working = group === "working";
  return (
    <div
      data-working-id={working ? project.id : undefined}
      data-stowed-id={working ? undefined : project.id}
      className={cn(
        "group relative mx-1.5 flex cursor-grab touch-none select-none items-center gap-2 rounded px-2 py-1.5 hover:bg-hover",
        statusRowClass(badge, active),
        dragging && "cursor-grabbing opacity-40",
      )}
      tabIndex={working ? 0 : undefined}
      onPointerDown={onPointerDown}
      onDragStart={(event) => event.preventDefault()}
      onClick={onClick}
      onKeyDown={(event) => {
        if (!onClick) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onClick();
      }}
    >
      {line === "before" && (
        <span className="pointer-events-none absolute inset-x-1 top-px z-10 h-px rounded-full bg-accent" />
      )}
      <Folder
        size={13}
        className={cn(
          "pointer-events-none shrink-0",
          active ? "text-ink-muted" : "text-ink-subtle",
        )}
      />
      <span
        className={cn(
          "pointer-events-none min-w-0 flex-1 truncate text-[12px]",
          active ? "text-ink" : "text-ink-muted",
        )}
      >
        {project.name}
      </span>
      {working && <StatusDot status={badge} className="pointer-events-none" />}
      {working && opened && onStop && (
        <button
          type="button"
          className="hidden shrink-0 text-ink-subtle hover:text-ink group-hover:block"
          title="关闭会话"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onStop();
          }}
        >
          <CircleStop size={12} />
        </button>
      )}
      {working && onStow && (
        <button
          type="button"
          className="hidden shrink-0 text-ink-subtle hover:text-ink group-hover:block"
          title="收纳项目"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onStow();
          }}
        >
          <Archive size={12} />
        </button>
      )}
      {!working && onRestore && (
        <button
          type="button"
          className="hidden shrink-0 text-ink-subtle hover:text-ink group-hover:block"
          title="恢复项目"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onRestore();
          }}
        >
          <ArchiveRestore size={12} />
        </button>
      )}
      {!working && onRemove && (
        <button
          type="button"
          className="hidden shrink-0 text-ink-subtle hover:text-red-400 group-hover:block"
          title="彻底移除"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
        >
          <X size={12} />
        </button>
      )}
      {line === "after" && (
        <span className="pointer-events-none absolute inset-x-1 bottom-px z-10 h-px rounded-full bg-accent" />
      )}
    </div>
  );
}
