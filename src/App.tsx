import { useEffect } from "react";
import { AppLayout } from "./components/layout/AppLayout";
import { SettingsDialog } from "./components/settings/SettingsDialog";
import { ProjectDialog } from "./components/settings/ProjectDialog";
import { Toast } from "./components/ui/Toast";
import { UpdatePrompt } from "./components/ui/UpdatePrompt";
import { applyRegisteredXtermTheme } from "./components/terminal/TerminalPane";
import { useOsFileDrop } from "./hooks/useOsFileDrop";
import { usePtyStatusListener } from "./hooks/usePtyStatusListener";
import { useAgentSessionCapture } from "./hooks/useAgentSessionCapture";
import { useOpencodeSessionHook } from "./hooks/useOpencodeSessionHook";
import { applyDocumentTheme } from "./lib/theme";
import { usePathDropListeners } from "./lib/dnd";
import { discoverLocalNerdFonts, setPreferredTerminalFont } from "./lib/terminalFonts";
import {
  applyRegisteredTerminalFont,
  ensurePtyListeners,
} from "./lib/termRegistry";
import { useWorkspace } from "./store/workspace";

export default function App() {
  const bootstrap = useWorkspace((s) => s.bootstrap);
  const loading = useWorkspace((s) => s.loading);
  const theme = useWorkspace((s) => s.config?.settings.theme);
  const terminalFont = useWorkspace((s) => s.config?.settings.terminal_font);
  usePtyStatusListener();
  useOsFileDrop();
  usePathDropListeners();
  useAgentSessionCapture();
  useOpencodeSessionHook();

  useEffect(() => {
    let cancelled = false;
    void ensurePtyListeners()
      .then(() => {
        if (!cancelled) return bootstrap();
      })
      .catch(() => {
        if (!cancelled) return bootstrap();
      });
    return () => {
      cancelled = true;
    };
  }, [bootstrap]);

  useEffect(() => {
    applyDocumentTheme(theme);
    applyRegisteredXtermTheme(theme ?? "dark");
  }, [theme]);

  useEffect(() => {
    setPreferredTerminalFont(terminalFont);
    void discoverLocalNerdFonts().then(() => applyRegisteredTerminalFont(terminalFont));
  }, [terminalFont]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center bg-surface text-ink-subtle">
        加载中…
      </div>
    );
  }

  return (
    <div className="h-full bg-surface text-ink">
      <AppLayout />
      <SettingsDialog />
      <ProjectDialog />
      <Toast />
      <UpdatePrompt />
    </div>
  );
}
