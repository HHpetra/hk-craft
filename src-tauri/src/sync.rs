use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::error::{AppError, AppResult};
use crate::AppState;

const SYNC_TIMEOUT: Duration = Duration::from_secs(600);
const FORBIDDEN: [char; 6] = ['\n', '\r', ';', '|', '&', '$'];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteTarget {
    pub host: String,
    pub user: String,
    pub path: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncDirection {
    Upload,
    Download,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SyncResult {
    pub files: usize,
    pub added: usize,
    pub modified: usize,
    pub deleted: usize,
    pub used_git: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SyncProgress {
    pub project_id: String,
    pub percent: u8,
    pub speed: String,
    pub file: String,
    pub op: String,
    pub transferred: usize,
    pub added: usize,
    pub modified: usize,
    pub deleted: usize,
    pub phase: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UnisonLine {
    Scan,
    Copy(String),
    Update(String),
    Delete(String),
    Error(String),
}

pub fn posix_single_quote(value: &str) -> String {
    let mut out = String::from("'");
    for part in value.split('\'') {
        if out.len() > 1 {
            out.push_str("'\\''");
        }
        out.push_str(part);
    }
    out.push('\'');
    out
}

pub fn validate_remote(host: &str, user: &str, path: &str) -> Result<RemoteTarget, String> {
    let host = host.trim();
    let user = user.trim();
    let path = path.trim().trim_end_matches('/');
    if path.is_empty() || path == "/" {
        return Err("远程目录无效".into());
    }
    for (name, value) in [("主机", host), ("用户名", user), ("远程目录", path)] {
        if value.is_empty() {
            return Err(format!("请填写{name}"));
        }
        if value.chars().any(|c| FORBIDDEN.contains(&c) || c == '`' || c.is_control()) {
            return Err(format!("{name}含有非法字符"));
        }
    }
    Ok(RemoteTarget {
        host: host.to_string(),
        user: user.to_string(),
        path: path.to_string(),
    })
}

pub fn ssh_destination(user: &str, host: &str) -> String {
    format!("{user}@{}", host_for_url(host))
}

pub fn unison_ssh_root(user: &str, host: &str, path: &str) -> String {
    let host = host_for_url(host);
    let path = path.trim_end_matches('/');
    format!("ssh://{user}@{host}/{path}")
}

fn host_for_url(host: &str) -> String {
    if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_string()
    }
}

pub fn has_git_metadata(root: &Path) -> bool {
    root.join(".git").exists()
}

fn local_root(path: &Path) -> String {
    dunce::simplified(path).to_string_lossy().into_owned()
}

pub fn gitignore_to_unison_ignore(raw: &str) -> Option<String> {
    let mut line = raw.trim();
    if let Some(stripped) = line.strip_suffix('\r') {
        line = stripped.trim();
    }
    if line.is_empty() || line.starts_with('#') || line.starts_with('!') {
        return None;
    }
    let anchored = line.starts_with('/');
    if anchored {
        line = &line[1..];
    }
    let dir_only = line.ends_with('/');
    if dir_only {
        line = line.trim_end_matches('/');
    }
    if line.is_empty() {
        return None;
    }
    if anchored || line.contains('/') {
        Some(format!("Path {line}"))
    } else {
        Some(format!("Name {line}"))
    }
}

fn bgn_path(line: &str, prefix: &str) -> Option<String> {
    let rest = line.strip_prefix(prefix)?;
    let file = rest.split(" from ").next().unwrap_or(rest).trim();
    if file.is_empty() {
        None
    } else {
        Some(file.to_string())
    }
}

pub fn parse_unison_line(line: &str) -> Option<UnisonLine> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let lower = line.to_ascii_lowercase();
    if lower.contains("fatal error") || lower.starts_with("error:") {
        return Some(UnisonLine::Error(line.to_string()));
    }
    if let Some(file) = bgn_path(line, "[BGN] Updating file ") {
        return Some(UnisonLine::Update(file));
    }
    if let Some(file) = bgn_path(line, "[BGN] Copying ") {
        return Some(UnisonLine::Copy(file));
    }
    if let Some(file) = bgn_path(line, "[BGN] Deleting ") {
        return Some(UnisonLine::Delete(file));
    }
    if line.starts_with("Looking for changes")
        || line.starts_with("Reconciling changes")
        || line.starts_with("Waiting for changes")
        || lower.contains("started propagating")
    {
        return Some(UnisonLine::Scan);
    }
    None
}

fn load_unison_ignores(root: &Path) -> Vec<String> {
    let mut out = vec!["Name .git".to_string()];
    let Ok(text) = std::fs::read_to_string(root.join(".gitignore")) else {
        return out;
    };
    for line in text.lines() {
        if let Some(pat) = gitignore_to_unison_ignore(line) {
            if !out.contains(&pat) {
                out.push(pat);
            }
        }
    }
    out
}

fn bump_percent(progress: &mut SyncProgress) {
    let next = 20u8.saturating_add(((progress.transferred + progress.deleted) * 2).min(75) as u8);
    progress.percent = progress.percent.max(next).min(95);
}

fn missing_bin(bin: &str) -> AppError {
    match bin {
        "unison" => AppError::msg("未找到 unison，请安装 Unison 并加入 PATH"),
        "ssh" => AppError::msg("未找到 ssh，请安装 OpenSSH 客户端"),
        _ => AppError::msg(format!("未找到 {bin}")),
    }
}

fn hidden_command(bin: &str) -> Command {
    let mut cmd = Command::new(bin);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

fn wait_child(
    child: &mut std::process::Child,
    deadline: Instant,
    bin: &str,
) -> AppResult<std::process::ExitStatus> {
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(AppError::msg(format!("{bin} 超时")));
                }
                thread::sleep(Duration::from_millis(50));
            }
            Err(err) => return Err(AppError::msg(format!("无法等待 {bin}：{err}"))),
        }
    }
}

fn ssh_mkdir(remote: &RemoteTarget) -> AppResult<()> {
    let dest = ssh_destination(&remote.user, &remote.host);
    let script = format!("mkdir -p -- {}", posix_single_quote(&remote.path));
    let mut cmd = hidden_command("ssh");
    cmd.args(["-o", "BatchMode=yes", &dest, &script])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let output = match cmd.output() {
        Ok(output) => output,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Err(missing_bin("ssh")),
        Err(err) => return Err(AppError::msg(format!("无法启动 ssh：{err}"))),
    };
    if output.status.success() {
        return Ok(());
    }
    let mut msg = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if msg.is_empty() {
        msg = String::from_utf8_lossy(&output.stdout).trim().to_string();
    }
    if msg.chars().count() > 400 {
        msg = msg.chars().take(400).collect::<String>() + "…";
    }
    Err(AppError::msg(format!("ssh 失败：{msg}")))
}

fn drain_stream(mut pipe: impl Read + Send, tx: mpsc::Sender<String>) {
    let mut buf = [0u8; 4096];
    let mut acc = Vec::new();
    loop {
        let n = match pipe.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(_) => break,
        };
        for &b in &buf[..n] {
            if b == b'\n' || b == b'\r' {
                if !acc.is_empty() {
                    let _ = tx.send(String::from_utf8_lossy(&acc).into_owned());
                    acc.clear();
                }
            } else {
                acc.push(b);
            }
        }
    }
    if !acc.is_empty() {
        let _ = tx.send(String::from_utf8_lossy(&acc).into_owned());
    }
}

fn emit_progress(app: &AppHandle, progress: &SyncProgress) {
    let _ = app.emit("sync-progress", progress);
}

fn apply_line(progress: &mut SyncProgress, line: &str, errors: &mut Vec<String>) {
    match parse_unison_line(line) {
        Some(UnisonLine::Error(msg)) => errors.push(msg),
        Some(UnisonLine::Copy(file)) => {
            progress.file = file;
            progress.op = "add".into();
            progress.added += 1;
            progress.transferred += 1;
            bump_percent(progress);
        }
        Some(UnisonLine::Update(file)) => {
            progress.file = file;
            progress.op = "modify".into();
            progress.modified += 1;
            progress.transferred += 1;
            bump_percent(progress);
        }
        Some(UnisonLine::Delete(file)) => {
            progress.file = file;
            progress.op = "delete".into();
            progress.deleted += 1;
            bump_percent(progress);
        }
        Some(UnisonLine::Scan) => {
            if progress.percent < 15 {
                progress.percent = 15;
            }
        }
        None => {}
    }
}

fn run_unison(
    app: &AppHandle,
    project_id: &str,
    root: &Path,
    remote: &RemoteTarget,
    direction: SyncDirection,
    used_git: bool,
) -> AppResult<SyncResult> {
    let local = local_root(root);
    let remote_root = unison_ssh_root(&remote.user, &remote.host, &remote.path);
    let force = match direction {
        SyncDirection::Upload => local.clone(),
        SyncDirection::Download => remote_root.clone(),
    };
    let mut cmd = hidden_command("unison");
    cmd.arg(&local)
        .arg(&remote_root)
        .arg("-batch")
        .arg("-auto")
        .arg("-ui")
        .arg("text")
        .arg("-dumbtty")
        .arg("-force")
        .arg(&force)
        .arg("-sshargs")
        .arg("-o BatchMode=yes");
    if used_git {
        for ignore in load_unison_ignores(root) {
            cmd.arg("-ignore").arg(ignore);
        }
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Err(missing_bin("unison")),
        Err(err) => return Err(AppError::msg(format!("无法启动 unison：{err}"))),
    };

    let (tx, rx) = mpsc::channel::<String>();
    if let Some(stdout) = child.stdout.take() {
        let tx = tx.clone();
        thread::spawn(move || drain_stream(stdout, tx));
    }
    if let Some(stderr) = child.stderr.take() {
        let tx = tx.clone();
        thread::spawn(move || drain_stream(stderr, tx));
    }
    drop(tx);

    let mut progress = SyncProgress {
        project_id: project_id.to_string(),
        percent: 0,
        speed: String::new(),
        file: String::new(),
        op: String::new(),
        transferred: 0,
        added: 0,
        modified: 0,
        deleted: 0,
        phase: "running".into(),
        message: String::new(),
    };
    emit_progress(app, &progress);

    let mut errors = Vec::new();
    let deadline = Instant::now() + SYNC_TIMEOUT;
    while Instant::now() < deadline {
        match rx.recv_timeout(Duration::from_millis(80)) {
            Ok(line) => {
                apply_line(&mut progress, &line, &mut errors);
                progress.phase = "running".into();
                emit_progress(app, &progress);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if child.try_wait()?.is_some() {
                    break;
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    let drain_until = Instant::now() + Duration::from_millis(400);
    while Instant::now() < drain_until {
        match rx.recv_timeout(Duration::from_millis(50)) {
            Ok(line) => apply_line(&mut progress, &line, &mut errors),
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    let status = match child.try_wait()? {
        Some(status) => status,
        None => wait_child(&mut child, deadline, "unison")?,
    };

    if !status.success() {
        let mut msg = errors.last().cloned().unwrap_or_else(|| {
            format!("退出码 {}", status.code().unwrap_or(-1))
        });
        if msg.chars().count() > 400 {
            msg = msg.chars().take(400).collect::<String>() + "…";
        }
        progress.phase = "error".into();
        progress.message = msg.clone();
        emit_progress(app, &progress);
        return Err(AppError::msg(format!("unison 失败：{msg}")));
    }

    progress.percent = 100;
    progress.phase = "done".into();
    progress.message = String::new();
    emit_progress(app, &progress);
    Ok(SyncResult {
        files: progress.transferred,
        added: progress.added,
        modified: progress.modified,
        deleted: progress.deleted,
        used_git,
    })
}

fn run_sync(
    app: &AppHandle,
    project_id: &str,
    root: &Path,
    remote: &RemoteTarget,
    direction: SyncDirection,
) -> AppResult<SyncResult> {
    if !root.is_dir() {
        return Err(AppError::msg("项目目录不存在"));
    }
    let used_git = has_git_metadata(root);
    ssh_mkdir(remote)?;
    run_unison(app, project_id, root, remote, direction, used_git)
}

fn project_sync_fields(state: &State<AppState>, project_id: &str) -> AppResult<(PathBuf, String, String, String)> {
    let cfg = state.config.lock().expect("config lock");
    let project = cfg
        .projects
        .iter()
        .find(|project| project.id == project_id)
        .ok_or_else(|| AppError::msg("项目不存在"))?;
    Ok((
        PathBuf::from(&project.path),
        project.remote_host.clone(),
        project.remote_user.clone(),
        project.remote_path.clone(),
    ))
}

#[tauri::command]
pub fn sync_has_git(project_id: String, state: State<AppState>) -> AppResult<bool> {
    let (path, _, _, _) = project_sync_fields(&state, &project_id)?;
    Ok(has_git_metadata(&path))
}

#[tauri::command]
pub fn sync_project(
    app: AppHandle,
    project_id: String,
    direction: String,
    state: State<AppState>,
) -> AppResult<SyncResult> {
    let (path, host, user, remote_path) = project_sync_fields(&state, &project_id)?;
    let remote = validate_remote(&host, &user, &remote_path).map_err(AppError::msg)?;
    let dir = match direction.as_str() {
        "upload" => SyncDirection::Upload,
        "download" => SyncDirection::Download,
        _ => return Err(AppError::msg("未知同步方向")),
    };
    match run_sync(&app, &project_id, &path, &remote, dir) {
        Ok(result) => Ok(result),
        Err(err) => {
            let _ = app.emit(
                "sync-progress",
                SyncProgress {
                    project_id: project_id.clone(),
                    percent: 0,
                    speed: String::new(),
                    file: String::new(),
                    op: String::new(),
                    transferred: 0,
                    added: 0,
                    modified: 0,
                    deleted: 0,
                    phase: "error".into(),
                    message: err.to_string(),
                },
            );
            Err(err)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn posix_single_quote_wraps_and_escapes() {
        assert_eq!(posix_single_quote("foo"), "'foo'");
        assert_eq!(posix_single_quote("foo'bar"), "'foo'\\''bar'");
        assert_eq!(posix_single_quote(""), "''");
    }

    #[test]
    fn validate_remote_rejects_bad_input() {
        assert!(validate_remote("10.0.0.2", "dev", "/home/dev/p").is_ok());
        assert_eq!(
            validate_remote("", "dev", "/home/dev/p").unwrap_err(),
            "请填写主机"
        );
        assert!(validate_remote("10.0.0.2", "dev", "/").is_err());
        assert!(validate_remote("10.0.0.2;rm", "dev", "/home/dev/p").is_err());
        let ok = validate_remote("10.0.0.2", "dev", "/home/dev/p/").unwrap();
        assert_eq!(ok.path, "/home/dev/p");
    }

    #[test]
    fn unison_ssh_root_uses_double_slash_for_absolute() {
        assert_eq!(
            unison_ssh_root("dev", "10.0.0.2", "/tmp/p"),
            "ssh://dev@10.0.0.2//tmp/p"
        );
        assert_eq!(
            unison_ssh_root("dev", "2001:db8::1", "/tmp/p"),
            "ssh://dev@[2001:db8::1]//tmp/p"
        );
        assert_eq!(
            unison_ssh_root("dev", "10.0.0.2", "work/p"),
            "ssh://dev@10.0.0.2/work/p"
        );
    }

    #[test]
    fn has_git_metadata_sees_dir_or_file() {
        let root = std::env::temp_dir().join(format!("hk-sync-git-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        assert!(!has_git_metadata(&root));
        std::fs::write(root.join(".git"), "gitdir: /tmp/foo").unwrap();
        assert!(has_git_metadata(&root));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn gitignore_to_unison_ignore_converts_common_lines() {
        assert_eq!(gitignore_to_unison_ignore("node_modules/").as_deref(), Some("Name node_modules"));
        assert_eq!(gitignore_to_unison_ignore("*.log").as_deref(), Some("Name *.log"));
        assert_eq!(gitignore_to_unison_ignore("/dist").as_deref(), Some("Path dist"));
        assert_eq!(gitignore_to_unison_ignore("foo/bar").as_deref(), Some("Path foo/bar"));
        assert_eq!(gitignore_to_unison_ignore("# comment"), None);
        assert_eq!(gitignore_to_unison_ignore("!keep.txt"), None);
        assert_eq!(gitignore_to_unison_ignore("  "), None);
    }

    #[test]
    fn parse_unison_line_reads_copy_update_delete_and_scan() {
        assert_eq!(
            parse_unison_line("[BGN] Copying src/a.ts from /local"),
            Some(UnisonLine::Copy("src/a.ts".into()))
        );
        assert_eq!(
            parse_unison_line("[BGN] Updating file src/b.ts from /local to ssh://host//tmp"),
            Some(UnisonLine::Update("src/b.ts".into()))
        );
        assert_eq!(
            parse_unison_line("[BGN] Deleting old.txt from ssh://host//tmp"),
            Some(UnisonLine::Delete("old.txt".into()))
        );
        assert_eq!(parse_unison_line("Looking for changes"), Some(UnisonLine::Scan));
        assert_eq!(parse_unison_line("Reconciling changes"), Some(UnisonLine::Scan));
        match parse_unison_line("Fatal error: Missing version") {
            Some(UnisonLine::Error(msg)) => assert!(msg.contains("Fatal error")),
            other => panic!("expected error, got {other:?}"),
        }
        assert_eq!(parse_unison_line("hello"), None);
    }
}
