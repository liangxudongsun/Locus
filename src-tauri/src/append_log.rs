//! Line-oriented append logs for small, frequently updated state files.
//! Appends write only the changed records; compaction is the only full write.
use std::io::Write;
use std::path::Path;

pub struct LogLines {
    pub lines: Vec<String>,
    /// False when the file ended in a partial line or held invalid UTF-8,
    /// so the next append would extend a damaged record. Callers compact first.
    pub clean: bool,
}

pub fn read_lines(path: &Path) -> std::io::Result<LogLines> {
    let raw = match std::fs::read(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(LogLines { lines: Vec::new(), clean: true })
        }
        Err(error) => return Err(error),
    };
    let mut clean = true;
    let mut lines = Vec::new();
    let mut segments = raw.split(|byte| *byte == b'\n').peekable();
    while let Some(segment) = segments.next() {
        let last = segments.peek().is_none();
        if last {
            // A complete file ends with '\n', which leaves one empty segment.
            if !segment.is_empty() {
                clean = false;
            }
            break;
        }
        let segment = segment.strip_suffix(b"\r").unwrap_or(segment);
        if segment.is_empty() {
            continue;
        }
        match std::str::from_utf8(segment) {
            Ok(line) => lines.push(line.to_string()),
            Err(_) => clean = false,
        }
    }
    Ok(LogLines { lines, clean })
}

/// Appends complete lines in one write. `sync` forces them to disk.
pub fn append(path: &Path, lines: &[String], sync: bool) -> Result<u64, String> {
    if lines.is_empty() {
        return Ok(0);
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let mut buffer = String::with_capacity(lines.iter().map(|line| line.len() + 1).sum());
    for line in lines {
        debug_assert!(!line.contains('\n'));
        buffer.push_str(line);
        buffer.push('\n');
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| format!("failed to open '{}': {error}", path.display()))?;
    file.write_all(buffer.as_bytes())
        .and_then(|_| if sync { file.sync_all() } else { Ok(()) })
        .map_err(|error| format!("failed to append '{}': {error}", path.display()))?;
    Ok(buffer.len() as u64)
}

/// Replaces the whole log atomically (compaction).
pub fn rewrite(path: &Path, lines: &[String]) -> Result<u64, String> {
    let mut buffer = String::with_capacity(lines.iter().map(|line| line.len() + 1).sum());
    for line in lines {
        buffer.push_str(line);
        buffer.push('\n');
    }
    crate::config::atomic_write_config(path, buffer.as_bytes())?;
    Ok(buffer.len() as u64)
}

pub fn sync(path: &Path) -> Result<(), String> {
    match std::fs::OpenOptions::new().append(true).open(path) {
        Ok(file) => file.sync_all().map_err(|error| error.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appends_and_detects_a_torn_tail() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("log.jsonl");
        assert!(read_lines(&path).unwrap().lines.is_empty());
        append(&path, &["{\"a\":1}".into(), "{\"a\":2}".into()], false).unwrap();
        append(&path, &["{\"a\":3}".into()], true).unwrap();
        let read = read_lines(&path).unwrap();
        assert_eq!(read.lines.len(), 3);
        assert!(read.clean);
        std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b"{\"a\":")
            .unwrap();
        let torn = read_lines(&path).unwrap();
        assert_eq!(torn.lines.len(), 3);
        assert!(!torn.clean);
        rewrite(&path, &torn.lines).unwrap();
        assert!(read_lines(&path).unwrap().clean);
    }
}
