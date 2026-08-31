import { Bot, Columns2, FolderTree, Terminal } from "lucide-react";
import type { ViewMode } from "../../types";
import { cn, sessionId } from "../../lib/format";
import { useWorkspace } from "../../store/workspace";
import { StatusDot } from "../ui/StatusDot";

const items: { mode: ViewMode; label: string; shortcut: string; icon: typeof Bot }[] = [
  { mode: "explorer", label: "资源管理", shortcut: "1", icon: FolderTree },
  { mode: "agent", label: "Agent", shortcut: "2", icon: Bot },
  { mode: "runner", label: "运行终端", shortcut: "3", icon: Terminal },
  { mode: "tiled", label: "平铺分屏", shortcut: "4", icon: Columns2 },
];

interface ViewSwitcherProps {
  viewMode: ViewMode;
  onChange: (mode: ViewMode) => void;
}

export function ViewSwitcher({ viewMode, onChange }: ViewSwitcherProps) {
  const activeId = useWorkspace((s) => s.activeProjectId);
  const status = useWorkspace((s) => s.sessionStatus);

  return (
    <div className="flex h-10 shrink-0 items-center gap-1 border-b border-line bg-surface px-2">
      {items.map(({ mode, label, shortcut, icon: Icon }) => {
        const sessionStatus =
          mode === "agent" && activeId
            ? status[sessionId(activeId, "agent")]
            : mode === "runner" && activeId
              ? status[sessionId(activeId, "runner")]
              : undefined;
        return (
          <button
            key={mode}
            type="button"
            onClick={() => onChange(mode)}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-ink-muted hover:bg-hover hover:text-ink",
              viewMode === mode && "bg-active text-ink",
            )}
          >
            <Icon size={14} />
            <span>
              {shortcut}: {label}
            </span>
            {(mode === "agent" || mode === "runner") && <StatusDot status={sessionStatus} />}
          </button>
        );
      })}
    </div>
  );
}
