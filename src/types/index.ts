export type WorkspaceLayout = "tabs" | "row" | "grid";

export type PaneKind = "explorer" | "agent" | "runner" | "docker";

export type SessionKind = "agent" | "runner" | "docker";

export type SessionStatus = "idle" | "running" | "waiting" | "exited" | "error";

export type ExplorerView = "list" | "icons";

export type AppTheme = "dark" | "light";

export interface Settings {
  theme: string;
  default_split_ratio: number[];
  active_project_id: string | null;
  explorer_view: string;
  explorer_column_widths?: number[];
  resume_on_start: boolean;
  terminal_font: string;
  last_agent_size?: [number, number];
  last_runner_size?: [number, number];
  last_docker_size?: [number, number];
}

export interface AgentPreset {
  id: string;
  name: string;
  command: string;
  drag_prefix: string;
}

export interface Bookmark {
  name: string;
  path: string;
}

export type WorkspacePane =
  | { id: string; kind: "explorer" }
  | { id: string; kind: "agent"; preset_id?: string | null; agent_session_id?: string | null }
  | { id: string; kind: "runner" }
  | {
      id: string;
      kind: "docker";
      docker_container?: string | null;
      docker_auto_exec?: boolean;
      docker_exec_command?: string;
    };

export type DockerPane = Extract<WorkspacePane, { kind: "docker" }>;
export type AgentPane = Extract<WorkspacePane, { kind: "agent" }>;

export interface DockerContainer {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  running: boolean;
}

export interface QuickCommand {
  id: string;
  name: string;
  command: string;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  agent_preset: string;
  agent_seen: boolean;
  agent_session_id: string | null;
  layout: WorkspaceLayout;
  active_pane_id: string | null;
  panes: WorkspacePane[];
  stowed?: boolean;
  quick_commands?: QuickCommand[];
  remote_host?: string;
  remote_user?: string;
  remote_path?: string;
}

export type SyncDirection = "upload" | "download";

export interface SyncResult {
  files: number;
  deleted: number;
  used_git: boolean;
}

export type SyncPhase = "running" | "done" | "error";

export interface SyncProgress {
  project_id: string;
  percent: number;
  speed: string;
  file: string;
  transferred: number;
  deleted: number;
  phase: SyncPhase | string;
  message: string;
}

export interface AppConfig {
  settings: Settings;
  agent_presets: AgentPreset[];
  bookmarks: Bookmark[];
  projects: Project[];
}

export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  modified: number;
  kind: string;
}

export interface SpawnResult {
  session_id: string;
  reused: boolean;
  generation: number;
}

export interface PtySessionStat {
  session_id: string;
  pid: number;
  memory_bytes: number;
  cpu_pct: number;
  process_count: number;
}

export interface PtyOutput {
  session_id: string;
  data: string;
  generation?: number;
}

export interface PtyExit {
  session_id: string;
  success: boolean;
  code: number;
  generation?: number;
}

export interface OpencodeHookEvent {
  session_id: string;
  opencode_id: string;
}

export interface SpawnOpts {
  sessionId: string;
  cwd: string;
  command: string;
  args?: string[];
  cols?: number;
  rows?: number;
}
