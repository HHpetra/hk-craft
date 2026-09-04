use std::collections::HashMap;
use std::io::Read;
use std::process::{Command, Output, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

const ENSURE_TIMEOUT: Duration = Duration::from_secs(20);
const ENSURE_POLL: Duration = Duration::from_millis(250);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DockerContainer {
    pub id: String,
    pub name: String,
    pub image: String,
    pub state: String,
    pub status: String,
    pub running: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InspectState {
    pub status: String,
    pub running: bool,
    pub paused: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnsureStep {
    Ready,
    Unpause,
    Start,
    Sleep,
    Fail,
}

fn docker_command() -> Command {
    let mut cmd = Command::new("docker");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

fn docker_missing(err: &std::io::Error) -> bool {
    err.kind() == std::io::ErrorKind::NotFound
}

fn timeout_err(name: &str) -> AppError {
    AppError::msg(format!("等待容器 {name} 就绪超时"))
}

fn list_timeout_err() -> AppError {
    AppError::msg("列出 Docker 容器超时")
}

fn spawn_docker(args: &[&str]) -> AppResult<std::process::Child> {
    match docker_command()
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => Ok(child),
        Err(err) if docker_missing(&err) => {
            Err(AppError::msg("未找到 Docker，请确认已安装并加入 PATH"))
        }
        Err(err) => Err(AppError::msg(format!("无法启动 Docker：{err}"))),
    }
}

fn collect_output(child: &mut std::process::Child, status: std::process::ExitStatus) -> Output {
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    if let Some(mut pipe) = child.stdout.take() {
        let _ = pipe.read_to_end(&mut stdout);
    }
    if let Some(mut pipe) = child.stderr.take() {
        let _ = pipe.read_to_end(&mut stderr);
    }
    Output {
        status,
        stdout,
        stderr,
    }
}

fn wait_child_until(
    child: &mut std::process::Child,
    deadline: Instant,
    timeout: AppError,
) -> AppResult<std::process::ExitStatus> {
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(timeout);
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(err) => return Err(AppError::msg(format!("无法等待 Docker：{err}"))),
        }
    }
}

fn run_docker_until(args: &[&str], deadline: Instant, timeout: AppError) -> AppResult<Output> {
    if Instant::now() >= deadline {
        return Err(timeout);
    }
    let mut child = spawn_docker(args)?;
    let status = wait_child_until(&mut child, deadline, timeout)?;
    Ok(collect_output(&mut child, status))
}

fn stderr_text(output: &std::process::Output) -> String {
    String::from_utf8_lossy(&output.stderr).trim().to_string()
}

fn inspect_missing(err: &str) -> bool {
    let lower = err.to_ascii_lowercase();
    lower.contains("no such object") || lower.contains("no such container")
}

fn boolish(value: &str) -> bool {
    matches!(value.trim().to_ascii_lowercase().as_str(), "true" | "1")
}

pub fn parse_inspect_state(stdout: &str) -> InspectState {
    let line = stdout.trim();
    let mut parts = line.splitn(3, '\t');
    let status = parts.next().unwrap_or("").trim().to_string();
    let running = boolish(parts.next().unwrap_or(""));
    let paused = boolish(parts.next().unwrap_or(""));
    InspectState {
        status,
        running,
        paused,
    }
}

fn status_is(state: &InspectState, name: &str) -> bool {
    state.status.eq_ignore_ascii_case(name)
}

pub fn ensure_step(state: &InspectState, already_started: bool) -> EnsureStep {
    if state.paused {
        return EnsureStep::Unpause;
    }
    if state.running {
        return EnsureStep::Ready;
    }
    if status_is(state, "restarting") {
        return EnsureStep::Sleep;
    }
    if already_started && (status_is(state, "exited") || status_is(state, "dead")) {
        return EnsureStep::Fail;
    }
    if already_started {
        return EnsureStep::Sleep;
    }
    EnsureStep::Start
}

pub fn parse_ps_line(line: &str) -> Option<DockerContainer> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let mut parts = line.splitn(5, '\t');
    let id = parts.next()?.trim();
    let names = parts.next()?.trim();
    let image = parts.next().unwrap_or("").trim();
    let state = parts.next().unwrap_or("").trim();
    let status = parts.next().unwrap_or("").trim();
    if id.is_empty() || names.is_empty() {
        return None;
    }
    let name = names.split(',').next()?.trim();
    if name.is_empty() {
        return None;
    }
    Some(DockerContainer {
        id: id.to_string(),
        name: name.to_string(),
        image: image.to_string(),
        state: state.to_string(),
        status: status.to_string(),
        running: state.eq_ignore_ascii_case("running"),
    })
}

pub fn parse_ps_output(text: &str) -> Vec<DockerContainer> {
    let mut rows: Vec<DockerContainer> = text.lines().filter_map(parse_ps_line).collect();
    rows.sort_by(|a, b| b.running.cmp(&a.running).then_with(|| a.name.cmp(&b.name)));
    rows
}

fn inspect_container(name: &str, deadline: Instant) -> AppResult<InspectState> {
    let inspect = run_docker_until(
        &[
            "inspect",
            "-f",
            "{{.State.Status}}\t{{.State.Running}}\t{{.State.Paused}}",
            name,
        ],
        deadline,
        timeout_err(name),
    )?;
    if !inspect.status.success() {
        let err = stderr_text(&inspect);
        if inspect_missing(&err) {
            return Err(AppError::msg(format!("找不到容器 {name}")));
        }
        if err.is_empty() {
            return Err(AppError::msg(format!("无法检查容器 {name}")));
        }
        return Err(AppError::msg(err));
    }
    Ok(parse_inspect_state(&String::from_utf8_lossy(&inspect.stdout)))
}

fn docker_action(args: &[&str], deadline: Instant, name: &str, fail: impl FnOnce() -> String) -> AppResult<()> {
    let output = run_docker_until(args, deadline, timeout_err(name))?;
    if output.status.success() {
        return Ok(());
    }
    let err = stderr_text(&output);
    if err.is_empty() {
        return Err(AppError::msg(fail()));
    }
    Err(AppError::msg(err))
}

fn ensure_locks() -> &'static Mutex<HashMap<String, Arc<Mutex<()>>>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    LOCKS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn with_container_lock<T>(name: &str, f: impl FnOnce() -> T) -> T {
    let lock = {
        let mut map = ensure_locks()
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        map.entry(name.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    };
    let _guard = lock.lock().unwrap_or_else(|err| err.into_inner());
    f()
}

fn ensure_running_serialized(name: String) -> AppResult<()> {
    let key = name.trim().to_string();
    with_container_lock(&key, || ensure_running(name))
}

fn list_containers() -> AppResult<Vec<DockerContainer>> {
    let deadline = Instant::now() + ENSURE_TIMEOUT;
    let output = run_docker_until(
        &[
            "ps",
            "-a",
            "--format",
            "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.State}}\t{{.Status}}",
        ],
        deadline,
        list_timeout_err(),
    )?;
    if !output.status.success() {
        let err = stderr_text(&output);
        if err.is_empty() {
            return Err(AppError::msg("无法列出 Docker 容器"));
        }
        return Err(AppError::msg(format!("无法列出 Docker 容器：{err}")));
    }
    Ok(parse_ps_output(&String::from_utf8_lossy(&output.stdout)))
}

fn ensure_running(name: String) -> AppResult<()> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::msg("未指定容器"));
    }
    let deadline = Instant::now() + ENSURE_TIMEOUT;
    let mut started = false;
    loop {
        if Instant::now() >= deadline {
            return Err(timeout_err(&name));
        }
        let state = inspect_container(&name, deadline)?;
        match ensure_step(&state, started) {
            EnsureStep::Ready => return Ok(()),
            EnsureStep::Unpause => {
                docker_action(&["unpause", &name], deadline, &name, || {
                    format!("无法恢复容器 {name}")
                })?;
                std::thread::sleep(ENSURE_POLL);
            }
            EnsureStep::Start => {
                docker_action(&["start", &name], deadline, &name, || {
                    format!("无法启动容器 {name}")
                })?;
                started = true;
                std::thread::sleep(ENSURE_POLL);
            }
            EnsureStep::Fail => {
                return Err(AppError::msg(format!(
                    "容器 {name} 启动后立即退出"
                )));
            }
            EnsureStep::Sleep => {
                if Instant::now() >= deadline {
                    return Err(timeout_err(&name));
                }
                std::thread::sleep(ENSURE_POLL);
            }
        }
        if Instant::now() >= deadline {
            return Err(timeout_err(&name));
        }
    }
}

#[tauri::command]
pub async fn docker_list_containers() -> AppResult<Vec<DockerContainer>> {
    tauri::async_runtime::spawn_blocking(list_containers)
        .await
        .map_err(|err| AppError::msg(err.to_string()))?
}

#[tauri::command]
pub async fn docker_ensure_running(name: String) -> AppResult<()> {
    tauri::async_runtime::spawn_blocking(move || ensure_running_serialized(name))
        .await
        .map_err(|err| AppError::msg(err.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_ps_line_reads_tab_fields() {
        let row = parse_ps_line(
            "abc123\tweb,web-alias\tnginx:latest\trunning\tUp 2 hours",
        )
        .expect("row");
        assert_eq!(row.id, "abc123");
        assert_eq!(row.name, "web");
        assert_eq!(row.image, "nginx:latest");
        assert_eq!(row.state, "running");
        assert_eq!(row.status, "Up 2 hours");
        assert!(row.running);
    }

    #[test]
    fn parse_ps_line_marks_exited() {
        let row = parse_ps_line("def456\tdb\tpostgres:16\texited\tExited (0) 3 days ago").expect("row");
        assert_eq!(row.name, "db");
        assert!(!row.running);
    }

    #[test]
    fn parse_ps_output_sorts_running_first() {
        let rows = parse_ps_output(
            "a1\tzed\talpine\texited\tExited (0) 1h\n\
             a2\talpha\tbusybox\trunning\tUp 1s\n\
             a3\tbeta\tbusybox\trunning\tUp 2s\n",
        );
        let names: Vec<&str> = rows.iter().map(|row| row.name.as_str()).collect();
        assert_eq!(names, ["alpha", "beta", "zed"]);
    }

    #[test]
    fn parse_inspect_state_reads_fields() {
        let running = parse_inspect_state("running\ttrue\tfalse\n");
        assert_eq!(running.status, "running");
        assert!(running.running);
        assert!(!running.paused);

        let paused = parse_inspect_state("paused\ttrue\ttrue");
        assert!(paused.running);
        assert!(paused.paused);

        let restarting = parse_inspect_state("restarting\tfalse\tfalse");
        assert_eq!(restarting.status, "restarting");
        assert!(!restarting.running);
    }

    #[test]
    fn ensure_step_unpause_start_wait_ready() {
        let paused = InspectState {
            status: "paused".into(),
            running: true,
            paused: true,
        };
        assert_eq!(ensure_step(&paused, false), EnsureStep::Unpause);

        let exited = InspectState {
            status: "exited".into(),
            running: false,
            paused: false,
        };
        assert_eq!(ensure_step(&exited, false), EnsureStep::Start);
        assert_eq!(ensure_step(&exited, true), EnsureStep::Fail);

        let dead = InspectState {
            status: "dead".into(),
            running: false,
            paused: false,
        };
        assert_eq!(ensure_step(&dead, true), EnsureStep::Fail);

        let restarting = InspectState {
            status: "restarting".into(),
            running: false,
            paused: false,
        };
        assert_eq!(ensure_step(&restarting, false), EnsureStep::Sleep);
        assert_eq!(ensure_step(&restarting, true), EnsureStep::Sleep);

        let running = InspectState {
            status: "running".into(),
            running: true,
            paused: false,
        };
        assert_eq!(ensure_step(&running, true), EnsureStep::Ready);
    }

    #[test]
    fn run_docker_until_expired_deadline_does_not_spawn() {
        let err = run_docker_until(
            &["version"],
            Instant::now() - Duration::from_secs(1),
            timeout_err("web"),
        )
        .expect_err("deadline");
        assert!(err.to_string().contains("超时"));

        let list_err = run_docker_until(
            &["ps"],
            Instant::now() - Duration::from_secs(1),
            list_timeout_err(),
        )
        .expect_err("list deadline");
        assert!(list_err.to_string().contains("列出 Docker 容器超时"));
    }
}
