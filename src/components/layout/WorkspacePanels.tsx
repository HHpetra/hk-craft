import type { DragEvent, ReactNode } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { FileExplorer } from "../explorer/FileExplorer";
import { QuickCommandBar } from "../terminal/QuickCommandBar";
import { TerminalPane } from "../terminal/TerminalPane";
import { cn, sessionId } from "../../lib/format";
import { paneCaps } from "../../lib/paneCaps";
import { commitPathDrop, noteDropHover, usePathDrag } from "../../lib/dnd";
import { useActiveProject, useWorkspace } from "../../store/workspace";
import type { Project, SessionKind, WorkspacePane } from "../../types";

function gridRows(panes: WorkspacePane[]): Array<Array<WorkspacePane | null>> {
  const n = panes.length;
  if (n <= 1) return [panes];
  const cols = Math.ceil(n / 2);
  const cells: Array<WorkspacePane | null> = [...panes];
  if (n % 2 === 1) cells.push(null);
  return [cells.slice(0, cols), cells.slice(cols, cols * 2)];
}

function TerminalHost({
  sessionId: sid,
  kind,
  interactive,
}: {
  sessionId: string;
  kind: SessionKind;
  interactive: boolean;
}) {
  const dragging = Boolean(usePathDrag()?.length);
  const caps = paneCaps(kind);

  function onDragOver(event: DragEvent) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    noteDropHover(sid);
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    commitPathDrop(sid);
  }

  return (
    <div data-drop-session={caps.acceptsPathDrop ? sid : undefined} className="flex h-full w-full flex-col bg-surface-term">
      <div className="relative h-0 min-h-0 flex-1">
        <TerminalPane sessionId={sid} kind={kind} interactive={interactive} />
        {caps.acceptsPathDrop && (
          <div
            className={cn(
              "absolute inset-0 z-30 rounded-sm border-2",
              dragging && interactive
                ? "pointer-events-auto border-(--color-accent) bg-(--color-accent-dim)"
                : "pointer-events-none border-transparent",
            )}
            onDragOver={onDragOver}
            onDrop={onDrop}
          />
        )}
      </div>
      {caps.quickCommands && <QuickCommandBar sessionId={sid} />}
    </div>
  );
}

function PaneBody({
  pane,
  project,
  interactive,
}: {
  pane: WorkspacePane;
  project: Project;
  interactive: boolean;
}) {
  if (pane.kind === "explorer") {
    return <FileExplorer key={pane.id} project={project} />;
  }
  return (
    <TerminalHost
      sessionId={sessionId(project.id, pane.kind, pane.id)}
      kind={pane.kind}
      interactive={interactive}
    />
  );
}

function PaneFrame({
  pane,
  project,
  interactive,
}: {
  pane: WorkspacePane;
  project: Project;
  interactive: boolean;
}) {
  const setActivePane = useWorkspace((s) => s.setActivePane);
  return (
    <div
      className="h-full min-h-0 min-w-0"
      onMouseDown={() => {
        if (project.active_pane_id !== pane.id) void setActivePane(pane.id);
      }}
    >
      <PaneBody pane={pane} project={project} interactive={interactive} />
    </div>
  );
}

function SplitRow({
  cells,
  project,
}: {
  cells: Array<WorkspacePane | null>;
  project: Project;
}) {
  return (
    <Group orientation="horizontal" className="h-full" id={`row-${cells.map((cell) => cell?.id ?? "e").join("-")}`}>
      {cells.map((cell, index) => (
        <PaneSlot key={cell?.id ?? `empty-${index}`} id={cell?.id ?? `empty-${index}`} first={index === 0}>
          {cell ? (
            <PaneFrame pane={cell} project={project} interactive />
          ) : (
            <div className="h-full bg-surface" />
          )}
        </PaneSlot>
      ))}
    </Group>
  );
}

function PaneSlot({ id, first, children }: { id: string; first: boolean; children: ReactNode }) {
  return (
    <>
      {!first && <Separator className="w-1" />}
      <Panel id={id} minSize="12%" className="min-w-0 overflow-hidden">
        {children}
      </Panel>
    </>
  );
}

export function WorkspacePanels() {
  const project = useActiveProject();
  const panes = project?.panes ?? [];
  const layout = project?.layout ?? "row";
  const activeId = project?.active_pane_id ?? panes[0]?.id ?? null;

  if (!project) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-ink-subtle">
        <span className="text-[13px]">请先在左侧添加一个项目</span>
      </div>
    );
  }

  if (panes.length === 0) {
    return <div className="h-full bg-surface" />;
  }

  if (layout === "tabs" || panes.length === 1) {
    return (
      <div className="relative h-full w-full">
        {panes.map((pane) => {
          const active = pane.id === activeId;
          return (
            <div
              key={pane.id}
              className={cn("absolute inset-0", active ? "z-10" : "invisible pointer-events-none")}
            >
              <PaneBody pane={pane} project={project} interactive={active} />
            </div>
          );
        })}
      </div>
    );
  }

  if (layout === "row") {
    return <SplitRow cells={panes} project={project} />;
  }

  const rows = gridRows(panes);
  if (rows.length === 1) {
    return <SplitRow cells={rows[0]} project={project} />;
  }

  return (
    <Group orientation="vertical" className="h-full" id={`grid-${project.id}`}>
      <Panel id={`${project.id}-grid-top`} minSize="12%" className="min-h-0 overflow-hidden">
        <SplitRow cells={rows[0]} project={project} />
      </Panel>
      <Separator className="h-1" />
      <Panel id={`${project.id}-grid-bottom`} minSize="12%" className="min-h-0 overflow-hidden">
        <SplitRow cells={rows[1]} project={project} />
      </Panel>
    </Group>
  );
}
