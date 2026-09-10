import { create } from "zustand";
import type {
  AgentPreset,
  AppConfig,
  ExplorerView,
  PaneKind,
  Project,
  SessionStatus,
  Settings,
  SpawnOpts,
  SpawnResult,
  WorkspaceLayout,
  WorkspacePane,
} from "../types";
import { agentTargets, liveAgentTargets } from "../lib/agentProtocol";
import { planCapturedSessions, type SessionAssignment } from "../lib/agentSessionAssign";
import { checkDir, deleteRunnerPersist, discoverAgentSessions, dockerEnsureRunning, loadConfig, ptyKill, ptyList, ptySpawn, ptyWrite, saveConfig } from "../lib/api";
import { dockerLaunchNotice, dockerLaunchStatus, executeDockerLaunch } from "../lib/dockerLaunch";
import { normalizeColumnWidths } from "../lib/explorerColumns";
import { beginPaneLaunch, cancelPaneLaunch, endPaneLaunch, requestPaneRelaunch, takePendingRelaunch } from "../lib/paneLaunchLock";
import { pathsEqual, sessionId } from "../lib/format";
import { getPtyActivity } from "../lib/ptyActivity";
import { agentPanesToRestart, planPaneLaunch, type AgentRestartReason, type PaneLaunchPlan } from "../lib/paneLaunch";
import { createDockerPane, createPane, neighborPaneId, normalizeLayout, paneSessionId, projectSessionIds, terminalPanes, withDefaultWorkspace } from "../lib/panes";
import {
  ensureOpened,
  nextWorkingId,
  placeProject,
  placementUnchanged,
  stowedProjects,
  workingProjects,
  type ProjectGroup,
} from "../lib/projects";
import { clearPtySession, waitPtyQuiet, waitResumeBootOutcome } from "../lib/ptyWait";
import { createSerialQueue, resolveQueuedUpdate } from "../lib/serialQueue";
import { sessionKindLabel } from "../lib/status";
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
  persist: (next: AppConfig | ((current: AppConfig) => AppConfig)) => Promise<boolean>;
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
  addPane: (kind: Exclude<PaneKind, "docker">, presetId?: string) => Promise<void>;
  addDockerPane: (container: string, autoExec: boolean, command: string) => Promise<void>;
  updateDockerPane: (paneId: string, container: string, autoExec: boolean, command: string) => Promise<void>;
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
  captureOpenedAgentSessions: () => Promise<void>;
  snapshotOpenedSessions: () => Promise<void>;
  setTheme: (theme: "dark" | "light") => Promise<void>;
  setResumeOnStart: (resume: boolean) => Promise<void>;
  setTerminalFont: (family: string) => Promise<void>;
  setExplorerView: (view: ExplorerView) => Promise<void>;
  previewExplorerColumnWidths: (widths: number[]) => void;
  setExplorerColumnWidths: (widths: number[]) => Promise<void>;
}

const defaultConfig = (): AppConfig => ({
  settings: {
    theme: "dark",
    default_split_ratio: [30, 40, 30],
    active_project_id: null,
    explorer_view: "list",
    explorer_column_widths: [42, 28, 16, 14],
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

function patchSettings(config: AppConfig, patch: Partial<Settings>): AppConfig {
  return { ...config, settings: { ...config.settings, ...patch } };
}

function mapProject(
  config: AppConfig,
  projectId: string,
  update: (project: Project) => Partial<Project> | null,
): AppConfig {
  const current = config.projects.find((project) => project.id === projectId);
  if (!current) return config;
  const patch = update(current);
  return patch ? patchProject(config, projectId, patch) : config;
}

function moveListed<T extends { id: string }>(items: T[], fromId: string, toIndex: number): T[] | null {
  const fromIndex = items.findIndex((item) => item.id === fromId);
  if (fromIndex < 0 || items.length === 0) return null;
  const clamped = Math.max(0, Math.min(toIndex, items.length - 1));
  if (fromIndex === clamped) return null;
  const next = [...items];
  const [moved] = next.splice(fromIndex, 1);
  if (!moved) return null;
  next.splice(clamped, 0, moved);
  return next;
}

const enqueuePersist = createSerialQueue();

function paneActivity(projectId: string, paneId: string) {
  const track = getPtyActivity(sessionId(projectId, "agent", paneId));
  return { lastUserWrite: track.lastUserWrite, lastOutput: track.lastOutput };
}

function applySessionAssignments(config: AppConfig, assignments: SessionAssignment[]): AppConfig | null {
  if (assignments.length === 0) return null;
  const byProject = new Map<string, Map<string, string | null>>();
  for (const assignment of assignments) {
    const panes = byProject.get(assignment.projectId) ?? new Map<string, string | null>();
    panes.set(assignment.paneId, assignment.sessionId);
    byProject.set(assignment.projectId, panes);
  }
  let changed = false;
  const projects = config.projects.map((project) => {
    const paneUpdates = byProject.get(project.id);
    if (!paneUpdates) return project;
    let projectChanged = false;
    const panes = project.panes.map((pane) => {
      if (!paneUpdates.has(pane.id) || pane.kind !== "agent") return pane;
      const nextId = paneUpdates.get(pane.id) ?? null;
      if ((pane.agent_session_id ?? null) === nextId) return pane;
      projectChanged = true;
      changed = true;
      return { ...pane, agent_session_id: nextId };
    });
    return projectChanged ? { ...project, panes } : project;
  });
  return changed ? { ...config, projects } : null;
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
  if (plan.action === "skip") return false;
  const signal = beginPaneLaunch(plan.sessionId);
  if (!signal) {
    requestPaneRelaunch(plan.sessionId);
    return false;
  }
  let ok = false;
  try {
    if (plan.kind === "docker") {
      const { setSessionStatus, setNotice } = get();
      setSessionStatus(plan.sessionId, "idle");
      const outcome = await executeDockerLaunch(
        { ...plan.input, signal },
        {
          ensureRunning: dockerEnsureRunning,
          spawn: spawnPty,
          write: ptyWrite,
          clearSession: clearPtySession,
          waitQuiet: waitPtyQuiet,
          kill: ptyKill,
          clearTerminal,
          sessionExists: async (sessionId) => (await ptyList()).includes(sessionId),
        },
      );
      if (!paneStillOpen(get, projectId, paneId)) {
        try {
          await ptyKill(plan.sessionId);
        } catch {
          // already gone
        }
        setSessionStatus(plan.sessionId, "idle");
      } else {
        setSessionStatus(plan.sessionId, dockerLaunchStatus(outcome));
        const notice = dockerLaunchNotice(outcome);
        if (notice) setNotice(notice);
        ok = outcome.ok || (outcome.reason === "inject" && outcome.sessionAlive);
      }
    } else {
      ok = await executeAgentOrRunnerLaunch(get, plan, projectId, paneId);
    }
  } finally {
    endPaneLaunch(plan.sessionId);
  }
  if (takePendingRelaunch(plan.sessionId)) {
    await get().restartPane(projectId, paneId);
  }
  return ok;
}

function paneStillOpen(get: WorkspaceGet, projectId: string, paneId: string) {
  const project = get().config?.projects.find((item) => item.id === projectId);
  if (!project || project.stowed) return false;
  if (!get().openedProjectIds.includes(projectId)) return false;
  return Boolean(project.panes?.some((pane) => pane.id === paneId));
}

async function executeAgentOrRunnerLaunch(
  get: WorkspaceGet,
  plan: Extract<PaneLaunchPlan, { action: "spawn"; kind: "agent" | "runner" }>,
  projectId: string,
  paneId: string,
): Promise<boolean> {
  const { setSessionStatus, setNotice } = get();
  const failPrefix = sessionKindLabel(plan.kind);
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
    if (plan.kind !== "agent" || !plan.resumeFallback) return;
    void get().persist((latest) =>
      mapProject(latest, projectId, (current) => ({
        panes: current.panes.map((item) =>
          item.id === paneId && item.kind === "agent" ? { ...item, agent_session_id: null } : item,
        ),
      })),
    );
  };

  const persistSeen = () => {
    if (plan.kind !== "agent" || !plan.markAgentSeen) return;
    void get().persist((latest) => patchProject(latest, projectId, { agent_seen: true }));
  };

  const markRunning = (reused: boolean) => {
    if (plan.killFirst || !reused) setSessionStatus(plan.sessionId, "running");
  };

  try {
    const result = await spawnPty(plan.spawn);
    markRunning(result.reused);
    persistSeen();
    if (plan.kind === "agent" && plan.resumeFallback && !result.reused) {
      const outcome = await waitResumeBootOutcome(plan.sessionId, result.generation);
      if (outcome === "fatal" && paneStillOpen(get, projectId, paneId)) {
        persistClearSession();
        await clearPtySession(plan.sessionId);
        clearTerminal(plan.sessionId);
        const second = await spawnPty(plan.resumeFallback);
        markRunning(second.reused);
      }
    }
    return true;
  } catch (err) {
    if (plan.kind === "agent" && plan.resumeFallback) {
      try {
        const second = await spawnPty(plan.resumeFallback);
        markRunning(second.reused);
        persistClearSession();
        return true;
      } catch (retryErr) {
        setSessionStatus(plan.sessionId, "error");
        setNotice(`${failPrefix} 启动失败：${String(retryErr)}`);
        return false;
      }
    }
    setSessionStatus(plan.sessionId, "error");
    setNotice(`${failPrefix} 启动失败：${String(err)}`);
    return false;
  }
}

async function appendPane(get: WorkspaceGet, pane: WorkspacePane) {
  const { config, activeProjectId } = get();
  if (!config || !activeProjectId) return;
  const saved = await get().persist((latest) =>
    mapProject(latest, activeProjectId, (current) => ({
      panes: [...(current.panes ?? []), pane],
      active_pane_id: pane.id,
    })),
  );
  if (!saved) return;
  const latest = get().config?.projects.find((p) => p.id === activeProjectId);
  if (latest) await get().spawnForProject(latest);
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
        docker: config.settings.last_docker_size,
      });
      void discoverLocalNerdFonts().then(() => applyRegisteredTerminalFont());
      if (active !== savedActive) {
        await get().persist((latest) => patchSettings(latest, { active_project_id: active }));
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

  persist: (next) =>
    enqueuePersist(async () => {
      const resolved = resolveQueuedUpdate(get().config, next);
      if (!resolved) return false;
      try {
        const sizes = peekLastFittedSizes();
        const saved = await saveConfig({
          ...resolved,
          settings: {
            ...resolved.settings,
            ...(sizes.agent ? { last_agent_size: sizes.agent } : {}),
            ...(sizes.runner ? { last_runner_size: sizes.runner } : {}),
            ...(sizes.docker ? { last_docker_size: sizes.docker } : {}),
          },
        });
        set({ config: saved });
        applyDocumentTheme(saved.settings.theme);
        return true;
      } catch (err) {
        set({ notice: String(err) });
        return false;
      }
    }),

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
    const saved = await get().persist((latest) => patchSettings(latest, { active_project_id: id }));
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
    const saved = await get().persist((latest) => {
      if (latest.projects.some((item) => pathsEqual(item.path, path.trim()))) return latest;
      return patchSettings(
        {
          ...latest,
          projects: [...workingProjects(latest.projects), project, ...stowedProjects(latest.projects)],
        },
        { active_project_id: project.id },
      );
    });
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
    set((state) => ({
      config: state.config
        ? patchSettings(
            { ...state.config, projects: placeProject(state.config.projects, fromId, dest, toIndex) },
            { active_project_id: nextActive },
          )
        : state.config,
      activeProjectId: nextActive,
    }));
    const saved = await get().persist((latest) => {
      const placed = placeProject(latest.projects, fromId, dest, toIndex);
      const activeId =
        becomingStowed && latest.settings.active_project_id === fromId
          ? nextWorkingId(placed, fromId)
          : latest.settings.active_project_id;
      return patchSettings({ ...latest, projects: placed }, { active_project_id: activeId });
    });
    if (!saved) {
      set({ config: prevConfig, activeProjectId: prevActive });
      return;
    }
    if (!becomingStowed) return;
    await get().closeProject(fromId);
    set({ notice: `已收纳「${from.name}」` });
    if (!wasActive || !nextActive) return;
    const project = get().config?.projects.find((item) => item.id === nextActive);
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
    for (const session of sessions) cancelPaneLaunch(session);
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
    const saved = await get().persist((latest) => {
      const remaining = latest.projects.filter((item) => item.id !== id);
      const activeId = wasActive ? nextWorkingId(remaining) : latest.settings.active_project_id;
      return patchSettings({ ...latest, projects: remaining }, { active_project_id: activeId });
    });
    if (!saved) return;
    await get().closeProject(id);
    try {
      await deleteRunnerPersist(id);
    } catch {
      // leftover files are non-fatal
    }
    set({ activeProjectId: nextActive });
    if (wasActive && nextActive) {
      const project = get().config?.projects.find((p) => p.id === nextActive);
      if (!project) return;
      await openAndSpawn(get, set, project);
    }
  },

  updateProjectPreset: async (id, agentPreset) => {
    const { config } = get();
    if (!config) return;
    await get().persist((latest) => patchProject(latest, id, { agent_preset: agentPreset }));
  },

  addPane: async (kind, presetId) => {
    const { config, activeProjectId } = get();
    if (!config || !activeProjectId) return;
    const project = config.projects.find((p) => p.id === activeProjectId);
    if (!project) return;
    const preset = kind === "agent" ? (presetId || project.agent_preset) : undefined;
    await appendPane(get, createPane(kind, preset));
  },

  addDockerPane: async (container, autoExec, command) => {
    await appendPane(get, createDockerPane({ container, autoExec, command }));
  },

  updateDockerPane: async (paneId, container, autoExec, command) => {
    const { config, activeProjectId } = get();
    if (!config || !activeProjectId) return;
    const project = config.projects.find((p) => p.id === activeProjectId);
    if (!project) return;
    const saved = await get().persist((latest) =>
      mapProject(latest, activeProjectId, (current) => ({
        panes: (current.panes ?? []).map((item) =>
          item.id === paneId && item.kind === "docker"
            ? {
                ...item,
                docker_container: container.trim(),
                docker_auto_exec: autoExec,
                docker_exec_command: command,
              }
            : item,
        ),
      })),
    );
    if (!saved) return;
    await get().restartPane(activeProjectId, paneId);
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
      cancelPaneLaunch(session);
      try {
        await ptyKill(session);
      } catch {
        // ignore
      }
      disposeTerminal(session);
      get().setSessionStatus(session, "idle");
    }
    await get().persist((latest) =>
      mapProject(latest, activeProjectId, (current) => {
        const panes = (current.panes ?? []).filter((item) => item.id !== paneId);
        const active_pane_id =
          current.active_pane_id === paneId ? neighborPaneId(current.panes ?? [], paneId) : current.active_pane_id;
        return { panes, active_pane_id };
      }),
    );
  },

  reorderPanes: async (fromId, toIndex) => {
    const { config, activeProjectId } = get();
    if (!config || !activeProjectId) return;
    const project = config.projects.find((p) => p.id === activeProjectId);
    if (!project) return;
    const prev = project.panes ?? [];
    if (!moveListed(prev, fromId, toIndex)) return;
    await get().persist((latest) =>
      mapProject(latest, activeProjectId, (item) => {
        const panes = moveListed(item.panes ?? [], fromId, toIndex);
        return panes ? { panes } : null;
      }),
    );
  },

  addQuickCommand: async (name, command) => {
    const { config, activeProjectId } = get();
    if (!config || !activeProjectId) return;
    const project = config.projects.find((item) => item.id === activeProjectId);
    if (!project) return;
    const label = name.trim();
    const body = command.trim();
    if (!label || !body) return;
    const entry = { id: crypto.randomUUID(), name: label, command: body };
    await get().persist((latest) =>
      mapProject(latest, activeProjectId, (current) => ({
        quick_commands: [...(current.quick_commands ?? []), entry],
      })),
    );
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
    await get().persist((latest) =>
      mapProject(latest, activeProjectId, (current) => ({
        quick_commands: (current.quick_commands ?? []).map((item) =>
          item.id === id ? { ...item, name: label, command: body } : item,
        ),
      })),
    );
  },

  removeQuickCommand: async (id) => {
    const { config, activeProjectId } = get();
    if (!config || !activeProjectId) return;
    const project = config.projects.find((item) => item.id === activeProjectId);
    if (!project) return;
    const prev = project.quick_commands ?? [];
    if (!prev.some((item) => item.id === id)) return;
    await get().persist((latest) =>
      mapProject(latest, activeProjectId, (current) => ({
        quick_commands: (current.quick_commands ?? []).filter((item) => item.id !== id),
      })),
    );
  },

  reorderQuickCommands: async (fromId, toIndex) => {
    const { config, activeProjectId } = get();
    if (!config || !activeProjectId) return;
    const project = config.projects.find((item) => item.id === activeProjectId);
    if (!project) return;
    const prev = project.quick_commands ?? [];
    if (!moveListed(prev, fromId, toIndex)) return;
    await get().persist((latest) =>
      mapProject(latest, activeProjectId, (current) => {
        const quick_commands = moveListed(current.quick_commands ?? [], fromId, toIndex);
        return quick_commands ? { quick_commands } : null;
      }),
    );
  },

  setLayout: async (layout) => {
    const { config, activeProjectId } = get();
    if (!config || !activeProjectId) return;
    const project = config.projects.find((p) => p.id === activeProjectId);
    if (!project || project.layout === layout) return;
    await get().persist((latest) =>
      mapProject(latest, activeProjectId, (current) =>
        current.layout === layout ? null : { layout: normalizeLayout(layout) },
      ),
    );
  },

  setActivePane: async (paneId) => {
    const { config, activeProjectId } = get();
    if (!config || !activeProjectId) return;
    const project = config.projects.find((p) => p.id === activeProjectId);
    if (!project || project.active_pane_id === paneId) return;
    if (!project.panes.some((pane) => pane.id === paneId)) return;
    await get().persist((latest) =>
      mapProject(latest, activeProjectId, (current) => {
        if (current.active_pane_id === paneId) return null;
        if (!current.panes.some((pane) => pane.id === paneId)) return null;
        return { active_pane_id: paneId };
      }),
    );
  },

  spawnForProject: async (project) => {
    const { config } = get();
    if (!config) return;
    const resumeOnStart = config.settings.resume_on_start !== false;
    if (resumeOnStart) {
      const assignments = await planCapturedSessions(
        agentTargets(project, config.agent_presets),
        discoverAgentSessions,
        () => ({ lastUserWrite: 0, lastOutput: 0 }),
        "resume",
      );
      const latest = get().config;
      if (latest && assignments.length > 0) {
        await get().persist((current) => applySessionAssignments(current, assignments) ?? current);
      }
    }
    const current = get().config?.projects.find((item) => item.id === project.id) ?? project;
    const presets = get().config?.agent_presets ?? config.agent_presets;
    const agentSeen = current.agent_seen;
    const launches: Promise<boolean>[] = [];
    for (const pane of terminalPanes(current)) {
      const sid = paneSessionId(current.id, pane);
      const plan = planPaneLaunch({
        mode: "ensure",
        project: current,
        pane,
        presets,
        resumeOnStart,
        status: sid ? get().sessionStatus[sid] : undefined,
        agentSeen,
      });
      if (!plan || plan.action === "skip") continue;
      launches.push(executePaneLaunch(get, plan, current.id, pane.id));
    }
    await Promise.all(launches);
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
    await get().persist(
      (latest) => applySessionAssignments(latest, [{ projectId, paneId, sessionId: chatId }]) ?? latest,
    );
  },

  captureOpenedAgentSessions: async () => {
    const { config, openedProjectIds } = get();
    if (!config) return;
    const targets = liveAgentTargets(
      config.projects,
      openedProjectIds,
      get().sessionStatus,
      config.agent_presets,
    );
    const assignments = await planCapturedSessions(targets, discoverAgentSessions, paneActivity);
    const latest = get().config;
    if (!latest) return;
    await get().persist((current) => applySessionAssignments(current, assignments) ?? current);
  },

  snapshotOpenedSessions: async () => {
    await get().captureOpenedAgentSessions();
    const activeProjectId = get().activeProjectId;
    const latest = get().config;
    if (!latest || latest.settings.active_project_id === activeProjectId) return;
    await get().persist((current) => patchSettings(current, { active_project_id: activeProjectId }));
  },

  setTheme: async (theme) => {
    const { config } = get();
    if (!config) return;
    applyDocumentTheme(theme);
    await get().persist((latest) => patchSettings(latest, { theme: normalizeTheme(theme) }));
    restartAgentTargets(get, { kind: "theme" });
  },

  setResumeOnStart: async (resume) => {
    const { config } = get();
    if (!config) return;
    await get().persist((latest) => patchSettings(latest, { resume_on_start: resume }));
  },

  setTerminalFont: async (family) => {
    const { config } = get();
    if (!config) return;
    setPreferredTerminalFont(family);
    applyRegisteredTerminalFont(family);
    await get().persist((latest) => patchSettings(latest, { terminal_font: family }));
  },

  setExplorerView: async (view) => {
    const { config } = get();
    if (!config) return;
    await get().persist((latest) => patchSettings(latest, { explorer_view: view }));
  },

  previewExplorerColumnWidths: (widths) => {
    const { config } = get();
    if (!config) return;
    set({
      config: patchSettings(config, { explorer_column_widths: [...normalizeColumnWidths(widths)] }),
    });
  },

  setExplorerColumnWidths: async (widths) => {
    const { config } = get();
    if (!config) return;
    const next = [...normalizeColumnWidths(widths)];
    await get().persist((latest) => patchSettings(latest, { explorer_column_widths: next }));
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
