import { Folder, Plus, Settings, X } from "lucide-react";
import { cn, sessionId } from "../../lib/format";
import { projectBadge } from "../../lib/status";
import { useWorkspace } from "../../store/workspace";
import { StatusDot } from "../ui/StatusDot";

export function ProjectSidebar() {
  const projects = useWorkspace((s) => s.config?.projects ?? []);
  const activeId = useWorkspace((s) => s.activeProjectId);
  const status = useWorkspace((s) => s.sessionStatus);
  const selectProject = useWorkspace((s) => s.selectProject);
  const removeProject = useWorkspace((s) => s.removeProject);
  const setProjectDialogOpen = useWorkspace((s) => s.setProjectDialogOpen);
  const setSettingsOpen = useWorkspace((s) => s.setSettingsOpen);

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-line bg-surface-sidebar">
      <div className="px-3 py-3 text-[11px] uppercase tracking-wide text-ink-subtle">
        项目
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {projects.length === 0 && (
          <div className="px-3 text-ink-subtle">暂无项目</div>
        )}
        {projects.map((project) => {
          const badge = projectBadge(
            status[sessionId(project.id, "agent")],
            status[sessionId(project.id, "runner")],
          );
          const active = project.id === activeId;
          return (
            <div
              key={project.id}
              className={cn(
                "group flex items-center gap-2 px-3 py-2 hover:bg-hover",
                active && "bg-active",
              )}
            >
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
                onClick={() => void selectProject(project.id)}
              >
                <Folder size={14} className="shrink-0 text-ink-subtle" />
                <span className={cn("truncate", active ? "text-ink" : "text-ink-muted")}>
                  {project.name}
                </span>
                <StatusDot status={badge} className="ml-auto" />
              </button>
              <button
                type="button"
                className="hidden text-ink-subtle hover:text-ink group-hover:block"
                title="移除项目"
                onClick={() => void removeProject(project.id)}
              >
                <X size={13} />
              </button>
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
