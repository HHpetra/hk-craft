use std::collections::HashMap;
use std::io::{Read, Write};
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
}

#[derive(Serialize, Clone)]
pub struct PtyExit {
    pub session_id: String,
    pub success: bool,
    pub code: u32,
}

#[derive(Serialize)]
pub struct SpawnResult {
    pub session_id: String,
    pub reused: bool,
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
}

pub struct PtyManager {
    sessions: Mutex<HashMap<String, Arc<PtySession>>>,
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
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
                        dead.push((id.clone(), status.success(), status.exit_code()));
                    }
                    Err(_) => {
                        dead.push((id.clone(), false, 1));
                    }
                    Ok(None) => {}
                }
            }
            for (id, _, _) in &dead {
                map.remove(id);
            }
        }
        for (session_id, success, code) in dead {
            let _ = app.emit(
                "pty-exit",
                PtyExit {
                    session_id,
                    success,
                    code,
                },
            );
        }
    }

    fn exists(&self, session_id: &str) -> bool {
        self.sessions
            .lock()
            .expect("pty lock")
            .contains_key(session_id)
    }

    pub fn list(&self) -> Vec<String> {
        self.sessions.lock().expect("pty lock").keys().cloned().collect()
    }

    pub fn spawn(&self, app: AppHandle, opts: SpawnOpts) -> AppResult<SpawnResult> {
        if self.exists(&opts.session_id) {
            return Ok(SpawnResult {
                session_id: opts.session_id,
                reused: true,
            });
        }

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
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");

        let child = pair.slave.spawn_command(cmd)?;
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;
        let session_id = opts.session_id.clone();

        let session = Arc::new(PtySession {
            writer: Mutex::new(writer),
            master: Mutex::new(pair.master),
            child: Mutex::new(child),
        });

        self.sessions
            .lock()
            .expect("pty lock")
            .insert(session_id.clone(), Arc::clone(&session));

        thread::Builder::new()
            .name(format!("pty-read-{session_id}"))
            .spawn(move || {
                let mut buf = [0u8; 8192];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            let data = String::from_utf8_lossy(&buf[..n]).to_string();
                            let _ = app.emit(
                                "pty-output",
                                PtyOutput {
                                    session_id: session_id.clone(),
                                    data,
                                },
                            );
                        }
                        Err(_) => break,
                    }
                }
            })
            .map_err(|e| AppError::msg(e.to_string()))?;

        Ok(SpawnResult {
            session_id: opts.session_id,
            reused: false,
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
            let _ = session.child.lock().expect("child lock").kill();
        }
        Ok(())
    }
}

fn default_shell() -> (String, Vec<String>) {
    #[cfg(windows)]
    {
        ("powershell.exe".into(), vec!["-NoLogo".into()])
    }
    #[cfg(not(windows))]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
        (shell, Vec::new())
    }
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
        cmd.arg("/c");
        cmd.arg(&program);
        for arg in program_args {
            cmd.arg(arg);
        }
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
    state.pty.spawn(app, opts)
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
