use std::fs;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::sync::OnceLock;
use std::time::SystemTime;

use serde::Deserialize;

use crate::error::AppResult;

#[derive(Debug, Clone, Deserialize)]
struct CursorMeta {
    cwd: Option<String>,
    #[serde(rename = "updatedAtMs")]
    updated_at_ms: Option<u64>,
    #[serde(rename = "createdAtMs")]
    created_at_ms: Option<u64>,
}

#[derive(Debug, Clone)]
struct Found {
    id: String,
    updated_ms: u64,
}

#[derive(Debug, Deserialize)]
struct ProtocolFile {
    agents: Vec<AgentSpec>,
}

#[derive(Debug, Deserialize)]
struct AgentSpec {
    bins: Vec<String>,
    resume: String,
    discover: Option<String>,
}

fn protocols() -> &'static [AgentSpec] {
    static PROTOCOLS: OnceLock<Vec<AgentSpec>> = OnceLock::new();
    PROTOCOLS.get_or_init(|| {
        let raw: ProtocolFile = serde_json::from_str(include_str!("../../src/lib/agent-protocol.json"))
            .expect("agent-protocol.json must parse");
        raw.agents
    })
}

fn spec_for(command: &str) -> Option<&'static AgentSpec> {
    let bin = agent_bin(command);
    protocols()
        .iter()
        .find(|spec| spec.bins.iter().any(|name| name == &bin))
}

fn agent_bin(command: &str) -> String {
    command
        .trim()
        .split_whitespace()
        .next()
        .unwrap_or("")
        .replace('\\', "/")
        .rsplit('/')
        .next()
        .unwrap_or("")
        .trim_end_matches(".exe")
        .trim_end_matches(".cmd")
        .to_ascii_lowercase()
}

#[cfg_attr(not(test), allow(dead_code))]
fn resume_args(command: &str, session_id: &str) -> Vec<String> {
    if session_id.trim().is_empty() {
        return Vec::new();
    }
    spec_for(command)
        .map(|spec| vec![spec.resume.clone(), session_id.to_string()])
        .unwrap_or_default()
}

fn normalize_path(path: &str) -> String {
    path.replace('\\', "/")
        .trim_end_matches('/')
        .to_ascii_lowercase()
}

pub fn paths_match(a: &str, b: &str) -> bool {
    normalize_path(a) == normalize_path(b)
}

pub fn cursor_project_slug(path: &str) -> String {
    path.replace('\\', "-")
        .replace('/', "-")
        .replace(':', "")
        .trim_end_matches('-')
        .to_string()
}

pub fn claude_project_slug(path: &str) -> String {
    let unified = path.replace('\\', "/");
    unified
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c
            } else {
                '-'
            }
        })
        .collect()
}

fn file_mtime_ms(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn consider(best: &mut Option<Found>, id: String, updated_ms: u64) {
    let better = match best {
        None => true,
        Some(current) => updated_ms >= current.updated_ms,
    };
    if better {
        *best = Some(Found { id, updated_ms });
    }
}

pub fn discover_cursor_chats(chats_root: &Path, cwd: &str) -> Option<String> {
    let mut best: Option<Found> = None;
    let Ok(hashes) = fs::read_dir(chats_root) else {
        return None;
    };
    for hash in hashes.flatten() {
        let hash_path = hash.path();
        if !hash_path.is_dir() {
            continue;
        }
        let Ok(chats) = fs::read_dir(&hash_path) else {
            continue;
        };
        for chat in chats.flatten() {
            let chat_path = chat.path();
            if !chat_path.is_dir() {
                continue;
            }
            let id = chat.file_name().to_string_lossy().to_string();
            let meta_path = chat_path.join("meta.json");
            let Ok(raw) = fs::read_to_string(&meta_path) else {
                continue;
            };
            let Ok(meta) = serde_json::from_str::<CursorMeta>(&raw) else {
                continue;
            };
            let Some(meta_cwd) = meta.cwd else {
                continue;
            };
            if !paths_match(&meta_cwd, cwd) {
                continue;
            }
            let updated = meta
                .updated_at_ms
                .or(meta.created_at_ms)
                .unwrap_or_else(|| file_mtime_ms(&meta_path));
            consider(&mut best, id, updated);
        }
    }
    best.map(|f| f.id)
}

fn discover_cursor_transcripts(projects_root: &Path, cwd: &str) -> Option<String> {
    let slug = cursor_project_slug(cwd);
    let transcripts = projects_root.join(slug).join("agent-transcripts");
    let mut best: Option<Found> = None;
    let Ok(entries) = fs::read_dir(&transcripts) else {
        return None;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let id = entry.file_name().to_string_lossy().to_string();
        consider(&mut best, id, file_mtime_ms(&path));
    }
    best.map(|f| f.id)
}

fn discover_claude(projects_root: &Path, cwd: &str) -> Option<String> {
    let slug = claude_project_slug(cwd);
    let dir = projects_root.join(&slug);
    let mut best: Option<Found> = None;
    let mut scan = |folder: &Path| {
        let Ok(entries) = fs::read_dir(folder) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let id = path
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            if id.is_empty() {
                continue;
            }
            consider(&mut best, id, file_mtime_ms(&path));
        }
    };
    scan(&dir);
    scan(&dir.join("sessions"));
    best.map(|f| f.id)
}

#[derive(Deserialize)]
struct CodexLine {
    #[serde(rename = "type")]
    kind: Option<String>,
    payload: Option<CodexPayload>,
}

#[derive(Deserialize)]
struct CodexPayload {
    id: Option<String>,
    session_id: Option<String>,
    cwd: Option<String>,
}

fn walk_files(dir: &Path, visit: &mut impl FnMut(&Path)) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk_files(&path, visit);
        } else {
            visit(&path);
        }
    }
}

fn read_codex_meta(path: &Path) -> Option<(String, String)> {
    let file = fs::File::open(path).ok()?;
    let mut first = String::new();
    BufReader::new(file).read_line(&mut first).ok()?;
    let line: CodexLine = serde_json::from_str(first.trim()).ok()?;
    if line.kind.as_deref() != Some("session_meta") {
        return None;
    }
    let payload = line.payload?;
    let id = payload
        .id
        .or(payload.session_id)
        .filter(|value| !value.is_empty())?;
    let cwd = payload.cwd.filter(|value| !value.is_empty())?;
    Some((id, cwd))
}

pub fn discover_codex(sessions_root: &Path, cwd: &str) -> Option<String> {
    let mut best: Option<Found> = None;
    walk_files(sessions_root, &mut |path| {
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if !name.starts_with("rollout-") || !name.ends_with(".jsonl") {
            return;
        }
        let Some((id, meta_cwd)) = read_codex_meta(path) else {
            return;
        };
        if !paths_match(&meta_cwd, cwd) {
            return;
        }
        consider(&mut best, id, file_mtime_ms(path));
    });
    best.map(|f| f.id)
}

fn codex_sessions_dir(home: &Path) -> std::path::PathBuf {
    std::env::var_os("CODEX_HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| home.join(".codex"))
        .join("sessions")
}

pub fn discover_latest(command: &str, cwd: &str) -> Option<String> {
    let home = dirs::home_dir()?;
    match spec_for(command).and_then(|spec| spec.discover.as_deref()) {
        Some("cursor") => {
            let from_chats = discover_cursor_chats(&home.join(".cursor").join("chats"), cwd);
            let from_transcripts =
                discover_cursor_transcripts(&home.join(".cursor").join("projects"), cwd);
            from_chats.or(from_transcripts)
        }
        Some("claude") => discover_claude(&home.join(".claude").join("projects"), cwd),
        Some("codex") => discover_codex(&codex_sessions_dir(&home), cwd),
        _ => None,
    }
}

#[tauri::command]
pub fn discover_agent_session(command: String, cwd: String) -> AppResult<Option<String>> {
    Ok(discover_latest(&command, &cwd))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_and_match() {
        assert!(paths_match(r"C:\Agent\App", "C:/Agent/App"));
        assert_eq!(
            cursor_project_slug(r"C:\Agent\Agent10-WorkTable"),
            "C-Agent-Agent10-WorkTable"
        );
        assert_eq!(
            claude_project_slug(r"C:\Agent\Agent10-WorkTable"),
            "C--Agent-Agent10-WorkTable"
        );
    }

    #[test]
    fn resume_flags() {
        assert_eq!(
            resume_args("cursor-agent", "abc"),
            vec!["--resume", "abc"]
        );
        assert_eq!(resume_args("opencode", "s1"), vec!["--session", "s1"]);
        assert_eq!(resume_args("codex", "019d-abc"), vec!["resume", "019d-abc"]);
        assert_eq!(resume_args("dsh-tui", "sess"), vec!["--resume", "sess"]);
        assert_eq!(resume_args("dst", "sess"), vec!["--resume", "sess"]);
        assert!(resume_args("mystery", "s1").is_empty());
        assert_eq!(
            spec_for("cursor-agent").and_then(|s| s.discover.clone()).as_deref(),
            Some("cursor")
        );
        assert_eq!(spec_for("codex").and_then(|s| s.discover.clone()).as_deref(), Some("codex"));
        assert_eq!(spec_for("opencode").and_then(|s| s.discover.clone()), None);
    }

    #[test]
    fn codex_rollouts_pick_latest_for_cwd() {
        let root = std::env::temp_dir().join(format!("aw-codex-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let old_dir = root.join("2026").join("09").join("01");
        let new_dir = root.join("2026").join("09").join("02");
        fs::create_dir_all(&old_dir).unwrap();
        fs::create_dir_all(&new_dir).unwrap();
        fs::write(
            old_dir.join("rollout-2026-09-01T00-00-00-old-id.jsonl"),
            r#"{"type":"session_meta","payload":{"id":"old-id","cwd":"C:\\work\\app"}}"#,
        )
        .unwrap();
        fs::write(
            new_dir.join("rollout-2026-09-02T00-00-00-other-id.jsonl"),
            r#"{"type":"session_meta","payload":{"id":"other-id","cwd":"C:\\work\\other"}}"#,
        )
        .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::write(
            new_dir.join("rollout-2026-09-02T12-00-00-new-id.jsonl"),
            r#"{"type":"session_meta","payload":{"id":"new-id","cwd":"C:\\work\\app"}}"#,
        )
        .unwrap();
        assert_eq!(discover_codex(&root, r"C:\work\app").as_deref(), Some("new-id"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn cursor_chats_pick_latest_for_cwd() {
        let root = std::env::temp_dir().join(format!("aw-chats-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let a = root.join("hash").join("chat-old");
        let b = root.join("hash").join("chat-new");
        fs::create_dir_all(&a).unwrap();
        fs::create_dir_all(&b).unwrap();
        fs::write(
            a.join("meta.json"),
            r#"{"cwd":"C:\\work\\app","updatedAtMs":1}"#,
        )
        .unwrap();
        fs::write(
            b.join("meta.json"),
            r#"{"cwd":"C:\\work\\app","updatedAtMs":9}"#,
        )
        .unwrap();
        fs::create_dir_all(root.join("hash").join("other")).unwrap();
        fs::write(
            root.join("hash").join("other").join("meta.json"),
            r#"{"cwd":"C:\\work\\other","updatedAtMs":99}"#,
        )
        .unwrap();
        assert_eq!(discover_cursor_chats(&root, r"C:\work\app").as_deref(), Some("chat-new"));
        let _ = fs::remove_dir_all(&root);
    }
}
