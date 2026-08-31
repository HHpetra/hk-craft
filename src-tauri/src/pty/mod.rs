use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::error::{AppError, AppResult};
use crate::AppState;

#[derive(Serialize, Clone)]
pub struct PtyOutput {
    pub session_id: String,
    pub data: String,
    pub generation: u64,
}

#[derive(Serialize, Clone)]
pub struct PtyExit {
    pub session_id: String,
    pub success: bool,
    pub code: u32,
    pub generation: u64,
}

#[derive(Serialize)]
pub struct SpawnResult {
    pub session_id: String,
    pub reused: bool,
    pub generation: u64,
}

#[derive(Deserialize)]
pub struct SpawnOpts {
    pub session_id: String,
    pub cwd: String,
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub cols: Option<u16>,
    #[serde(default)]
    pub rows: Option<u16>,
}

struct PtySession {
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
    generation: u64,
}

pub struct PtyManager {
    sessions: Mutex<HashMap<String, Arc<PtySession>>>,
    pending: Mutex<HashSet<String>>,
    generations: Mutex<HashMap<String, u64>>,
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            pending: Mutex::new(HashSet::new()),
            generations: Mutex::new(HashMap::new()),
        }
    }

    pub fn start_reaper(self: &Arc<Self>, app: AppHandle) {
        let mgr = Arc::clone(self);
        thread::Builder::new()
            .name("pty-reaper".into())
            .spawn(move || loop {
                thread::sleep(Duration::from_millis(250));
                mgr.reap(&app);
            })
            .ok();
    }

    fn next_generation(&self, session_id: &str) -> u64 {
        let mut map = self.generations.lock().expect("gen lock");
        let slot = map.entry(session_id.to_string()).or_insert(0);
        *slot += 1;
        *slot
    }

    fn reap(&self, app: &AppHandle) {
        let mut dead = Vec::new();
        {
            let mut map = self.sessions.lock().expect("pty lock");
            let ids: Vec<String> = map.keys().cloned().collect();
            for id in ids {
                let Some(session) = map.get(&id).cloned() else {
                    continue;
                };
                let mut child = session.child.lock().expect("child lock");
                match child.try_wait() {
                    Ok(Some(status)) => {
                        dead.push((id.clone(), status.success(), status.exit_code(), session.generation));
                    }
                    Err(_) => {
                        dead.push((id.clone(), false, 1, session.generation));
                    }
                    Ok(None) => {}
                }
            }
            for (id, _, _, _) in &dead {
                map.remove(id);
            }
        }
        for (session_id, success, code, generation) in dead {
            {
                let map = self.sessions.lock().expect("pty lock");
                if let Some(current) = map.get(&session_id) {
                    if current.generation != generation {
                        continue;
                    }
                }
            }
            let _ = app.emit(
                "pty-exit",
                PtyExit {
                    session_id,
                    success,
                    code,
                    generation,
                },
            );
        }
    }

    pub fn list(&self) -> Vec<String> {
        self.sessions.lock().expect("pty lock").keys().cloned().collect()
    }

    pub fn spawn(&self, app: AppHandle, opts: SpawnOpts, theme: &str) -> AppResult<SpawnResult> {
        loop {
            {
                let sessions = self.sessions.lock().expect("pty lock");
                if let Some(session) = sessions.get(&opts.session_id) {
                    return Ok(SpawnResult {
                        session_id: opts.session_id,
                        reused: true,
                        generation: session.generation,
                    });
                }
                let mut pending = self.pending.lock().expect("pending lock");
                if pending.contains(&opts.session_id) {
                    drop(pending);
                    drop(sessions);
                    thread::sleep(Duration::from_millis(50));
                    continue;
                }
                pending.insert(opts.session_id.clone());
            }
            break;
        }

        let session_id = opts.session_id.clone();
        let result = self.spawn_inner(app, opts, theme);
        self.pending.lock().expect("pending lock").remove(&session_id);
        result
    }

    fn spawn_inner(&self, app: AppHandle, opts: SpawnOpts, theme: &str) -> AppResult<SpawnResult> {
        let session_id = opts.session_id.clone();

        let cols = opts.cols.unwrap_or(80);
        let rows = opts.rows.unwrap_or(24);
        let pty_system = native_pty_system();
        let pair = pty_system.openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;

        let mut cmd = build_command(&opts.command, &opts.args);
        cmd.cwd(&opts.cwd);
        apply_user_shell_env(&mut cmd);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("PYTHONIOENCODING", "utf-8");
        apply_color_theme_env(&mut cmd, theme);

        let child = pair.slave.spawn_command(cmd)?;
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;

        let generation = self.next_generation(&session_id);
        let session = Arc::new(PtySession {
            writer: Mutex::new(writer),
            master: Mutex::new(pair.master),
            child: Mutex::new(child),
            generation,
        });

        self.sessions
            .lock()
            .expect("pty lock")
            .insert(session_id.clone(), Arc::clone(&session));

        let emit_id = session_id.clone();
        let emit_gen = generation;
        thread::Builder::new()
            .name(format!("pty-read-{session_id}"))
            .spawn(move || {
                let mut buf = [0u8; 8192];
                let mut leftover = Vec::new();
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) => {
                            if !leftover.is_empty() {
                                let data = String::from_utf8_lossy(&leftover).into_owned();
                                let _ = app.emit(
                                    "pty-output",
                                    PtyOutput {
                                        session_id: emit_id.clone(),
                                        data,
                                        generation: emit_gen,
                                    },
                                );
                            }
                            break;
                        }
                        Ok(n) => {
                            leftover.extend_from_slice(&buf[..n]);
                            let data = drain_pty_text(&mut leftover);
                            if data.is_empty() {
                                continue;
                            }
                            let _ = app.emit(
                                "pty-output",
                                PtyOutput {
                                    session_id: emit_id.clone(),
                                    data,
                                    generation: emit_gen,
                                },
                            );
                        }
                        Err(_) => break,
                    }
                }
            })
            .map_err(|e| {
                self.sessions.lock().expect("pty lock").remove(&session_id);
                AppError::msg(e.to_string())
            })?;

        Ok(SpawnResult {
            session_id: opts.session_id,
            reused: false,
            generation,
        })
    }

    pub fn write(&self, session_id: &str, data: &str) -> AppResult<()> {
        let session = self
            .sessions
            .lock()
            .expect("pty lock")
            .get(session_id)
            .cloned()
            .ok_or_else(|| AppError::msg("终端会话不存在"))?;
        let mut writer = session.writer.lock().expect("writer lock");
        writer.write_all(data.as_bytes())?;
        writer.flush()?;
        Ok(())
    }

    pub fn resize(&self, session_id: &str, cols: u16, rows: u16) -> AppResult<()> {
        if cols < 2 || rows < 2 {
            return Ok(());
        }
        let session = self
            .sessions
            .lock()
            .expect("pty lock")
            .get(session_id)
            .cloned()
            .ok_or_else(|| AppError::msg("终端会话不存在"))?;
        session
            .master
            .lock()
            .expect("master lock")
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })?;
        Ok(())
    }

    pub fn kill(&self, session_id: &str) -> AppResult<()> {
        let session = {
            let mut map = self.sessions.lock().expect("pty lock");
            map.remove(session_id)
        };
        if let Some(session) = session {
            let mut child = session.child.lock().expect("child lock");
            let _ = child.kill();
            let _ = child.wait();
        }
        Ok(())
    }
}

fn apply_color_theme_env(cmd: &mut CommandBuilder, theme: &str) {
    let light = theme.eq_ignore_ascii_case("light");
    cmd.env("TERM_THEME", if light { "light" } else { "dark" });
    cmd.env("COLORFGBG", if light { "0;15" } else { "15;0" });
}

fn apply_user_shell_env(cmd: &mut CommandBuilder) {
    for (key, _) in std::env::vars_os() {
        if let Some(name) = key.to_str() {
            if is_activation_env(name) {
                cmd.env_remove(name);
            }
        }
    }

    let login = cmd
        .get_env("PATH")
        .or_else(|| cmd.get_env("Path"))
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let process = std::env::var_os("PATH")
        .or_else(|| std::env::var_os("Path"))
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let merged = merge_path_lists(&login, &process);
    if !merged.is_empty() {
        cmd.env("PATH", merged);
    }
}

fn is_activation_env(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    matches!(
        upper.as_str(),
        "CONDA_SHLVL"
            | "CONDA_PREFIX"
            | "CONDA_DEFAULT_ENV"
            | "CONDA_PROMPT_MODIFIER"
            | "CONDA_PYTHON_EXE"
            | "CONDA_EXE"
            | "CONDA_ROOT"
            | "_CONDA_EXE"
            | "_CONDA_ROOT"
            | "_CE_M"
            | "_CE_CONDA"
            | "VIRTUAL_ENV"
            | "VIRTUAL_ENV_PROMPT"
    ) || upper.starts_with("CONDA_PREFIX_")
}

fn path_sep() -> char {
    if cfg!(windows) { ';' } else { ':' }
}

fn is_unix_style_conda_bin(path: &str) -> bool {
    let normalized = path.replace('/', "\\").trim_end_matches('\\').to_ascii_lowercase();
    let Some((_, last)) = normalized.rsplit_once('\\') else {
        return normalized == "bin";
    };
    last == "bin"
        && (normalized.contains("\\miniconda")
            || normalized.contains("\\anaconda")
            || normalized.ends_with("\\conda\\bin"))
}

fn should_drop_path_entry(path: &str) -> bool {
    let path = path.trim();
    path.is_empty() || (is_unix_style_conda_bin(path) && !Path::new(path).exists())
}

fn merge_path_lists(login: &str, extra: &str) -> String {
    let sep = path_sep();
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for part in login.split(sep).chain(extra.split(sep)) {
        let entry = part.trim();
        if should_drop_path_entry(entry) {
            continue;
        }
        let key = if cfg!(windows) {
            entry.to_ascii_lowercase()
        } else {
            entry.to_string()
        };
        if !seen.insert(key) {
            continue;
        }
        out.push(entry.to_string());
    }
    out.join(&sep.to_string())
}

fn drain_pty_text(buffer: &mut Vec<u8>) -> String {
    let mut out = String::new();
    loop {
        if buffer.is_empty() {
            return out;
        }
        match std::str::from_utf8(buffer) {
            Ok(s) => {
                out.push_str(s);
                buffer.clear();
                return out;
            }
            Err(err) => {
                let valid = err.valid_up_to();
                if valid > 0 {
                    out.push_str(std::str::from_utf8(&buffer[..valid]).unwrap_or(""));
                    buffer.drain(..valid);
                    continue;
                }
                if err.error_len().is_none() {
                    return out;
                }
                let remaining = buffer.len();
                let decoded = decode_gbk_available(buffer);
                if buffer.len() < remaining {
                    out.push_str(&decoded);
                    continue;
                }
                let len = err.error_len().unwrap_or(1).min(buffer.len());
                out.push('\u{FFFD}');
                buffer.drain(..len);
            }
        }
    }
}

fn decode_gbk_available(buffer: &mut Vec<u8>) -> String {
    let mut decoder = encoding_rs::GBK.new_decoder();
    let needed = decoder
        .max_utf8_buffer_length(buffer.len())
        .unwrap_or(buffer.len().saturating_mul(3));
    let mut decoded = String::with_capacity(needed);
    let (_result, read, _had_replacements) = decoder.decode_to_string(buffer, &mut decoded, false);
    if read == 0 {
        return String::new();
    }
    buffer.drain(..read);
    decoded
}

fn default_shell() -> (String, Vec<String>) {
    #[cfg(windows)]
    {
        (
            "powershell.exe".into(),
            vec![
                "-NoLogo".into(),
                "-NoExit".into(),
                "-Command".into(),
                "[Console]::InputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding; chcp 65001 | Out-Null".into(),
            ],
        )
    }
    #[cfg(not(windows))]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
        (shell, Vec::new())
    }
}

#[cfg_attr(not(windows), allow(dead_code))]
fn quote_cmd_arg(value: &str) -> String {
    if value.is_empty() {
        return "\"\"".into();
    }
    if !value.chars().any(|c| c.is_whitespace() || matches!(c, '"' | '&' | '|' | '<' | '>' | '^')) {
        return value.to_string();
    }
    format!("\"{}\"", value.replace('"', "\\\""))
}

fn build_command(command: &str, args: &[String]) -> CommandBuilder {
    let (program, program_args) = if command.trim().is_empty() {
        default_shell()
    } else {
        (command.to_string(), args.to_vec())
    };

    #[cfg(windows)]
    {
        let lower = program.to_ascii_lowercase();
        if lower.ends_with("powershell.exe")
            || lower.ends_with("pwsh.exe")
            || lower.ends_with("pwsh")
            || lower.ends_with("cmd.exe")
            || lower == "cmd"
        {
            let mut cmd = CommandBuilder::new(&program);
            for arg in program_args {
                cmd.arg(arg);
            }
            return cmd;
        }
        let mut cmd = CommandBuilder::new("cmd.exe");
        cmd.arg("/d");
        cmd.arg("/s");
        cmd.arg("/c");
        let mut line = String::from("chcp 65001 >nul & ");
        line.push_str(&quote_cmd_arg(&program));
        for arg in program_args {
            line.push(' ');
            line.push_str(&quote_cmd_arg(&arg));
        }
        cmd.arg(line);
        cmd
    }

    #[cfg(not(windows))]
    {
        let mut cmd = CommandBuilder::new(&program);
        for arg in program_args {
            cmd.arg(arg);
        }
        cmd
    }
}

#[tauri::command]
pub fn pty_spawn(app: AppHandle, state: State<'_, AppState>, opts: SpawnOpts) -> AppResult<SpawnResult> {
    let theme = state
        .config
        .lock()
        .expect("config lock")
        .settings
        .theme
        .clone();
    state.pty.spawn(app, opts, &theme)
}

#[tauri::command]
pub fn pty_write(state: State<'_, AppState>, session_id: String, data: String) -> AppResult<()> {
    state.pty.write(&session_id, &data)
}

#[tauri::command]
pub fn pty_resize(
    state: State<'_, AppState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> AppResult<()> {
    state.pty.resize(&session_id, cols, rows)
}

#[tauri::command]
pub fn pty_kill(state: State<'_, AppState>, session_id: String) -> AppResult<()> {
    state.pty.kill(&session_id)
}

#[tauri::command]
pub fn pty_list(state: State<'_, AppState>) -> Vec<String> {
    state.pty.list()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drain_keeps_incomplete_trailing_utf8() {
        let bytes = "你好".as_bytes();
        let last = bytes[bytes.len() - 1];
        let mut buf = bytes[..bytes.len() - 1].to_vec();
        assert_eq!(drain_pty_text(&mut buf), "你");
        assert!(!buf.is_empty());
        buf.push(last);
        assert_eq!(drain_pty_text(&mut buf), "好");
        assert!(buf.is_empty());
    }

    #[test]
    fn drain_gbk_chinese() {
        // 你好 in GBK
        let mut buf = vec![0xC4, 0xE3, 0xBA, 0xC3];
        assert_eq!(drain_pty_text(&mut buf), "你好");
        assert!(buf.is_empty());
    }

    #[test]
    fn quote_paths_with_spaces() {
        assert_eq!(quote_cmd_arg("cursor-agent"), "cursor-agent");
        assert_eq!(quote_cmd_arg(r"C:\Program Files\app.exe"), r#""C:\Program Files\app.exe""#);
    }

    #[test]
    fn strips_conda_and_venv_activation_vars() {
        assert!(is_activation_env("CONDA_SHLVL"));
        assert!(is_activation_env("conda_prefix"));
        assert!(is_activation_env("CONDA_PREFIX_1"));
        assert!(is_activation_env("VIRTUAL_ENV"));
        assert!(!is_activation_env("PATH"));
        assert!(!is_activation_env("CONDA_PKGS_DIRS"));
    }

    #[test]
    fn drops_missing_unix_conda_bin_from_path() {
        let fake_bin = r"C:\definitely-missing\miniconda3\bin";
        assert!(is_unix_style_conda_bin(fake_bin));
        assert!(!is_unix_style_conda_bin(r"C:\Users\me\miniconda3\Scripts"));
        let merged = merge_path_lists(
            r"C:\Windows;C:\definitely-missing\miniconda3\bin;C:\Windows\System32",
            r"C:\definitely-missing\miniconda3\bin;C:\Windows",
        );
        let lower = merged.to_ascii_lowercase();
        assert!(!lower.contains(r"miniconda3\bin"), "{merged}");
        assert!(lower.contains(r"c:\windows"));
        assert!(lower.contains(r"c:\windows\system32"));
    }
}
