import { invoke } from "@tauri-apps/api/core";
import type { AppConfig, FileEntry, SpawnOpts, SpawnResult } from "../types";

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

export function ptyWrite(sessionId: string, data: string) {
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

export function discoverAgentSession(command: string, cwd: string) {
  return invoke<string | null>("discover_agent_session", { command, cwd });
}
