mod clipboard;
mod config;
mod docker;
mod error;
mod fs;
mod opencode_discover;
mod opencode_hook;
mod pty;
mod runner;
mod session;
mod update;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use config::AppConfig;
use pty::PtyManager;
use tauri::Manager;

pub struct AppState {
    pub config: Mutex<AppConfig>,
    pub config_path: PathBuf,
    pub pty: Arc<PtyManager>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let config_path = config::config_path().map_err(|e| e.to_string())?;
            let cfg = match config::load_from_disk(&config_path) {
                Ok(cfg) => cfg,
                Err(err) => {
                    eprintln!("config load failed: {err}");
                    AppConfig::default()
                }
            };
            let pty = Arc::new(PtyManager::new());
            pty.start_reaper(app.handle().clone());
            opencode_hook::start(app.handle().clone());
            app.manage(AppState {
                config: Mutex::new(cfg),
                config_path,
                pty,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            config::load_config,
            config::save_config,
            fs::fs_list,
            fs::fs_open,
            fs::fs_reveal,
            fs::fs_copy,
            fs::fs_move,
            fs::fs_rename,
            fs::fs_delete,
            fs::fs_create,
            fs::open_url,
            fs::check_dir,
            clipboard::clipboard_read_text,
            clipboard::clipboard_write_text,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_list,
            pty::pty_session_stats,
            docker::docker_list_containers,
            docker::docker_ensure_running,
            session::discover_agent_sessions,
            runner::delete_runner_persist,
            update::fetch_latest_release_tag,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
