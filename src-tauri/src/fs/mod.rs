use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::AppState;

#[derive(Debug, Clone, Serialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: i64,
    pub kind: String,
}

fn display_path(path: &Path) -> String {
    dunce::simplified(path).to_string_lossy().to_string()
}

fn is_under(path: &Path, root: &Path) -> bool {
    let Ok(path) = dunce::canonicalize(path) else {
        return false;
    };
    let Ok(root) = dunce::canonicalize(root) else {
        return false;
    };
    path == root || path.starts_with(&root)
}

pub fn is_allowed(path: &Path, roots: &[PathBuf]) -> bool {
    roots.iter().any(|root| is_under(path, root))
}

fn kind_of(path: &Path, is_dir: bool) -> String {
    if is_dir {
        return "文件夹".into();
    }
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_uppercase())
        .unwrap_or_else(|| "文件".into())
}

fn list_dir(path: &Path, roots: &[PathBuf]) -> AppResult<Vec<FileEntry>> {
    if !path.exists() {
        return Err(AppError::msg(format!("路径不存在：{}", display_path(path))));
    }
    if !path.is_dir() {
        return Err(AppError::msg("目标不是目录"));
    }
    if !is_allowed(path, roots) {
        return Err(AppError::msg("路径不在已纳管的项目或书签目录内"));
    }

    let mut entries = Vec::new();
    for entry in std::fs::read_dir(path)? {
        let entry = entry?;
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let is_dir = meta.is_dir();
        let file_path = entry.path();
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        entries.push(FileEntry {
            name: entry.file_name().to_string_lossy().to_string(),
            path: display_path(&file_path),
            is_dir,
            size: if is_dir { 0 } else { meta.len() },
            modified,
            kind: kind_of(&file_path, is_dir),
        });
    }
    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(entries)
}

fn open_file(path: &Path, roots: &[PathBuf]) -> AppResult<()> {
    if !path.exists() {
        return Err(AppError::msg(format!("路径不存在：{}", display_path(path))));
    }
    if path.is_dir() {
        return Err(AppError::msg("请双击文件以用默认程序打开"));
    }
    if !is_allowed(path, roots) {
        return Err(AppError::msg("路径不在已纳管的项目或书签目录内"));
    }
    open::that_detached(path).map_err(|e| AppError::msg(format!("无法打开文件：{e}")))
}

#[tauri::command]
pub async fn fs_open(state: State<'_, AppState>, path: String) -> AppResult<()> {
    let roots = state.config.lock().expect("config lock").allowed_roots();
    tauri::async_runtime::spawn_blocking(move || open_file(Path::new(&path), &roots))
        .await
        .map_err(|e| AppError::msg(e.to_string()))?
}

#[tauri::command]
pub async fn fs_list(state: State<'_, AppState>, path: String) -> AppResult<Vec<FileEntry>> {
    let roots = state
        .config
        .lock()
        .expect("config lock")
        .allowed_roots();
    tauri::async_runtime::spawn_blocking(move || list_dir(Path::new(&path), &roots))
        .await
        .map_err(|e| AppError::msg(e.to_string()))?
}

#[tauri::command]
pub fn check_dir(path: String) -> AppResult<bool> {
    Ok(PathBuf::from(path).is_dir())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kind_folder_and_extension() {
        assert_eq!(kind_of(Path::new("a/b"), true), "文件夹");
        assert_eq!(kind_of(Path::new("a/b.ts"), false), "TS");
        assert_eq!(kind_of(Path::new("Makefile"), false), "文件");
    }

    #[test]
    fn sibling_prefix_is_not_under() {
        let tmp = std::env::temp_dir().join(format!("aw-fs-{}", std::process::id()));
        let root = tmp.join("app");
        let sibling = tmp.join("app2");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&sibling).unwrap();
        assert!(is_under(&root, &root));
        assert!(!is_under(&sibling, &root));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn open_file_rejects_directory_and_outside_root() {
        let tmp = std::env::temp_dir().join(format!("aw-open-{}", std::process::id()));
        let root = tmp.join("app");
        let outside = tmp.join("other.txt");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(&outside, "x").unwrap();
        let dir_err = open_file(&root, std::slice::from_ref(&root))
            .unwrap_err()
            .to_string();
        assert!(dir_err.contains("文件"), "{dir_err}");
        let outside_err = open_file(&outside, std::slice::from_ref(&root))
            .unwrap_err()
            .to_string();
        assert!(outside_err.contains("纳管"), "{outside_err}");
        let missing = open_file(&root.join("nope.txt"), std::slice::from_ref(&root))
            .unwrap_err()
            .to_string();
        assert!(missing.contains("不存在"), "{missing}");
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
