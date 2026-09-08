use std::collections::{HashMap, HashSet, VecDeque};
use std::thread;
use std::time::Duration;

use serde::Serialize;
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};

const SAMPLE_GAP: Duration = Duration::from_millis(300);

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct PtySessionStat {
    pub session_id: String,
    pub pid: u32,
    pub memory_bytes: u64,
    pub cpu_pct: f32,
    pub process_count: u32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ProcSnap {
    pub pid: u32,
    pub parent: Option<u32>,
    pub memory_bytes: u64,
    pub cpu_pct: f32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TreeStat {
    pub memory_bytes: u64,
    pub cpu_pct: f32,
    pub process_count: u32,
}

pub fn fold_tree(procs: &[ProcSnap], root_pid: u32) -> TreeStat {
    let by_pid: HashMap<u32, &ProcSnap> = procs.iter().map(|proc| (proc.pid, proc)).collect();
    if !by_pid.contains_key(&root_pid) {
        return TreeStat {
            memory_bytes: 0,
            cpu_pct: 0.0,
            process_count: 0,
        };
    }

    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for proc in procs {
        if let Some(parent) = proc.parent {
            children.entry(parent).or_default().push(proc.pid);
        }
    }

    let mut seen = HashSet::new();
    let mut queue = VecDeque::from([root_pid]);
    let mut memory_bytes = 0u64;
    let mut cpu_pct = 0f32;
    let mut process_count = 0u32;

    while let Some(pid) = queue.pop_front() {
        if !seen.insert(pid) {
            continue;
        }
        if let Some(proc) = by_pid.get(&pid) {
            memory_bytes += proc.memory_bytes;
            cpu_pct += proc.cpu_pct;
            process_count += 1;
        }
        if let Some(kids) = children.get(&pid) {
            queue.extend(kids.iter().copied());
        }
    }

    TreeStat {
        memory_bytes,
        cpu_pct,
        process_count,
    }
}

pub fn sample_sessions(roots: &[(String, u32)]) -> Vec<PtySessionStat> {
    if roots.is_empty() {
        return Vec::new();
    }
    let snaps = snapshot_procs();
    roots
        .iter()
        .map(|(session_id, pid)| {
            let tree = fold_tree(&snaps, *pid);
            PtySessionStat {
                session_id: session_id.clone(),
                pid: *pid,
                memory_bytes: tree.memory_bytes,
                cpu_pct: tree.cpu_pct,
                process_count: tree.process_count,
            }
        })
        .collect()
}

fn snapshot_procs() -> Vec<ProcSnap> {
    let mut sys = System::new();
    let kind = ProcessRefreshKind::nothing()
        .with_cpu()
        .with_memory()
        .without_tasks();
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, kind);
    thread::sleep(SAMPLE_GAP);
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, kind);
    sys.processes()
        .iter()
        .map(|(pid, proc)| ProcSnap {
            pid: pid.as_u32(),
            parent: proc.parent().map(|parent| parent.as_u32()),
            memory_bytes: proc.memory(),
            cpu_pct: proc.cpu_usage(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proc(pid: u32, parent: Option<u32>, memory_bytes: u64, cpu_pct: f32) -> ProcSnap {
        ProcSnap {
            pid,
            parent,
            memory_bytes,
            cpu_pct,
        }
    }

    #[test]
    fn fold_includes_descendants_not_parent() {
        let procs = [
            proc(1, None, 100, 1.0),
            proc(10, Some(1), 50, 2.0),
            proc(11, Some(10), 200, 3.0),
            proc(12, Some(10), 30, 1.0),
            proc(13, Some(11), 10, 0.5),
        ];
        let tree = fold_tree(&procs, 10);
        assert_eq!(
            tree,
            TreeStat {
                memory_bytes: 290,
                cpu_pct: 6.5,
                process_count: 4,
            }
        );
    }

    #[test]
    fn fold_missing_root_is_empty() {
        let procs = [proc(2, Some(1), 10, 1.0)];
        assert_eq!(
            fold_tree(&procs, 9),
            TreeStat {
                memory_bytes: 0,
                cpu_pct: 0.0,
                process_count: 0,
            }
        );
    }

    #[test]
    fn fold_lone_root_is_itself() {
        let procs = [proc(7, Some(1), 40, 2.5)];
        assert_eq!(
            fold_tree(&procs, 7),
            TreeStat {
                memory_bytes: 40,
                cpu_pct: 2.5,
                process_count: 1,
            }
        );
    }

    #[test]
    fn fold_breaks_cycles() {
        let procs = [proc(4, Some(5), 8, 1.0), proc(5, Some(4), 2, 1.0)];
        let tree = fold_tree(&procs, 4);
        assert_eq!(tree.process_count, 2);
        assert_eq!(tree.memory_bytes, 10);
    }
}
