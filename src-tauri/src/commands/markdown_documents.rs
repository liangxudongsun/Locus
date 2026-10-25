use crate::{
    error::AppError,
    markdown_attachments as attachments,
    workspace_service::{ProjectRegistry, WorkspaceRef},
};
use base64::Engine;
use serde::Serialize;
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use tauri::{AppHandle, Manager, State};

fn error(value: impl ToString) -> AppError {
    AppError::new("markdown.document", value.to_string())
}

fn document_path(root: &Path, content_path: &str) -> Result<PathBuf, AppError> {
    if content_path.trim().is_empty() {
        return Err(error("A document path is required"));
    }
    let path = attachments::normalize(&root.join(content_path));
    let parent = dunce::canonicalize(
        path.parent()
            .ok_or_else(|| error("Invalid document path"))?,
    )
    .map_err(error)?;
    if !crate::knowledge_source_registry::path_is_within(&parent, root) {
        return Err(error("Document is outside the workspace"));
    }
    Ok(parent.join(
        path.file_name()
            .ok_or_else(|| error("Invalid document path"))?,
    ))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedMarkdownImage {
    path: String,
    relative_path: String,
}

#[tauri::command]
pub async fn markdown_relative_path(
    workspace_ref: WorkspaceRef,
    content_path: String,
    target_path: String,
    registry: State<'_, Arc<ProjectRegistry>>,
) -> Result<String, AppError> {
    let scope = super::knowledge::resolve_knowledge_workspace_scope(
        registry.inner().as_ref(),
        &workspace_ref,
    )?;
    let root = dunce::canonicalize(scope.runtime().root()).map_err(error)?;
    let document = document_path(&root, &content_path)?;
    Ok(attachments::relative_url(
        &document,
        &root.join(target_path),
    ))
}

#[tauri::command]
pub async fn markdown_import_image(
    workspace_ref: WorkspaceRef,
    content_path: String,
    name: String,
    data: Option<String>,
    source_path: Option<String>,
    registry: State<'_, Arc<ProjectRegistry>>,
) -> Result<ImportedMarkdownImage, AppError> {
    let scope = super::knowledge::resolve_knowledge_workspace_scope(
        registry.inner().as_ref(),
        &workspace_ref,
    )?;
    let root = dunce::canonicalize(scope.runtime().root()).map_err(error)?;
    let document = document_path(&root, &content_path)?;
    let bytes = if let Some(data) = data {
        if data.len() > 28 * 1024 * 1024 {
            return Err(error("Image exceeds 20 MiB"));
        }
        base64::engine::general_purpose::STANDARD
            .decode(data)
            .map_err(error)?
    } else if let Some(path) = source_path {
        if std::fs::metadata(&path).map_err(error)?.len() > 20 * 1024 * 1024 {
            return Err(error("Image exceeds 20 MiB"));
        }
        std::fs::read(path).map_err(error)?
    } else {
        return Err(error("Image data is required"));
    };
    if bytes.is_empty() || bytes.len() > 20 * 1024 * 1024 {
        return Err(error("Image exceeds 20 MiB or is empty"));
    }
    let extension = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "png"
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        "jpg"
    } else if bytes.starts_with(b"GIF8") {
        "gif"
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        "webp"
    } else if bytes.starts_with(b"BM") {
        "bmp"
    } else if name.to_lowercase().ends_with(".svg")
        && std::str::from_utf8(&bytes).is_ok_and(|s| s.contains("<svg"))
    {
        "svg"
    } else {
        return Err(error("Unsupported image format"));
    };
    let directory = root.join(attachments::IMAGE_DIRECTORY);
    // Reject symlinked attachment directories before creating or writing files.
    let mut ancestor = root.clone();
    for part in Path::new(attachments::IMAGE_DIRECTORY).components() {
        ancestor.push(part);
        if std::fs::symlink_metadata(&ancestor).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(error("Attachment directory must be inside the workspace"));
        }
    }
    std::fs::create_dir_all(&directory).map_err(error)?;
    let path = directory.join(format!("image-{}.{}", uuid::Uuid::new_v4(), extension));
    crate::config::atomic_write_config(&path, &bytes).map_err(error)?;
    Ok(ImportedMarkdownImage {
        path: path.to_string_lossy().replace('\\', "/"),
        relative_path: attachments::relative_url(&document, &path),
    })
}

#[tauri::command]
pub async fn markdown_rewrite_image_links(
    workspace_ref: WorkspaceRef,
    content_path: String,
    text: String,
    old_path: String,
    new_path: String,
    registry: State<'_, Arc<ProjectRegistry>>,
) -> Result<String, AppError> {
    let scope = super::knowledge::resolve_knowledge_workspace_scope(
        registry.inner().as_ref(),
        &workspace_ref,
    )?;
    let root = dunce::canonicalize(scope.runtime().root()).map_err(error)?;
    let document = document_path(&root, &content_path)?;
    Ok(attachments::rewrite_image_links(
        &text,
        &root,
        &document,
        Path::new(&old_path),
        Path::new(&new_path),
    ))
}

use crate::document_recovery::{
    DocumentRecoveryStore, RecoveryRead, RecoveryUpdate, RecoveryUpdateResult,
};

async fn with_recovery<T: Send + 'static>(
    store: Arc<DocumentRecoveryStore>,
    work: impl FnOnce(&DocumentRecoveryStore) -> Result<T, String> + Send + 'static,
) -> Result<T, AppError> {
    tauri::async_runtime::spawn_blocking(move || work(&store))
        .await
        .map_err(error)?
        .map_err(error)
}

#[tauri::command]
pub async fn markdown_recovery_read(
    key: String,
    include_history: Option<bool>,
    store: State<'_, Arc<DocumentRecoveryStore>>,
) -> Result<RecoveryRead, AppError> {
    let include_history = include_history.unwrap_or(false);
    with_recovery(store.inner().clone(), move |store| {
        store.read(&key, include_history)
    })
    .await
}

#[tauri::command]
pub async fn markdown_recovery_update(
    request: RecoveryUpdate,
    store: State<'_, Arc<DocumentRecoveryStore>>,
) -> Result<RecoveryUpdateResult, AppError> {
    with_recovery(store.inner().clone(), move |store| store.update(request)).await
}

pub(crate) fn recovery_image_updates(
    app: &AppHandle,
    root: &Path,
    checkout: Option<&str>,
    old: &Path,
    new: &Path,
) -> Result<Vec<attachments::ReferenceUpdate>, AppError> {
    let Some(store) = app.try_state::<Arc<DocumentRecoveryStore>>() else {
        return Ok(Vec::new());
    };
    let rewrites = store
        .image_rewrites(checkout, |content_path, text| {
            let document = root.join(content_path);
            attachments::rewrite_image_links(text, root, &document, old, new)
        })
        .map_err(error)?;
    Ok(rewrites
        .into_iter()
        .map(|rewrite| attachments::ReferenceUpdate {
            path: rewrite.path,
            before: rewrite.before,
            after: rewrite.after,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn document_import_is_scoped_to_workspace() {
        let root = tempfile::tempdir().unwrap();
        let canonical = dunce::canonicalize(root.path()).unwrap();
        std::fs::create_dir(root.path().join("Docs")).unwrap();
        assert!(document_path(&canonical, "Docs/readme.md").is_ok());
        assert!(document_path(&canonical, "../outside.md").is_err());
    }
}
