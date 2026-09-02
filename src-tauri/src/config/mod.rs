use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::AppState;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Settings {
    #[serde(default = "default_theme")]
    pub theme: String,
    #[serde(default = "default_split_ratio")]
    pub default_split_ratio: Vec<f64>,
    #[serde(default)]
    pub active_project_id: Option<String>,
    #[serde(default = "default_explorer_view")]
    pub explorer_view: String,
    #[serde(default = "default_true")]
    pub resume_on_start: bool,
    #[serde(default)]
    pub terminal_font: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub last_agent_size: Vec<u16>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub last_runner_size: Vec<u16>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AgentPreset {
    pub id: String,
    pub name: String,
    pub command: String,
    #[serde(default = "default_drag_prefix")]
    pub drag_prefix: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Bookmark {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WorkspacePane {
    pub id: String,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preset_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Project {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(default)]
    pub agent_preset: String,
    #[serde(default = "default_true")]
    pub agent_seen: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_session_id: Option<String>,
    #[serde(default = "default_layout")]
    pub layout: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_pane_id: Option<String>,
    #[serde(default)]
    pub panes: Option<Vec<WorkspacePane>>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub stowed: bool,
}

impl Default for Project {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            path: String::new(),
            agent_preset: String::new(),
            agent_seen: true,
            agent_session_id: None,
            layout: default_layout(),
            active_pane_id: None,
            panes: None,
            stowed: false,
        }
    }
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
            resume_on_start: true,
            terminal_font: String::new(),
            last_agent_size: Vec::new(),
            last_runner_size: Vec::new(),
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

fn default_true() -> bool {
    true
}

fn is_false(value: &bool) -> bool {
    !*value
}

fn default_drag_prefix() -> String {
    "@".into()
}

fn default_layout() -> String {
    "row".into()
}

fn normalize_layout(layout: &str) -> String {
    match layout {
        "tabs" | "row" | "grid" => layout.to_string(),
        _ => default_layout(),
    }
}

fn seed_default_panes(agent_preset: &str, agent_session_id: Option<&str>) -> Vec<WorkspacePane> {
    vec![
        WorkspacePane {
            id: uuid::Uuid::new_v4().to_string(),
            kind: "explorer".into(),
            preset_id: None,
            agent_session_id: None,
        },
        WorkspacePane {
            id: uuid::Uuid::new_v4().to_string(),
            kind: "agent".into(),
            preset_id: Some(agent_preset.to_string()),
            agent_session_id: agent_session_id.map(str::to_string),
        },
        WorkspacePane {
            id: uuid::Uuid::new_v4().to_string(),
            kind: "runner".into(),
            preset_id: None,
            agent_session_id: None,
        },
    ]
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
        dsh_tui_preset(),
    ]
}

fn dsh_tui_preset() -> AgentPreset {
    AgentPreset {
        id: "dsh-tui".into(),
        name: "DeepSeek Harness TUI".into(),
        command: "dsh-tui".into(),
        drag_prefix: "@".into(),
    }
}

fn fallback_preset_id(presets: &[AgentPreset]) -> String {
    if presets.iter().any(|preset| preset.id == "cursor-agent") {
        "cursor-agent".into()
    } else {
        presets
            .first()
            .map(|preset| preset.id.clone())
            .unwrap_or_else(|| "cursor-agent".into())
    }
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
        self.agent_presets.retain(|preset| preset.id != "aider");
        if !self.agent_presets.iter().any(|preset| preset.id == "dsh-tui") {
            self.agent_presets.push(dsh_tui_preset());
        }
        let fallback = fallback_preset_id(&self.agent_presets);
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
            if project.agent_preset.is_empty() || project.agent_preset == "aider" {
                project.agent_preset = fallback.clone();
            }
            project.layout = normalize_layout(&project.layout);
            if project.panes.is_none() {
                project.panes = Some(seed_default_panes(
                    &project.agent_preset,
                    project.agent_session_id.as_deref(),
                ));
            }
            if let Some(panes) = project.panes.as_mut() {
                for pane in panes {
                    if pane.preset_id.as_deref() == Some("aider") {
                        pane.preset_id = Some(fallback.clone());
                    }
                }
            }
            let panes = project.panes.as_deref().unwrap_or(&[]);
            let active_ok = project
                .active_pane_id
                .as_ref()
                .is_some_and(|id| panes.iter().any(|pane| pane.id == *id));
            if !active_ok {
                project.active_pane_id = panes.first().map(|pane| pane.id.clone());
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
    let before = cfg.clone();
    cfg.migrate();
    if cfg != before {
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
        assert_eq!(cfg.agent_presets[3].id, "dsh-tui");
        assert_eq!(cfg.agent_presets[3].command, "dsh-tui");
        assert_eq!(cfg.settings.theme, "dark");
        assert_eq!(cfg.settings.explorer_view, "list");
        assert_eq!(cfg.settings.default_split_ratio, vec![30.0, 40.0, 30.0]);
    }

    #[test]
    fn migrate_fills_empty_project_id() {
        let mut cfg = AppConfig {
            projects: vec![Project {
                name: "demo".into(),
                path: "C:/tmp".into(),
                ..Project::default()
            }],
            ..AppConfig::default()
        };
        cfg.migrate();
        assert!(!cfg.projects[0].id.is_empty());
        assert_eq!(cfg.projects[0].agent_preset, "cursor-agent");
    }

    #[test]
    fn migrate_seeds_default_panes() {
        let mut cfg = AppConfig {
            projects: vec![Project {
                id: "proj-1".into(),
                name: "demo".into(),
                path: "C:/tmp".into(),
                agent_preset: "opencode".into(),
                agent_session_id: Some("chat-9".into()),
                layout: "nope".into(),
                ..Project::default()
            }],
            ..AppConfig::default()
        };
        cfg.migrate();
        let project = &cfg.projects[0];
        assert_eq!(project.layout, "row");
        let panes = project.panes.as_ref().expect("seeded panes");
        assert_eq!(panes.len(), 3);
        assert_eq!(panes[0].kind, "explorer");
        assert_eq!(panes[1].kind, "agent");
        assert_eq!(panes[1].preset_id.as_deref(), Some("opencode"));
        assert_eq!(panes[1].agent_session_id.as_deref(), Some("chat-9"));
        assert_eq!(panes[2].kind, "runner");
        assert_eq!(project.active_pane_id.as_deref(), Some(panes[0].id.as_str()));
    }

    #[test]
    fn migrate_keeps_explicit_empty_panes() {
        let mut cfg = AppConfig {
            projects: vec![Project {
                id: "proj-1".into(),
                name: "demo".into(),
                path: "C:/tmp".into(),
                agent_preset: "cursor-agent".into(),
                layout: "tabs".into(),
                panes: Some(Vec::new()),
                ..Project::default()
            }],
            ..AppConfig::default()
        };
        cfg.migrate();
        assert_eq!(cfg.projects[0].layout, "tabs");
        assert_eq!(cfg.projects[0].panes.as_ref().map(Vec::len), Some(0));
        assert_eq!(cfg.projects[0].active_pane_id, None);
    }

    #[test]
    fn migrate_replaces_aider_with_dsh_tui() {
        let mut cfg = AppConfig {
            agent_presets: vec![
                AgentPreset {
                    id: "cursor-agent".into(),
                    name: "Cursor Agent".into(),
                    command: "cursor-agent".into(),
                    drag_prefix: "@".into(),
                },
                AgentPreset {
                    id: "aider".into(),
                    name: "Aider".into(),
                    command: "aider".into(),
                    drag_prefix: "@".into(),
                },
            ],
            projects: vec![Project {
                id: "proj-1".into(),
                name: "demo".into(),
                path: "C:/tmp".into(),
                agent_preset: "aider".into(),
                panes: Some(vec![WorkspacePane {
                    id: "pane-agent".into(),
                    kind: "agent".into(),
                    preset_id: Some("aider".into()),
                    agent_session_id: None,
                }]),
                ..Project::default()
            }],
            ..AppConfig::default()
        };
        cfg.migrate();
        assert!(cfg.agent_presets.iter().all(|preset| preset.id != "aider"));
        assert!(cfg.agent_presets.iter().any(|preset| preset.id == "dsh-tui"));
        assert_eq!(cfg.projects[0].agent_preset, "cursor-agent");
        assert_eq!(
            cfg.projects[0].panes.as_ref().unwrap()[0]
                .preset_id
                .as_deref(),
            Some("cursor-agent")
        );
        cfg.migrate();
        assert_eq!(
            cfg.agent_presets
                .iter()
                .filter(|preset| preset.id == "dsh-tui")
                .count(),
            1
        );
    }

    #[test]
    fn stowed_defaults_false_and_skips_toml() {
        let project = Project {
            id: "p1".into(),
            name: "demo".into(),
            path: "C:/tmp".into(),
            ..Project::default()
        };
        assert!(!project.stowed);
        let body = toml::to_string(&project).expect("serialize project");
        assert!(!body.contains("stowed"));

        let parsed: Project = toml::from_str(
            r#"
name = "demo"
path = "C:/tmp"
"#,
        )
        .expect("parse project");
        assert!(!parsed.stowed);

        let stowed: Project = toml::from_str(
            r#"
name = "demo"
path = "C:/tmp"
stowed = true
"#,
        )
        .expect("parse stowed project");
        assert!(stowed.stowed);
        let stowed_body = toml::to_string(&stowed).expect("serialize stowed");
        assert!(stowed_body.contains("stowed = true"));
    }
}
