import { invoke } from "@tauri-apps/api/core";
import { notePtyUserInput } from "./ptyActivity";
import type { AppConfig, DockerContainer, FileEntry, PtySessionStat, SpawnOpts, SpawnResult, SyncDirection, SyncPreview, SyncResult } from "../types";

export function loadConfig() {
  return invoke<AppConfig>("load_config");
}

export function saveConfig(config: AppConfig) {
  return invoke<AppConfig>("save_config", { config });
}

export function fsList(path: string) {
  return invoke<FileEntry[]>("fs_list", { path });
}

export function fsOpen(path: string) {
  return invoke<void>("fs_open", { path });
}

export function fsReveal(path: string) {
  return invoke<void>("fs_reveal", { path });
}

export function fsCopy(src: string, dest: string) {
  return invoke<string>("fs_copy", { src, dest });
}

export function fsMove(src: string, dest: string) {
  return invoke<string>("fs_move", { src, dest });
}

export function fsRename(path: string, newName: string) {
  return invoke<string>("fs_rename", { path, newName });
}

export function fsDelete(path: string) {
  return invoke<void>("fs_delete", { path });
}

export function fsCreate(dir: string, name: string, isDir: boolean) {
  return invoke<string>("fs_create", { dir, name, isDir });
}

export function openUrl(url: string) {
  return invoke<void>("open_url", { url });
}

export function fetchLatestReleaseTag(repo: string) {
  return invoke<string>("fetch_latest_release_tag", { repo });
}

export function checkDir(path: string) {
  return invoke<boolean>("check_dir", { path });
}

export function deleteRunnerPersist(projectId: string) {
  return invoke<void>("delete_runner_persist", { projectId });
}

export function ptySpawn(opts: SpawnOpts) {
  return invoke<SpawnResult>("pty_spawn", {
    opts: {
      session_id: opts.sessionId,
      cwd: opts.cwd,
      command: opts.command,
      args: opts.args ?? [],
      cols: opts.cols ?? null,
      rows: opts.rows ?? null,
    },
  });
}

export function clipboardReadText() {
  return invoke<string>("clipboard_read_text");
}

export function clipboardWriteText(text: string) {
  return invoke<void>("clipboard_write_text", { text });
}

export function ptyWrite(sessionId: string, data: string) {
  // OSC replies are terminal protocol, not keystrokes.
  if (!data.startsWith("\x1b]")) notePtyUserInput(sessionId);
  return invoke<void>("pty_write", { sessionId, data });
}

export function ptyResize(sessionId: string, cols: number, rows: number) {
  return invoke<void>("pty_resize", { sessionId, cols, rows });
}

export function ptyKill(sessionId: string) {
  return invoke<void>("pty_kill", { sessionId });
}

export function ptyList() {
  return invoke<string[]>("pty_list");
}

export function ptySessionStats() {
  return invoke<PtySessionStat[]>("pty_session_stats");
}

export function discoverAgentSessions(command: string, cwd: string) {
  return invoke<Array<{ id: string; updated_ms: number }>>("discover_agent_sessions", {
    command,
    cwd,
  }).then((rows) => rows.map((row) => ({ id: row.id, updatedMs: row.updated_ms })));
}

/** Whether `--resume <id>` can still load a stored session log for this pane. */
export function agentSessionAvailable(command: string, cwd: string, id: string) {
  return invoke<boolean>("agent_session_available", { command, cwd, id });
}

export function dockerListContainers() {
  return invoke<DockerContainer[]>("docker_list_containers");
}

export function dockerEnsureRunning(name: string) {
  return invoke<void>("docker_ensure_running", { name });
}

export function syncHasGit(projectId: string) {
  return invoke<boolean>("sync_has_git", { projectId });
}

export function syncProject(projectId: string, direction: SyncDirection) {
  return invoke<SyncResult>("sync_project", { projectId, direction });
}

export function syncPreview(projectId: string, direction: SyncDirection) {
  return invoke<SyncPreview>("sync_preview", { projectId, direction });
}

export function syncConfirm(projectId: string, direction: SyncDirection) {
  return invoke<SyncResult>("sync_confirm", { projectId, direction });
}

export function syncAbort(projectId: string) {
  return invoke<void>("sync_abort", { projectId });
}
