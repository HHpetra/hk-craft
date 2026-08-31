import { cn, sessionId } from "../../lib/format";
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
    </div>
  );
}
