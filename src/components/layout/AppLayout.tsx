import { ProjectSidebar } from "../sidebar/ProjectSidebar";
import { ViewSwitcher } from "./ViewSwitcher";
import { WorkspacePanels } from "./WorkspacePanels";
import { useWorkspace } from "../../store/workspace";
import { useHotkeys } from "../../hooks/useHotkeys";

export function AppLayout() {
  const viewMode = useWorkspace((s) => s.viewMode);
  const setViewMode = useWorkspace((s) => s.setViewMode);
  useHotkeys(setViewMode);

  return (
    <div className="flex h-full bg-surface">
      <ProjectSidebar />
      <main className="flex min-w-0 flex-1 flex-col">
        <ViewSwitcher viewMode={viewMode} onChange={setViewMode} />
        <div className="min-h-0 flex-1">
          <WorkspacePanels />
        </div>
      </main>
    </div>
  );
}
