use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc;
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::error::{AppError, AppResult};
use crate::AppState;

const SYNC_TIMEOUT: Duration = Duration::from_secs(600);
const HOLD_TIMEOUT: Duration = Duration::from_secs(600);
const SSH_TIMEOUT: Duration = Duration::from_secs(60);
const PREVIEW_LIST_CAP: usize = 200;
const UNISON_MAX_THREADS: u32 = 4;
const PREVIEW_EXPIRED_MSG: &str = "预览已过期，请重新扫描";
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

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SyncPreview {
    pub used_git: bool,
    pub added: Vec<String>,
    pub modified: Vec<String>,
    pub deleted: Vec<String>,
    pub added_count: usize,
    pub modified_count: usize,
    pub deleted_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UnisonLine {
    Scan,
    Copy(String),
    Update(String),
    Delete(String),
    Error(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReconKind {
    Add,
    Modify,
    Delete,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UnisonPreviewLine {
    Recon {
        kind: ReconKind,
        path: String,
        toward_right: bool,
    },
    ProceedPropagate,
    ConfirmBigDel,
    PressReturn,
    NothingToDo,
    StartedPropagating,
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

#[cfg(unix)]
pub fn ssh_control_path() -> String {
    std::env::temp_dir()
        .join("hk-craft-ssh-%C")
        .to_string_lossy()
        .replace('\\', "/")
}

pub fn ssh_opt_pairs() -> Vec<(&'static str, String)> {
    #[cfg(unix)]
    {
        vec![
            ("BatchMode", "yes".into()),
            ("ControlMaster", "auto".into()),
            ("ControlPath", ssh_control_path()),
            ("ControlPersist", "30".into()),
        ]
    }
    #[cfg(windows)]
    {
        vec![("BatchMode", "yes".into())]
    }
}

pub fn ssh_argv_opts() -> Vec<String> {
    let mut out = Vec::new();
    for (key, value) in ssh_opt_pairs() {
        out.push("-o".into());
        out.push(format!("{key}={value}"));
    }
    out
}

pub fn ssh_args_for_unison() -> String {
    ssh_argv_opts().join(" ")
}

pub fn parse_unison_version(text: &str) -> Option<(u32, u32)> {
    for token in text.split_whitespace() {
        let mut nums = token.split('.');
        let Some(major_s) = nums.next() else { continue };
        let Some(minor_s) = nums.next() else { continue };
        if let (Ok(major), Ok(minor)) = (major_s.parse::<u32>(), minor_s.parse::<u32>()) {
            return Some((major, minor));
        }
    }
    None
}

pub fn unison_maxthreads_arg(version: Option<(u32, u32)>) -> Option<u32> {
    match version {
        Some((major, minor)) if major > 2 || (major == 2 && minor >= 53) => Some(UNISON_MAX_THREADS),
        _ => None,
    }
}

pub fn unison_compress_supported(version: Option<(u32, u32)>) -> bool {
    matches!(version, Some((2, minor)) if minor < 53)
}

fn probe_unison_version() -> Option<(u32, u32)> {
    static CACHED: OnceLock<Option<(u32, u32)>> = OnceLock::new();
    *CACHED.get_or_init(|| {
        let mut cmd = hidden_command("unison");
        cmd.arg("-version")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let output = cmd.output().ok()?;
        parse_unison_version(&format!(
            "{} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        ))
    })
}

fn unison_profile_dir() -> Option<PathBuf> {
    let dir = dirs::home_dir()?.join(".hk-craft").join("unison");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

fn session_usable(
    direction: SyncDirection,
    expected: SyncDirection,
    hold_until: Instant,
    now: Instant,
) -> bool {
    direction == expected && now < hold_until
}

#[cfg(test)]
fn take_pending<V>(
    map: &mut HashMap<String, V>,
    project_id: &str,
    keep: impl FnOnce(&V) -> bool,
) -> Option<V> {
    match map.remove(project_id) {
        Some(session) if keep(&session) => Some(session),
        _ => None,
    }
}

struct PendingSync {
    direction: SyncDirection,
    used_git: bool,
    hold_until: Instant,
    child: Child,
    stdin: Option<ChildStdin>,
    rx: mpsc::Receiver<String>,
    disarm: bool,
}

impl Drop for PendingSync {
    fn drop(&mut self) {
        if self.disarm {
            return;
        }
        write_reply(&mut self.stdin, "q");
        kill_unison(&mut self.child);
    }
}

enum PreviewOutcome {
    Done(SyncPreview),
    Parked(SyncPreview, PendingSync),
}

pub struct SyncHost {
    inner: Mutex<SyncHostInner>,
}

struct SyncHostInner {
    pending: HashMap<String, PendingSync>,
    cancelled: HashSet<String>,
}

impl Default for SyncHost {
    fn default() -> Self {
        Self::new()
    }
}

impl SyncHost {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(SyncHostInner {
                pending: HashMap::new(),
                cancelled: HashSet::new(),
            }),
        }
    }

    fn begin_preview(&self, project_id: &str) {
        let mut inner = self.inner.lock().expect("sync lock");
        inner.cancelled.remove(project_id);
        let old = inner.pending.remove(project_id);
        drop(inner);
        drop(old);
    }

    fn abort(&self, project_id: &str) {
        let mut inner = self.inner.lock().expect("sync lock");
        inner.cancelled.insert(project_id.to_string());
        let old = inner.pending.remove(project_id);
        drop(inner);
        drop(old);
    }

    fn insert(&self, project_id: String, session: PendingSync) {
        let mut inner = self.inner.lock().expect("sync lock");
        if inner.cancelled.remove(&project_id) {
            drop(inner);
            drop(session);
            return;
        }
        let old = inner.pending.insert(project_id, session);
        drop(inner);
        drop(old);
    }

    fn take(&self, project_id: &str, direction: SyncDirection) -> AppResult<PendingSync> {
        let mut inner = self.inner.lock().expect("sync lock");
        let mut session = inner
            .pending
            .remove(project_id)
            .ok_or_else(|| AppError::msg(PREVIEW_EXPIRED_MSG))?;
        drop(inner);
        let alive = session.child.try_wait().ok().flatten().is_none();
        if !session_usable(session.direction, direction, session.hold_until, Instant::now()) || !alive {
            return Err(AppError::msg(PREVIEW_EXPIRED_MSG));
        }
        Ok(session)
    }
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

const RIGHT_ARROWS: [&str; 4] = ["====>", "==?=>", "---->", "--?->"];
const LEFT_ARROWS: [&str; 4] = ["<====", "<=?==", "<----", "<-?--"];
const STATUS_TOKENS: [&str; 13] = [
    "new file", "new dir", "new link", "chgd lnk", "chgd dir", "rnmd dir", "changed", "deleted",
    "renamed", "props", "file", "link", "dir",
];

fn strip_ansi(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' && chars.peek() == Some(&'[') {
            chars.next();
            for next in chars.by_ref() {
                if next.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            out.push(ch);
        }
    }
    out
}

fn find_arrow(line: &str) -> Option<(usize, usize, bool)> {
    let mut found: Option<(usize, usize, bool)> = None;
    for pat in RIGHT_ARROWS {
        if let Some(i) = line.find(pat) {
            if found.map(|(best, _, _)| i < best).unwrap_or(true) {
                found = Some((i, pat.len(), true));
            }
        }
    }
    for pat in LEFT_ARROWS {
        if let Some(i) = line.find(pat) {
            if found.map(|(best, _, _)| i < best).unwrap_or(true) {
                found = Some((i, pat.len(), false));
            }
        }
    }
    found
}

fn split_status_path(rest: &str) -> (&str, &str) {
    let rest = rest.trim_start();
    for token in STATUS_TOKENS {
        if let Some(after) = rest.strip_prefix(token) {
            if after.is_empty() || after.starts_with(' ') {
                return (token, after.trim());
            }
        }
    }
    ("", rest.trim())
}

fn trim_recon_path(path: &str) -> String {
    let mut path = path.trim();
    if let Some(i) = path.rfind(" [") {
        if path.ends_with(']') {
            path = path[..i].trim_end();
        }
    }
    path.to_string()
}

fn status_is_blank(status: &str) -> bool {
    status.trim().is_empty()
}

fn status_is_new(status: &str) -> bool {
    let t = status.trim();
    t.starts_with("new ") || matches!(t, "file" | "dir" | "link")
}

fn status_is_deleted(status: &str) -> bool {
    status.trim().starts_with("deleted")
}

fn classify_recon(src: &str, dst: &str) -> ReconKind {
    if status_is_deleted(src) || (status_is_blank(src) && !status_is_blank(dst)) {
        ReconKind::Delete
    } else if status_is_new(src) && status_is_blank(dst) {
        ReconKind::Add
    } else {
        ReconKind::Modify
    }
}

pub fn parse_unison_preview_line(line: &str) -> Option<UnisonPreviewLine> {
    let line = strip_ansi(line);
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let lower = line.to_ascii_lowercase();
    if lower.contains("fatal error") || lower.starts_with("error:") {
        return Some(UnisonPreviewLine::Error(line.to_string()));
    }
    if lower.contains("proceed with propagating") {
        return Some(UnisonPreviewLine::ProceedPropagate);
    }
    if lower.contains("do you really want to proceed") {
        return Some(UnisonPreviewLine::ConfirmBigDel);
    }
    if lower.contains("press return to continue") {
        return Some(UnisonPreviewLine::PressReturn);
    }
    if lower.starts_with("nothing to do") || lower.contains("no updates to propagate") {
        return Some(UnisonPreviewLine::NothingToDo);
    }
    if line.contains("[BGN]") || lower.contains("started propagating") {
        return Some(UnisonPreviewLine::StartedPropagating);
    }
    let (arrow_at, arrow_len, toward_right) = find_arrow(line)?;
    let left = line[..arrow_at].trim();
    let rest = line[arrow_at + arrow_len..].trim_start();
    let (right, path_raw) = split_status_path(rest);
    let path = trim_recon_path(path_raw);
    if path.is_empty() {
        return None;
    }
    let (src, dst) = if toward_right {
        (left, right)
    } else {
        (right, left)
    };
    Some(UnisonPreviewLine::Recon {
        kind: classify_recon(src, dst),
        path,
        toward_right,
    })
}

pub fn preview_prompt_reply(line: &UnisonPreviewLine) -> Option<&'static str> {
    match line {
        UnisonPreviewLine::ConfirmBigDel => Some("y"),
        UnisonPreviewLine::PressReturn => Some(""),
        _ => None,
    }
}

#[derive(Debug, Default)]
struct PreviewAcc {
    added: Vec<String>,
    modified: Vec<String>,
    deleted: Vec<String>,
    added_count: usize,
    modified_count: usize,
    deleted_count: usize,
    proceed: bool,
    propagating: bool,
    nothing: bool,
    errors: Vec<String>,
}

fn push_preview_path(list: &mut Vec<String>, count: &mut usize, path: String) {
    *count += 1;
    if list.len() < PREVIEW_LIST_CAP {
        list.push(path);
    }
}

fn apply_preview_line(acc: &mut PreviewAcc, line: &str, direction: SyncDirection) {
    match parse_unison_preview_line(line) {
        Some(UnisonPreviewLine::Error(msg)) => acc.errors.push(msg),
        Some(UnisonPreviewLine::ProceedPropagate) => acc.proceed = true,
        Some(UnisonPreviewLine::ConfirmBigDel | UnisonPreviewLine::PressReturn) => {}
        Some(UnisonPreviewLine::NothingToDo) => acc.nothing = true,
        Some(UnisonPreviewLine::StartedPropagating) => acc.propagating = true,
        Some(UnisonPreviewLine::Recon {
            kind,
            path,
            toward_right,
        }) => {
            let want_right = matches!(direction, SyncDirection::Upload);
            if toward_right != want_right {
                return;
            }
            match kind {
                ReconKind::Add => push_preview_path(&mut acc.added, &mut acc.added_count, path),
                ReconKind::Modify => {
                    push_preview_path(&mut acc.modified, &mut acc.modified_count, path)
                }
                ReconKind::Delete => {
                    push_preview_path(&mut acc.deleted, &mut acc.deleted_count, path)
                }
            }
        }
        None => {}
    }
}

impl PreviewAcc {
    fn into_preview(self, used_git: bool) -> SyncPreview {
        SyncPreview {
            used_git,
            added: self.added,
            modified: self.modified,
            deleted: self.deleted,
            added_count: self.added_count,
            modified_count: self.modified_count,
            deleted_count: self.deleted_count,
        }
    }
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
    cmd.args(ssh_argv_opts()).arg(&dest).arg(&script)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Err(missing_bin("ssh")),
        Err(err) => return Err(AppError::msg(format!("无法启动 ssh：{err}"))),
    };
    let status = wait_child(&mut child, Instant::now() + SSH_TIMEOUT, "ssh")?;
    let mut stderr = Vec::new();
    let mut stdout = Vec::new();
    if let Some(mut pipe) = child.stderr.take() {
        let _ = pipe.read_to_end(&mut stderr);
    }
    if let Some(mut pipe) = child.stdout.take() {
        let _ = pipe.read_to_end(&mut stdout);
    }
    if status.success() {
        return Ok(());
    }
    let mut msg = String::from_utf8_lossy(&stderr).trim().to_string();
    if msg.is_empty() {
        msg = String::from_utf8_lossy(&stdout).trim().to_string();
    }
    if msg.chars().count() > 400 {
        msg = msg.chars().take(400).collect::<String>() + "…";
    }
    Err(AppError::msg(format!("ssh 失败：{msg}")))
}

fn looks_like_unison_prompt(acc: &[u8]) -> bool {
    let lower = String::from_utf8_lossy(acc).to_ascii_lowercase();
    if lower.contains("press return to continue") {
        return true;
    }
    (acc.last() == Some(&b'?') || acc.ends_with(b"? ")) && lower.contains("proceed")
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
                if looks_like_unison_prompt(&acc) {
                    let _ = tx.send(String::from_utf8_lossy(&acc).into_owned());
                    acc.clear();
                }
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

fn parse_direction(direction: &str) -> AppResult<SyncDirection> {
    match direction {
        "upload" => Ok(SyncDirection::Upload),
        "download" => Ok(SyncDirection::Download),
        _ => Err(AppError::msg("未知同步方向")),
    }
}

fn unison_command(
    root: &Path,
    remote: &RemoteTarget,
    direction: SyncDirection,
    used_git: bool,
    batch: bool,
) -> Command {
    let local = local_root(root);
    let remote_root = unison_ssh_root(&remote.user, &remote.host, &remote.path);
    let force = match direction {
        SyncDirection::Upload => local.clone(),
        SyncDirection::Download => remote_root.clone(),
    };
    let mut cmd = hidden_command("unison");
    cmd.arg(local).arg(remote_root);
    if batch {
        cmd.arg("-batch");
    }
    cmd.arg("-auto")
        .arg("-ui")
        .arg("text")
        .arg("-dumbtty")
        .arg("-fastcheck")
        .arg("false")
        .arg("-ignorearchives")
        .arg("-force")
        .arg(&force)
        .arg("-sshargs")
        .arg(ssh_args_for_unison());
    let version = probe_unison_version();
    if let Some(threads) = unison_maxthreads_arg(version) {
        cmd.arg("-maxthreads").arg(threads.to_string());
    }
    if unison_compress_supported(version) {
        cmd.arg("-compress");
    }
    if let Some(profile_dir) = unison_profile_dir() {
        cmd.env("UNISON", profile_dir);
    }
    if used_git {
        for ignore in load_unison_ignores(root) {
            cmd.arg("-ignore").arg(ignore);
        }
    }
    cmd
}

fn spawn_unison(mut cmd: Command, stdin: Stdio) -> AppResult<std::process::Child> {
    cmd.stdin(stdin)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    match cmd.spawn() {
        Ok(child) => Ok(child),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Err(missing_bin("unison")),
        Err(err) => Err(AppError::msg(format!("无法启动 unison：{err}"))),
    }
}

fn attach_pipes(child: &mut std::process::Child) -> mpsc::Receiver<String> {
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
    rx
}

fn write_reply(stdin: &mut Option<ChildStdin>, reply: &str) {
    if let Some(pipe) = stdin.as_mut() {
        let _ = pipe.write_all(reply.as_bytes());
        let _ = pipe.write_all(b"\n");
        let _ = pipe.flush();
    }
}

fn kill_unison(child: &mut std::process::Child) {
    let _ = child.kill();
    let _ = child.wait();
}

fn truncate_err(msg: &str) -> String {
    if msg.chars().count() > 400 {
        msg.chars().take(400).collect::<String>() + "…"
    } else {
        msg.to_string()
    }
}

fn drain_unison_progress(
    app: &AppHandle,
    project_id: &str,
    child: &mut Child,
    rx: &mpsc::Receiver<String>,
    used_git: bool,
) -> AppResult<SyncResult> {
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
        None => wait_child(child, deadline, "unison")?,
    };

    if !status.success() {
        let msg = truncate_err(&errors.last().cloned().unwrap_or_else(|| {
            format!("退出码 {}", status.code().unwrap_or(-1))
        }));
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

fn run_unison(
    app: &AppHandle,
    project_id: &str,
    root: &Path,
    remote: &RemoteTarget,
    direction: SyncDirection,
    used_git: bool,
) -> AppResult<SyncResult> {
    let cmd = unison_command(root, remote, direction, used_git, true);
    let mut child = spawn_unison(cmd, Stdio::null())?;
    let rx = attach_pipes(&mut child);
    drain_unison_progress(app, project_id, &mut child, &rx, used_git)
}

fn finish_parked_unison(
    app: &AppHandle,
    project_id: &str,
    mut session: PendingSync,
) -> AppResult<SyncResult> {
    write_reply(&mut session.stdin, "y");
    let result = drain_unison_progress(
        app,
        project_id,
        &mut session.child,
        &session.rx,
        session.used_git,
    );
    session.disarm = true;
    result
}

fn abort_preview_process(stdin: &mut Option<ChildStdin>, child: &mut Child) {
    drop(stdin.take());
    kill_unison(child);
}

fn run_unison_preview(
    root: &Path,
    remote: &RemoteTarget,
    direction: SyncDirection,
    used_git: bool,
) -> AppResult<PreviewOutcome> {
    let cmd = unison_command(root, remote, direction, used_git, false);
    let mut child = spawn_unison(cmd, Stdio::piped())?;
    let mut stdin = child.stdin.take();
    let rx = attach_pipes(&mut child);
    let mut acc = PreviewAcc::default();
    let deadline = Instant::now() + SYNC_TIMEOUT;

    while Instant::now() < deadline {
        match rx.recv_timeout(Duration::from_millis(80)) {
            Ok(line) => {
                if let Some(parsed) = parse_unison_preview_line(&line) {
                    if let Some(reply) = preview_prompt_reply(&parsed) {
                        write_reply(&mut stdin, reply);
                    }
                }
                apply_preview_line(&mut acc, &line, direction);
                if acc.propagating {
                    abort_preview_process(&mut stdin, &mut child);
                    return Err(AppError::msg("预览时同步已开始，已中止"));
                }
                if acc.proceed {
                    break;
                }
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
            Ok(line) => {
                apply_preview_line(&mut acc, &line, direction);
                if acc.propagating {
                    abort_preview_process(&mut stdin, &mut child);
                    return Err(AppError::msg("预览时同步已开始，已中止"));
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    if acc.propagating {
        abort_preview_process(&mut stdin, &mut child);
        return Err(AppError::msg("预览时同步已开始，已中止"));
    }

    let has_items = acc.added_count + acc.modified_count + acc.deleted_count > 0;
    let still_running = child.try_wait()?.is_none();
    if acc.proceed && has_items && still_running {
        return Ok(PreviewOutcome::Parked(
            acc.into_preview(used_git),
            PendingSync {
                direction,
                used_git,
                hold_until: Instant::now() + HOLD_TIMEOUT,
                child,
                stdin,
                rx,
                disarm: false,
            },
        ));
    }

    if still_running {
        match wait_child(&mut child, deadline, "unison") {
            Ok(_) => {}
            Err(_) => {
                if acc.nothing || !has_items {
                    return Ok(PreviewOutcome::Done(acc.into_preview(used_git)));
                }
                return Err(AppError::msg("unison 超时"));
            }
        }
    }

    if !acc.errors.is_empty() && !acc.proceed && !acc.nothing && !has_items {
        let msg = truncate_err(acc.errors.last().expect("errors not empty"));
        return Err(AppError::msg(format!("unison 失败：{msg}")));
    }
    Ok(PreviewOutcome::Done(acc.into_preview(used_git)))
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

fn emit_sync_error(app: &AppHandle, project_id: &str, err: &AppError) {
    let _ = app.emit(
        "sync-progress",
        SyncProgress {
            project_id: project_id.to_string(),
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
}

fn run_preview(
    host: &SyncHost,
    project_id: &str,
    root: &Path,
    remote: &RemoteTarget,
    direction: SyncDirection,
) -> AppResult<SyncPreview> {
    if !root.is_dir() {
        return Err(AppError::msg("项目目录不存在"));
    }
    host.begin_preview(project_id);
    let used_git = has_git_metadata(root);
    ssh_mkdir(remote)?;
    match run_unison_preview(root, remote, direction, used_git)? {
        PreviewOutcome::Done(preview) => Ok(preview),
        PreviewOutcome::Parked(preview, session) => {
            host.insert(project_id.to_string(), session);
            Ok(preview)
        }
    }
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
    let dir = parse_direction(&direction)?;
    match run_sync(&app, &project_id, &path, &remote, dir) {
        Ok(result) => Ok(result),
        Err(err) => {
            emit_sync_error(&app, &project_id, &err);
            Err(err)
        }
    }
}

#[tauri::command]
pub fn sync_preview(
    project_id: String,
    direction: String,
    state: State<AppState>,
) -> AppResult<SyncPreview> {
    let (path, host, user, remote_path) = project_sync_fields(&state, &project_id)?;
    let remote = validate_remote(&host, &user, &remote_path).map_err(AppError::msg)?;
    let dir = parse_direction(&direction)?;
    run_preview(&state.sync, &project_id, &path, &remote, dir)
}

#[tauri::command]
pub fn sync_confirm(
    app: AppHandle,
    project_id: String,
    direction: String,
    state: State<AppState>,
) -> AppResult<SyncResult> {
    let dir = parse_direction(&direction)?;
    let session = state.sync.take(&project_id, dir)?;
    match finish_parked_unison(&app, &project_id, session) {
        Ok(result) => Ok(result),
        Err(err) => {
            emit_sync_error(&app, &project_id, &err);
            Err(err)
        }
    }
}

#[tauri::command]
pub fn sync_abort(project_id: String, state: State<AppState>) -> AppResult<()> {
    state.sync.abort(&project_id);
    Ok(())
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

    #[test]
    fn parse_unison_preview_line_reads_add_modify_delete() {
        match parse_unison_preview_line("new file ---->   src/a.ts") {
            Some(UnisonPreviewLine::Recon {
                kind: ReconKind::Add,
                path,
                toward_right: true,
            }) => assert_eq!(path, "src/a.ts"),
            other => panic!("expected add, got {other:?}"),
        }
        match parse_unison_preview_line("changed  ----> changed  src/b.ts") {
            Some(UnisonPreviewLine::Recon {
                kind: ReconKind::Modify,
                path,
                toward_right: true,
            }) => assert_eq!(path, "src/b.ts"),
            other => panic!("expected modify, got {other:?}"),
        }
        match parse_unison_preview_line("deleted  ---->   old.txt") {
            Some(UnisonPreviewLine::Recon {
                kind: ReconKind::Delete,
                path,
                toward_right: true,
            }) => assert_eq!(path, "old.txt"),
            other => panic!("expected delete, got {other:?}"),
        }
        match parse_unison_preview_line("  ====> new file extra.txt") {
            Some(UnisonPreviewLine::Recon {
                kind: ReconKind::Delete,
                path,
                toward_right: true,
            }) => assert_eq!(path, "extra.txt"),
            other => panic!("expected forced remote delete, got {other:?}"),
        }
        match parse_unison_preview_line("         <---- new file   c") {
            Some(UnisonPreviewLine::Recon {
                kind: ReconKind::Add,
                path,
                toward_right: false,
            }) => assert_eq!(path, "c"),
            other => panic!("expected local add, got {other:?}"),
        }
    }

    #[test]
    fn parse_unison_preview_line_proceed_nothing_and_bgn() {
        assert_eq!(
            parse_unison_preview_line("Proceed with propagating updates?"),
            Some(UnisonPreviewLine::ProceedPropagate)
        );
        assert_eq!(
            parse_unison_preview_line("Do you really want to proceed?"),
            Some(UnisonPreviewLine::ConfirmBigDel)
        );
        assert_eq!(
            parse_unison_preview_line("Press return to continue.[<spc>]"),
            Some(UnisonPreviewLine::PressReturn)
        );
        assert_eq!(
            parse_unison_preview_line("Nothing to do: replicas have not changed since last sync."),
            Some(UnisonPreviewLine::NothingToDo)
        );
        assert_eq!(
            parse_unison_preview_line("No updates to propagate"),
            Some(UnisonPreviewLine::NothingToDo)
        );
        assert_eq!(
            parse_unison_preview_line("[BGN] Copying src/a.ts from /local"),
            Some(UnisonPreviewLine::StartedPropagating)
        );
        assert_eq!(parse_unison_preview_line("Looking for changes"), None);
    }

    #[test]
    fn preview_prompt_reply_leaves_proceed_for_confirm() {
        assert_eq!(
            preview_prompt_reply(&UnisonPreviewLine::ProceedPropagate),
            None
        );
        assert_eq!(
            preview_prompt_reply(&UnisonPreviewLine::ConfirmBigDel),
            Some("y")
        );
        assert_eq!(
            preview_prompt_reply(&UnisonPreviewLine::PressReturn),
            Some("")
        );
        assert_eq!(
            preview_prompt_reply(&UnisonPreviewLine::NothingToDo),
            None
        );
    }

    #[test]
    fn apply_preview_line_keeps_destination_files_and_counts() {
        let mut acc = PreviewAcc::default();
        apply_preview_line(&mut acc, "new file ---->   src/a.ts", SyncDirection::Upload);
        apply_preview_line(&mut acc, "changed  ----> changed  src/b.ts", SyncDirection::Upload);
        apply_preview_line(&mut acc, "  ====> new file extra.txt", SyncDirection::Upload);
        apply_preview_line(
            &mut acc,
            "         <---- new file local-only.ts",
            SyncDirection::Upload,
        );
        apply_preview_line(&mut acc, "Proceed with propagating updates?", SyncDirection::Upload);
        apply_preview_line(&mut acc, "[BGN] Copying src/a.ts from /local", SyncDirection::Upload);
        assert_eq!(acc.added, vec!["src/a.ts"]);
        assert_eq!(acc.modified, vec!["src/b.ts"]);
        assert_eq!(acc.deleted, vec!["extra.txt"]);
        assert_eq!(acc.added_count, 1);
        assert_eq!(acc.modified_count, 1);
        assert_eq!(acc.deleted_count, 1);
        assert!(acc.proceed);
        assert!(acc.propagating);
    }

    #[test]
    fn apply_preview_line_download_uses_left_arrow() {
        let mut acc = PreviewAcc::default();
        apply_preview_line(&mut acc, "         <---- new file   c", SyncDirection::Download);
        apply_preview_line(&mut acc, "new file ---->   remote-only.ts", SyncDirection::Download);
        apply_preview_line(
            &mut acc,
            "changed  <---- changed  src/app.ts",
            SyncDirection::Download,
        );
        assert_eq!(acc.added, vec!["c"]);
        assert_eq!(acc.modified, vec!["src/app.ts"]);
        assert!(acc.deleted.is_empty());
    }

    #[test]
    fn looks_like_unison_prompt_flushes_without_newline() {
        assert!(looks_like_unison_prompt(b"Proceed with propagating updates?"));
        assert!(looks_like_unison_prompt(b"Do you really want to proceed? "));
        assert!(looks_like_unison_prompt(b"Press return to continue."));
        assert!(looks_like_unison_prompt(b"Press return to continue.[<spc>]"));
        assert!(!looks_like_unison_prompt(b"new file ----> foo?"));
        assert!(!looks_like_unison_prompt(b"Looking for changes"));
    }

    #[test]
    fn ssh_opts_include_batch_and_controlmaster() {
        let args = ssh_args_for_unison();
        assert!(args.contains("BatchMode=yes"));
        #[cfg(unix)]
        {
            assert!(args.contains("ControlMaster=auto"));
            assert!(args.contains("hk-craft-ssh-%C"));
            assert!(args.contains("ControlPersist=30"));
        }
        #[cfg(windows)]
        {
            assert!(!args.contains("ControlMaster"));
            assert!(!args.contains("ControlPath"));
        }
        let argv = ssh_argv_opts();
        assert_eq!(argv[0], "-o");
        assert!(argv.windows(2).any(|pair| pair[0] == "-o" && pair[1] == "BatchMode=yes"));
    }

    #[test]
    fn unison_compress_only_supported_before_2_53() {
        assert!(unison_compress_supported(Some((2, 51))));
        assert!(unison_compress_supported(Some((2, 52))));
        assert!(!unison_compress_supported(Some((2, 53))));
        assert!(!unison_compress_supported(Some((2, 54))));
        assert!(!unison_compress_supported(Some((3, 0))));
        assert!(!unison_compress_supported(None));
    }

    #[test]
    fn parse_unison_version_and_maxthreads_gate() {
        assert_eq!(parse_unison_version("unison version 2.51.5"), Some((2, 51)));
        assert_eq!(parse_unison_version("unison version 2.53.3"), Some((2, 53)));
        assert_eq!(parse_unison_version("not a version"), None);
        assert_eq!(unison_maxthreads_arg(Some((2, 51))), None);
        assert_eq!(unison_maxthreads_arg(Some((2, 53))), Some(4));
        assert_eq!(unison_maxthreads_arg(Some((3, 0))), Some(4));
        assert_eq!(unison_maxthreads_arg(None), None);
    }

    #[test]
    fn unison_command_ignores_archives_in_preview_and_batch() {
        let root = std::env::temp_dir();
        let remote = RemoteTarget {
            host: "10.0.0.2".into(),
            user: "dev".into(),
            path: "/tmp/p".into(),
        };
        let args = |batch: bool| -> Vec<String> {
            unison_command(&root, &remote, SyncDirection::Upload, false, batch)
                .get_args()
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect()
        };
        let preview = args(false);
        assert!(preview.iter().any(|arg| arg == "-ignorearchives"));
        assert!(!preview.iter().any(|arg| arg == "-batch"));
        let batch = args(true);
        assert!(batch.iter().any(|arg| arg == "-ignorearchives"));
        assert!(batch.iter().any(|arg| arg == "-batch"));
    }

    #[test]
    fn unison_command_compares_contents_not_timestamps() {
        let root = std::env::temp_dir();
        let remote = RemoteTarget {
            host: "10.0.0.2".into(),
            user: "dev".into(),
            path: "/tmp/p".into(),
        };
        let args: Vec<String> =
            unison_command(&root, &remote, SyncDirection::Upload, false, true)
                .get_args()
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect();
        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "-fastcheck" && pair[1] == "false"));
        assert!(!args.iter().any(|arg| arg == "-fastercheckUNSAFE"));
    }

    #[test]
    fn take_pending_keeps_matching_session_and_drops_the_rest() {
        struct Fake {
            direction: SyncDirection,
            hold_until: Instant,
        }
        let now = Instant::now();
        let mut map = HashMap::new();
        map.insert(
            "p1".into(),
            Fake {
                direction: SyncDirection::Upload,
                hold_until: now + Duration::from_secs(60),
            },
        );
        let taken = take_pending(&mut map, "p1", |session| {
            session_usable(session.direction, SyncDirection::Upload, session.hold_until, now)
        });
        assert!(taken.is_some());
        assert!(map.is_empty());

        map.insert(
            "p1".into(),
            Fake {
                direction: SyncDirection::Upload,
                hold_until: now + Duration::from_secs(60),
            },
        );
        assert!(take_pending(&mut map, "p1", |session| {
            session_usable(
                session.direction,
                SyncDirection::Download,
                session.hold_until,
                now,
            )
        })
        .is_none());
        assert!(map.is_empty());

        map.insert(
            "p1".into(),
            Fake {
                direction: SyncDirection::Upload,
                hold_until: now - Duration::from_secs(1),
            },
        );
        assert!(take_pending(&mut map, "p1", |session| {
            session_usable(session.direction, SyncDirection::Upload, session.hold_until, now)
        })
        .is_none());
        assert!(map.is_empty());

        map.insert(
            "p1".into(),
            Fake {
                direction: SyncDirection::Upload,
                hold_until: now + Duration::from_secs(60),
            },
        );
        map.remove("p1");
        assert!(take_pending(&mut map, "p1", |_| true).is_none());
    }
}
