//! Bounded, fixed-window invalidation batching. A flood degrades to one rescan,
//! never an unbounded queue of WebView events. Idle watchers do not poll.
use std::collections::BTreeMap;
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crate::workspace_changes::WorkspaceChangeKind;

const FLUSH_INTERVAL: Duration = Duration::from_millis(100);
const MAX_PENDING_PATHS: usize = 64;
type Changes = Vec<(String, WorkspaceChangeKind)>;

#[derive(Default)]
struct Pending {
    paths: BTreeMap<String, WorkspaceChangeKind>,
    rescan_path: Option<String>,
    deadline: Option<Instant>,
    stopped: bool,
}

impl Pending {
    fn push(&mut self, changes: Changes, rescan: bool, now: Instant) -> bool {
        if self.stopped || (changes.is_empty() && !rescan) {
            return false;
        }
        let wake = self.deadline.is_none();
        self.deadline.get_or_insert(now + FLUSH_INTERVAL);
        if rescan {
            self.rescan_path = Some(".".into());
            self.paths.clear();
        }
        for (path, kind) in changes {
            if let Some(root) = &mut self.rescan_path {
                widen_rescan_root(root, &path);
            } else if !self.paths.contains_key(&path) && self.paths.len() == MAX_PENDING_PATHS {
                let mut root = parent_path(&path).to_string();
                for pending_path in self.paths.keys() {
                    widen_rescan_root(&mut root, pending_path);
                }
                self.paths.clear();
                self.rescan_path = Some(root);
            } else {
                self.paths.insert(path, kind);
            }
        }
        wake
    }

    fn take(&mut self) -> (Changes, bool) {
        self.deadline = None;
        let rescan_path = self.rescan_path.take();
        let paths = std::mem::take(&mut self.paths);
        if let Some(path) = rescan_path {
            (vec![(path, WorkspaceChangeKind::Upsert)], true)
        } else {
            (paths.into_iter().collect(), false)
        }
    }
}

fn parent_path(path: &str) -> &str {
    path.rsplit_once('/')
        .map(|(parent, _)| parent)
        .filter(|parent| !parent.is_empty())
        .unwrap_or(".")
}

// Keep a dependency install's overflow inside node_modules rather than
// invalidating every displayed image/Unity preview ten times per second.
fn widen_rescan_root(root: &mut String, path: &str) {
    while root != "."
        && path != root
        && !path
            .strip_prefix(root.as_str())
            .is_some_and(|tail| tail.starts_with('/'))
    {
        *root = parent_path(root).to_string();
    }
}

#[derive(Clone, Default)]
pub(super) struct ChangeQueue(Arc<(Mutex<Pending>, Condvar)>);

impl ChangeQueue {
    pub fn push(&self, changes: Changes, rescan: bool) {
        let (lock, wake) = &*self.0;
        let mut pending = lock.lock().unwrap_or_else(|error| error.into_inner());
        if pending.push(changes, rescan, Instant::now()) {
            wake.notify_one();
        }
    }

    pub fn start(
        &self,
        mut publish: impl FnMut(Changes, bool) + Send + 'static,
    ) -> Result<ChangeWorker, String> {
        let queue = self.clone();
        let worker_queue = queue.clone();
        let worker = std::thread::Builder::new()
            .name("workspace-file-changes".into())
            .spawn(move || {
                let (lock, wake) = &*worker_queue.0;
                loop {
                    let mut pending = lock.lock().unwrap_or_else(|error| error.into_inner());
                    loop {
                        if pending.stopped {
                            return;
                        }
                        match pending.deadline {
                            Some(deadline) => {
                                let remaining = deadline.saturating_duration_since(Instant::now());
                                if remaining.is_zero() {
                                    break;
                                }
                                pending = wake
                                    .wait_timeout(pending, remaining)
                                    .unwrap_or_else(|error| error.into_inner())
                                    .0;
                            }
                            None => {
                                pending = wake
                                    .wait(pending)
                                    .unwrap_or_else(|error| error.into_inner())
                            }
                        }
                    }
                    let (changes, rescan) = pending.take();
                    drop(pending);
                    publish(changes, rescan);
                }
            })
            .map_err(|error| error.to_string())?;
        Ok(ChangeWorker {
            queue,
            worker: Some(worker),
        })
    }
}

pub(super) struct ChangeWorker {
    queue: ChangeQueue,
    worker: Option<JoinHandle<()>>,
}

impl Drop for ChangeWorker {
    fn drop(&mut self) {
        let (lock, wake) = &*self.queue.0;
        {
            let mut pending = lock.lock().unwrap_or_else(|error| error.into_inner());
            pending.stopped = true;
            pending.paths.clear();
            wake.notify_one();
        }
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use WorkspaceChangeKind::{Delete, Upsert};

    #[test]
    fn latest_change_wins_without_postponing_the_flush() {
        let mut pending = Pending::default();
        let now = Instant::now();
        assert!(pending.push(vec![("old.md".into(), Upsert)], false, now));
        for i in 1..1000 {
            assert!(!pending.push(
                vec![("old.md".into(), Delete), ("new.md".into(), Upsert)],
                false,
                now + Duration::from_millis(i)
            ));
        }
        assert_eq!(pending.deadline, Some(now + FLUSH_INTERVAL));
        assert_eq!(
            pending.take(),
            (
                vec![("new.md".into(), Upsert), ("old.md".into(), Delete)],
                false
            )
        );
        assert!(pending.deadline.is_none());
    }

    #[test]
    fn a_hundred_thousand_paths_have_bounded_memory_and_one_invalidation() {
        let mut pending = Pending::default();
        for i in 0..100_000 {
            pending.push(
                vec![(format!("node_modules/package/{i}.js"), Upsert)],
                false,
                Instant::now(),
            );
            assert!(pending.paths.len() <= MAX_PENDING_PATHS);
        }
        assert_eq!(
            pending.take(),
            (vec![("node_modules/package".into(), Upsert)], true)
        );
        pending.push(vec![("after.md".into(), Upsert)], false, Instant::now());
        assert_eq!(pending.take(), (vec![("after.md".into(), Upsert)], false));
    }

    #[test]
    fn overflow_widens_for_every_later_path_and_respects_directory_boundaries() {
        let mut pending = Pending::default();
        for i in 0..100 {
            pending.push(
                vec![(format!("build/out/{i}"), Upsert)],
                false,
                Instant::now(),
            );
        }
        pending.push(
            vec![("build/outside/file".into(), Delete)],
            false,
            Instant::now(),
        );
        assert_eq!(pending.rescan_path.as_deref(), Some("build"));
        pending.push(vec![("src/main.ts".into(), Upsert)], false, Instant::now());
        assert_eq!(pending.take(), (vec![(".".into(), Upsert)], true));
    }

    #[test]
    fn rescan_supersedes_paths_and_empty_events_do_not_start_timers() {
        let mut pending = Pending::default();
        assert!(!pending.push(vec![], false, Instant::now()));
        assert!(pending.deadline.is_none());
        pending.push(vec![("a".into(), Delete)], false, Instant::now());
        pending.push(vec![], true, Instant::now());
        pending.push(vec![("b".into(), Upsert)], false, Instant::now());
        assert_eq!(pending.take(), (vec![(".".into(), Upsert)], true));
    }

    #[test]
    fn worker_delivers_without_a_quiet_period_and_stops_with_its_owner() {
        let queue = ChangeQueue::default();
        let (tx, rx) = std::sync::mpsc::channel();
        let worker = queue
            .start(move |paths, rescan| {
                let _ = tx.send((paths, rescan));
            })
            .unwrap();
        queue.push(vec![("one.md".into(), Upsert)], false);
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(3)).unwrap(),
            (vec![("one.md".into(), Upsert)], false)
        );
        queue.push(vec![("cancelled.md".into(), Upsert)], false);
        drop(worker);
        queue.push(vec![("after-stop.md".into(), Upsert)], false);
        assert!(rx.try_recv().is_err());
    }
}
