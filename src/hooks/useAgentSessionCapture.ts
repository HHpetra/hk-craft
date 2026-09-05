import { useEffect } from "react";
import { confirm } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { activeRunningSessions } from "../lib/panes";
import { sessionKindLabel } from "../lib/status";
import { useWorkspace } from "../store/workspace";

const POLL_MS = 2500;

export function useAgentSessionCapture() {
  const openedProjectIds = useWorkspace((s) => s.openedProjectIds);
  const captureOpenedAgentSessions = useWorkspace((s) => s.captureOpenedAgentSessions);
  const snapshotOpenedSessions = useWorkspace((s) => s.snapshotOpenedSessions);

  useEffect(() => {
    let cancelled = false;

    async function capture() {
      if (cancelled) return;
      await captureOpenedAgentSessions();
    }

    void capture();
    const timer = window.setInterval(() => {
      void capture();
    }, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [openedProjectIds, captureOpenedAgentSessions]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let closing = false;
    let handling = false;
    let disposed = false;
    let delay: ReturnType<typeof setTimeout> | undefined;

    async function finishClose() {
      try {
        await snapshotOpenedSessions();
      } finally {
        closing = true;
      }
    }

    async function confirmAndDestroy(running: ReturnType<typeof activeRunningSessions>) {
      try {
        await getCurrentWindow().unminimize();
        const label = running.map((item) => `${item.projectName}·${sessionKindLabel(item.kind)}`).join("、");
        const ok = await confirm(
          `还有 ${running.length} 个终端会话正在运行（${label}）。\n退出将终止这些进程，确定退出吗？`,
          { title: "退出确认", kind: "warning", okLabel: "退出", cancelLabel: "取消" },
        );
        if (!ok || disposed) return;
      } catch {
        if (disposed) return;
      }
      try {
        await finishClose();
      } finally {
        if (!disposed) await getCurrentWindow().destroy();
      }
    }

    void getCurrentWindow()
      .onCloseRequested(async (event) => {
        if (closing || disposed) return;
        const running = activeRunningSessions(useWorkspace.getState());
        if (running.length === 0) {
          await finishClose();
          return;
        }
        event.preventDefault();
        if (handling) return;
        handling = true;
        delay = window.setTimeout(() => {
          delay = undefined;
          void confirmAndDestroy(running).finally(() => {
            handling = false;
          });
        }, 0);
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      if (delay !== undefined) window.clearTimeout(delay);
      unlisten?.();
    };
  }, [snapshotOpenedSessions]);
}
