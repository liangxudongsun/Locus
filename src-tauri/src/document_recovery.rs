//! Markdown draft recovery outside the workspace.
//!
//! Each document key owns a small record (`<hash>.json`) and an append-only
//! version log (`<hash>.history.jsonl`). The renderer sends single-span deltas
//! against the last acknowledged version, so a keystroke pause or a save writes
//! only the changed text. Saves within five minutes share one history slot;
//! checkpoints (the disk version seen on open, the text replaced by a restore)
//! always keep their own slot. Compaction is the only full rewrite.
use crate::append_log;
use crate::text_delta::{self, TextDelta};
use serde::{Deserialize, Deserializer, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const SNAPSHOT_LIMIT: usize = 20;
const MERGE_WINDOW_MS: i64 = 5 * 60 * 1000;
const COMPACT_LINES: usize = 60;
const MAX_TEXT_BYTES: usize = 2 * 1024 * 1024;
const RECORD_VERSION: u32 = 2;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentSnapshot {
    pub text: String,
    pub at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryRead {
    pub schema_version: u32,
    /// Hash of the latest history version; drafts are relative to it.
    pub head: Option<String>,
    pub draft: Option<DocumentSnapshot>,
    pub snapshots: Vec<DocumentSnapshot>,
}

/// A text version sent by the renderer: full text, or a delta against `base`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionChange {
    pub hash: String,
    #[serde(default)]
    pub base: Option<String>,
    #[serde(default)]
    pub delta: Option<TextDelta>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub checkpoint: bool,
}

fn double_option<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryUpdate {
    pub key: String,
    #[serde(default)]
    pub head: Option<VersionChange>,
    /// Absent keeps the draft, null clears it.
    #[serde(default, deserialize_with = "double_option")]
    pub draft: Option<Option<VersionChange>>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryUpdateResult {
    pub head: Option<String>,
    pub head_accepted: bool,
    pub draft_accepted: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredDraft {
    at: i64,
    hash: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    base: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    delta: Option<TextDelta>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    text: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    schema_version: u32,
    #[serde(default)]
    key: String,
    #[serde(default)]
    head: Option<String>,
    #[serde(default)]
    head_at: i64,
    #[serde(default)]
    slot_start: i64,
    #[serde(default)]
    slot_pinned: bool,
    #[serde(default)]
    history_lines: usize,
    #[serde(default)]
    draft: Option<StoredDraft>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HistoryLine {
    slot: i64,
    at: i64,
    #[serde(default)]
    pinned: bool,
    hash: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    base: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    delta: Option<TextDelta>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    text: Option<String>,
}

#[derive(Debug, Clone)]
struct Version {
    slot: i64,
    at: i64,
    pinned: bool,
    hash: String,
    text: String,
}

/// Version-1 layout, kept only for migration.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyRecord {
    schema_version: u32,
    #[serde(default)]
    key: String,
    #[serde(default)]
    base: String,
    #[serde(default)]
    draft: Option<DocumentSnapshot>,
    #[serde(default)]
    snapshots: Vec<DocumentSnapshot>,
}

pub struct ReferenceRewrite {
    pub path: PathBuf,
    pub before: String,
    pub after: String,
}

pub struct DocumentRecoveryStore {
    dir: PathBuf,
    legacy_dirs: Vec<PathBuf>,
    /// Serializes every record operation; `true` once legacy data is converted.
    migrated: Mutex<bool>,
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn check_size(text: &str) -> Result<(), String> {
    if text.len() > MAX_TEXT_BYTES {
        Err("Document recovery exceeds 2 MiB".into())
    } else {
        Ok(())
    }
}

fn file_stem(key: &str) -> String {
    blake3::hash(key.as_bytes()).to_hex().to_string()
}

fn read_record(path: &Path) -> Result<Option<Record>, String> {
    let raw = match std::fs::read(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let record: Record = serde_json::from_slice(&raw).map_err(|e| e.to_string())?;
    if record.schema_version != RECORD_VERSION {
        return Err("Unsupported document recovery version".into());
    }
    Ok(Some(record))
}

fn write_record(path: &Path, record: &Record) -> Result<(), String> {
    let bytes = serde_json::to_vec(record).map_err(|e| e.to_string())?;
    crate::config::atomic_write_config(path, &bytes)
}

/// Replays every log line. A delta may follow any earlier version (a retried
/// request can repeat one), so its base is looked up among all prior versions.
fn replay(lines: &[String]) -> Vec<Version> {
    let mut versions: Vec<Version> = Vec::new();
    for line in lines {
        let Ok(line) = serde_json::from_str::<HistoryLine>(line) else {
            continue;
        };
        let text = match (&line.text, &line.delta) {
            (Some(text), _) => text.clone(),
            (None, Some(delta)) => {
                let Some(base) = line.base.as_deref().and_then(|base| {
                    versions.iter().rev().find(|version| version.hash == base)
                }) else {
                    continue;
                };
                match text_delta::apply(&base.text, delta) {
                    Ok(text) => text,
                    Err(_) => continue,
                }
            }
            (None, None) => continue,
        };
        if text_delta::text_hash(&text) != line.hash {
            continue;
        }
        versions.push(Version {
            slot: line.slot,
            at: line.at,
            pinned: line.pinned,
            hash: line.hash,
            text,
        });
    }
    versions
}

/// Latest version of each slot, in slot order, limited to the newest slots.
fn collapse(versions: Vec<Version>) -> Vec<Version> {
    let mut slots: Vec<Version> = Vec::new();
    for version in versions {
        if let Some(existing) = slots.iter_mut().find(|item| item.slot == version.slot) {
            *existing = version;
        } else {
            slots.push(version);
        }
    }
    // Retries can append an older slot after a newer one; keep chronological order.
    slots.sort_by_key(|version| version.slot);
    let excess = slots.len().saturating_sub(SNAPSHOT_LIMIT);
    slots.drain(..excess);
    slots
}

/// First version as full text, each later one as a delta against its predecessor.
fn encode(versions: &[Version]) -> Vec<String> {
    let mut lines = Vec::with_capacity(versions.len());
    for (index, version) in versions.iter().enumerate() {
        let previous = index.checked_sub(1).map(|i| &versions[i]);
        let delta = previous.and_then(|previous| {
            text_delta::single_span(&previous.text, &version.text)
                .map(|delta| (previous.hash.clone(), delta))
        });
        let line = match delta {
            Some((base, delta)) if delta.insert.len() < version.text.len() => HistoryLine {
                slot: version.slot,
                at: version.at,
                pinned: version.pinned,
                hash: version.hash.clone(),
                base: Some(base),
                delta: Some(delta),
                text: None,
            },
            _ => HistoryLine {
                slot: version.slot,
                at: version.at,
                pinned: version.pinned,
                hash: version.hash.clone(),
                base: None,
                delta: None,
                text: Some(version.text.clone()),
            },
        };
        lines.push(serde_json::to_string(&line).unwrap_or_default());
    }
    lines.retain(|line| !line.is_empty());
    lines
}

fn draft_text(draft: &StoredDraft, versions: &[Version]) -> Option<String> {
    if let Some(text) = &draft.text {
        return Some(text.clone());
    }
    let base = versions
        .iter()
        .rev()
        .find(|version| Some(&version.hash) == draft.base.as_ref())?;
    let text = text_delta::apply(&base.text, draft.delta.as_ref()?).ok()?;
    (text_delta::text_hash(&text) == draft.hash).then_some(text)
}

impl DocumentRecoveryStore {
    pub fn new(dir: PathBuf, legacy_dirs: Vec<PathBuf>) -> Self {
        Self {
            dir,
            legacy_dirs,
            migrated: Mutex::new(false),
        }
    }

    fn record_path(&self, key: &str) -> PathBuf {
        self.dir.join(format!("{}.json", file_stem(key)))
    }

    fn history_path(&self, key: &str) -> PathBuf {
        self.dir.join(format!("{}.history.jsonl", file_stem(key)))
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, bool>, String> {
        let mut guard = self.migrated.lock().map_err(|e| e.to_string())?;
        if !*guard {
            if let Err(error) = self.migrate_legacy() {
                // Unconverted files stay in place and are retried on the next start.
                eprintln!("[DocumentRecovery] legacy migration incomplete: {error}");
            }
            *guard = true;
        }
        Ok(guard)
    }

    /// Converts legacy data once. Called from a startup thread as well.
    pub fn ensure_ready(&self) {
        if let Err(error) = self.lock() {
            eprintln!("[DocumentRecovery] unavailable: {error}");
        }
    }

    fn versions(&self, key: &str) -> Result<Vec<Version>, String> {
        let log = append_log::read_lines(&self.history_path(key)).map_err(|e| e.to_string())?;
        Ok(replay(&log.lines))
    }

    pub fn read(&self, key: &str, include_history: bool) -> Result<RecoveryRead, String> {
        let _guard = self.lock()?;
        let Some(record) = read_record(&self.record_path(key))? else {
            return Ok(RecoveryRead {
                schema_version: RECORD_VERSION,
                head: None,
                draft: None,
                snapshots: Vec::new(),
            });
        };
        let needs_versions =
            include_history || record.draft.as_ref().is_some_and(|draft| draft.text.is_none());
        let versions = if needs_versions { self.versions(key)? } else { Vec::new() };
        let draft = record.draft.as_ref().and_then(|draft| {
            let text = draft_text(draft, &versions);
            if text.is_none() {
                eprintln!("[DocumentRecovery] draft base is missing for {}", record.key);
            }
            text.map(|text| DocumentSnapshot { text, at: draft.at })
        });
        let snapshots = if include_history {
            collapse(versions)
                .into_iter()
                .map(|version| DocumentSnapshot {
                    text: version.text,
                    at: version.at,
                })
                .collect()
        } else {
            Vec::new()
        };
        Ok(RecoveryRead {
            schema_version: RECORD_VERSION,
            head: record.head,
            draft,
            snapshots,
        })
    }

    pub fn update(&self, request: RecoveryUpdate) -> Result<RecoveryUpdateResult, String> {
        let _guard = self.lock()?;
        let record_path = self.record_path(&request.key);
        let history_path = self.history_path(&request.key);
        let mut record = read_record(&record_path)?.unwrap_or_else(|| Record {
            schema_version: RECORD_VERSION,
            key: request.key.clone(),
            ..Record::default()
        });
        let before = serde_json::to_string(&record).map_err(|e| e.to_string())?;
        let now = now_ms();
        let mut head_accepted = true;
        let mut draft_accepted = true;

        if let Some(head) = &request.head {
            if record.head.as_ref() != Some(&head.hash) {
                let line = match (&head.text, &head.delta) {
                    (Some(text), _) => {
                        check_size(text)?;
                        if text_delta::text_hash(text) != head.hash {
                            return Err("Document recovery hash does not match its text".into());
                        }
                        Some((None, None, Some(text.clone())))
                    }
                    (None, Some(delta)) if head.base.is_some() && head.base == record.head => {
                        check_size(&delta.insert)?;
                        Some((head.base.clone(), Some(delta.clone()), None))
                    }
                    (None, Some(_)) => None,
                    (None, None) => return Err("A recovery version needs text or a delta".into()),
                };
                match line {
                    Some((base, delta, text)) => {
                        // A delta draft must not outlive the version it refers to.
                        if request.draft.is_none() {
                            if let Some(draft) = record.draft.as_mut().filter(|d| d.text.is_none()) {
                                if draft.hash == head.hash {
                                    record.draft = None;
                                } else {
                                    let versions = self.versions(&request.key)?;
                                    match draft_text(draft, &versions) {
                                        Some(text) => {
                                            draft.text = Some(text);
                                            draft.base = None;
                                            draft.delta = None;
                                        }
                                        None => record.draft = None,
                                    }
                                }
                            }
                        }
                        let merge = !head.checkpoint
                            && record.head.is_some()
                            && !record.slot_pinned
                            && now - record.slot_start < MERGE_WINDOW_MS;
                        // Slots are unique and increasing even within one millisecond.
                        let slot = if merge {
                            record.slot_start
                        } else {
                            now.max(record.slot_start + 1)
                        };
                        let entry = HistoryLine {
                            slot,
                            at: now,
                            pinned: head.checkpoint,
                            hash: head.hash.clone(),
                            base,
                            delta,
                            text,
                        };
                        let line = serde_json::to_string(&entry).map_err(|e| e.to_string())?;
                        append_log::append(&history_path, &[line], false)?;
                        record.head = Some(head.hash.clone());
                        record.head_at = now;
                        record.slot_start = slot;
                        record.slot_pinned = head.checkpoint;
                        record.history_lines += 1;
                        if record.draft.as_ref().is_some_and(|draft| draft.hash == head.hash) {
                            record.draft = None;
                        }
                    }
                    None => head_accepted = false,
                }
            }
        }

        if let Some(draft) = &request.draft {
            match draft {
                None => record.draft = None,
                Some(draft) if Some(&draft.hash) == record.head.as_ref() => record.draft = None,
                Some(draft) => match (&draft.text, &draft.delta) {
                    (Some(text), _) => {
                        check_size(text)?;
                        record.draft = Some(StoredDraft {
                            at: now,
                            hash: draft.hash.clone(),
                            base: None,
                            delta: None,
                            text: Some(text.clone()),
                        });
                    }
                    (None, Some(delta)) if draft.base.is_some() && draft.base == record.head => {
                        check_size(&delta.insert)?;
                        record.draft = Some(StoredDraft {
                            at: now,
                            hash: draft.hash.clone(),
                            base: draft.base.clone(),
                            delta: Some(delta.clone()),
                            text: None,
                        });
                    }
                    (None, Some(_)) => draft_accepted = false,
                    (None, None) => return Err("A recovery draft needs text or a delta".into()),
                },
            }
        }

        if record.history_lines > COMPACT_LINES {
            let versions = collapse(self.versions(&request.key)?);
            if versions.last().map(|v| &v.hash) == record.head.as_ref() {
                append_log::rewrite(&history_path, &encode(&versions))?;
                record.history_lines = versions.len();
            }
        }
        if serde_json::to_string(&record).map_err(|e| e.to_string())? != before {
            write_record(&record_path, &record)?;
        }
        Ok(RecoveryUpdateResult {
            head: record.head,
            head_accepted,
            draft_accepted,
        })
    }

    /// Rewrites image links in every recovery version of a checkout.
    pub fn image_rewrites(
        &self,
        checkout: Option<&str>,
        rewrite: impl Fn(&str, &str) -> String,
    ) -> Result<Vec<ReferenceRewrite>, String> {
        let _guard = self.lock()?;
        let mut updates = Vec::new();
        let Some(checkout) = checkout else {
            return Ok(updates);
        };
        let entries = match std::fs::read_dir(&self.dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(updates),
            Err(error) => return Err(error.to_string()),
        };
        for entry in entries {
            let path = entry.map_err(|e| e.to_string())?.path();
            let is_record = path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.ends_with(".json") && !name.ends_with(".history.json"));
            if !is_record {
                continue;
            }
            let record_before = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
            let Ok(mut record) = serde_json::from_str::<Record>(&record_before) else {
                continue;
            };
            let Ok(key) = serde_json::from_str::<Vec<serde_json::Value>>(&record.key) else {
                continue;
            };
            if key.first().and_then(|v| v.as_str()) != Some(checkout) {
                continue;
            }
            let Some(content_path) = key.get(2).and_then(|v| v.as_str()) else {
                continue;
            };
            let history_path = self.history_path(&record.key);
            let history_before = std::fs::read_to_string(&history_path).unwrap_or_default();
            let log = append_log::read_lines(&history_path).map_err(|e| e.to_string())?;
            let versions = replay(&log.lines);
            let draft = record.draft.as_ref().and_then(|d| draft_text(d, &versions));
            let mut changed = false;
            let rewritten: Vec<Version> = collapse(versions)
                .into_iter()
                .map(|version| {
                    let text = rewrite(content_path, &version.text);
                    changed |= text != version.text;
                    Version {
                        hash: text_delta::text_hash(&text),
                        text,
                        ..version
                    }
                })
                .collect();
            let draft = draft.map(|text| {
                let rewritten = rewrite(content_path, &text);
                changed |= rewritten != text;
                rewritten
            });
            if !changed {
                continue;
            }
            let history_after: String = encode(&rewritten)
                .into_iter()
                .map(|line| line + "\n")
                .collect();
            record.head = rewritten.last().map(|v| v.hash.clone());
            record.history_lines = rewritten.len();
            if let (Some(stored), Some(text)) = (record.draft.as_mut(), draft) {
                *stored = StoredDraft {
                    at: stored.at,
                    hash: text_delta::text_hash(&text),
                    base: None,
                    delta: None,
                    text: Some(text),
                };
            }
            let record_after = serde_json::to_string(&record).map_err(|e| e.to_string())?;
            if history_after != history_before {
                updates.push(ReferenceRewrite {
                    path: history_path,
                    before: history_before,
                    after: history_after,
                });
            }
            if record_after != record_before {
                updates.push(ReferenceRewrite {
                    path,
                    before: record_before,
                    after: record_after,
                });
            }
        }
        Ok(updates)
    }

    fn migrate_legacy(&self) -> Result<(), String> {
        let mut directories: Vec<PathBuf> = Vec::new();
        for directory in &self.legacy_dirs {
            if !directories.contains(directory) {
                directories.push(directory.clone());
            }
        }
        for directory in directories {
            let entries = match std::fs::read_dir(&directory) {
                Ok(entries) => entries,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error.to_string()),
            };
            let mut paths: Vec<PathBuf> = entries.filter_map(|e| e.ok().map(|e| e.path())).collect();
            paths.sort();
            for path in paths {
                let Some(name) = path.file_name().and_then(|n| n.to_str()).map(str::to_owned) else {
                    continue;
                };
                if !name.ends_with(".json") || name.ends_with(".history.json") {
                    continue;
                }
                if let Err(error) = self.migrate_record(&path) {
                    eprintln!("[DocumentRecovery] failed to migrate {}: {error}", path.display());
                }
            }
            if directory != self.dir {
                // Removes the directory only when every file was converted.
                let _ = std::fs::remove_dir(&directory);
            }
        }
        Ok(())
    }

    fn migrate_record(&self, path: &Path) -> Result<(), String> {
        let raw = std::fs::read(path).map_err(|e| e.to_string())?;
        let Ok(legacy) = serde_json::from_slice::<LegacyRecord>(&raw) else {
            return Ok(());
        };
        if legacy.schema_version != 1 {
            return Ok(());
        }
        let legacy_history = path.with_extension("history.json");
        let target = self.dir.join(path.file_name().ok_or("Invalid recovery path")?);
        let target_exists_as_v2 = target != path && read_record(&target).ok().flatten().is_some();
        if !target_exists_as_v2 {
            let mut snapshots = match std::fs::read(&legacy_history) {
                Ok(raw) => serde_json::from_slice::<LegacyRecord>(&raw)
                    .map(|history| history.snapshots)
                    .unwrap_or_default(),
                Err(_) => legacy.snapshots.clone(),
            };
            if !legacy.base.is_empty() && snapshots.last().is_none_or(|s| s.text != legacy.base) {
                let at = snapshots.last().map_or(now_ms(), |s| s.at + 1);
                snapshots.push(DocumentSnapshot {
                    text: legacy.base.clone(),
                    at,
                });
            }
            let mut versions: Vec<Version> = Vec::new();
            for snapshot in snapshots {
                let slot = versions.last().map_or(snapshot.at, |v| snapshot.at.max(v.slot + 1));
                versions.push(Version {
                    slot,
                    at: snapshot.at,
                    pinned: false,
                    hash: text_delta::text_hash(&snapshot.text),
                    text: snapshot.text,
                });
            }
            let excess = versions.len().saturating_sub(SNAPSHOT_LIMIT);
            versions.drain(..excess);
            let history_path = target.with_extension("history.jsonl");
            if !versions.is_empty() {
                append_log::rewrite(&history_path, &encode(&versions))?;
            }
            let record = Record {
                schema_version: RECORD_VERSION,
                key: legacy.key.clone(),
                head: versions.last().map(|v| v.hash.clone()),
                head_at: versions.last().map_or(0, |v| v.at),
                slot_start: versions.last().map_or(0, |v| v.slot),
                // The next save opens a new slot instead of replacing a migrated version.
                slot_pinned: true,
                history_lines: versions.len(),
                draft: legacy.draft.map(|draft| StoredDraft {
                    at: draft.at,
                    hash: text_delta::text_hash(&draft.text),
                    base: None,
                    delta: None,
                    text: Some(draft.text),
                }),
            };
            write_record(&target, &record)?;
        }
        if target != path {
            std::fs::remove_file(path).map_err(|e| e.to_string())?;
        }
        match std::fs::remove_file(&legacy_history) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::text_delta::{single_span, text_hash};

    fn store(dir: &Path) -> DocumentRecoveryStore {
        DocumentRecoveryStore::new(dir.join("new"), vec![dir.join("old")])
    }

    fn full(text: &str, checkpoint: bool) -> VersionChange {
        VersionChange {
            hash: text_hash(text),
            base: None,
            delta: None,
            text: Some(text.into()),
            checkpoint,
        }
    }

    fn delta(base: &str, next: &str) -> VersionChange {
        VersionChange {
            hash: text_hash(next),
            base: Some(text_hash(base)),
            delta: single_span(base, next),
            text: None,
            checkpoint: false,
        }
    }

    fn update(
        store: &DocumentRecoveryStore,
        head: Option<VersionChange>,
        draft: Option<Option<VersionChange>>,
    ) -> RecoveryUpdateResult {
        store
            .update(RecoveryUpdate {
                key: "[\"checkout\",0,\"Docs/a.md\",\"body\"]".into(),
                head,
                draft,
            })
            .unwrap()
    }

    const KEY: &str = "[\"checkout\",0,\"Docs/a.md\",\"body\"]";

    #[test]
    fn drafts_and_saves_are_written_as_deltas() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        let base = "# Title\n".repeat(2000);
        update(&store, Some(full(&base, true)), Some(None));
        let history = store.history_path(KEY);
        let record = store.record_path(KEY);
        let after_open = std::fs::metadata(&history).unwrap().len();

        let typed = format!("{base}more");
        let result = update(&store, None, Some(Some(delta(&base, &typed))));
        assert!(result.draft_accepted);
        assert!(std::fs::metadata(&record).unwrap().len() < 400);
        assert_eq!(store.read(KEY, false).unwrap().draft.unwrap().text, typed);

        let result = update(&store, Some(delta(&base, &typed)), Some(None));
        assert!(result.head_accepted);
        assert!(std::fs::metadata(&history).unwrap().len() - after_open < 400);
        let read = store.read(KEY, true).unwrap();
        assert!(read.draft.is_none());
        assert_eq!(read.head, Some(text_hash(&typed)));
        assert_eq!(read.snapshots.len(), 2);
        assert_eq!(read.snapshots[1].text, typed);
    }

    #[test]
    fn saves_within_five_minutes_share_a_slot_but_checkpoints_do_not() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        update(&store, Some(full("v0", true)), Some(None));
        update(&store, Some(delta("v0", "v1")), Some(None));
        update(&store, Some(delta("v1", "v2")), Some(None));
        let read = store.read(KEY, true).unwrap();
        let texts: Vec<_> = read.snapshots.iter().map(|s| s.text.as_str()).collect();
        assert_eq!(texts, vec!["v0", "v2"]);
        update(&store, Some(full("restored-from", true)), Some(None));
        update(&store, Some(delta("restored-from", "v3")), Some(None));
        let texts: Vec<_> = store
            .read(KEY, true)
            .unwrap()
            .snapshots
            .into_iter()
            .map(|s| s.text)
            .collect();
        assert_eq!(texts, vec!["v0", "v2", "restored-from", "v3"]);
    }

    #[test]
    fn stale_deltas_are_rejected_and_unchanged_heads_do_not_append() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        update(&store, Some(full("disk", true)), Some(None));
        let size = std::fs::metadata(store.history_path(KEY)).unwrap().len();
        let unchanged = update(&store, Some(full("disk", true)), Some(None));
        assert!(unchanged.head_accepted);
        assert_eq!(std::fs::metadata(store.history_path(KEY)).unwrap().len(), size);
        let stale = update(&store, Some(delta("other", "next")), Some(Some(delta("other", "x"))));
        assert!(!stale.head_accepted);
        assert!(!stale.draft_accepted);
        assert_eq!(stale.head, Some(text_hash("disk")));
    }

    #[test]
    fn a_head_without_draft_converts_the_old_delta_draft_to_text() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        update(&store, Some(full("base", true)), None);
        update(&store, None, Some(Some(delta("base", "base and draft"))));
        update(&store, Some(full("external", false)), None);
        let read = store.read(KEY, false).unwrap();
        assert_eq!(read.draft.unwrap().text, "base and draft");
    }

    #[test]
    fn compaction_keeps_the_latest_slots_and_the_head() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        let mut previous = String::from("start");
        update(&store, Some(full(&previous, true)), Some(None));
        for i in 0..(COMPACT_LINES + 5) {
            let next = format!("{previous}{i}");
            update(&store, Some(VersionChange { checkpoint: true, ..delta(&previous, &next) }), Some(None));
            previous = next;
        }
        let lines = append_log::read_lines(&store.history_path(KEY)).unwrap().lines;
        assert!(lines.len() <= SNAPSHOT_LIMIT + 5);
        let read = store.read(KEY, true).unwrap();
        assert_eq!(read.snapshots.len(), SNAPSHOT_LIMIT);
        assert_eq!(read.snapshots.last().unwrap().text, previous);
        assert_eq!(read.head, Some(text_hash(&previous)));
    }

    #[test]
    fn torn_history_tail_is_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        update(&store, Some(full("one", true)), Some(None));
        update(&store, Some(delta("one", "two")), Some(Some(delta("two", "two!"))));
        use std::io::Write;
        std::fs::OpenOptions::new()
            .append(true)
            .open(store.history_path(KEY))
            .unwrap()
            .write_all(b"{\"slot\":1,\"at\":")
            .unwrap();
        let read = store.read(KEY, true).unwrap();
        assert_eq!(read.draft.unwrap().text, "two!");
        assert_eq!(read.snapshots.last().unwrap().text, "two");
    }

    #[test]
    fn legacy_records_migrate_to_the_storage_directory() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("old");
        std::fs::create_dir_all(&old).unwrap();
        let stem = file_stem(KEY);
        std::fs::write(
            old.join(format!("{stem}.json")),
            serde_json::json!({"schemaVersion":1,"key":KEY,"base":"saved v2",
                "draft":{"text":"unsaved","at":30},"snapshots":[]})
            .to_string(),
        )
        .unwrap();
        std::fs::write(
            old.join(format!("{stem}.history.json")),
            serde_json::json!({"schemaVersion":1,"key":KEY,"base":"","draft":null,
                "snapshots":[{"text":"saved v1","at":10},{"text":"saved v2","at":20}]})
            .to_string(),
        )
        .unwrap();
        let store = store(dir.path());
        store.ensure_ready();
        assert!(!old.exists());
        let read = store.read(KEY, true).unwrap();
        assert_eq!(read.draft.unwrap().text, "unsaved");
        let texts: Vec<_> = read.snapshots.iter().map(|s| s.text.as_str()).collect();
        assert_eq!(texts, vec!["saved v1", "saved v2"]);
        assert_eq!(read.head, Some(text_hash("saved v2")));
        // The migrated head accepts deltas immediately.
        let next = update(&store, Some(delta("saved v2", "saved v3")), Some(None));
        assert!(next.head_accepted);
    }

    #[test]
    fn image_rewrites_cover_history_and_drafts() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        update(&store, Some(full("![a](img/a.png)", true)), None);
        update(&store, None, Some(Some(delta("![a](img/a.png)", "![a](img/a.png) draft"))));
        let updates = store
            .image_rewrites(Some("checkout"), |_, text| text.replace("img/a.png", "img/b.png"))
            .unwrap();
        assert_eq!(updates.len(), 2);
        for update in &updates {
            std::fs::write(&update.path, &update.after).unwrap();
        }
        let read = store.read(KEY, true).unwrap();
        assert_eq!(read.draft.unwrap().text, "![a](img/b.png) draft");
        assert_eq!(read.snapshots[0].text, "![a](img/b.png)");
        assert!(store.image_rewrites(Some("other"), |_, t| t.into()).unwrap().is_empty());
    }
}
