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

fn is_allowed_github_url(url: &str) -> bool {
    let url = url.trim();
    if url.is_empty() || url.chars().any(char::is_whitespace) {
        return false;
    }
    let Some(rest) = url.strip_prefix("https://") else {
        return false;
    };
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = host.split(':').next().unwrap_or("");
    host.eq_ignore_ascii_case("github.com") || host.eq_ignore_ascii_case("www.github.com")
}

fn require_exists(path: &Path) -> AppResult<()> {
    if !path.exists() {
        return Err(AppError::msg(format!("路径不存在：{}", display_path(path))));
    }
    Ok(())
}

fn require_allowed(path: &Path, roots: &[PathBuf]) -> AppResult<()> {
    if !is_allowed(path, roots) {
        return Err(AppError::msg("路径不在已纳管的项目或书签目录内"));
    }
    Ok(())
}

fn is_valid_file_name(name: &str) -> bool {
    if name.is_empty() || name != name.trim() {
        return false;
    }
    if name == "." || name == ".." {
        return false;
    }
    if name.contains('/') || name.contains('\\') || name.contains('\0') {
        return false;
    }
    if name.chars().any(|c| c.is_control() || "<>:\"|?*".contains(c)) {
        return false;
    }
    !name.ends_with('.') && !name.ends_with(' ')
}

#[cfg(test)]
fn split_file_name(name: &str) -> (String, String) {
    match name.rfind('.') {
        Some(idx) if idx > 0 => (name[..idx].to_string(), name[idx..].to_string()),
        _ => (name.to_string(), String::new()),
    }
}

#[cfg(test)]
fn unique_name(desired: &str, existing: &[String], is_dir: bool) -> String {
    let lower: Vec<String> = existing.iter().map(|item| item.to_lowercase()).collect();
    if !lower.iter().any(|item| item == &desired.to_lowercase()) {
        return desired.to_string();
    }
    let (stem, ext) = if is_dir {
        (desired.to_string(), String::new())
    } else {
        split_file_name(desired)
    };
    let mut index = 1;
    loop {
        let candidate = format!("{stem} ({index}){ext}");
        if !lower.iter().any(|item| item == &candidate.to_lowercase()) {
            return candidate;
        }
        index += 1;
    }
}

fn is_nested_dest(src: &Path, dest: &Path) -> bool {
    dest == src || dest.starts_with(src)
}

fn resolve_new_path(dest: &Path, roots: &[PathBuf]) -> AppResult<PathBuf> {
    let parent = dest
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .ok_or_else(|| AppError::msg("无效的目标路径"))?;
    if !parent.exists() {
        return Err(AppError::msg(format!("目标目录不存在：{}", display_path(parent))));
    }
    if !parent.is_dir() {
        return Err(AppError::msg("目标不是目录"));
    }
    require_allowed(parent, roots)?;
    let name = dest
        .file_name()
        .ok_or_else(|| AppError::msg("无效的目标路径"))?;
    let name = name.to_string_lossy();
    if !is_valid_file_name(&name) {
        return Err(AppError::msg("无效的文件名"));
    }
    Ok(dunce::canonicalize(parent)?.join(name.as_ref()))
}

fn same_path(a: &Path, b: &Path) -> bool {
    match (dunce::canonicalize(a), dunce::canonicalize(b)) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

fn is_managed_root(path: &Path, roots: &[PathBuf]) -> bool {
    let Ok(canon) = dunce::canonicalize(path) else {
        return false;
    };
    roots.iter().any(|root| dunce::canonicalize(root).ok().as_deref() == Some(canon.as_path()))
}

fn copy_recursive(src: &Path, dest: &Path) -> AppResult<()> {
    let meta = std::fs::symlink_metadata(src)?;
    if meta.is_dir() {
        std::fs::create_dir(dest)?;
        for entry in std::fs::read_dir(src)? {
            let entry = entry?;
            copy_recursive(&entry.path(), &dest.join(entry.file_name()))?;
        }
        return Ok(());
    }
    std::fs::copy(src, dest)?;
    Ok(())
}

fn delete_path(path: &Path) -> AppResult<()> {
    let meta = std::fs::symlink_metadata(path)?;
    if meta.is_dir() {
        std::fs::remove_dir_all(path)?;
    } else {
        std::fs::remove_file(path)?;
    }
    Ok(())
}

fn is_cross_device(err: &std::io::Error) -> bool {
    match err.raw_os_error() {
        #[cfg(unix)]
        Some(18) => true,
        #[cfg(windows)]
        Some(17) => true,
        _ => false,
    }
}

fn copy_entry(src: &Path, dest: &Path, roots: &[PathBuf]) -> AppResult<String> {
    require_exists(src)?;
    require_allowed(src, roots)?;
    let dest_resolved = resolve_new_path(dest, roots)?;
    if dest_resolved.exists() {
        return Err(AppError::msg(format!("目标已存在：{}", display_path(&dest_resolved))));
    }
    let src_canon = dunce::canonicalize(src)?;
    if is_nested_dest(&src_canon, &dest_resolved) {
        return Err(AppError::msg("不能复制到自身或子目录"));
    }
    copy_recursive(&src_canon, &dest_resolved)?;
    Ok(display_path(&dest_resolved))
}

fn move_entry(src: &Path, dest: &Path, roots: &[PathBuf]) -> AppResult<String> {
    require_exists(src)?;
    require_allowed(src, roots)?;
    let dest_resolved = resolve_new_path(dest, roots)?;
    if dest_resolved.exists() {
        return Err(AppError::msg(format!("目标已存在：{}", display_path(&dest_resolved))));
    }
    let src_canon = dunce::canonicalize(src)?;
    if is_nested_dest(&src_canon, &dest_resolved) {
        return Err(AppError::msg("不能移动到自身或子目录"));
    }
    if is_managed_root(&src_canon, roots) {
        return Err(AppError::msg("不能移动项目根或书签目录"));
    }
    match std::fs::rename(&src_canon, &dest_resolved) {
        Ok(()) => Ok(display_path(&dest_resolved)),
        Err(err) if is_cross_device(&err) => {
            copy_recursive(&src_canon, &dest_resolved)?;
            delete_path(&src_canon)?;
            Ok(display_path(&dest_resolved))
        }
        Err(err) => Err(err.into()),
    }
}

fn rename_entry(path: &Path, new_name: &str, roots: &[PathBuf]) -> AppResult<String> {
    require_exists(path)?;
    require_allowed(path, roots)?;
    if !is_valid_file_name(new_name) {
        return Err(AppError::msg("无效的文件名"));
    }
    if is_managed_root(path, roots) {
        return Err(AppError::msg("不能重命名项目根或书签目录"));
    }
    let parent = path
        .parent()
        .ok_or_else(|| AppError::msg("无效的路径"))?;
    let dest = dunce::canonicalize(parent)?.join(new_name);
    if dest.exists() && !same_path(path, &dest) {
        return Err(AppError::msg(format!("目标已存在：{}", display_path(&dest))));
    }
    std::fs::rename(path, &dest)?;
    Ok(display_path(&dest))
}

fn delete_entry(path: &Path, roots: &[PathBuf]) -> AppResult<()> {
    require_exists(path)?;
    require_allowed(path, roots)?;
    if is_managed_root(path, roots) {
        return Err(AppError::msg("不能删除项目根或书签目录"));
    }
    delete_path(path)
}

fn create_entry(dir: &Path, name: &str, is_dir: bool, roots: &[PathBuf]) -> AppResult<String> {
    require_exists(dir)?;
    if !dir.is_dir() {
        return Err(AppError::msg("目标不是目录"));
    }
    require_allowed(dir, roots)?;
    if !is_valid_file_name(name) {
        return Err(AppError::msg("无效的文件名"));
    }
    let dest = dunce::canonicalize(dir)?.join(name);
    if dest.exists() {
        return Err(AppError::msg(format!("目标已存在：{}", display_path(&dest))));
    }
    if is_dir {
        std::fs::create_dir(&dest)?;
    } else {
        std::fs::File::create(&dest)?;
    }
    Ok(display_path(&dest))
}

fn reveal_path(path: &Path, roots: &[PathBuf]) -> AppResult<()> {
    require_exists(path)?;
    require_allowed(path, roots)?;
    #[cfg(windows)]
    {
        std::process::Command::new("explorer")
            .arg(format!("/select,{}", display_path(path)))
            .spawn()
            .map_err(|e| AppError::msg(format!("无法打开资源管理器：{e}")))?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", &display_path(path)])
            .spawn()
            .map_err(|e| AppError::msg(format!("无法打开资源管理器：{e}")))?;
        return Ok(());
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let dir = if path.is_dir() {
            path
        } else {
            path.parent().unwrap_or(path)
        };
        open::that_detached(dir).map_err(|e| AppError::msg(format!("无法打开目录：{e}")))
    }
}

fn spawn_fs<T: Send + 'static>(
    work: impl FnOnce() -> AppResult<T> + Send + 'static,
) -> impl std::future::Future<Output = AppResult<T>> {
    async move {
        tauri::async_runtime::spawn_blocking(work)
            .await
            .map_err(|e| AppError::msg(e.to_string()))?
    }
}

#[tauri::command]
pub fn open_url(url: String) -> AppResult<()> {
    if !is_allowed_github_url(&url) {
        return Err(AppError::msg("仅允许打开 GitHub 链接"));
    }
    open::that_detached(url.trim()).map_err(|e| AppError::msg(format!("无法打开链接：{e}")))
}

#[tauri::command]
pub async fn fs_open(state: State<'_, AppState>, path: String) -> AppResult<()> {
    let roots = state.config.lock().expect("config lock").allowed_roots();
    spawn_fs(move || open_file(Path::new(&path), &roots)).await
}

#[tauri::command]
pub async fn fs_list(state: State<'_, AppState>, path: String) -> AppResult<Vec<FileEntry>> {
    let roots = state.config.lock().expect("config lock").allowed_roots();
    spawn_fs(move || list_dir(Path::new(&path), &roots)).await
}

#[tauri::command]
pub async fn fs_reveal(state: State<'_, AppState>, path: String) -> AppResult<()> {
    let roots = state.config.lock().expect("config lock").allowed_roots();
    spawn_fs(move || reveal_path(Path::new(&path), &roots)).await
}

#[tauri::command]
pub async fn fs_copy(state: State<'_, AppState>, src: String, dest: String) -> AppResult<String> {
    let roots = state.config.lock().expect("config lock").allowed_roots();
    spawn_fs(move || copy_entry(Path::new(&src), Path::new(&dest), &roots)).await
}

#[tauri::command]
pub async fn fs_move(state: State<'_, AppState>, src: String, dest: String) -> AppResult<String> {
    let roots = state.config.lock().expect("config lock").allowed_roots();
    spawn_fs(move || move_entry(Path::new(&src), Path::new(&dest), &roots)).await
}

#[tauri::command]
pub async fn fs_rename(state: State<'_, AppState>, path: String, new_name: String) -> AppResult<String> {
    let roots = state.config.lock().expect("config lock").allowed_roots();
    spawn_fs(move || rename_entry(Path::new(&path), &new_name, &roots)).await
}

#[tauri::command]
pub async fn fs_delete(state: State<'_, AppState>, path: String) -> AppResult<()> {
    let roots = state.config.lock().expect("config lock").allowed_roots();
    spawn_fs(move || delete_entry(Path::new(&path), &roots)).await
}

#[tauri::command]
pub async fn fs_create(
    state: State<'_, AppState>,
    dir: String,
    name: String,
    is_dir: bool,
) -> AppResult<String> {
    let roots = state.config.lock().expect("config lock").allowed_roots();
    spawn_fs(move || create_entry(Path::new(&dir), &name, is_dir, &roots)).await
}

#[tauri::command]
pub fn check_dir(path: String) -> AppResult<bool> {
    Ok(PathBuf::from(path).is_dir())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("aw-fs-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn kind_folder_and_extension() {
        assert_eq!(kind_of(Path::new("a/b"), true), "文件夹");
        assert_eq!(kind_of(Path::new("a/b.ts"), false), "TS");
        assert_eq!(kind_of(Path::new("Makefile"), false), "文件");
    }

    #[test]
    fn sibling_prefix_is_not_under() {
        let tmp = temp_root("under");
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
        let tmp = temp_root("open");
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

    #[test]
    fn file_name_rejects_path_bits_and_reserved() {
        assert!(is_valid_file_name("foo.ts"));
        assert!(is_valid_file_name("新建文件夹"));
        assert!(!is_valid_file_name(""));
        assert!(!is_valid_file_name("  padded  "));
        assert!(!is_valid_file_name("."));
        assert!(!is_valid_file_name(".."));
        assert!(!is_valid_file_name("a/b"));
        assert!(!is_valid_file_name("a\\b"));
        assert!(!is_valid_file_name("a:b"));
        assert!(!is_valid_file_name("foo."));
    }

    #[test]
    fn unique_name_inserts_number_before_extension() {
        let existing = vec!["foo.ts".into(), "foo (1).ts".into()];
        assert_eq!(unique_name("bar.ts", &existing, false), "bar.ts");
        assert_eq!(unique_name("foo.ts", &existing, false), "foo (2).ts");
        assert_eq!(
            unique_name("src", &["src".into()], true),
            "src (1)"
        );
        assert_eq!(
            unique_name("foo.bar", &["foo.bar".into()], true),
            "foo.bar (1)"
        );
    }

    #[test]
    fn nested_dest_uses_path_components() {
        let src = Path::new("/proj/foo");
        assert!(is_nested_dest(src, Path::new("/proj/foo")));
        assert!(is_nested_dest(src, Path::new("/proj/foo/bar")));
        assert!(!is_nested_dest(src, Path::new("/proj/foo-backup")));
        assert!(!is_nested_dest(src, Path::new("/proj/other")));
    }

    #[test]
    fn copy_move_rename_delete_and_create_stay_inside_root() {
        let tmp = temp_root("mutate");
        let root = tmp.join("app");
        let outside = tmp.join("out");
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(root.join("src/a.ts"), "a").unwrap();
        let roots = [root.clone()];

        let copied = copy_entry(
            &root.join("src/a.ts"),
            &root.join("src/b.ts"),
            &roots,
        )
        .unwrap();
        assert!(copied.ends_with("b.ts"));
        assert_eq!(std::fs::read_to_string(root.join("src/b.ts")).unwrap(), "a");

        let exists_err = copy_entry(
            &root.join("src/a.ts"),
            &root.join("src/b.ts"),
            &roots,
        )
        .unwrap_err()
        .to_string();
        assert!(exists_err.contains("已存在"), "{exists_err}");

        let nested_err = copy_entry(&root.join("src"), &root.join("src/nested"), &roots)
            .unwrap_err()
            .to_string();
        assert!(nested_err.contains("自身"), "{nested_err}");

        let outside_err = copy_entry(
            &root.join("src/a.ts"),
            &outside.join("stolen.ts"),
            &roots,
        )
        .unwrap_err()
        .to_string();
        assert!(outside_err.contains("纳管"), "{outside_err}");

        let renamed = rename_entry(&root.join("src/b.ts"), "c.ts", &roots).unwrap();
        assert!(renamed.ends_with("c.ts"));
        assert!(!root.join("src/b.ts").exists());

        let bad_name = rename_entry(&root.join("src/c.ts"), "../x.ts", &roots)
            .unwrap_err()
            .to_string();
        assert!(bad_name.contains("无效"), "{bad_name}");

        let moved = move_entry(
            &root.join("src/c.ts"),
            &root.join("c.ts"),
            &roots,
        )
        .unwrap();
        assert!(moved.ends_with("c.ts"));
        assert!(!root.join("src/c.ts").exists());

        let created = create_entry(&root, "new.txt", false, &roots).unwrap();
        assert!(root.join("new.txt").is_file());
        assert!(created.ends_with("new.txt"));
        let folder = create_entry(&root, "folder", true, &roots).unwrap();
        assert!(root.join("folder").is_dir());
        assert!(folder.ends_with("folder"));

        delete_entry(&root.join("new.txt"), &roots).unwrap();
        assert!(!root.join("new.txt").exists());
        let root_err = delete_entry(&root, &roots).unwrap_err().to_string();
        assert!(root_err.contains("项目根"), "{root_err}");

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
