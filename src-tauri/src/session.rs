use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::SystemTime;

use serde::{Deserialize, Serialize};

use crate::error::AppResult;

#[derive(Debug, Clone, Deserialize)]
struct CursorMeta {
    cwd: Option<String>,
    #[serde(rename = "updatedAtMs")]
    updated_at_ms: Option<u64>,
    #[serde(rename = "createdAtMs")]
    created_at_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DiscoveredSession {
    pub id: String,
    pub updated_ms: u64,
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

pub(crate) fn agent_bin(command: &str) -> String {
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

fn collect_session(out: &mut Vec<DiscoveredSession>, id: String, updated_ms: u64) {
    if id.is_empty() {
        return;
    }
    if let Some(existing) = out.iter_mut().find(|session| session.id == id) {
        if updated_ms > existing.updated_ms {
            existing.updated_ms = updated_ms;
        }
        return;
    }
    out.push(DiscoveredSession { id, updated_ms });
}

fn sort_sessions(mut sessions: Vec<DiscoveredSession>) -> Vec<DiscoveredSession> {
    sessions.sort_by(|a, b| b.updated_ms.cmp(&a.updated_ms).then(a.id.cmp(&b.id)));
    sessions
}

pub fn discover_cursor_chats(chats_root: &Path, cwd: &str) -> Vec<DiscoveredSession> {
    let mut found = Vec::new();
    let Ok(hashes) = fs::read_dir(chats_root) else {
        return found;
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
            collect_session(&mut found, id, updated);
        }
    }
    sort_sessions(found)
}

fn discover_cursor_transcripts(projects_root: &Path, cwd: &str) -> Vec<DiscoveredSession> {
    let slug = cursor_project_slug(cwd);
    let transcripts = projects_root.join(slug).join("agent-transcripts");
    let mut found = Vec::new();
    let Ok(entries) = fs::read_dir(&transcripts) else {
        return found;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let id = entry.file_name().to_string_lossy().to_string();
        collect_session(&mut found, id, file_mtime_ms(&path));
    }
    found
}

fn discover_claude(projects_root: &Path, cwd: &str) -> Vec<DiscoveredSession> {
    let slug = claude_project_slug(cwd);
    let dir = projects_root.join(&slug);
    let mut found = Vec::new();
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
            collect_session(&mut found, id, file_mtime_ms(&path));
        }
    };
    scan(&dir);
    scan(&dir.join("sessions"));
    sort_sessions(found)
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

pub fn discover_codex(sessions_root: &Path, cwd: &str) -> Vec<DiscoveredSession> {
    let mut found = Vec::new();
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
        collect_session(&mut found, id, file_mtime_ms(path));
    });
    sort_sessions(found)
}

fn codex_sessions_dir(home: &Path) -> std::path::PathBuf {
    std::env::var_os("CODEX_HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| home.join(".codex"))
        .join("sessions")
}

/// DSH JSONL project directory: `--<slug>--` with `/\:` collapsed to `-`.
pub fn dsh_project_key(cwd: &str) -> String {
    let mut readable = String::new();
    let mut separator_run = false;
    for ch in cwd.chars() {
        if matches!(ch, '/' | '\\' | ':') {
            if !separator_run {
                readable.push('-');
            }
            separator_run = true;
        } else if ch != '~' && (ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-')) {
            readable.push(ch);
            separator_run = false;
        } else {
            readable.push('~');
            readable.push_str(&format!("{:04X}", ch as u32));
            separator_run = false;
        }
    }
    let slug = readable.trim_start_matches('-');
    let slug = if slug.is_empty() { "root" } else { slug };
    let slug: String = slug.chars().take(251).collect();
    format!("--{slug}--")
}

/// Encode a session id as one filesystem-safe directory segment, mirroring the
/// DSH persistence backend's `encodeSegment`: safe ASCII stays literal, every
/// other code unit (including `~`) becomes `~XXXX`. HK-Craft decodes directory
/// names with [`decode_dsh_segment`]; this is the inverse direction, needed to
/// look a *stored* id up on disk again.
fn encode_dsh_segment(raw: &str) -> String {
    if raw == "." {
        return "~002E".into();
    }
    if raw == ".." {
        return "~002E~002E".into();
    }
    let mut out = String::with_capacity(raw.len());
    for ch in raw.chars() {
        if ch != '~' && (ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-')) {
            out.push(ch);
        } else {
            out.push('~');
            out.push_str(&format!("{:04X}", ch as u32));
        }
    }
    out
}

fn decode_dsh_segment(encoded: &str) -> String {
    let mut out = String::new();
    let chars: Vec<char> = encoded.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '~' && i + 4 < chars.len() {
            let hex: String = chars[i + 1..i + 5].iter().collect();
            if let Ok(code) = u32::from_str_radix(&hex, 16) {
                if let Some(ch) = char::from_u32(code) {
                    out.push(ch);
                    i += 5;
                    continue;
                }
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

fn is_dsh_session_log(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.starts_with("session") && lower.contains(".jsonl")
}

fn dsh_session_dir_mtime(dir: &Path) -> Option<u64> {
    let entries = fs::read_dir(dir).ok()?;
    let mut newest: Option<u64> = None;
    for entry in entries.flatten() {
        if !is_dsh_session_log(&entry.file_name().to_string_lossy()) {
            continue;
        }
        let ms = file_mtime_ms(&entry.path());
        newest = Some(newest.map_or(ms, |prev| prev.max(ms)));
    }
    newest
}

fn read_dsh_resume_id(path: &Path) -> Option<String> {
    let raw = fs::read_to_string(path).ok()?;
    let id = raw.lines().map(str::trim).find(|line| !line.is_empty())?;
    Some(id.to_string())
}

fn read_dsh_last_used(path: &Path) -> HashMap<String, u64> {
    let Ok(raw) = fs::read_to_string(path) else {
        return HashMap::new();
    };
    let Ok(serde_json::Value::Object(map)) = serde_json::from_str(&raw) else {
        return HashMap::new();
    };
    map.into_iter()
        .filter_map(|(key, value)| {
            let updated = value
                .as_u64()
                .or_else(|| value.as_f64().map(|n| n as u64))?;
            Some((key, updated))
        })
        .collect()
}

fn dsh_session_roots(home: &Path) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(root) = std::env::var_os("DSH_TUI_SESSION_ROOT") {
        roots.push(PathBuf::from(root));
    }
    let dsh_home = std::env::var_os("DSH_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".dsh"));
    roots.push(dsh_home.join("sessions"));
    roots.push(home.join(".dsh-tui").join("sessions"));
    let mut seen = std::collections::HashSet::new();
    roots.retain(|path| seen.insert(path.clone()));
    roots
}

pub fn discover_dsh_tui(
    sessions_roots: &[PathBuf],
    cwd: &str,
    last_used: &HashMap<String, u64>,
    resume_id: Option<&str>,
    resume_updated_ms: u64,
) -> Vec<DiscoveredSession> {
    let project = dsh_project_key(cwd);
    let mut found = Vec::new();
    for root in sessions_roots {
        let dir = root.join(&project);
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let encoded = entry.file_name().to_string_lossy().into_owned();
            if encoded.is_empty() || encoded.starts_with('.') {
                continue;
            }
            let Some(log_ms) = dsh_session_dir_mtime(&path) else {
                continue;
            };
            let id = decode_dsh_segment(&encoded);
            let is_resume = resume_id == Some(id.as_str());
            let used = last_used.get(&id).copied();
            let updated = if is_resume {
                used.unwrap_or(0).max(resume_updated_ms).max(1)
            } else if let Some(ms) = used {
                ms
            } else if last_used.is_empty() {
                log_ms
            } else {
                continue;
            };
            collect_session(&mut found, id, updated);
        }
    }
    sort_sessions(found)
}

fn discover_dsh_tui_from_home(home: &Path, cwd: &str) -> Vec<DiscoveredSession> {
    let last_used = read_dsh_last_used(&home.join(".dsh-tui").join("last-used.json"));
    let resume_path = {
        let current = home.join(".dsh-tui").join("resume.txt");
        if current.is_file() {
            current
        } else {
            home.join(".dsh-cc").join("resume.txt")
        }
    };
    let resume_id = read_dsh_resume_id(&resume_path);
    let resume_updated_ms = if resume_path.is_file() {
        file_mtime_ms(&resume_path)
    } else {
        0
    };
    discover_dsh_tui(
        &dsh_session_roots(home),
        cwd,
        &last_used,
        resume_id.as_deref(),
        resume_updated_ms,
    )
}

pub fn discover_all(command: &str, cwd: &str) -> Vec<DiscoveredSession> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    match spec_for(command).and_then(|spec| spec.discover.as_deref()) {
        Some("cursor") => {
            let mut found = discover_cursor_chats(&home.join(".cursor").join("chats"), cwd);
            for session in discover_cursor_transcripts(&home.join(".cursor").join("projects"), cwd)
            {
                collect_session(&mut found, session.id, session.updated_ms);
            }
            sort_sessions(found)
        }
        Some("claude") => discover_claude(&home.join(".claude").join("projects"), cwd),
        Some("codex") => discover_codex(&codex_sessions_dir(&home), cwd),
        Some("dsh-tui") => discover_dsh_tui_from_home(&home, cwd),
        Some("opencode") => crate::opencode_discover::discover_opencode(cwd),
        _ => Vec::new(),
    }
}

/// DSH stores a session's log inside its own directory; the physical name is
/// `session.jsonl` for plaintext and `session.jsonl.zstd` when compressed.
const DSH_LOG_NAMES: [&str; 2] = ["session.jsonl.zstd", "session.jsonl"];

fn dsh_session_log_available_in(roots: &[PathBuf], cwd: &str, id: &str) -> bool {
    let id = id.trim();
    if id.is_empty() {
        return false;
    }
    let segment = encode_dsh_segment(id);
    let project = dsh_project_key(cwd);
    roots.iter().any(|root| {
        let dir = root.join(&project).join(&segment);
        DSH_LOG_NAMES.iter().any(|name| dir.join(name).is_file())
    })
}

/// Whether `--resume <id>` can still load a log for this command and cwd.
///
/// dsh-tui hard-exits instead of falling back to a fresh session when the log it
/// is handed cannot be read (`resumeFallback`), and its lookup is rooted at the
/// *current* project directory — a log stored under a different project key is
/// rejected as corrupt rather than resumed, so only this cwd's directory counts.
/// Every other agent keeps its stored id: those CLIs tolerate a vanished log.
pub fn session_log_available(command: &str, cwd: &str, id: &str) -> bool {
    if spec_for(command).and_then(|spec| spec.discover.as_deref()) != Some("dsh-tui") {
        return true;
    }
    let Some(home) = dirs::home_dir() else {
        return true;
    };
    let roots = dsh_session_roots(&home);
    // A store that is not there at all cannot prove the log is gone.
    if !roots.iter().any(|root| root.is_dir()) {
        return true;
    }
    dsh_session_log_available_in(&roots, cwd, id)
}

#[tauri::command]
pub fn agent_session_available(command: String, cwd: String, id: String) -> AppResult<bool> {
    Ok(session_log_available(&command, &cwd, &id))
}

#[tauri::command]
pub fn discover_agent_sessions(command: String, cwd: String) -> AppResult<Vec<DiscoveredSession>> {
    Ok(discover_all(&command, &cwd))
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
        assert_eq!(spec_for("dsh-tui").and_then(|s| s.discover.clone()).as_deref(), Some("dsh-tui"));
        assert_eq!(spec_for("dst").and_then(|s| s.discover.clone()).as_deref(), Some("dsh-tui"));
        assert_eq!(
            spec_for("opencode").and_then(|s| s.discover.clone()).as_deref(),
            Some("opencode")
        );
    }

    fn ids(sessions: &[DiscoveredSession]) -> Vec<&str> {
        sessions.iter().map(|session| session.id.as_str()).collect()
    }

    #[test]
    fn codex_rollouts_list_matching_cwd_newest_first() {
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
        let found = discover_codex(&root, r"C:\work\app");
        assert_eq!(ids(&found), vec!["new-id", "old-id"]);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn cursor_chats_list_matching_cwd_newest_first() {
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
        let found = discover_cursor_chats(&root, r"C:\work\app");
        assert_eq!(ids(&found), vec!["chat-new", "chat-old"]);
        let _ = fs::remove_dir_all(&root);
    }

    fn write_dsh_session(root: &Path, cwd: &str, id: &str) {
        let dir = root.join(dsh_project_key(cwd)).join(id);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("session.jsonl.zstd"), id.as_bytes()).unwrap();
    }

    #[test]
    fn dsh_segment_encode_round_trips() {
        for raw in ["chat-1", "407ed355-921b-41a7-8fc0-cf7da588956d", "a/b", "a~b"] {
            assert_eq!(decode_dsh_segment(&encode_dsh_segment(raw)), raw);
        }
        assert_eq!(encode_dsh_segment("session-1"), "session-1");
        assert_eq!(encode_dsh_segment(".."), "~002E~002E");
        assert_eq!(encode_dsh_segment("a/b"), "a~002Fb");
    }

    #[test]
    fn dsh_session_log_available_requires_the_stored_artifact() {
        let root = std::env::temp_dir().join(format!("aw-dsh-avail-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let cwd = r"C:\work\app";
        write_dsh_session(&root, cwd, "chat-live");
        let roots = vec![root.clone()];
        assert!(dsh_session_log_available_in(&roots, cwd, "chat-live"));
        assert!(!dsh_session_log_available_in(&roots, cwd, "chat-gone"));
        // A log recorded for another directory is unresumable from this cwd.
        assert!(!dsh_session_log_available_in(&roots, r"C:\work\other", "chat-live"));
        // A session directory without a log is not resumable either.
        fs::create_dir_all(root.join(dsh_project_key(cwd)).join("chat-empty")).unwrap();
        assert!(!dsh_session_log_available_in(&roots, cwd, "chat-empty"));
        // Plaintext logs (compression off) count as stored logs too.
        let plain = root.join(dsh_project_key(cwd)).join("chat-plain");
        fs::create_dir_all(&plain).unwrap();
        fs::write(plain.join("session.jsonl"), b"{}").unwrap();
        assert!(dsh_session_log_available_in(&roots, cwd, "chat-plain"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn unknown_agents_keep_their_stored_session_id() {
        assert!(session_log_available("cursor-agent", r"C:\work\app", "chat-1"));
        assert!(session_log_available("mystery", r"C:\work\app", "chat-1"));
    }

    #[test]
    fn dsh_project_key_matches_jsonl_layout() {
        assert_eq!(
            dsh_project_key(r"C:\Agent\Agent10-WorkTable"),
            "--C-Agent-Agent10-WorkTable--"
        );
        assert_eq!(
            dsh_project_key("C:/Agent/Agent10-WorkTable"),
            "--C-Agent-Agent10-WorkTable--"
        );
        assert_eq!(decode_dsh_segment("session-1"), "session-1");
        assert_eq!(decode_dsh_segment("~002E"), ".");
    }

    #[test]
    fn dsh_tui_lists_project_sessions_from_last_used_and_resume() {
        let root = std::env::temp_dir().join(format!("aw-dsh-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        write_dsh_session(&root, r"C:\work\app", "chat-new");
        write_dsh_session(&root, r"C:\work\app", "chat-old");
        write_dsh_session(&root, r"C:\work\app", "empty-boot");
        write_dsh_session(&root, r"C:\work\other", "other");
        let mut last_used = HashMap::new();
        last_used.insert("chat-new".into(), 9);
        last_used.insert("chat-old".into(), 1);
        last_used.insert("other".into(), 99);
        let found = discover_dsh_tui(
            &[root.clone()],
            r"C:\work\app",
            &last_used,
            Some("chat-old"),
            50,
        );
        assert_eq!(ids(&found), vec!["chat-old", "chat-new"]);
        let resume_only = discover_dsh_tui(
            &[root.clone()],
            r"C:\work\app",
            &last_used,
            Some("empty-boot"),
            100,
        );
        assert_eq!(ids(&resume_only), vec!["empty-boot", "chat-new", "chat-old"]);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn dsh_tui_falls_back_to_disk_mtime_when_last_used_missing() {
        let root = std::env::temp_dir().join(format!("aw-dsh-empty-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        write_dsh_session(&root, r"C:\work\app", "chat-a");
        std::thread::sleep(std::time::Duration::from_millis(20));
        write_dsh_session(&root, r"C:\work\app", "chat-b");
        let found = discover_dsh_tui(&[root.clone()], r"C:\work\app", &HashMap::new(), None, 0);
        assert_eq!(ids(&found), vec!["chat-b", "chat-a"]);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn dsh_resume_txt_reads_first_nonempty_line() {
        let path = std::env::temp_dir().join(format!("aw-dsh-resume-{}.txt", std::process::id()));
        fs::write(&path, "\n  79747403-270f-40fa-acd8-c9024e1f54cd  \n").unwrap();
        assert_eq!(
            read_dsh_resume_id(&path).as_deref(),
            Some("79747403-270f-40fa-acd8-c9024e1f54cd")
        );
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn dsh_tui_from_home_reads_resume_txt_and_last_used() {
        if std::env::var_os("DSH_HOME").is_some() || std::env::var_os("DSH_TUI_SESSION_ROOT").is_some()
        {
            return;
        }
        let home = std::env::temp_dir().join(format!("aw-dsh-home-{}", std::process::id()));
        let _ = fs::remove_dir_all(&home);
        let cwd = r"C:\work\app";
        let sessions = home.join(".dsh").join("sessions");
        write_dsh_session(&sessions, cwd, "chat-new");
        write_dsh_session(&sessions, cwd, "chat-old");
        write_dsh_session(&sessions, cwd, "empty-boot");
        fs::create_dir_all(home.join(".dsh-tui")).unwrap();
        fs::write(
            home.join(".dsh-tui").join("last-used.json"),
            r#"{"chat-new":9,"chat-old":1}"#,
        )
        .unwrap();
        fs::write(home.join(".dsh-tui").join("resume.txt"), "chat-old\n").unwrap();
        let found = discover_dsh_tui_from_home(&home, cwd);
        assert_eq!(ids(&found).first().copied(), Some("chat-old"));
        assert!(ids(&found).contains(&"chat-new"));
        assert!(!ids(&found).contains(&"empty-boot"));
        let _ = fs::remove_dir_all(&home);
    }
}
