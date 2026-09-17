use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::sync::{
    has_git_metadata, hidden_command, missing_bin, posix_single_quote, project_sync_fields,
    ssh_argv_opts, ssh_destination, validate_remote, wait_child, RemoteTarget,
};
use crate::AppState;

const PATCH_HOLD: Duration = Duration::from_secs(600);
const GIT_TIMEOUT: Duration = Duration::from_secs(180);
const PREVIEW_EXPIRED_MSG: &str = "预览已过期，请重新扫描";
const HEAD_MISMATCH_MSG: &str = "本地与远程不在同一提交，请先切换到同一分支后再拉取改动。";
const PATCH_MARK: &[u8] = b"HKCRAFT_PATCH\n";
const PATCH_MARK_CR: &[u8] = b"HKCRAFT_PATCH\r\n";
const PREVIEW_LIST_CAP: usize = 200;
const FORBIDDEN: [char; 6] = ['\n', '\r', ';', '|', '&', '$'];

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct GitRepoStatus {
    pub has_git: bool,
    pub current: String,
    pub branches: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct GitPatchPreview {
    pub added: Vec<String>,
    pub modified: Vec<String>,
    pub deleted: Vec<String>,
    pub added_count: usize,
    pub modified_count: usize,
    pub deleted_count: usize,
    pub local_dirty: bool,
    pub local_head: String,
    pub remote_head: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct GitPatchResult {
    pub files: usize,
    pub added: usize,
    pub modified: usize,
    pub deleted: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiffKind {
    Add,
    Modify,
    Delete,
}

struct PendingPatch {
    patch: Vec<u8>,
    local_head: String,
    preview: GitPatchPreview,
    hold_until: Instant,
}

pub struct GitHost {
    pending: Mutex<HashMap<String, PendingPatch>>,
}

impl Default for GitHost {
    fn default() -> Self {
        Self::new()
    }
}

impl GitHost {
    pub fn new() -> Self {
        Self {
            pending: Mutex::new(HashMap::new()),
        }
    }

    fn insert(&self, project_id: String, session: PendingPatch) {
        let mut pending = self.pending.lock().expect("git lock");
        pending.insert(project_id, session);
    }

    fn abort(&self, project_id: &str) {
        self.pending.lock().expect("git lock").remove(project_id);
    }

    fn take(&self, project_id: &str) -> AppResult<PendingPatch> {
        let mut pending = self.pending.lock().expect("git lock");
        let session = pending
            .remove(project_id)
            .ok_or_else(|| AppError::msg(PREVIEW_EXPIRED_MSG))?;
        if Instant::now() >= session.hold_until {
            return Err(AppError::msg(PREVIEW_EXPIRED_MSG));
        }
        Ok(session)
    }
}

pub fn valid_branch_name(name: &str) -> bool {
    let name = name.trim();
    if name.is_empty() || name.starts_with('-') || name.contains("..") || name.contains('@') {
        return false;
    }
    if name.chars().any(|c| {
        c.is_whitespace()
            || c.is_control()
            || FORBIDDEN.contains(&c)
            || matches!(c, '`' | '\\' | ':' | '?' | '[' | ']' | '*' | '~' | '^')
    }) {
        return false;
    }
    true
}

pub fn is_git_sha(value: &str) -> bool {
    let value = value.trim();
    (7..=40).contains(&value.len()) && value.chars().all(|c| c.is_ascii_hexdigit())
}

fn parse_diff_git_line(line: &str) -> Option<(String, String)> {
    let rest = line.strip_prefix("diff --git ")?;
    let rest = rest.strip_prefix("a/")?;
    let (a, b) = rest.split_once(" b/")?;
    if a.is_empty() || b.is_empty() {
        return None;
    }
    Some((a.to_string(), b.to_string()))
}

pub fn parse_diff_paths(patch: &str) -> Vec<(DiffKind, String)> {
    let mut out = Vec::new();
    let mut current: Option<(String, String)> = None;
    let mut kind = DiffKind::Modify;
    let flush = |kind: DiffKind, sides: Option<(String, String)>, out: &mut Vec<(DiffKind, String)>| {
        let Some((a, b)) = sides else { return };
        let path = match kind {
            DiffKind::Delete => a,
            DiffKind::Add | DiffKind::Modify => {
                if b == "dev/null" {
                    a
                } else {
                    b
                }
            }
        };
        if path.is_empty() || path == "dev/null" {
            return;
        }
        out.push((kind, path));
    };
    for line in patch.lines() {
        if let Some(sides) = parse_diff_git_line(line) {
            flush(kind, current.take(), &mut out);
            current = Some(sides);
            kind = DiffKind::Modify;
            continue;
        }
        if current.is_none() {
            continue;
        }
        let trimmed = line.trim_start();
        if trimmed.starts_with("new file mode") {
            kind = DiffKind::Add;
        } else if trimmed.starts_with("deleted file mode") {
            kind = DiffKind::Delete;
        }
    }
    flush(kind, current, &mut out);
    out
}

fn preview_from_paths(
    entries: Vec<(DiffKind, String)>,
    local_dirty: bool,
    local_head: String,
    remote_head: String,
) -> GitPatchPreview {
    let mut added = Vec::new();
    let mut modified = Vec::new();
    let mut deleted = Vec::new();
    for (kind, path) in entries {
        match kind {
            DiffKind::Add => added.push(path),
            DiffKind::Modify => modified.push(path),
            DiffKind::Delete => deleted.push(path),
        }
    }
    added.sort();
    modified.sort();
    deleted.sort();
    added.dedup();
    modified.dedup();
    deleted.dedup();
    let added_count = added.len();
    let modified_count = modified.len();
    let deleted_count = deleted.len();
    GitPatchPreview {
        added: cap_list(added),
        modified: cap_list(modified),
        deleted: cap_list(deleted),
        added_count,
        modified_count,
        deleted_count,
        local_dirty,
        local_head,
        remote_head,
    }
}

fn cap_list(mut paths: Vec<String>) -> Vec<String> {
    if paths.len() > PREVIEW_LIST_CAP {
        paths.truncate(PREVIEW_LIST_CAP);
    }
    paths
}

fn split_head_and_patch(stdout: &[u8]) -> AppResult<(String, Vec<u8>)> {
    let Some(nl) = stdout.iter().position(|&b| b == b'\n') else {
        return Err(AppError::msg("远程 Git 输出无效"));
    };
    let head = String::from_utf8_lossy(&stdout[..nl]).trim().to_string();
    if !is_git_sha(&head) {
        return Err(AppError::msg("远程 Git 输出无效"));
    }
    let rest = &stdout[nl + 1..];
    if let Some(patch) = rest.strip_prefix(PATCH_MARK) {
        return Ok((head, patch.to_vec()));
    }
    if let Some(patch) = rest.strip_prefix(PATCH_MARK_CR) {
        return Ok((head, patch.to_vec()));
    }
    Err(AppError::msg("远程 Git 输出无效"))
}

fn remote_patch_script(path: &str) -> String {
    let quoted = posix_single_quote(path);
    format!(
        "cd -- {quoted} && git rev-parse --is-inside-work-tree >/dev/null && git rev-parse HEAD && printf '%s\\n' HKCRAFT_PATCH && git diff HEAD --binary && git ls-files --others --exclude-standard | while IFS= read -r f; do [ -n \"$f\" ] || continue; git --no-pager diff --no-index --binary -- /dev/null \"$f\" || :; done"
    )
}

fn trim_cmd_msg(text: &[u8]) -> String {
    let mut msg = String::from_utf8_lossy(text).trim().to_string();
    if msg.chars().count() > 400 {
        msg = msg.chars().take(400).collect::<String>() + "…";
    }
    msg
}

fn spawn_piped(
    bin: &str,
    mut build: impl FnMut(&mut std::process::Command),
) -> AppResult<std::process::Child> {
    let mut cmd = hidden_command(bin);
    build(&mut cmd);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    match cmd.spawn() {
        Ok(child) => Ok(child),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Err(missing_bin(bin)),
        Err(err) => Err(AppError::msg(format!("无法启动 {bin}：{err}"))),
    }
}

fn collect_output(
    mut child: std::process::Child,
    timeout: Duration,
    bin: &str,
) -> AppResult<(Vec<u8>, Vec<u8>, std::process::ExitStatus)> {
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let out_h = thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut pipe) = stdout {
            let _ = pipe.read_to_end(&mut buf);
        }
        buf
    });
    let err_h = thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut pipe) = stderr {
            let _ = pipe.read_to_end(&mut buf);
        }
        buf
    });
    let status = wait_child(&mut child, Instant::now() + timeout, bin)?;
    let stdout = out_h.join().unwrap_or_default();
    let stderr = err_h.join().unwrap_or_default();
    Ok((stdout, stderr, status))
}

fn git_output(root: &Path, args: &[&str]) -> AppResult<(Vec<u8>, Vec<u8>, std::process::ExitStatus)> {
    let child = spawn_piped("git", |cmd| {
        cmd.arg("-C").arg(root).args(args);
    })?;
    collect_output(child, GIT_TIMEOUT, "git")
}

fn git_ok_text(root: &Path, args: &[&str]) -> AppResult<String> {
    let (stdout, stderr, status) = git_output(root, args)?;
    if status.success() {
        return Ok(String::from_utf8_lossy(&stdout).to_string());
    }
    let mut msg = trim_cmd_msg(&stderr);
    if msg.is_empty() {
        msg = trim_cmd_msg(&stdout);
    }
    if msg.is_empty() {
        msg = "git 失败".into();
    }
    Err(AppError::msg(msg))
}

fn ssh_output(remote: &RemoteTarget, script: &str) -> AppResult<(Vec<u8>, Vec<u8>, std::process::ExitStatus)> {
    let dest = ssh_destination(&remote.user, &remote.host);
    let child = spawn_piped("ssh", |cmd| {
        cmd.args(ssh_argv_opts()).arg(&dest).arg(script);
    })?;
    collect_output(child, GIT_TIMEOUT, "ssh")
}

fn require_git_root(root: &Path) -> AppResult<()> {
    if !root.is_dir() {
        return Err(AppError::msg("项目目录不存在"));
    }
    if !has_git_metadata(root) {
        return Err(AppError::msg("当前项目不是 Git 仓库"));
    }
    Ok(())
}

fn local_head(root: &Path) -> AppResult<String> {
    let text = git_ok_text(root, &["rev-parse", "HEAD"])?;
    let head = text.trim().to_string();
    if !is_git_sha(&head) {
        return Err(AppError::msg("无法读取本地 HEAD"));
    }
    Ok(head)
}

fn local_dirty(root: &Path) -> AppResult<bool> {
    let text = git_ok_text(root, &["status", "--porcelain=v1"])?;
    Ok(text.lines().any(|line| !line.trim().is_empty()))
}

fn list_local_branches(root: &Path) -> AppResult<Vec<String>> {
    let text = git_ok_text(root, &["branch", "--format=%(refname:short)"])?;
    let mut branches: Vec<String> = text
        .lines()
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty() && valid_branch_name(line))
        .collect();
    branches.sort();
    branches.dedup();
    Ok(branches)
}

fn current_branch(root: &Path) -> AppResult<String> {
    let name = git_ok_text(root, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    let name = name.trim();
    if name.is_empty() || name == "HEAD" {
        let sha = git_ok_text(root, &["rev-parse", "--short", "HEAD"])?;
        return Ok(sha.trim().to_string());
    }
    Ok(name.to_string())
}

fn repo_status(root: &Path) -> AppResult<GitRepoStatus> {
    if !has_git_metadata(root) {
        return Ok(GitRepoStatus {
            has_git: false,
            current: String::new(),
            branches: Vec::new(),
        });
    }
    Ok(GitRepoStatus {
        has_git: true,
        current: current_branch(root)?,
        branches: list_local_branches(root)?,
    })
}

fn apply_patch(root: &Path, patch: &[u8], check: bool) -> AppResult<()> {
    let mut cmd = hidden_command("git");
    cmd.arg("-C").arg(root).arg("apply");
    if check {
        cmd.arg("--check");
    }
    cmd.arg("--whitespace=nowarn")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Err(missing_bin("git")),
        Err(err) => return Err(AppError::msg(format!("无法启动 git：{err}"))),
    };
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(patch)
            .map_err(|err| AppError::msg(format!("无法写入补丁：{err}")))?;
    }
    let (stdout, stderr, status) = collect_output(child, GIT_TIMEOUT, "git")?;
    if status.success() {
        return Ok(());
    }
    let mut msg = trim_cmd_msg(&stderr);
    if msg.is_empty() {
        msg = trim_cmd_msg(&stdout);
    }
    if msg.is_empty() {
        msg = if check {
            "补丁无法应用到本地工作区".into()
        } else {
            "应用补丁失败".into()
        };
    }
    Err(AppError::msg(msg))
}

fn project_root(state: &State<AppState>, project_id: &str) -> AppResult<PathBuf> {
    let (path, _, _, _) = project_sync_fields(state, project_id)?;
    Ok(path)
}

#[tauri::command]
pub fn git_status(project_id: String, state: State<AppState>) -> AppResult<GitRepoStatus> {
    let root = project_root(&state, &project_id)?;
    repo_status(&root)
}

#[tauri::command]
pub fn git_checkout(project_id: String, branch: String, state: State<AppState>) -> AppResult<GitRepoStatus> {
    let root = project_root(&state, &project_id)?;
    require_git_root(&root)?;
    if !valid_branch_name(&branch) {
        return Err(AppError::msg("无效的分支名"));
    }
    let branches = list_local_branches(&root)?;
    if !branches.iter().any(|name| name == &branch) {
        return Err(AppError::msg("只能切换到已有的本地分支"));
    }
    git_ok_text(&root, &["checkout", &branch])?;
    repo_status(&root)
}

#[tauri::command]
pub fn git_patch_preview(project_id: String, state: State<AppState>) -> AppResult<GitPatchPreview> {
    let (path, host, user, remote_path) = project_sync_fields(&state, &project_id)?;
    require_git_root(&path)?;
    let remote = validate_remote(&host, &user, &remote_path).map_err(AppError::msg)?;
    let local = local_head(&path)?;
    let dirty = local_dirty(&path)?;
    let script = remote_patch_script(&remote.path);
    let (stdout, stderr, status) = ssh_output(&remote, &script)?;
    if !status.success() {
        let mut msg = trim_cmd_msg(&stderr);
        if msg.is_empty() {
            msg = trim_cmd_msg(&stdout);
        }
        if msg.is_empty() {
            msg = "无法读取远程 Git 改动".into();
        }
        return Err(AppError::msg(format!("ssh 失败：{msg}")));
    }
    let (remote_head, patch) = split_head_and_patch(&stdout)?;
    if remote_head != local {
        return Err(AppError::msg(HEAD_MISMATCH_MSG));
    }
    let text = String::from_utf8_lossy(&patch);
    let preview = preview_from_paths(parse_diff_paths(&text), dirty, local.clone(), remote_head);
    if preview.added_count + preview.modified_count + preview.deleted_count > 0 {
        state.git.insert(
            project_id,
            PendingPatch {
                patch,
                local_head: local,
                preview: preview.clone(),
                hold_until: Instant::now() + PATCH_HOLD,
            },
        );
    } else {
        state.git.abort(&project_id);
    }
    Ok(preview)
}

#[tauri::command]
pub fn git_patch_apply(project_id: String, state: State<AppState>) -> AppResult<GitPatchResult> {
    let root = project_root(&state, &project_id)?;
    require_git_root(&root)?;
    let session = state.git.take(&project_id)?;
    let head = local_head(&root)?;
    if head != session.local_head {
        return Err(AppError::msg(HEAD_MISMATCH_MSG));
    }
    apply_patch(&root, &session.patch, true)?;
    apply_patch(&root, &session.patch, false)?;
    Ok(GitPatchResult {
        files: session.preview.added_count
            + session.preview.modified_count
            + session.preview.deleted_count,
        added: session.preview.added_count,
        modified: session.preview.modified_count,
        deleted: session.preview.deleted_count,
    })
}

#[tauri::command]
pub fn git_patch_abort(project_id: String, state: State<AppState>) -> AppResult<()> {
    state.git.abort(&project_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `git diff --no-index` exits 1 when the files differ; 0 if they match.
    /// Exit codes 2+ are real errors and must not be swallowed.
    fn no_index_diff_ok(code: i32) -> bool {
        code == 0 || code == 1
    }

    #[test]
    fn valid_branch_name_rejects_shell_and_git_meta() {
        assert!(valid_branch_name("main"));
        assert!(valid_branch_name("feature/foo"));
        assert!(!valid_branch_name(""));
        assert!(!valid_branch_name("-bad"));
        assert!(!valid_branch_name("a..b"));
        assert!(!valid_branch_name("foo;bar"));
        assert!(!valid_branch_name("foo bar"));
        assert!(!valid_branch_name("foo|rm"));
        assert!(!valid_branch_name("feat@{1}"));
    }

    #[test]
    fn is_git_sha_accepts_short_and_full() {
        assert!(is_git_sha("abc1234"));
        assert!(is_git_sha("0123456789abcdef0123456789abcdef01234567"));
        assert!(!is_git_sha("HEAD"));
        assert!(!is_git_sha("abc"));
        assert!(!is_git_sha("zzzzzzz"));
    }

    #[test]
    fn no_index_diff_ok_treats_one_as_difference() {
        // git diff --no-index: 0 identical, 1 different, 2+ error.
        assert!(no_index_diff_ok(0));
        assert!(no_index_diff_ok(1));
        assert!(!no_index_diff_ok(2));
        assert!(!no_index_diff_ok(128));
    }

    #[test]
    fn parse_diff_paths_classifies_add_modify_delete() {
        let patch = "\
diff --git a/old.txt b/old.txt
deleted file mode 100644
index 111..000
--- a/old.txt
+++ /dev/null
diff --git a/src/a.ts b/src/a.ts
index 222..333 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-a
+b
diff --git a/dev/null b/new.md
new file mode 100644
index 000..444
--- /dev/null
+++ b/new.md
@@ -0,0 +1 @@
+hi
";
        let parsed = parse_diff_paths(patch);
        assert_eq!(
            parsed,
            vec![
                (DiffKind::Delete, "old.txt".into()),
                (DiffKind::Modify, "src/a.ts".into()),
                (DiffKind::Add, "new.md".into()),
            ]
        );
    }

    #[test]
    fn split_head_and_patch_reads_marker() {
        let mut body = b"abc1234def5678901234567890abcdef12345678\nHKCRAFT_PATCH\n".to_vec();
        body.extend_from_slice(b"diff --git a/f b/f\n");
        let (head, patch) = split_head_and_patch(&body).unwrap();
        assert_eq!(head, "abc1234def5678901234567890abcdef12345678");
        assert_eq!(patch, b"diff --git a/f b/f\n");
    }

    #[test]
    fn remote_patch_script_quotes_path() {
        let script = remote_patch_script("/tmp/it's");
        assert!(script.contains("cd -- '/tmp/it'\\''s'"));
        assert!(script.contains("HKCRAFT_PATCH"));
        assert!(script.contains("git diff HEAD --binary"));
        assert!(script.contains("git ls-files --others --exclude-standard"));
        assert!(script.contains("diff --no-index"));
    }
}
