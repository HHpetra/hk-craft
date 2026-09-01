import type { DragEvent } from "react";
import { cn, sessionId } from "../../lib/format";
import { commitPathDrop, noteDropHover, usePathDrag } from "../../lib/dnd";
import type { SessionKind } from "../../types";
import { TerminalPane } from "./TerminalPane";

interface TerminalStackProps {
  kind: SessionKind;
  activeProjectId: string | null;
  openedProjectIds: string[];
  interactive: boolean;
}

export function TerminalStack({
  kind,
  activeProjectId,
  openedProjectIds,
  interactive,
}: TerminalStackProps) {
  const dragging = Boolean(usePathDrag()?.length);

  function onDragOver(event: DragEvent) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    noteDropHover(kind);
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    commitPathDrop(kind);
  }

  return (
    <div data-drop-kind={kind} className="relative h-full w-full bg-surface-term">
      {openedProjectIds.map((projectId) => {
        const active = projectId === activeProjectId;
        return (
          <div
            key={`${projectId}:${kind}`}
            className={cn(
              "absolute inset-0",
              active ? "z-10" : "invisible pointer-events-none",
            )}
          >
            <TerminalPane
              sessionId={sessionId(projectId, kind)}
              kind={kind}
              interactive={interactive && active}
            />
          </div>
        );
      })}
      <div
        className={cn(
          "absolute inset-0 z-30 rounded-sm border-2",
          dragging && interactive
            ? "pointer-events-auto border-sky-400/70 bg-sky-400/10"
            : "pointer-events-none border-transparent",
        )}
        onDragOver={onDragOver}
        onDrop={onDrop}
      />
    </div>
  );
}
