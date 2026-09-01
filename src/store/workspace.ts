import { create } from "zustand";
import type { AppConfig, ExplorerView, Project, SessionStatus, ViewMode } from "../types";
import { checkDir, discoverAgentSession, loadConfig, ptyKill, ptySpawn, saveConfig } from "../lib/api";
import { pathsEqual, resumeArgsForSession, sessionId } from "../lib/format";
import { applyDocumentTheme, normalizeTheme } from "../lib/theme";
import {
  applyRegisteredTerminalFont,
  clearTerminal,
  discoverLocalNerdFonts,
  disposeTerminal,
  setPreferredTerminalFont,
  setSessionGeneration,
} from "../lib/termRegistry";

type SessionMap = Record<string, SessionStatus>;

interface WorkspaceState {
  config: AppConfig | null;
  loading: boolean;
  notice: string | null;
  viewMode: ViewMode;
  splitRatio: [number, number, number];
  activeProjectId: string | null;
  openedProjectIds: string[];
  sessionStatus: SessionMap;
  settingsOpen: boolean;
  projectDialogOpen: boolean;
  bootstrap: () => Promise<void>;
  persist: (next: AppConfig) => Promise<boolean>;
  setNotice: (notice: string | null) => void;
  setViewMode: (mode: ViewMode) => void;
  setSplitRatio: (ratio: [number, number, number]) => void;
  persistSplitRatio: () => Promise<void>;
  setSessionStatus: (id: string, status: SessionStatus) => void;
  setSettingsOpen: (open: boolean) => void;
  setProjectDialogOpen: (open: boolean) => void;
  selectProject: (id: string) => Promise<void>;
  addProject: (name: string, path: string, agentPreset: string) => Promise<void>;
  closeProject: (id: string) => Promise<void>;
  removeProject: (id: string) => Promise<void>;
  updateProjectPreset: (id: string, agentPreset: string) => Promise<void>;
  spawnForProject: (project: Project) => Promise<void>;
  restartSession: (projectId: string, kind: "agent" | "runner") => Promise<void>;
  rememberAgentSession: (projectId: string, chatId: string) => Promise<void>;
  snapshotOpenedSessions: () => Promise<void>;
  setTheme: (theme: "dark" | "light") => Promise<void>;
  setResumeOnStart: (resume: boolean) => Promise<void>;
  setTerminalFont: (family: string) => Promise<void>;
  setExplorerView: (view: ExplorerView) => Promise<void>;
}

const defaultConfig = (): AppConfig => ({
  settings: {
    theme: "dark",
    default_split_ratio: [30, 40, 30],
    active_project_id: null,
    explorer_view: "list",
    resume_on_start: true,
    terminal_font: "",
  },
  agent_presets: [],
  bookmarks: [],
  projects: [],
});

function asRatio(values: number[] | undefined): [number, number, number] {
  if (!values || values.length !== 3) return [30, 40, 30];
  return [values[0], values[1], values[2]];
}

function isLive(status: SessionStatus | undefined) {
  return status === "running" || status === "waiting";
}

let splitTimer: ReturnType<typeof setTimeout> | null = null;

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  config: null,
  loading: true,
  notice: null,
  viewMode: "tiled",
  splitRatio: [30, 40, 30],
  activeProjectId: null,
  openedProjectIds: [],
  sessionStatus: {},
  settingsOpen: false,
  projectDialogOpen: false,

  setNotice: (notice) => set({ notice }),
  setViewMode: (viewMode) => set({ viewMode }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setProjectDialogOpen: (projectDialogOpen) => set({ projectDialogOpen }),

  setSplitRatio: (splitRatio) => {
    set({ splitRatio });
    if (splitTimer) clearTimeout(splitTimer);
    splitTimer = setTimeout(() => {
      void get().persistSplitRatio();
    }, 400);
  },

  persistSplitRatio: async () => {
    const { config, splitRatio } = get();
    if (!config) return;
    const next = {
      ...config,
      settings: { ...config.settings, default_split_ratio: [...splitRatio] },
    };
    await get().persist(next);
  },

  setSessionStatus: (id, status) =>
    set((s) => ({ sessionStatus: { ...s.sessionStatus, [id]: status } })),

  bootstrap: async () => {
    try {
      const config = await loadConfig();
      const savedActive = config.settings.active_project_id;
      const active =
        savedActive && config.projects.some((p) => p.id === savedActive)
          ? savedActive
          : (config.projects[0]?.id ?? null);
      const project = config.projects.find((p) => p.id === active) ?? null;
      set({
        config,
        loading: false,
        splitRatio: asRatio(config.settings.default_split_ratio),
        activeProjectId: active,
        openedProjectIds: active ? [active] : [],
      });
      applyDocumentTheme(config.settings.theme);
      setPreferredTerminalFont(config.settings.terminal_font);
      void discoverLocalNerdFonts().then(() => applyRegisteredTerminalFont());
      if (active !== savedActive) {
        const latest = get().config ?? config;
        await get().persist({
          ...latest,
          settings: { ...latest.settings, active_project_id: active },
        });
      }
      if (project) {
        await get().spawnForProject(project);
      }
    } catch (err) {
      set({
        config: defaultConfig(),
        loading: false,
        notice: String(err),
      });
    }
  },

  persist: async (next) => {
    try {
      const saved = await saveConfig(next);
      set({ config: saved });
      applyDocumentTheme(saved.settings.theme);
      return true;
    } catch (err) {
      set({ notice: String(err) });
      return false;
    }
  },

  selectProject: async (id) => {
    const { config } = get();
    if (!config) return;
    const project = config.projects.find((p) => p.id === id);
    if (!project) return;
    if (get().activeProjectId === id && get().openedProjectIds.includes(id)) {
      return;
    }
    const prevActive = get().activeProjectId;
    const prevOpened = get().openedProjectIds;
    set((s) => ({
      activeProjectId: id,
      openedProjectIds: s.openedProjectIds.includes(id)
        ? s.openedProjectIds
        : [...s.openedProjectIds, id],
    }));
    const saved = await get().persist({
      ...config,
      settings: { ...config.settings, active_project_id: id },
    });
    if (!saved) {
      set({ activeProjectId: prevActive, openedProjectIds: prevOpened });
      return;
    }
    await get().spawnForProject(project);
  },

  addProject: async (name, path, agentPreset) => {
    const exists = await checkDir(path);
    if (!exists) {
      set({ notice: "目录不存在，请检查路径" });
      return;
    }
    const config = get().config ?? defaultConfig();
    if (config.projects.some((p) => pathsEqual(p.path, path.trim()))) {
      set({ notice: "该目录已经是项目，无需重复添加" });
      return;
    }
    const project: Project = {
      id: crypto.randomUUID(),
      name: name.trim() || path,
      path: path.trim(),
      agent_preset: agentPreset,
      agent_seen: false,
      agent_session_id: null,
    };
    const next: AppConfig = {
      ...config,
      projects: [...config.projects, project],
      settings: { ...config.settings, active_project_id: project.id },
    };
    const saved = await get().persist(next);
    if (!saved) return;
    set((s) => ({
      activeProjectId: project.id,
      openedProjectIds: [...s.openedProjectIds, project.id],
      projectDialogOpen: false,
    }));
    await get().spawnForProject(project);
  },

  closeProject: async (id) => {
    const agentId = sessionId(id, "agent");
    const runnerId = sessionId(id, "runner");
    set((s) => {
      const sessionStatus = { ...s.sessionStatus, [agentId]: "idle" as const, [runnerId]: "idle" as const };
      return {
        openedProjectIds: s.openedProjectIds.filter((pid) => pid !== id),
        sessionStatus,
      };
    });
    try {
      await ptyKill(agentId);
    } catch {
      // session may already be gone
    }
    try {
      await ptyKill(runnerId);
    } catch {
      // session may already be gone
    }
    disposeTerminal(agentId);
    disposeTerminal(runnerId);
  },

  removeProject: async (id) => {
    const { config } = get();
    if (!config) return;
    const wasActive = get().activeProjectId === id;
    const projects = config.projects.filter((p) => p.id !== id);
    const nextActive = wasActive ? (projects[0]?.id ?? null) : get().activeProjectId;
    const next: AppConfig = {
      ...config,
      projects,
      settings: { ...config.settings, active_project_id: nextActive },
    };
    const saved = await get().persist(next);
    if (!saved) return;
    await get().closeProject(id);
    set({ activeProjectId: nextActive });
    if (wasActive && nextActive) {
      const project = projects.find((p) => p.id === nextActive);
      if (!project) return;
      set((s) => ({
        openedProjectIds: s.openedProjectIds.includes(nextActive)
          ? s.openedProjectIds
          : [...s.openedProjectIds, nextActive],
      }));
      await get().spawnForProject(project);
    }
  },

  updateProjectPreset: async (id, agentPreset) => {
    const { config } = get();
    if (!config) return;
    await get().persist({
      ...config,
      projects: config.projects.map((p) =>
        p.id === id ? { ...p, agent_preset: agentPreset } : p,
      ),
    });
  },

  spawnForProject: async (project) => {
    const { config, setSessionStatus, setNotice } = get();
    const preset = config?.agent_presets.find((p) => p.id === project.agent_preset);
    const runnerId = sessionId(project.id, "runner");
    const agentId = sessionId(project.id, "agent");
    const command = preset?.command ?? "cursor-agent";
    const resume =
      config?.settings.resume_on_start !== false
        ? resumeArgsForSession(command, project.agent_session_id)
        : [];
    if (!isLive(get().sessionStatus[runnerId])) {
      try {
        const result = await ptySpawn({ sessionId: runnerId, cwd: project.path, command: "" });
        setSessionGeneration(runnerId, result.generation);
        if (!result.reused) setSessionStatus(runnerId, "running");
      } catch (err) {
        setSessionStatus(runnerId, "error");
        setNotice(`Runner 启动失败：${String(err)}`);
      }
    }
    if (isLive(get().sessionStatus[agentId])) return;
    try {
      const result = await ptySpawn({
        sessionId: agentId,
        cwd: project.path,
        command,
        args: resume,
      });
      setSessionGeneration(agentId, result.generation);
      if (!result.reused) setSessionStatus(agentId, "running");
      if (!project.agent_seen) {
        const latest = get().config;
        if (latest) {
          void get().persist({
            ...latest,
            projects: latest.projects.map((p) =>
              p.id === project.id ? { ...p, agent_seen: true } : p,
            ),
          });
        }
      }
    } catch (err) {
      if (resume.length > 0) {
        try {
          const result = await ptySpawn({
            sessionId: agentId,
            cwd: project.path,
            command,
            args: [],
          });
          setSessionGeneration(agentId, result.generation);
          if (!result.reused) setSessionStatus(agentId, "running");
          const latest = get().config;
          if (latest) {
            void get().persist({
              ...latest,
              projects: latest.projects.map((p) =>
                p.id === project.id ? { ...p, agent_session_id: null } : p,
              ),
            });
          }
          return;
        } catch (retryErr) {
          setSessionStatus(agentId, "error");
          setNotice(`Agent 启动失败：${String(retryErr)}`);
          return;
        }
      }
      setSessionStatus(agentId, "error");
      setNotice(`Agent 启动失败：${String(err)}`);
    }
  },

  restartSession: async (projectId, kind) => {
    const { config } = get();
    const project = config?.projects.find((p) => p.id === projectId);
    if (!project) return;
    const id = sessionId(projectId, kind);
    try {
      await ptyKill(id);
    } catch {
      // ignore
    }
    clearTerminal(id);
    get().setSessionStatus(id, "idle");
    if (kind === "runner") {
      try {
        const result = await ptySpawn({ sessionId: id, cwd: project.path, command: "" });
        setSessionGeneration(id, result.generation);
        get().setSessionStatus(id, "running");
      } catch (err) {
        get().setSessionStatus(id, "error");
        get().setNotice(`Runner 启动失败：${String(err)}`);
      }
      return;
    }
    const preset = config?.agent_presets.find((p) => p.id === project.agent_preset);
    const command = preset?.command ?? "cursor-agent";
    const resume =
      config?.settings.resume_on_start !== false
        ? resumeArgsForSession(command, project.agent_session_id)
        : [];
    try {
      const result = await ptySpawn({
        sessionId: id,
        cwd: project.path,
        command,
        args: resume,
      });
      setSessionGeneration(id, result.generation);
      get().setSessionStatus(id, "running");
    } catch (err) {
      if (resume.length > 0) {
        try {
          const result = await ptySpawn({
            sessionId: id,
            cwd: project.path,
            command,
            args: [],
          });
          setSessionGeneration(id, result.generation);
          get().setSessionStatus(id, "running");
          const latest = get().config;
          if (latest) {
            void get().persist({
              ...latest,
              projects: latest.projects.map((p) =>
                p.id === projectId ? { ...p, agent_session_id: null } : p,
              ),
            });
          }
          return;
        } catch (retryErr) {
          get().setSessionStatus(id, "error");
          get().setNotice(`Agent 启动失败：${String(retryErr)}`);
          return;
        }
      }
      get().setSessionStatus(id, "error");
      get().setNotice(`Agent 启动失败：${String(err)}`);
    }
  },

  rememberAgentSession: async (projectId, chatId) => {
    const { config } = get();
    if (!config) return;
    const project = config.projects.find((p) => p.id === projectId);
    if (!project || project.agent_session_id === chatId) return;
    await get().persist({
      ...config,
      projects: config.projects.map((p) =>
        p.id === projectId ? { ...p, agent_session_id: chatId } : p,
      ),
    });
  },

  snapshotOpenedSessions: async () => {
    const { config, openedProjectIds } = get();
    if (!config) return;
    for (const projectId of openedProjectIds) {
      const project = config.projects.find((p) => p.id === projectId);
      if (!project) continue;
      const preset = config.agent_presets.find((p) => p.id === project.agent_preset);
      const command = preset?.command ?? "cursor-agent";
      try {
        const found = await discoverAgentSession(command, project.path);
        if (found) await get().rememberAgentSession(projectId, found);
      } catch {
        // discovery is best-effort
      }
    }
    const latest = get().config;
    const activeProjectId = get().activeProjectId;
    if (!latest || latest.settings.active_project_id === activeProjectId) return;
    await get().persist({
      ...latest,
      settings: { ...latest.settings, active_project_id: activeProjectId },
    });
  },

  setTheme: async (theme) => {
    const { config } = get();
    if (!config) return;
    applyDocumentTheme(theme);
    await get().persist({
      ...config,
      settings: { ...config.settings, theme: normalizeTheme(theme) },
    });
    const { openedProjectIds } = get();
    for (const id of openedProjectIds) {
      void get().restartSession(id, "agent");
    }
  },

  setResumeOnStart: async (resume) => {
    const { config } = get();
    if (!config) return;
    await get().persist({
      ...config,
      settings: { ...config.settings, resume_on_start: resume },
    });
  },

  setTerminalFont: async (family) => {
    const { config } = get();
    if (!config) return;
    setPreferredTerminalFont(family);
    applyRegisteredTerminalFont(family);
    await get().persist({
      ...config,
      settings: { ...config.settings, terminal_font: family },
    });
  },

  setExplorerView: async (view) => {
    const { config } = get();
    if (!config) return;
    await get().persist({
      ...config,
      settings: { ...config.settings, explorer_view: view },
    });
  },
}));

export function useActiveProject() {
  return useWorkspace((s) => s.config?.projects.find((p) => p.id === s.activeProjectId) ?? null);
}

export function useActivePreset() {
  const project = useActiveProject();
  return useWorkspace(
    (s) => s.config?.agent_presets.find((p) => p.id === project?.agent_preset) ?? null,
  );
}
