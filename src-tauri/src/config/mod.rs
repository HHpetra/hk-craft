use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::AppState;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    #[serde(default)]
    pub settings: Settings,
    #[serde(default)]
    pub agent_presets: Vec<AgentPreset>,
    #[serde(default)]
    pub bookmarks: Vec<Bookmark>,
    #[serde(default)]
    pub projects: Vec<Project>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    #[serde(default = "default_theme")]
    pub theme: String,
    #[serde(default = "default_split_ratio")]
    pub default_split_ratio: Vec<f64>,
    #[serde(default)]
    pub active_project_id: Option<String>,
    #[serde(default = "default_explorer_view")]
    pub explorer_view: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentPreset {
    pub id: String,
    pub name: String,
    pub command: String,
    #[serde(default = "default_drag_prefix")]
    pub drag_prefix: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Bookmark {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(default)]
    pub agent_preset: String,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            settings: Settings::default(),
            agent_presets: default_presets(),
            bookmarks: Vec::new(),
            projects: Vec::new(),
        }
    }
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: default_theme(),
            default_split_ratio: default_split_ratio(),
            active_project_id: None,
            explorer_view: default_explorer_view(),
        }
    }
}

fn default_theme() -> String {
    "dark".into()
}

fn default_explorer_view() -> String {
    "list".into()
}

fn default_split_ratio() -> Vec<f64> {
    vec![30.0, 40.0, 30.0]
}

fn default_drag_prefix() -> String {
    "@".into()
}

fn default_presets() -> Vec<AgentPreset> {
    vec![
        AgentPreset {
            id: "cursor-agent".into(),
            name: "Cursor Agent".into(),
            command: "cursor-agent".into(),
            drag_prefix: "@".into(),
        },
        AgentPreset {
            id: "opencode".into(),
            name: "OpenCode".into(),
            command: "opencode".into(),
            drag_prefix: "@".into(),
        },
        AgentPreset {
            id: "claude".into(),
            name: "Claude".into(),
            command: "claude".into(),
            drag_prefix: "@".into(),
        },
        AgentPreset {
            id: "aider".into(),
            name: "Aider".into(),
            command: "aider".into(),
            drag_prefix: "@".into(),
        },
    ]
}

impl AppConfig {
    pub fn allowed_roots(&self) -> Vec<PathBuf> {
        let mut roots: Vec<PathBuf> = self
            .projects
            .iter()
            .map(|p| PathBuf::from(&p.path))
            .collect();
        roots.extend(self.bookmarks.iter().map(|b| PathBuf::from(&b.path)));
        roots
    }

    pub fn migrate(&mut self) {
        if self.agent_presets.is_empty() {
            self.agent_presets = default_presets();
        }
        if self.settings.default_split_ratio.len() != 3 {
            self.settings.default_split_ratio = default_split_ratio();
        }
        if self.settings.theme != "light" {
            self.settings.theme = "dark".into();
        }
        if self.settings.explorer_view != "icons" {
            self.settings.explorer_view = "list".into();
        }
        for project in &mut self.projects {
            if project.id.is_empty() {
                project.id = uuid::Uuid::new_v4().to_string();
            }
            if project.agent_preset.is_empty() {
                project.agent_preset = self
                    .agent_presets
                    .first()
                    .map(|p| p.id.clone())
                    .unwrap_or_else(|| "cursor-agent".into());
            }
        }
    }
}

pub fn config_path() -> AppResult<PathBuf> {
    let home = dirs::home_dir().ok_or_else(|| AppError::msg("无法解析用户主目录"))?;
    Ok(home.join(".agent-workbench").join("config.toml"))
}

pub fn load_from_disk(path: &Path) -> AppResult<AppConfig> {
    if !path.exists() {
        let cfg = AppConfig::default();
        save_to_disk(path, &cfg)?;
        return Ok(cfg);
    }
    let raw = fs::read_to_string(path)?;
    let mut cfg: AppConfig = toml::from_str(&raw)?;
    let before = cfg.projects.clone();
    cfg.migrate();
    if cfg.projects.iter().any(|p| {
        before
            .iter()
            .find(|b| b.path == p.path)
            .map(|b| b.id.is_empty())
            .unwrap_or(false)
    }) {
        let _ = save_to_disk(path, &cfg);
    }
    Ok(cfg)
}

pub fn save_to_disk(path: &Path, cfg: &AppConfig) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let body = toml::to_string_pretty(cfg)?;
    let tmp = path.with_extension("toml.tmp");
    fs::write(&tmp, body)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

#[tauri::command]
pub fn load_config(state: State<'_, AppState>) -> AppResult<AppConfig> {
    let mut cfg = load_from_disk(&state.config_path)?;
    cfg.migrate();
    *state.config.lock().expect("config lock") = cfg.clone();
    Ok(cfg)
}

#[tauri::command]
pub fn save_config(state: State<'_, AppState>, config: AppConfig) -> AppResult<AppConfig> {
    let mut cfg = config;
    cfg.migrate();
    save_to_disk(&state.config_path, &cfg)?;
    *state.config.lock().expect("config lock") = cfg.clone();
    Ok(cfg)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_has_presets_and_split() {
        let cfg = AppConfig::default();
        assert_eq!(cfg.agent_presets.len(), 4);
        assert_eq!(cfg.settings.theme, "dark");
        assert_eq!(cfg.settings.explorer_view, "list");
        assert_eq!(cfg.settings.default_split_ratio, vec![30.0, 40.0, 30.0]);
    }

    #[test]
    fn migrate_fills_empty_project_id() {
        let mut cfg = AppConfig {
            projects: vec![Project {
                id: String::new(),
                name: "demo".into(),
                path: "C:/tmp".into(),
                agent_preset: String::new(),
            }],
            ..AppConfig::default()
        };
        cfg.migrate();
        assert!(!cfg.projects[0].id.is_empty());
        assert_eq!(cfg.projects[0].agent_preset, "cursor-agent");
    }
}
