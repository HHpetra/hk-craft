import { create } from "zustand";
import type {
  AppConfig,
  ExplorerView,
  PaneKind,
  Project,
  SessionStatus,
  SpawnOpts,
  SpawnResult,
  WorkspaceLayout,
} from "../types";
import { checkDir, deleteRunnerPersist, discoverAgentSession, loadConfig, ptyKill, ptySpawn, saveConfig } from "../lib/api";
import { pathsEqual, resumeArgsForSession } from "../lib/format";
import { createPane, neighborPaneId, normalizeLayout, paneSessionId, terminalPanes, withDefaultWorkspace } from "../lib/panes";
import { applyDocumentTheme, normalizeTheme } from "../lib/theme";
import {
  applyRegisteredTerminalFont,
  clearTerminal,
  discoverLocalNerdFonts,
  disposeTerminal,
  hydrateLastFittedSizes,
  lastFittedSize,
  peekLastFittedSizes,
  setPreferredTerminalFont,
  setSessionGeneration,
  terminalSize,
  waitTerminalSize,
} from "../lib/termRegistry";

type SessionMap = Record<string, SessionStatus>;

interface WorkspaceState {
  config: AppConfig | null;
  loading: boolean;
  notice: string | null;
  activeProjectId: string | null;
  openedProjectIds: string[];
  sessionStatus: SessionMap;
  settingsOpen: boolean;
  projectDialogOpen: boolean;
  bootstrap: () => Promise<void>;
  persist: (next: AppConfig) => Promise<boolean>;
  setNotice: (notice: string | null) => void;
  setSessionStatus: (id: string, status: SessionStatus) => void;
  setSettingsOpen: (open: boolean) => void;
  setProjectDialogOpen: (open: boolean) => void;
  selectProject: (id: string) => Promise<void>;
  addProject: (name: string, path: string, agentPreset: string) => Promise<void>;
  reorderProjects: (fromId: string, toIndex: number) => Promise<void>;
  closeProject: (id: string) => Promise<void>;
  removeProject: (id: string) => Promise<void>;
  updateProjectPreset: (id: string, agentPreset: string) => Promise<void>;
  addPane: (kind: PaneKind, presetId?: string) => Promise<void>;
  closePane: (paneId: string) => Promise<void>;
  reorderPanes: (fromId: string, toIndex: number) => Promise<void>;
  setLayout: (layout: WorkspaceLayout) => Promise<void>;
  setActivePane: (paneId: string) => Promise<void>;
  spawnForProject: (project: Project) => Promise<void>;
  restartPane: (projectId: string, paneId: string) => Promise<void>;
  rememberAgentSession: (projectId: string, paneId: string, chatId: string) => Promise<void>;
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

function isLive(status: SessionStatus | undefined) {
  return status === "running" || status === "waiting";
}

// The pty must be born at the pane's real size: spawning at the 80x24 default
// and resizing later makes ConPTY repaint the whole viewport as an
// erase-line+CRLF flood, which scrambles the screen. Wait briefly for the
// pane's first fit, then spawn with those dimensions.
async function spawnPty(opts: SpawnOpts): Promise<SpawnResult> {
  const size =
    terminalSize(opts.sessionId) ??
    (await waitTerminalSize(opts.sessionId)) ??
    lastFittedSize(opts.sessionId);
  const result = await ptySpawn(size ? { ...opts, cols: size.cols, rows: size.rows } : opts);
  setSessionGeneration(opts.sessionId, result.generation);
  return result;
}

function patchProject(config: AppConfig, projectId: string, patch: Partial<Project>): AppConfig {
  return {
    ...config,
    projects: config.projects.map((project) => (project.id === projectId ? { ...project, ...patch } : project)),
  };
}

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  config: null,
  loading: true,
  notice: null,
  activeProjectId: null,
  openedProjectIds: [],
  sessionStatus: {},
  settingsOpen: false,
  projectDialogOpen: false,

  setNotice: (notice) => set({ notice }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setProjectDialogOpen: (projectDialogOpen) => set({ projectDialogOpen }),

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
        activeProjectId: active,
        openedProjectIds: active ? [active] : [],
      });
      applyDocumentTheme(config.settings.theme);
      setPreferredTerminalFont(config.settings.terminal_font);
      hydrateLastFittedSizes({
        agent: config.settings.last_agent_size,
        runner: config.settings.last_runner_size,
      });
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
      const sizes = peekLastFittedSizes();
      const saved = await saveConfig({
        ...next,
        settings: {
          ...next.settings,
          ...(sizes.agent ? { last_agent_size: sizes.agent } : {}),
          ...(sizes.runner ? { last_runner_size: sizes.runner } : {}),
        },
      });
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
    const latest = get().config?.projects.find((p) => p.id === id) ?? project;
    await get().spawnForProject(latest);
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
    const project = withDefaultWorkspace({
      id: crypto.randomUUID(),
      name: name.trim() || path,
      path: path.trim(),
      agent_preset: agentPreset,
      agent_seen: false,
      agent_session_id: null,
    });
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
    const latest = get().config?.projects.find((p) => p.id === project.id) ?? project;
    await get().spawnForProject(latest);
  },

  reorderProjects: async (fromId, toIndex) => {
    const { config } = get();
    if (!config) return;
    const fromIndex = config.projects.findIndex((p) => p.id === fromId);
    if (fromIndex < 0 || config.projects.length === 0) return;
    const clamped = Math.max(0, Math.min(toIndex, config.projects.length - 1));
    if (fromIndex === clamped) return;
    const prev = config.projects;
    const projects = [...prev];
    const [moved] = projects.splice(fromIndex, 1);
    if (!moved) return;
    projects.splice(clamped, 0, moved);
    const next: AppConfig = { ...config, projects };
    set({ config: next });
    const saved = await get().persist(next);
    if (!saved) {
      set((s) => ({
        config: s.config ? { ...s.config, projects: prev } : { ...config, projects: prev },
      }));
    }
  },

  closeProject: async (id) => {
    const project = get().config?.projects.find((p) => p.id === id);
    const sessions = project ? terminalPanes(project).map((pane) => paneSessionId(id, pane)).filter((sid): sid is string => Boolean(sid)) : [];
    set((s) => {
      const sessionStatus = { ...s.sessionStatus };
      for (const session of sessions) sessionStatus[session] = "idle";
      return {
        openedProjectIds: s.openedProjectIds.filter((pid) => pid !== id),
        sessionStatus,
      };
    });
    for (const session of sessions) {
      try {
        await ptyKill(session);
      } catch {
        // session may already be gone
      }
      disposeTerminal(session);
    }
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
    try {
      await deleteRunnerPersist(id);
    } catch {
      // leftover files are non-fatal
    }
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
    await get().persist(patchProject(config, id, { agent_preset: agentPreset }));
  },

  addPane: async (kind, presetId) => {
    const { config, activeProjectId } = get();
    if (!config || !activeProjectId) return;
    const project = config.projects.find((p) => p.id === activeProjectId);
    if (!project) return;
    const preset = kind === "agent" ? (presetId || project.agent_preset) : undefined;
    const pane = createPane(kind, preset);
    const panes = [...(project.panes ?? []), pane];
    const saved = await get().persist(
      patchProject(config, activeProjectId, { panes, active_pane_id: pane.id }),
    );
    if (!saved) return;
    const latest = get().config?.projects.find((p) => p.id === activeProjectId);
    if (latest) await get().spawnForProject(latest);
  },

  closePane: async (paneId) => {
    const { config, activeProjectId } = get();
    if (!config || !activeProjectId) return;
    const project = config.projects.find((p) => p.id === activeProjectId);
    if (!project) return;
    const pane = project.panes?.find((item) => item.id === paneId);
    if (!pane) return;
    const session = paneSessionId(activeProjectId, pane);
    if (session) {
      try {
        await ptyKill(session);
      } catch {
        // ignore
      }
      disposeTerminal(session);
      get().setSessionStatus(session, "idle");
    }
    const panes = (project.panes ?? []).filter((item) => item.id !== paneId);
    const active_pane_id =
      project.active_pane_id === paneId ? neighborPaneId(project.panes ?? [], paneId) : project.active_pane_id;
    await get().persist(patchProject(config, activeProjectId, { panes, active_pane_id }));
  },

  reorderPanes: async (fromId, toIndex) => {
    const { config, activeProjectId } = get();
    if (!config || !activeProjectId) return;
    const project = config.projects.find((p) => p.id === activeProjectId);
    if (!project) return;
    const prev = project.panes ?? [];
    const fromIndex = prev.findIndex((pane) => pane.id === fromId);
    if (fromIndex < 0 || prev.length === 0) return;
    const clamped = Math.max(0, Math.min(toIndex, prev.length - 1));
    if (fromIndex === clamped) return;
    const panes = [...prev];
    const [moved] = panes.splice(fromIndex, 1);
    if (!moved) return;
    panes.splice(clamped, 0, moved);
    const next = patchProject(config, activeProjectId, { panes });
    set({ config: next });
    const saved = await get().persist(next);
    if (!saved) {
      set((s) => ({
        config: s.config
          ? patchProject(s.config, activeProjectId, { panes: prev })
          : patchProject(config, activeProjectId, { panes: prev }),
      }));
    }
  },

  setLayout: async (layout) => {
    const { config, activeProjectId } = get();
    if (!config || !activeProjectId) return;
    const project = config.projects.find((p) => p.id === activeProjectId);
    if (!project || project.layout === layout) return;
    await get().persist(patchProject(config, activeProjectId, { layout: normalizeLayout(layout) }));
  },

  setActivePane: async (paneId) => {
    const { config, activeProjectId } = get();
    if (!config || !activeProjectId) return;
    const project = config.projects.find((p) => p.id === activeProjectId);
    if (!project || project.active_pane_id === paneId) return;
    if (!project.panes.some((pane) => pane.id === paneId)) return;
    await get().persist(patchProject(config, activeProjectId, { active_pane_id: paneId }));
  },

  spawnForProject: async (project) => {
    const { config, setSessionStatus, setNotice } = get();
    if (!config) return;
    let markedSeen = project.agent_seen;
    for (const pane of terminalPanes(project)) {
      const sid = paneSessionId(project.id, pane);
      if (!sid || isLive(get().sessionStatus[sid])) continue;
      if (pane.kind === "runner") {
        try {
          const result = await spawnPty({ sessionId: sid, cwd: project.path, command: "" });
          if (!result.reused) setSessionStatus(sid, "running");
        } catch (err) {
          setSessionStatus(sid, "error");
          setNotice(`Runner 启动失败：${String(err)}`);
        }
        continue;
      }
      const preset = config.agent_presets.find((p) => p.id === (pane.preset_id ?? project.agent_preset));
      const command = preset?.command ?? "cursor-agent";
      const resume =
        config.settings.resume_on_start !== false
          ? resumeArgsForSession(command, pane.agent_session_id)
          : [];
      try {
        const result = await spawnPty({
          sessionId: sid,
          cwd: project.path,
          command,
          args: resume,
        });
        if (!result.reused) setSessionStatus(sid, "running");
        if (!markedSeen) {
          markedSeen = true;
          const latest = get().config;
          if (latest) {
            void get().persist(patchProject(latest, project.id, { agent_seen: true }));
          }
        }
      } catch (err) {
        if (resume.length > 0) {
          try {
            const result = await spawnPty({
              sessionId: sid,
              cwd: project.path,
              command,
              args: [],
            });
            if (!result.reused) setSessionStatus(sid, "running");
            const latest = get().config;
            if (latest) {
              const current = latest.projects.find((p) => p.id === project.id);
              const panes = (current?.panes ?? project.panes).map((item) =>
                item.id === pane.id ? { ...item, agent_session_id: null } : item,
              );
              void get().persist(patchProject(latest, project.id, { panes }));
            }
            continue;
          } catch (retryErr) {
            setSessionStatus(sid, "error");
            setNotice(`Agent 启动失败：${String(retryErr)}`);
            continue;
          }
        }
        setSessionStatus(sid, "error");
        setNotice(`Agent 启动失败：${String(err)}`);
      }
    }
  },

  restartPane: async (projectId, paneId) => {
    const { config } = get();
    const project = config?.projects.find((p) => p.id === projectId);
    const pane = project?.panes.find((item) => item.id === paneId);
    if (!config || !project || !pane) return;
    const sid = paneSessionId(projectId, pane);
    if (!sid) return;
    try {
      await ptyKill(sid);
    } catch {
      // ignore
    }
    clearTerminal(sid);
    get().setSessionStatus(sid, "idle");
    if (pane.kind === "runner") {
      try {
        await spawnPty({ sessionId: sid, cwd: project.path, command: "" });
        get().setSessionStatus(sid, "running");
      } catch (err) {
        get().setSessionStatus(sid, "error");
        get().setNotice(`Runner 启动失败：${String(err)}`);
      }
      return;
    }
    const preset = config.agent_presets.find((p) => p.id === (pane.preset_id ?? project.agent_preset));
    const command = preset?.command ?? "cursor-agent";
    const resume =
      config.settings.resume_on_start !== false
        ? resumeArgsForSession(command, pane.agent_session_id)
        : [];
    try {
      await spawnPty({
        sessionId: sid,
        cwd: project.path,
        command,
        args: resume,
      });
      get().setSessionStatus(sid, "running");
    } catch (err) {
      if (resume.length > 0) {
        try {
          await spawnPty({
            sessionId: sid,
            cwd: project.path,
            command,
            args: [],
          });
          get().setSessionStatus(sid, "running");
          const latest = get().config;
          if (latest) {
            const current = latest.projects.find((p) => p.id === projectId);
            const panes = (current?.panes ?? project.panes).map((item) =>
              item.id === paneId ? { ...item, agent_session_id: null } : item,
            );
            void get().persist(patchProject(latest, projectId, { panes }));
          }
          return;
        } catch (retryErr) {
          get().setSessionStatus(sid, "error");
          get().setNotice(`Agent 启动失败：${String(retryErr)}`);
          return;
        }
      }
      get().setSessionStatus(sid, "error");
      get().setNotice(`Agent 启动失败：${String(err)}`);
    }
  },

  rememberAgentSession: async (projectId, paneId, chatId) => {
    const { config } = get();
    if (!config) return;
    const project = config.projects.find((p) => p.id === projectId);
    const pane = project?.panes.find((item) => item.id === paneId);
    if (!project || !pane || pane.agent_session_id === chatId) return;
    const panes = project.panes.map((item) =>
      item.id === paneId ? { ...item, agent_session_id: chatId } : item,
    );
    await get().persist(patchProject(config, projectId, { panes }));
  },

  snapshotOpenedSessions: async () => {
    const { config, openedProjectIds } = get();
    if (!config) return;
    for (const projectId of openedProjectIds) {
      const project = config.projects.find((p) => p.id === projectId);
      if (!project) continue;
      for (const pane of project.panes.filter((item) => item.kind === "agent")) {
        const sid = paneSessionId(projectId, pane);
        const status = sid ? get().sessionStatus[sid] : undefined;
        if (status !== "running" && status !== "waiting") continue;
        const preset = config.agent_presets.find((p) => p.id === (pane.preset_id ?? project.agent_preset));
        const command = preset?.command ?? "cursor-agent";
        try {
          const found = await discoverAgentSession(command, project.path);
          if (found) await get().rememberAgentSession(projectId, pane.id, found);
        } catch {
          // discovery is best-effort
        }
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
    const latest = get().config;
    if (!latest) return;
    for (const id of openedProjectIds) {
      const project = latest.projects.find((p) => p.id === id);
      if (!project) continue;
      for (const pane of project.panes.filter((item) => item.kind === "agent")) {
        void get().restartPane(id, pane.id);
      }
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
