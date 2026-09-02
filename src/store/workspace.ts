import { create } from "zustand";
import type {
  AgentPreset,
  AppConfig,
  ExplorerView,
  PaneKind,
  Project,
  SessionStatus,
  SpawnOpts,
  SpawnResult,
  WorkspaceLayout,
} from "../types";
import { liveAgentTargets } from "../lib/agentProtocol";
import { checkDir, deleteRunnerPersist, discoverAgentSession, loadConfig, ptyKill, ptySpawn, saveConfig } from "../lib/api";
import { pathsEqual } from "../lib/format";
import { agentPanesToRestart, planPaneLaunch, type AgentRestartReason, type PaneLaunchPlan } from "../lib/paneLaunch";
import { createPane, neighborPaneId, normalizeLayout, paneSessionId, projectSessionIds, terminalPanes, withDefaultWorkspace } from "../lib/panes";
import {
  ensureOpened,
  nextWorkingId,
  placeProject,
  placementUnchanged,
  stowedProjects,
  workingProjects,
  type ProjectGroup,
} from "../lib/projects";
import { applyDocumentTheme, normalizeTheme } from "../lib/theme";
import { discoverLocalNerdFonts, setPreferredTerminalFont } from "../lib/terminalFonts";
import {
  applyRegisteredTerminalFont,
  clearTerminal,
  disposeTerminal,
  hydrateLastFittedSizes,
  lastFittedSize,
  peekLastFittedSizes,
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
  moveProject: (fromId: string, dest: ProjectGroup, toIndex: number) => Promise<void>;
  stowProject: (id: string) => Promise<void>;
  unstowProject: (id: string, activate: boolean) => Promise<void>;
  closeProject: (id: string) => Promise<void>;
  removeProject: (id: string) => Promise<void>;
  updateProjectPreset: (id: string, agentPreset: string) => Promise<void>;
  addPane: (kind: PaneKind, presetId?: string) => Promise<void>;
  closePane: (paneId: string) => Promise<void>;
  reorderPanes: (fromId: string, toIndex: number) => Promise<void>;
  addQuickCommand: (name: string, command: string) => Promise<void>;
  updateQuickCommand: (id: string, name: string, command: string) => Promise<void>;
  removeQuickCommand: (id: string) => Promise<void>;
  reorderQuickCommands: (fromId: string, toIndex: number) => Promise<void>;
  setLayout: (layout: WorkspaceLayout) => Promise<void>;
  setActivePane: (paneId: string) => Promise<void>;
  spawnForProject: (project: Project) => Promise<void>;
  restartPane: (projectId: string, paneId: string) => Promise<void>;
  restartOpenedAgentsForPresetChange: (prevPresets: AgentPreset[], nextPresets: AgentPreset[]) => void;
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

type WorkspaceGet = () => WorkspaceState;

type WorkspaceSet = (
  partial: WorkspaceState | Partial<WorkspaceState> | ((state: WorkspaceState) => WorkspaceState | Partial<WorkspaceState>),
) => void;

function openAndSpawn(get: WorkspaceGet, set: WorkspaceSet, project: Project) {
  set((state) => ({ openedProjectIds: ensureOpened(state.openedProjectIds, project.id) }));
  return get().spawnForProject(project);
}

function restartAgentTargets(get: WorkspaceGet, reason: AgentRestartReason) {
  const { config, openedProjectIds } = get();
  if (!config) return;
  for (const target of agentPanesToRestart(openedProjectIds, config.projects, reason)) {
    void get().restartPane(target.projectId, target.paneId);
  }
}

async function executePaneLaunch(
  get: WorkspaceGet,
  plan: PaneLaunchPlan,
  projectId: string,
  paneId: string,
): Promise<boolean> {
  if (plan.action === "skip" || !plan.spawn) return false;
  const { setSessionStatus, setNotice } = get();
  if (plan.killFirst) {
    try {
      await ptyKill(plan.sessionId);
    } catch {
      // ignore
    }
    clearTerminal(plan.sessionId);
    setSessionStatus(plan.sessionId, "idle");
  }

  const persistClearSession = () => {
    if (!plan.clearSessionOnFallback) return;
    const latest = get().config;
    if (!latest) return;
    const current = latest.projects.find((project) => project.id === projectId);
    if (!current) return;
    const panes = current.panes.map((item) =>
      item.id === paneId ? { ...item, agent_session_id: null } : item,
    );
    void get().persist(patchProject(latest, projectId, { panes }));
  };

  const persistSeen = () => {
    if (!plan.markAgentSeen) return;
    const latest = get().config;
    if (latest) void get().persist(patchProject(latest, projectId, { agent_seen: true }));
  };

  const markRunning = (reused: boolean) => {
    if (plan.killFirst || !reused) setSessionStatus(plan.sessionId, "running");
  };

  try {
    const result = await spawnPty(plan.spawn);
    markRunning(result.reused);
    persistSeen();
    return true;
  } catch (err) {
    if (plan.fallbackSpawn) {
      try {
        const result = await spawnPty(plan.fallbackSpawn);
        markRunning(result.reused);
        persistClearSession();
        return true;
      } catch (retryErr) {
        setSessionStatus(plan.sessionId, "error");
        setNotice(`${plan.failNoticePrefix} 启动失败：${String(retryErr)}`);
        return false;
      }
    }
    setSessionStatus(plan.sessionId, "error");
    setNotice(`${plan.failNoticePrefix} 启动失败：${String(err)}`);
    return false;
  }
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
      const saved = savedActive ? config.projects.find((p) => p.id === savedActive) : undefined;
      const active = saved && !saved.stowed ? saved.id : nextWorkingId(config.projects);
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
    if (project.stowed) {
      await get().unstowProject(id, true);
      return;
    }
    if (get().activeProjectId === id && get().openedProjectIds.includes(id)) {
      return;
    }
    const prevActive = get().activeProjectId;
    const prevOpened = get().openedProjectIds;
    set((s) => ({
      activeProjectId: id,
      openedProjectIds: ensureOpened(s.openedProjectIds, id),
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
      stowed: false,
    });
    const next: AppConfig = {
      ...config,
      projects: [...workingProjects(config.projects), project, ...stowedProjects(config.projects)],
      settings: { ...config.settings, active_project_id: project.id },
    };
    const saved = await get().persist(next);
    if (!saved) return;
    set((s) => ({
      activeProjectId: project.id,
      openedProjectIds: ensureOpened(s.openedProjectIds, project.id),
      projectDialogOpen: false,
    }));
    const latest = get().config?.projects.find((p) => p.id === project.id) ?? project;
    await get().spawnForProject(latest);
  },

  reorderProjects: async (fromId, toIndex) => {
    const from = get().config?.projects.find((project) => project.id === fromId);
    if (!from) return;
    await get().moveProject(fromId, from.stowed ? "stowed" : "working", toIndex);
  },

  moveProject: async (fromId, dest, toIndex) => {
    const { config } = get();
    if (!config) return;
    const from = config.projects.find((project) => project.id === fromId);
    if (!from) return;
    const projects = placeProject(config.projects, fromId, dest, toIndex);
    if (placementUnchanged(config.projects, projects)) return;
    const becomingStowed = dest === "stowed" && !from.stowed;
    const wasActive = becomingStowed && get().activeProjectId === fromId;
    const nextActive = wasActive ? nextWorkingId(projects, fromId) : get().activeProjectId;
    const prevConfig = config;
    const prevActive = get().activeProjectId;
    const next: AppConfig = {
      ...config,
      projects,
      settings: { ...config.settings, active_project_id: nextActive },
    };
    set({ config: next, activeProjectId: nextActive });
    const saved = await get().persist(next);
    if (!saved) {
      set({ config: prevConfig, activeProjectId: prevActive });
      return;
    }
    if (!becomingStowed) return;
    await get().closeProject(fromId);
    set({ notice: `已收纳「${from.name}」` });
    if (!wasActive || !nextActive) return;
    const project = projects.find((item) => item.id === nextActive);
    if (!project) return;
    await openAndSpawn(get, set, project);
  },

  stowProject: async (id) => {
    const from = get().config?.projects.find((project) => project.id === id);
    if (!from || from.stowed) return;
    const stowed = stowedProjects(get().config?.projects ?? []);
    await get().moveProject(id, "stowed", stowed.length);
  },

  unstowProject: async (id, activate) => {
    const from = get().config?.projects.find((project) => project.id === id);
    if (!from) return;
    if (from.stowed) {
      const working = workingProjects(get().config?.projects ?? []);
      await get().moveProject(id, "working", working.length);
    }
    const latest = get().config?.projects.find((project) => project.id === id);
    if (activate && latest && !latest.stowed) await get().selectProject(id);
  },

  closeProject: async (id) => {
    const project = get().config?.projects.find((p) => p.id === id);
    const sessions = projectSessionIds(id, project);
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
    const nextActive = wasActive ? nextWorkingId(projects) : get().activeProjectId;
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
      await openAndSpawn(get, set, project);
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

  addQuickCommand: async (name, command) => {
    const { config, activeProjectId } = get();
    if (!config || !activeProjectId) return;
    const project = config.projects.find((item) => item.id === activeProjectId);
    if (!project) return;
    const label = name.trim();
    const body = command.trim();
    if (!label || !body) return;
    const quick_commands = [
      ...(project.quick_commands ?? []),
      { id: crypto.randomUUID(), name: label, command: body },
    ];
    await get().persist(patchProject(config, activeProjectId, { quick_commands }));
  },

  updateQuickCommand: async (id, name, command) => {
    const { config, activeProjectId } = get();
    if (!config || !activeProjectId) return;
    const project = config.projects.find((item) => item.id === activeProjectId);
    if (!project) return;
    const label = name.trim();
    const body = command.trim();
    if (!label || !body) return;
    const prev = project.quick_commands ?? [];
    if (!prev.some((item) => item.id === id)) return;
    const quick_commands = prev.map((item) =>
      item.id === id ? { ...item, name: label, command: body } : item,
    );
    await get().persist(patchProject(config, activeProjectId, { quick_commands }));
  },

  removeQuickCommand: async (id) => {
    const { config, activeProjectId } = get();
    if (!config || !activeProjectId) return;
    const project = config.projects.find((item) => item.id === activeProjectId);
    if (!project) return;
    const prev = project.quick_commands ?? [];
    if (!prev.some((item) => item.id === id)) return;
    const quick_commands = prev.filter((item) => item.id !== id);
    await get().persist(patchProject(config, activeProjectId, { quick_commands }));
  },

  reorderQuickCommands: async (fromId, toIndex) => {
    const { config, activeProjectId } = get();
    if (!config || !activeProjectId) return;
    const project = config.projects.find((item) => item.id === activeProjectId);
    if (!project) return;
    const prev = project.quick_commands ?? [];
    const fromIndex = prev.findIndex((item) => item.id === fromId);
    if (fromIndex < 0 || prev.length === 0) return;
    const clamped = Math.max(0, Math.min(toIndex, prev.length - 1));
    if (fromIndex === clamped) return;
    const quick_commands = [...prev];
    const [moved] = quick_commands.splice(fromIndex, 1);
    if (!moved) return;
    quick_commands.splice(clamped, 0, moved);
    const next = patchProject(config, activeProjectId, { quick_commands });
    set({ config: next });
    const saved = await get().persist(next);
    if (!saved) {
      set((s) => ({
        config: s.config
          ? patchProject(s.config, activeProjectId, { quick_commands: prev })
          : patchProject(config, activeProjectId, { quick_commands: prev }),
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
    const { config } = get();
    if (!config) return;
    let agentSeen = project.agent_seen;
    const resumeOnStart = config.settings.resume_on_start !== false;
    for (const pane of terminalPanes(project)) {
      const sid = paneSessionId(project.id, pane);
      const plan = planPaneLaunch({
        mode: "ensure",
        project,
        pane,
        presets: config.agent_presets,
        resumeOnStart,
        status: sid ? get().sessionStatus[sid] : undefined,
        agentSeen,
      });
      if (!plan || plan.action === "skip") continue;
      const ok = await executePaneLaunch(get, plan, project.id, pane.id);
      if (ok && plan.markAgentSeen) agentSeen = true;
    }
  },

  restartPane: async (projectId, paneId) => {
    const { config } = get();
    const project = config?.projects.find((item) => item.id === projectId);
    const pane = project?.panes.find((item) => item.id === paneId);
    if (!config || !project || !pane) return;
    const sid = paneSessionId(projectId, pane);
    const plan = planPaneLaunch({
      mode: "restart",
      project,
      pane,
      presets: config.agent_presets,
      resumeOnStart: config.settings.resume_on_start !== false,
      status: sid ? get().sessionStatus[sid] : undefined,
      agentSeen: project.agent_seen,
    });
    if (!plan) return;
    await executePaneLaunch(get, plan, projectId, paneId);
  },

  restartOpenedAgentsForPresetChange: (prevPresets, nextPresets) => {
    restartAgentTargets(get, { kind: "preset-commands", prevPresets, nextPresets });
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
    for (const target of liveAgentTargets(config.projects, openedProjectIds, get().sessionStatus, config.agent_presets)) {
      try {
        const found = await discoverAgentSession(target.command, target.cwd);
        if (found) await get().rememberAgentSession(target.projectId, target.paneId, found);
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
    restartAgentTargets(get, { kind: "theme" });
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
