import { create } from "zustand";
import type { AppConfig, ExplorerView, Project, SessionStatus, ViewMode } from "../types";
import { checkDir, loadConfig, ptyKill, ptySpawn, saveConfig } from "../lib/api";
import { sessionId } from "../lib/format";
import { applyDocumentTheme, normalizeTheme } from "../lib/theme";

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
  removeProject: (id: string) => Promise<void>;
  updateProjectPreset: (id: string, agentPreset: string) => Promise<void>;
  spawnForProject: (project: Project) => Promise<void>;
  restartSession: (projectId: string, kind: "agent" | "runner") => Promise<void>;
  setTheme: (theme: "dark" | "light") => Promise<void>;
  setExplorerView: (view: ExplorerView) => Promise<void>;
}

const defaultConfig = (): AppConfig => ({
  settings: {
    theme: "dark",
    default_split_ratio: [30, 40, 30],
    active_project_id: null,
    explorer_view: "list",
  },
  agent_presets: [],
  bookmarks: [],
  projects: [],
});

function asRatio(values: number[] | undefined): [number, number, number] {
  if (!values || values.length !== 3) return [30, 40, 30];
  return [values[0], values[1], values[2]];
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
      const active =
        config.settings.active_project_id &&
        config.projects.some((p) => p.id === config.settings.active_project_id)
          ? config.settings.active_project_id
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
    set((s) => ({
      activeProjectId: id,
      openedProjectIds: s.openedProjectIds.includes(id)
        ? s.openedProjectIds
        : [...s.openedProjectIds, id],
    }));
    await get().persist({
      ...config,
      settings: { ...config.settings, active_project_id: id },
    });
    await get().spawnForProject(project);
  },

  addProject: async (name, path, agentPreset) => {
    const exists = await checkDir(path);
    if (!exists) {
      set({ notice: "目录不存在，请检查路径" });
      return;
    }
    const config = get().config ?? defaultConfig();
    const project: Project = {
      id: crypto.randomUUID(),
      name: name.trim() || path,
      path: path.trim(),
      agent_preset: agentPreset,
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

  removeProject: async (id) => {
    const { config } = get();
    if (!config) return;
    try {
      await ptyKill(sessionId(id, "agent"));
      await ptyKill(sessionId(id, "runner"));
    } catch {
      // session may already be gone
    }
    const projects = config.projects.filter((p) => p.id !== id);
    const nextActive =
      get().activeProjectId === id ? (projects[0]?.id ?? null) : get().activeProjectId;
    const next: AppConfig = {
      ...config,
      projects,
      settings: { ...config.settings, active_project_id: nextActive },
    };
    await get().persist(next);
    set((s) => ({
      activeProjectId: nextActive,
      openedProjectIds: s.openedProjectIds.filter((pid) => pid !== id),
    }));
    if (nextActive) {
      const project = projects.find((p) => p.id === nextActive);
      if (project) await get().spawnForProject(project);
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
    try {
      const result = await ptySpawn({ sessionId: runnerId, cwd: project.path, command: "" });
      if (!result.reused) setSessionStatus(runnerId, "running");
    } catch (err) {
      setSessionStatus(runnerId, "error");
      setNotice(`Runner 启动失败：${String(err)}`);
    }
    try {
      const result = await ptySpawn({
        sessionId: agentId,
        cwd: project.path,
        command: preset?.command ?? "cursor-agent",
      });
      if (!result.reused) setSessionStatus(agentId, "running");
    } catch (err) {
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
    get().setSessionStatus(id, "idle");
    if (kind === "runner") {
      try {
        await ptySpawn({ sessionId: id, cwd: project.path, command: "" });
        get().setSessionStatus(id, "running");
      } catch (err) {
        get().setSessionStatus(id, "error");
        get().setNotice(`Runner 启动失败：${String(err)}`);
      }
      return;
    }
    const preset = config?.agent_presets.find((p) => p.id === project.agent_preset);
    try {
      await ptySpawn({
        sessionId: id,
        cwd: project.path,
        command: preset?.command ?? "cursor-agent",
      });
      get().setSessionStatus(id, "running");
    } catch (err) {
      get().setSessionStatus(id, "error");
      get().setNotice(`Agent 启动失败：${String(err)}`);
    }
  },

  setTheme: async (theme) => {
    const { config } = get();
    if (!config) return;
    applyDocumentTheme(theme);
    await get().persist({
      ...config,
      settings: { ...config.settings, theme: normalizeTheme(theme) },
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
