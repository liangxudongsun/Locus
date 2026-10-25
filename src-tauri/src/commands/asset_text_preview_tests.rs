use super::*;

fn fallback(path: &Path) -> AssetPreviewPayload {
    build_binary_payload(
        path.file_name().unwrap().to_str().unwrap(),
        path,
        &BinaryCache::new(),
        &AssetDbState(Arc::new(Mutex::new(None))),
        None,
    )
}

#[test]
fn text_preview_fallback_handles_unknown_extensions_and_empty_files() {
    let root = tempfile::tempdir().unwrap();
    for name in [
        "事件大纲表.csv.view",
        "file.unrecognized",
        "README",
        "empty.custom",
    ] {
        let path = root.path().join(name);
        let content = if name.starts_with("empty") {
            ""
        } else {
            "事件,开始\n"
        };
        std::fs::write(&path, content).unwrap();
        let AssetPreviewPayload::Text(preview) = fallback(&path) else {
            panic!("expected text for {name}")
        };
        assert_eq!(preview.snippet, content);
        assert!(!preview.truncated);
        assert_eq!(preview.start_line, 1);
        assert!(preview.language.is_none());
    }
}

#[test]
fn text_preview_fallback_decodes_utf16_and_keeps_real_binary_as_metadata() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("file.custom");
    let mut bytes = vec![0xfe, 0xff];
    for unit in "事件\n".encode_utf16() {
        bytes.extend(unit.to_be_bytes());
    }
    std::fs::write(&path, bytes).unwrap();
    let AssetPreviewPayload::Text(preview) = fallback(&path) else {
        panic!("expected UTF-16 text")
    };
    assert_eq!(preview.snippet, "事件\n");
    for bytes in [
        b"hello\0world".as_slice(),
        b"\x01\x02binary",
        b"%PDF-1.4\nASCII header",
    ] {
        std::fs::write(&path, bytes).unwrap();
        assert!(matches!(
            fallback(&path),
            AssetPreviewPayload::BinaryInfo { .. }
        ));
    }
}

#[test]
fn text_preview_fallback_keeps_image_rendering_ahead_of_text_detection() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("image.custom");
    // The existing renderer identifies this by magic bytes, regardless of suffix.
    std::fs::write(&path, b"\x89PNG\r\n\x1a\n").unwrap();
    assert!(matches!(
        fallback(&path),
        AssetPreviewPayload::BinaryPreview { .. }
    ));
}

#[test]
fn text_preview_fallback_caps_reads_and_does_not_split_unicode_characters() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("large.custom");
    let prefix = "x".repeat(TEXT_SNIPPET_MAX_BYTES - 1);
    std::fs::write(&path, format!("{prefix}中{}", "x".repeat(2 * 1024 * 1024))).unwrap();
    let AssetPreviewPayload::Text(preview) = fallback(&path) else {
        panic!("expected text")
    };
    assert!(preview.truncated);
    assert!(preview.snippet.len() <= TEXT_SNIPPET_MAX_BYTES);
    assert_eq!(preview.snippet, format!("{prefix}\n"));
}

#[test]
fn text_preview_fallback_honors_line_budget_and_focus_within_the_read_prefix() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("lines.custom");
    let total = TEXT_SNIPPET_MAX_LINES + 5000;
    let text = (1..=total).map(|line| format!("{line}\n")).collect::<String>();
    std::fs::write(&path, text).unwrap();

    let whole = try_read_detected_text_snippet(&path, Some(250)).unwrap();
    assert_eq!(whole.start_line, 1);
    assert_eq!(whole.snippet.lines().count(), TEXT_SNIPPET_MAX_LINES);
    assert!(whole.truncated);

    let focus = (TEXT_SNIPPET_MAX_LINES + 2000) as u32;
    let preview = try_read_detected_text_snippet(&path, Some(focus)).unwrap();
    assert_eq!(preview.start_line, focus - (TEXT_SNIPPET_MAX_LINES / 2) as u32);
    assert_eq!(preview.snippet.lines().count(), total - preview.start_line as usize + 1);
    assert!(preview.snippet.contains(&format!("\n{focus}\n")));
    assert!(preview.snippet.ends_with(&format!("\n{total}\n")));
    assert!(preview.truncated);
}
