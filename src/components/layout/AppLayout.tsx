import { ProjectSidebar } from "../sidebar/ProjectSidebar";
import { WorkspaceTabBar } from "./WorkspaceTabBar";
import { WorkspacePanels } from "./WorkspacePanels";
import { useHotkeys } from "../../hooks/useHotkeys";

export function AppLayout() {
  useHotkeys();

  return (
    <div className="flex h-full bg-surface">
      <ProjectSidebar />
      <main className="flex min-w-0 flex-1 flex-col">
        <WorkspaceTabBar />
        <div className="min-h-0 flex-1">
          <WorkspacePanels />
        </div>
      </main>
    </div>
  );
}
