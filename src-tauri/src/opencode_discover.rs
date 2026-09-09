//! Read-only OpenCode session discovery from `opencode.db`.
//!
//! OpenCode 1.17+ stores chats in SQLite under the XDG data dir (including on
//! Windows). Listing is cwd-scoped so empty agent panes can resume with
//! `--session`. Live pane identity still comes from `opencode_hook`.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{Connection, OpenFlags};

use crate::opencode_hook::valid_opencode_id;
use crate::session::{paths_match, DiscoveredSession};

const BUSY_TIMEOUT: Duration = Duration::from_millis(1500);
const DB_NAME: &str = "opencode.db";

#[derive(Debug)]
struct SessionRow {
    id: String,
    directory: String,
    time_created: i64,
    time_updated: i64,
}

pub fn discover_opencode(cwd: &str) -> Vec<DiscoveredSession> {
    discover_opencode_from(cwd, &resolve_opencode_db_paths_from_env())
}

pub fn discover_opencode_from(cwd: &str, db_paths: &[PathBuf]) -> Vec<DiscoveredSession> {
    let mut found = Vec::new();
    for path in db_paths {
        for row in read_sessions(path) {
            if !paths_match(&row.directory, cwd) {
                continue;
            }
            if !valid_opencode_id(&row.id) {
                continue;
            }
            let updated_ms = if row.time_updated > 0 {
                row.time_updated as u64
            } else if row.time_created > 0 {
                row.time_created as u64
            } else {
                0
            };
            merge_session(&mut found, row.id, updated_ms);
        }
    }
    found.sort_by(|a, b| b.updated_ms.cmp(&a.updated_ms).then(a.id.cmp(&b.id)));
    found
}

pub fn resolve_opencode_data_directory(
    xdg_data_home: Option<&Path>,
    home: Option<&Path>,
) -> Option<PathBuf> {
    let xdg = xdg_data_home
        .map(Path::as_os_str)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    if let Some(xdg) = xdg {
        return Some(xdg.join("opencode"));
    }
    Some(home?.join(".local").join("share").join("opencode"))
}

pub fn resolve_opencode_db_paths(opencode_db: Option<&Path>, data_dir: Option<&Path>) -> Vec<PathBuf> {
    if let Some(path) = opencode_db {
        if path.is_absolute() && path.is_file() {
            return vec![path.to_path_buf()];
        }
    }
    let Some(dir) = data_dir else {
        return Vec::new();
    };
    list_opencode_databases(dir)
}

fn resolve_opencode_db_paths_from_env() -> Vec<PathBuf> {
    let opencode_db = std::env::var_os("OPENCODE_DB")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    let xdg = std::env::var_os("XDG_DATA_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    let data_dir = resolve_opencode_data_directory(xdg.as_deref(), dirs::home_dir().as_deref());
    resolve_opencode_db_paths(opencode_db.as_deref(), data_dir.as_deref())
}

fn list_opencode_databases(data_dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(data_dir) else {
        return Vec::new();
    };
    let mut paths: Vec<PathBuf> = entries
        .flatten()
        .filter(|entry| entry.file_type().map(|kind| kind.is_file()).unwrap_or(false))
        .map(|entry| entry.path())
        .filter(|path| is_opencode_db_name(path))
        .collect();
    paths.sort();
    paths
}

fn is_opencode_db_name(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    if name.eq_ignore_ascii_case(DB_NAME) {
        return true;
    }
    let Some(stem) = name.strip_suffix(".db") else {
        return false;
    };
    let Some(suffix) = stem.strip_prefix("opencode-") else {
        return false;
    };
    !suffix.is_empty()
        && suffix
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn read_sessions(path: &Path) -> Vec<SessionRow> {
    let conn = match open_readonly(path) {
        Ok(conn) => conn,
        Err(_) => return Vec::new(),
    };
    if !table_exists(&conn, "session")
        || !column_exists(&conn, "session", "id")
        || !column_exists(&conn, "session", "time_created")
        || !column_exists(&conn, "session", "time_updated")
        || !column_exists(&conn, "session", "directory")
    {
        return Vec::new();
    }
    let sql = session_list_sql(
        column_exists(&conn, "session", "parent_id"),
        column_exists(&conn, "session", "time_archived"),
    );
    let mut stmt = match conn.prepare(&sql) {
        Ok(stmt) => stmt,
        Err(_) => return Vec::new(),
    };
    let rows = stmt.query_map([], |row| {
        Ok(SessionRow {
            id: row.get(0)?,
            directory: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
            time_created: row.get::<_, Option<i64>>(2)?.unwrap_or(0),
            time_updated: row.get::<_, Option<i64>>(3)?.unwrap_or(0),
        })
    });
    match rows {
        Ok(mapped) => mapped.flatten().collect(),
        Err(_) => Vec::new(),
    }
}

fn session_list_sql(has_parent_id: bool, has_time_archived: bool) -> String {
    let parent = if has_parent_id {
        "AND parent_id IS NULL"
    } else {
        ""
    };
    let archived = if has_time_archived {
        "AND time_archived IS NULL"
    } else {
        ""
    };
    format!(
        "SELECT id, directory, time_created, time_updated
         FROM session
         WHERE 1=1 {parent} {archived}"
    )
}

fn open_readonly(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    conn.busy_timeout(BUSY_TIMEOUT)?;
    conn.pragma_update(None, "query_only", "ON")?;
    Ok(conn)
}

fn table_exists(conn: &Connection, name: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1 LIMIT 1",
        [name],
        |_| Ok(()),
    )
    .is_ok()
}

fn column_exists(conn: &Connection, table: &str, column: &str) -> bool {
    let Ok(mut stmt) = conn.prepare("SELECT 1 FROM pragma_table_info(?1) WHERE name = ?2 LIMIT 1") else {
        return false;
    };
    stmt.query_row([table, column], |_| Ok(())).is_ok()
}

fn merge_session(found: &mut Vec<DiscoveredSession>, id: String, updated_ms: u64) {
    if let Some(existing) = found.iter_mut().find(|session| session.id == id) {
        if updated_ms > existing.updated_ms {
            existing.updated_ms = updated_ms;
        }
        return;
    }
    found.push(DiscoveredSession { id, updated_ms });
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hk-oc-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_db(path: &Path, sql: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        let _ = fs::remove_file(path);
        let conn = Connection::open(path).unwrap();
        conn.execute_batch(sql).unwrap();
    }

    #[test]
    fn data_dir_prefers_xdg_then_local_share() {
        assert_eq!(
            resolve_opencode_data_directory(Some(Path::new("D:/xdg")), Some(Path::new("C:/Users/me"))),
            Some(PathBuf::from("D:/xdg").join("opencode"))
        );
        assert_eq!(
            resolve_opencode_data_directory(None, Some(Path::new("C:/Users/me"))),
            Some(
                PathBuf::from("C:/Users/me")
                    .join(".local")
                    .join("share")
                    .join("opencode")
            )
        );
        assert_eq!(resolve_opencode_data_directory(None, None), None);
    }

    #[test]
    fn db_paths_use_absolute_file_or_scan_data_dir() {
        let root = temp_dir("paths");
        let explicit = root.join("custom.db");
        write_db(&explicit, "CREATE TABLE session (id TEXT);");
        let data = root.join("data");
        fs::create_dir_all(&data).unwrap();
        write_db(&data.join(DB_NAME), "CREATE TABLE session (id TEXT);");
        write_db(&data.join("opencode-work.db"), "CREATE TABLE session (id TEXT);");
        write_db(&data.join("notes.db"), "CREATE TABLE session (id TEXT);");
        let decoy_dir = root.join("decoy");
        fs::create_dir_all(decoy_dir.join("opencode.db")).unwrap();

        assert_eq!(
            resolve_opencode_db_paths(Some(&explicit), Some(&data)),
            vec![explicit.clone()]
        );
        assert_eq!(
            resolve_opencode_db_paths(Some(Path::new("relative.db")), Some(&data)),
            vec![data.join("opencode-work.db"), data.join(DB_NAME)]
        );
        assert!(resolve_opencode_db_paths(None, Some(&decoy_dir)).is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn lists_matching_root_sessions_and_skips_the_rest() {
        let root = temp_dir("rows");
        let db = root.join(DB_NAME);
        write_db(
            &db,
            r#"
            CREATE TABLE session (
              id TEXT PRIMARY KEY,
              directory TEXT,
              time_created INTEGER,
              time_updated INTEGER,
              parent_id TEXT,
              time_archived INTEGER
            );
            INSERT INTO session VALUES
              ('ses_new', 'C:/work/app', 10, 400, NULL, NULL),
              ('ses_old', 'C:\work\app', 10, 100, NULL, NULL),
              ('ses_child', 'C:/work/app', 10, 500, 'ses_new', NULL),
              ('ses_arch', 'C:/work/app', 10, 600, NULL, 1),
              ('ses_other', 'C:/other', 10, 700, NULL, NULL),
              ('msg_bad', 'C:/work/app', 10, 800, NULL, NULL),
              ('ses_null', NULL, 10, 900, NULL, NULL);
            "#,
        );

        let found = discover_opencode_from(r"C:\work\app", &[db]);
        let ids: Vec<&str> = found.iter().map(|session| session.id.as_str()).collect();
        assert_eq!(ids, vec!["ses_new", "ses_old"]);
        assert_eq!(found[0].updated_ms, 400);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_or_unreadable_db_returns_empty() {
        let root = temp_dir("empty");
        let missing = root.join("nope.db");
        assert!(discover_opencode_from("C:/work/app", &[missing]).is_empty());

        let empty = root.join("empty.db");
        write_db(&empty, "CREATE TABLE other (id TEXT);");
        assert!(discover_opencode_from("C:/work/app", &[empty.clone()]).is_empty());

        let no_dir = root.join("nodir.db");
        write_db(
            &no_dir,
            "CREATE TABLE session (id TEXT, time_created INTEGER, time_updated INTEGER);",
        );
        assert!(discover_opencode_from("C:/work/app", &[no_dir]).is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn schema_without_parent_or_archive_still_lists() {
        let root = temp_dir("schema");
        let db = root.join(DB_NAME);
        write_db(
            &db,
            r#"
            CREATE TABLE session (
              id TEXT PRIMARY KEY,
              directory TEXT,
              time_created INTEGER,
              time_updated INTEGER
            );
            INSERT INTO session VALUES ('ses_ok', 'C:/work/app', 5, 0);
            "#,
        );
        let found = discover_opencode_from("C:/work/app", &[db]);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, "ses_ok");
        assert_eq!(found[0].updated_ms, 5);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn opencode_db_name_matches_orca_pattern() {
        assert!(is_opencode_db_name(Path::new("opencode.db")));
        assert!(is_opencode_db_name(Path::new("opencode-work.db")));
        assert!(!is_opencode_db_name(Path::new("opencode.db-wal")));
        assert!(!is_opencode_db_name(Path::new("notes.db")));
        assert!(!is_opencode_db_name(Path::new("opencode-.db")));
    }
}
