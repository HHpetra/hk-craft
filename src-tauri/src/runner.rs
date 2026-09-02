use std::fs;
use std::path::{Path, PathBuf};

use crate::config;
use crate::error::{AppError, AppResult};

pub fn parse_session_id(session_id: &str) -> Option<(&str, &str, &str)> {
    let mut parts = session_id.splitn(3, ':');
    let project_id = parts.next()?;
    let kind = parts.next()?;
    let pane_id = parts.next()?;
    if project_id.is_empty() || kind.is_empty() || pane_id.is_empty() {
        return None;
    }
    Some((project_id, kind, pane_id))
}

pub fn is_runner_session(session_id: &str) -> bool {
    matches!(parse_session_id(session_id), Some((_, "runner", _)))
}

pub fn runner_project_id(session_id: &str) -> Option<&str> {
    match parse_session_id(session_id) {
        Some((id, "runner", _)) if is_safe_project_id(id) => Some(id),
        _ => None,
    }
}

pub fn is_safe_project_id(id: &str) -> bool {
    !id.is_empty()
        && !id.contains("..")
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

pub fn workbench_dir() -> AppResult<PathBuf> {
    let cfg = config::config_path()?;
    cfg.parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| AppError::msg("无法解析工作台目录"))
}

pub fn runner_dir_in(root: &Path, project_id: &str) -> AppResult<PathBuf> {
    if !is_safe_project_id(project_id) {
        return Err(AppError::msg("无效的项目 ID"));
    }
    Ok(root.join("runners").join(project_id))
}

pub fn runner_dir(project_id: &str) -> AppResult<PathBuf> {
    runner_dir_in(&workbench_dir()?, project_id)
}

pub fn history_path(project_id: &str) -> AppResult<PathBuf> {
    Ok(runner_dir(project_id)?.join("history"))
}

pub fn prepare_history_file(project_id: &str) -> AppResult<PathBuf> {
    let dir = runner_dir(project_id)?;
    fs::create_dir_all(&dir)?;
    let leftover = dir.join("transcript");
    if leftover.exists() {
        let _ = fs::remove_file(leftover);
    }
    history_path(project_id)
}

pub fn history_path_for_session(session_id: &str) -> AppResult<Option<PathBuf>> {
    if !is_runner_session(session_id) {
        return Ok(None);
    }
    let Some(id) = runner_project_id(session_id) else {
        return Ok(None);
    };
    Ok(Some(prepare_history_file(id)?))
}

pub fn quote_ps_single(path: &str) -> String {
    format!("'{}'", path.replace('\'', "''"))
}

#[tauri::command]
pub fn delete_runner_persist(project_id: String) -> AppResult<()> {
    let dir = runner_dir(&project_id)?;
    if dir.exists() {
        fs::remove_dir_all(dir)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runner_session_maps_to_project_id() {
        assert_eq!(
            runner_project_id("a1b2c3d4-e5f6-7890-abcd-ef1234567890:runner:pane-1"),
            Some("a1b2c3d4-e5f6-7890-abcd-ef1234567890")
        );
        assert!(is_runner_session("abc:runner:pane-1"));
        assert!(!is_runner_session("abc:agent:pane-1"));
        assert!(!is_runner_session("abc:runner"));
        assert_eq!(runner_project_id("abc:agent:pane-1"), None);
        assert_eq!(runner_project_id("../evil:runner:pane-1"), None);
        assert_eq!(runner_project_id("a/b:runner:pane-1"), None);
    }

    #[test]
    fn quote_ps_single_escapes_quotes() {
        assert_eq!(quote_ps_single(r"C:\work\history"), r"'C:\work\history'");
        assert_eq!(quote_ps_single("a'b"), "'a''b'");
    }

    #[test]
    fn runner_dir_rejects_unsafe_id() {
        let root = Path::new("/tmp");
        assert!(runner_dir_in(root, "../x").is_err());
        assert_eq!(
            runner_dir_in(root, "ok-id").unwrap(),
            root.join("runners").join("ok-id")
        );
    }

    #[test]
    fn agent_session_has_no_history_path() {
        assert!(history_path_for_session("abc:agent:pane-1").unwrap().is_none());
        assert!(history_path_for_session("abc:runner").unwrap().is_none());
        assert!(history_path_for_session("not-a-runner").unwrap().is_none());
    }

    #[test]
    fn delete_runner_dir_removes_history() {
        let root = std::env::temp_dir().join(format!("aw-runner-test-{}", std::process::id()));
        let project = "proj-roundtrip";
        let dir = runner_dir_in(&root, project).unwrap();
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("history");
        fs::write(&path, "Get-ChildItem").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "Get-ChildItem");
        fs::remove_dir_all(&root).unwrap();
        assert!(!path.exists());
    }
}
