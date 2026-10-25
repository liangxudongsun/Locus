//! On-demand filesystem watching for non-Unity file-mode explorers.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;

use crate::workspace_changes::{WorkspaceChangeEvent, WorkspaceChangeKind, WorkspaceChangeSource};
use crate::workspace_service::event::{emit_for_workspace_scope, WorkspaceEventScope};
use crate::workspace_service::runtime::{WorkspaceLease, WorkspaceLeaseKind, WorkspaceRuntime};

mod coalescer;

struct FileWatcher {
    // Stop the publisher before dropping the native watcher; callbacks after
    // shutdown see a stopped queue and cannot publish into a retired scope.
    _worker: coalescer::ChangeWorker,
    _watcher: RecommendedWatcher,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileTreeChange {
    #[serde(flatten)]
    change: WorkspaceChangeEvent,
    rescan: bool,
}

struct Registration {
    _watcher: FileWatcher,
    _lease: WorkspaceLease,
    owners: HashMap<String, String>, // subscription token -> native window label
    materialization_epoch: u64,
    workspace_generation: u64,
}

#[derive(Clone, Default)]
pub struct WorkspaceFileWatchState(Arc<Mutex<Option<Registration>>>);

impl WorkspaceFileWatchState {
    pub fn acquire(
        &self,
        runtime: &Arc<WorkspaceRuntime>,
        app: &tauri::AppHandle,
        window: &str,
    ) -> Result<Option<String>, String> {
        self.acquire_with(runtime, window, || {
            let app = app.clone();
            let scope = WorkspaceEventScope::for_runtime(runtime);
            let hub = crate::workspace_changes::hub_for_workspace(runtime.root());
            watch(runtime.root(), move |changes, rescan| {
                for (path, kind) in changes {
                    if let Some(change) = hub.observe(&path, kind, WorkspaceChangeSource::OsWatcher)
                    {
                        emit_for_workspace_scope(
                            &app,
                            &scope,
                            crate::workspace_changes::WORKSPACE_FILE_CHANGED_EVENT,
                            FileTreeChange { change, rescan },
                        );
                    }
                }
            })
        })
    }

    fn acquire_with(
        &self,
        runtime: &Arc<WorkspaceRuntime>,
        window: &str,
        create: impl FnOnce() -> Result<FileWatcher, String>,
    ) -> Result<Option<String>, String> {
        let root = runtime.root();
        // Match the explorer's Unity detection, including non-Unity projects
        // that happen to have an Assets directory.
        if root.join("Assets").is_dir() && root.join("ProjectSettings/ProjectVersion.txt").is_file()
        {
            return Ok(None);
        }
        let mut guard = self.0.lock().map_err(|e| e.to_string())?;
        if guard.as_ref().is_some_and(|registration| {
            registration.materialization_epoch != runtime.materialization_epoch()
                || registration.workspace_generation != runtime.generation()
        }) {
            // A reassigned checkout must publish with its new routing identity.
            guard.take();
        }
        if guard.is_none() {
            let watcher = create()?;
            *guard = Some(Registration {
                _watcher: watcher,
                _lease: runtime.acquire_lease(WorkspaceLeaseKind::VisiblePane),
                owners: HashMap::new(),
                materialization_epoch: runtime.materialization_epoch(),
                workspace_generation: runtime.generation(),
            });
        }
        let token = uuid::Uuid::new_v4().to_string();
        guard
            .as_mut()
            .unwrap()
            .owners
            .insert(token.clone(), window.to_string());
        Ok(Some(token))
    }

    pub fn release(&self, window: &str, token: Option<&str>) {
        let retired = if let Ok(mut guard) = self.0.lock() {
            if let Some(registration) = guard.as_mut() {
                registration.owners.retain(|key, owner| {
                    owner != window || token.is_some_and(|token| token != key)
                });
                if registration.owners.is_empty() {
                    guard.take()
                } else {
                    None
                }
            } else {
                None
            }
        } else {
            None
        };
        // Dropping the native watcher may join its callback thread.
        drop(retired);
    }

    pub fn is_running(&self) -> bool {
        self.0.lock().map(|guard| guard.is_some()).unwrap_or(false)
    }
}

fn event_changes(root: &Path, event: &Event) -> Vec<(String, WorkspaceChangeKind)> {
    if matches!(event.kind, EventKind::Access(_)) {
        return Vec::new();
    }
    event
        .paths
        .iter()
        .filter_map(|path| {
            let relative = path.strip_prefix(root).ok()?;
            let path_string = relative.to_string_lossy().replace('\\', "/");
            // Internal bookkeeping must not cause a feedback loop while browsing.
            if path_string.split('/').any(|part| {
                part.eq_ignore_ascii_case(".git") || part.eq_ignore_ascii_case(".locus")
            }) {
                return None;
            }
            let kind = if path.exists() {
                WorkspaceChangeKind::Upsert
            } else {
                WorkspaceChangeKind::Delete
            };
            Some((
                if path_string.is_empty() {
                    ".".into()
                } else {
                    path_string
                },
                kind,
            ))
        })
        .collect()
}

fn watch(
    root: &Path,
    publish: impl FnMut(Vec<(String, WorkspaceChangeKind)>, bool) + Send + 'static,
) -> Result<FileWatcher, String> {
    let callback_root = PathBuf::from(root);
    let queue = coalescer::ChangeQueue::default();
    let callback_queue = queue.clone();
    let mut watcher = RecommendedWatcher::new(
        move |event: notify::Result<Event>| {
            match event {
                Ok(event) if !event.need_rescan() && !event.paths.is_empty() => {
                    callback_queue.push(event_changes(&callback_root, &event), false)
                }
                // Lost or ambiguous events invalidate every loaded directory. The
                // frontend coalesces these with ordinary changes before reading disk.
                _ => callback_queue.push(Vec::new(), true),
            }
        },
        Config::default(),
    )
    .map_err(|e| e.to_string())?;
    watcher
        .watch(root, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;
    let worker = queue.start(publish)?;
    Ok(FileWatcher {
        _worker: worker,
        _watcher: watcher,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{CreateKind, ModifyKind, RenameMode};

    #[test]
    fn shares_a_watcher_and_releases_only_the_owning_windows_tokens() {
        let dir = tempfile::tempdir().unwrap();
        let identity =
            crate::workspace_service::identity::ProjectIdResolver::resolve(dir.path()).unwrap();
        let runtime = WorkspaceRuntime::new(identity, vec![], 1);
        let state = runtime.core().file_watch();
        let first = state
            .acquire_with(&runtime, "main", || watch(dir.path(), |_, _| {}))
            .unwrap()
            .unwrap();
        let second = state
            .acquire_with(&runtime, "second", || panic!("watcher must be shared"))
            .unwrap()
            .unwrap();
        assert_eq!(runtime.lease_count(), 1);
        state.release("second", Some(&first));
        assert!(state.is_running());
        state.release("main", Some(&first));
        assert!(state.is_running());
        assert_eq!(runtime.lease_count(), 1);
        state.release("second", None);
        assert!(!state.is_running());
        assert_eq!(runtime.lease_count(), 0);
        state.release("second", Some(&second));
    }

    #[test]
    fn unity_checkout_does_not_acquire_a_general_watcher() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("Assets")).unwrap();
        std::fs::create_dir(dir.path().join("ProjectSettings")).unwrap();
        std::fs::write(
            dir.path().join("ProjectSettings/ProjectVersion.txt"),
            "m_EditorVersion: 6000.0.1f1",
        )
        .unwrap();
        let identity =
            crate::workspace_service::identity::ProjectIdResolver::resolve(dir.path()).unwrap();
        let runtime = WorkspaceRuntime::new(identity, vec![], 1);
        assert!(runtime
            .core()
            .file_watch()
            .acquire_with(&runtime, "main", || panic!("not for Unity"))
            .unwrap()
            .is_none());
        assert_eq!(runtime.lease_count(), 0);
    }

    #[test]
    fn maps_create_rename_and_internal_paths() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("old.md");
        let new = dir.path().join("new.md");
        std::fs::write(&new, "new").unwrap();
        let event = Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Both)))
            .add_path(old)
            .add_path(new);
        assert_eq!(
            event_changes(dir.path(), &event),
            vec![
                ("old.md".into(), WorkspaceChangeKind::Delete),
                ("new.md".into(), WorkspaceChangeKind::Upsert),
            ]
        );
        let ignored =
            Event::new(EventKind::Create(CreateKind::File)).add_path(dir.path().join(".git/index"));
        assert!(event_changes(dir.path(), &ignored).is_empty());
    }

    #[test]
    fn observes_real_disk_creation_rename_and_deletion() {
        let dir = tempfile::tempdir().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let _watcher = watch(dir.path(), move |changes, _| {
            for change in changes {
                let _ = tx.send(change);
            }
        })
        .unwrap();
        let wait_for = |path: &str, kind: WorkspaceChangeKind| {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            loop {
                let change = rx
                    .recv_timeout(deadline.saturating_duration_since(std::time::Instant::now()))
                    .unwrap();
                if change == (path.to_string(), kind) {
                    break;
                }
            }
        };
        std::fs::write(dir.path().join("new.md"), "hello").unwrap();
        wait_for("new.md", WorkspaceChangeKind::Upsert);
        std::fs::rename(dir.path().join("new.md"), dir.path().join("renamed.md")).unwrap();
        wait_for("renamed.md", WorkspaceChangeKind::Upsert);
        std::fs::remove_file(dir.path().join("renamed.md")).unwrap();
        wait_for("renamed.md", WorkspaceChangeKind::Delete);
        std::fs::create_dir(dir.path().join("nested")).unwrap();
        wait_for("nested", WorkspaceChangeKind::Upsert);
        std::fs::write(dir.path().join("nested/child.txt"), "child").unwrap();
        wait_for("nested/child.txt", WorkspaceChangeKind::Upsert);
    }
}
