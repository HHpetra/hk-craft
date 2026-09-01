export type ViewMode = "explorer" | "agent" | "runner" | "tiled";

export type SessionKind = "agent" | "runner";

export type SessionStatus = "idle" | "running" | "waiting" | "exited" | "error";

export type ExplorerView = "list" | "icons";

export type AppTheme = "dark" | "light";

export interface Settings {
  theme: string;
  default_split_ratio: number[];
  active_project_id: string | null;
  explorer_view: string;
  resume_on_start: boolean;
  terminal_font: string;
  last_agent_size?: [number, number];
  last_runner_size?: [number, number];
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

export interface Project {
  id: string;
  name: string;
  path: string;
  agent_preset: string;
  agent_seen: boolean;
  agent_session_id: string | null;
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

export interface SpawnOpts {
  sessionId: string;
  cwd: string;
  command: string;
  args?: string[];
  cols?: number;
  rows?: number;
}
