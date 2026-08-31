import { useEffect, useRef } from "react";
import { Group, Panel, Separator, useGroupRef } from "react-resizable-panels";
import { FileExplorer } from "../explorer/FileExplorer";
import { TerminalStack } from "../terminal/TerminalStack";
import { useWorkspace } from "../../store/workspace";
import type { ViewMode } from "../../types";

function layoutFor(mode: ViewMode, ratio: [number, number, number]) {
  if (mode === "explorer") return { explorer: 100, agent: 0, runner: 0 };
  if (mode === "agent") return { explorer: 0, agent: 100, runner: 0 };
  if (mode === "runner") return { explorer: 0, agent: 0, runner: 100 };
  return { explorer: ratio[0], agent: ratio[1], runner: ratio[2] };
}

export function WorkspacePanels() {
  const groupRef = useGroupRef();
  const viewMode = useWorkspace((s) => s.viewMode);
  const splitRatio = useWorkspace((s) => s.splitRatio);
  const setSplitRatio = useWorkspace((s) => s.setSplitRatio);
  const activeProjectId = useWorkspace((s) => s.activeProjectId);
  const openedProjectIds = useWorkspace((s) => s.openedProjectIds);
  const splitRatioRef = useRef(splitRatio);
  splitRatioRef.current = splitRatio;

  useEffect(() => {
    groupRef.current?.setLayout(layoutFor(viewMode, splitRatioRef.current));
  }, [viewMode, groupRef]);

  return (
    <Group
      id="trinity"
      orientation="horizontal"
      groupRef={groupRef}
      className="h-full"
      defaultLayout={layoutFor("tiled", splitRatio)}
      disabled={viewMode !== "tiled"}
      onLayoutChanged={(layout, meta) => {
        if (!meta.isUserInteraction || viewMode !== "tiled") return;
        setSplitRatio([
          layout.explorer ?? splitRatio[0],
          layout.agent ?? splitRatio[1],
          layout.runner ?? splitRatio[2],
        ]);
      }}
    >
      <Panel id="explorer" minSize="0%" collapsible className="min-w-0 overflow-hidden">
        <FileExplorer />
      </Panel>
      {viewMode === "tiled" && <Separator className="w-1" />}
      <Panel id="agent" minSize="0%" collapsible className="min-w-0 overflow-hidden">
        <TerminalStack
          kind="agent"
          activeProjectId={activeProjectId}
          openedProjectIds={openedProjectIds}
          interactive={viewMode === "tiled" || viewMode === "agent"}
        />
      </Panel>
      {viewMode === "tiled" && <Separator className="w-1" />}
      <Panel id="runner" minSize="0%" collapsible className="min-w-0 overflow-hidden">
        <TerminalStack
          kind="runner"
          activeProjectId={activeProjectId}
          openedProjectIds={openedProjectIds}
          interactive={viewMode === "tiled" || viewMode === "runner"}
        />
      </Panel>
    </Group>
  );
}
