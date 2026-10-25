//! Per-document reading positions, independent of open tabs.
//!
//! `reading_positions.jsonl` is an append-only log: each update appends one
//! short line for the changed document; compaction rewrites only the live
//! entries once the log grows past twice their number.
use crate::append_log;
use crate::workspace_service::{CheckoutId, ProjectRegistry};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{Manager, State};

pub const FILE_NAME: &str = "reading_positions.jsonl";
const ENTRY_LIMIT: usize = 2000;
const MIN_COMPACT_LINES: usize = 1000;
const FLUSH_DELAY: std::time::Duration = std::time::Duration::from_secs(1);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingPosition {
    #[serde(default)]
    pub line: u32,
    #[serde(default)]
    pub column: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line_hash: Option<String>,
    /// Pixels the anchor line has scrolled past the viewport top.
    #[serde(default)]
    pub offset: f64,
    /// Scroll offset when the viewport top lies above the document body.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before: Option<f64>,
    #[serde(default)]
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingTarget {
    #[serde(default)]
    pub checkout_id: Option<String>,
    pub resource: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingUpdate {
    pub target: ReadingTarget,
    #[serde(default)]
    pub position: Option<ReadingPosition>,
}

#[derive(Serialize, Deserialize)]
struct LogLine {
    k: String,
    #[serde(default)]
    p: Option<ReadingPosition>,
}

#[derive(Default)]
struct Inner {
    loaded: bool,
    entries: HashMap<String, ReadingPosition>,
    pending: HashMap<String, Option<ReadingPosition>>,
    log_lines: usize,
    flush_scheduled: bool,
}

pub struct ReadingPositionStore {
    path: PathBuf,
    inner: Mutex<Inner>,
    /// Orders appends and compaction; never held together with `inner` during IO.
    writer: Mutex<()>,
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn enforce_limit(entries: &mut HashMap<String, ReadingPosition>) {
    if entries.len() <= ENTRY_LIMIT {
        return;
    }
    let mut order: Vec<(i64, String)> = entries
        .iter()
        .map(|(key, position)| (position.updated_at, key.clone()))
        .collect();
    order.sort();
    for (_, key) in order.into_iter().take(entries.len() - ENTRY_LIMIT) {
        entries.remove(&key);
    }
}

fn compaction_due(log_lines: usize, live: usize) -> bool {
    log_lines > MIN_COMPACT_LINES.max(live * 2)
}

impl ReadingPositionStore {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            inner: Mutex::new(Inner::default()),
            writer: Mutex::new(()),
        }
    }

    fn entry_lines(entries: &HashMap<String, ReadingPosition>) -> Vec<String> {
        let mut lines: Vec<(i64, String)> = entries
            .iter()
            .filter_map(|(key, position)| {
                serde_json::to_string(&LogLine {
                    k: key.clone(),
                    p: Some(position.clone()),
                })
                .ok()
                .map(|line| (position.updated_at, line))
            })
            .collect();
        lines.sort();
        lines.into_iter().map(|(_, line)| line).collect()
    }

    fn ensure_loaded(&self) -> Result<(), String> {
        if self.inner.lock().map_err(|e| e.to_string())?.loaded {
            return Ok(());
        }
        let _writer = self.writer.lock().map_err(|e| e.to_string())?;
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        if inner.loaded {
            return Ok(());
        }
        let log = append_log::read_lines(&self.path).map_err(|e| e.to_string())?;
        let mut clean = log.clean;
        let mut entries = HashMap::new();
        for line in &log.lines {
            match serde_json::from_str::<LogLine>(line) {
                Ok(LogLine { k, p: Some(position) }) => {
                    entries.insert(k, position);
                }
                Ok(LogLine { k, p: None }) => {
                    entries.remove(&k);
                }
                Err(_) => clean = false,
            }
        }
        enforce_limit(&mut entries);
        let mut log_lines = log.lines.len();
        if !clean || compaction_due(log_lines, entries.len()) {
            // Never append after a damaged tail; start from the live entries.
            let lines = Self::entry_lines(&entries);
            append_log::rewrite(&self.path, &lines)?;
            log_lines = lines.len();
        }
        inner.entries = entries;
        inner.log_lines = log_lines;
        inner.loaded = true;
        Ok(())
    }

    pub fn get(&self, keys: &[String]) -> Result<Vec<Option<ReadingPosition>>, String> {
        self.ensure_loaded()?;
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        Ok(keys.iter().map(|key| inner.entries.get(key).cloned()).collect())
    }

    /// Records updates in memory. Returns true when a background flush must be scheduled.
    pub fn put(&self, updates: Vec<(String, Option<ReadingPosition>)>) -> Result<bool, String> {
        self.ensure_loaded()?;
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        let now = now_ms();
        for (key, position) in updates {
            let position = position.map(|mut position| {
                position.updated_at = now;
                position
            });
            let unchanged = match (&position, inner.entries.get(&key)) {
                (None, None) => true,
                (Some(next), Some(current)) => ReadingPosition { updated_at: 0, ..next.clone() }
                    == ReadingPosition { updated_at: 0, ..current.clone() },
                _ => false,
            };
            if unchanged {
                continue;
            }
            match &position {
                Some(position) => {
                    inner.entries.insert(key.clone(), position.clone());
                }
                None => {
                    inner.entries.remove(&key);
                }
            }
            inner.pending.insert(key, position);
        }
        enforce_limit(&mut inner.entries);
        let schedule = !inner.pending.is_empty() && !inner.flush_scheduled;
        if schedule {
            inner.flush_scheduled = true;
        }
        Ok(schedule)
    }

    /// Appends pending updates; compacts when the log outgrew its live entries.
    pub fn flush(&self, sync: bool) -> Result<(), String> {
        let _writer = self.writer.lock().map_err(|e| e.to_string())?;
        let (lines, compact) = {
            let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
            inner.flush_scheduled = false;
            let lines: Vec<String> = inner
                .pending
                .drain()
                .filter_map(|(k, p)| serde_json::to_string(&LogLine { k, p }).ok())
                .collect();
            inner.log_lines += lines.len();
            let compact = compaction_due(inner.log_lines, inner.entries.len())
                .then(|| Self::entry_lines(&inner.entries));
            (lines, compact)
        };
        if let Some(compacted) = compact {
            append_log::rewrite(&self.path, &compacted)?;
            self.inner.lock().map_err(|e| e.to_string())?.log_lines = compacted.len();
            return Ok(());
        }
        append_log::append(&self.path, &lines, sync)?;
        if sync && lines.is_empty() {
            append_log::sync(&self.path)?;
        }
        Ok(())
    }

    pub fn flush_on_exit(&self) {
        let loaded = self.inner.lock().map(|inner| inner.loaded).unwrap_or(false);
        if loaded {
            if let Err(error) = self.flush(true) {
                eprintln!("[ReadingPosition] final save failed: {error}");
            }
        }
    }
}

/// Positions are shared by every checkout of a project; files outside any
/// checkout use the `local` scope.
fn target_key(target: &ReadingTarget, registry: Option<&ProjectRegistry>) -> String {
    let scope = match target.checkout_id.as_deref().filter(|id| !id.is_empty()) {
        Some(checkout) => CheckoutId::new(checkout)
            .ok()
            .and_then(|id| registry.and_then(|registry| registry.runtime(&id)))
            .map(|runtime| format!("project:{}", runtime.project_id().as_str()))
            .unwrap_or_else(|| format!("checkout:{checkout}")),
        None => "local".to_string(),
    };
    let mut parts = Vec::with_capacity(target.resource.len() + 1);
    parts.push(scope);
    parts.extend(target.resource.iter().cloned());
    serde_json::to_string(&parts).unwrap_or_default()
}

fn schedule_flush(store: Arc<ReadingPositionStore>) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FLUSH_DELAY).await;
        let _ = tauri::async_runtime::spawn_blocking(move || {
            if let Err(error) = store.flush(false) {
                eprintln!("[ReadingPosition] save failed: {error}");
            }
        })
        .await;
    });
}

#[tauri::command]
pub async fn reading_position_get(
    targets: Vec<ReadingTarget>,
    store: State<'_, Arc<ReadingPositionStore>>,
    registry: State<'_, Arc<ProjectRegistry>>,
) -> Result<Vec<Option<ReadingPosition>>, String> {
    let keys: Vec<String> = targets
        .iter()
        .map(|target| target_key(target, Some(registry.inner().as_ref())))
        .collect();
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || store.get(&keys))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn reading_position_put(
    updates: Vec<ReadingUpdate>,
    store: State<'_, Arc<ReadingPositionStore>>,
    registry: State<'_, Arc<ProjectRegistry>>,
) -> Result<(), String> {
    let updates: Vec<(String, Option<ReadingPosition>)> = updates
        .into_iter()
        .map(|update| (target_key(&update.target, Some(registry.inner().as_ref())), update.position))
        .collect();
    let store = store.inner().clone();
    let schedule = {
        let store = store.clone();
        tauri::async_runtime::spawn_blocking(move || store.put(updates))
            .await
            .map_err(|e| e.to_string())??
    };
    if schedule {
        schedule_flush(store);
    }
    Ok(())
}

pub fn flush_on_exit(app: &tauri::AppHandle) {
    if let Some(store) = app.try_state::<Arc<ReadingPositionStore>>() {
        store.flush_on_exit();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn position(line: u32) -> ReadingPosition {
        ReadingPosition {
            line,
            column: 2,
            line_hash: Some("h".into()),
            offset: 4.5,
            before: None,
            updated_at: 0,
        }
    }

    #[test]
    fn appends_only_changed_entries_and_survives_restart() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        let store = ReadingPositionStore::new(path.clone());
        assert!(store.put(vec![("a".into(), Some(position(10)))]).unwrap());
        assert!(!store.put(vec![("b".into(), Some(position(3)))]).unwrap());
        store.flush(false).unwrap();
        let size = std::fs::metadata(&path).unwrap().len();
        // Unchanged positions do not append.
        store.put(vec![("a".into(), Some(position(10)))]).unwrap();
        store.flush(false).unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().len(), size);
        store.put(vec![("a".into(), Some(position(11))), ("b".into(), None)]).unwrap();
        store.flush(true).unwrap();
        let restarted = ReadingPositionStore::new(path);
        let values = restarted.get(&["a".into(), "b".into()]).unwrap();
        assert_eq!(values[0].as_ref().unwrap().line, 11);
        assert!(values[1].is_none());
    }

    #[test]
    fn compacts_and_limits_entries() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        let store = ReadingPositionStore::new(path.clone());
        for round in 0..3u32 {
            let updates = (0..(ENTRY_LIMIT as u32 + 50))
                .map(|i| (format!("doc-{i}"), Some(position(round * 10_000 + i))))
                .collect();
            store.put(updates).unwrap();
            store.flush(false).unwrap();
        }
        let lines = append_log::read_lines(&path).unwrap().lines.len();
        assert!(lines <= MIN_COMPACT_LINES.max(ENTRY_LIMIT * 2) + ENTRY_LIMIT + 50);
        let restarted = ReadingPositionStore::new(path);
        restarted.ensure_loaded().unwrap();
        assert_eq!(restarted.inner.lock().unwrap().entries.len(), ENTRY_LIMIT);
    }

    #[test]
    fn damaged_tail_is_rewritten_before_new_appends() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        let store = ReadingPositionStore::new(path.clone());
        store.put(vec![("a".into(), Some(position(1)))]).unwrap();
        store.flush(false).unwrap();
        use std::io::Write;
        std::fs::OpenOptions::new().append(true).open(&path).unwrap().write_all(b"{\"k\":").unwrap();
        let restarted = ReadingPositionStore::new(path.clone());
        restarted.put(vec![("b".into(), Some(position(2)))]).unwrap();
        restarted.flush(false).unwrap();
        assert!(append_log::read_lines(&path).unwrap().clean);
        let values = ReadingPositionStore::new(path).get(&["a".into(), "b".into()]).unwrap();
        assert!(values.iter().all(Option::is_some));
    }

    #[test]
    fn keys_share_projects_and_keep_local_files_separate() {
        let local = target_key(&ReadingTarget { checkout_id: None, resource: vec!["file".into(), "c:/a.md".into()] }, None);
        assert_eq!(local, r#"["local","file","c:/a.md"]"#);
        let unknown = target_key(
            &ReadingTarget { checkout_id: Some("checkout-a".into()), resource: vec!["file".into(), "a.md".into()] },
            None,
        );
        assert_eq!(unknown, r#"["checkout:checkout-a","file","a.md"]"#);
    }
}
