use std::sync::Arc;
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};

use crate::workspace_service::{ProjectRegistry, WorkspaceRef, WorkspaceRuntime};

pub const WORKSPACE_WINDOW_LABEL_PREFIX: &str = "workspace-app-";

pub fn is_workspace_window(label: &str) -> bool {
    label.starts_with(WORKSPACE_WINDOW_LABEL_PREFIX)
}

pub fn has_other_application_windows(app: &AppHandle, current_label: &str) -> bool {
    app.webview_windows().iter().any(|(label, window)| {
        label != current_label
            && (is_workspace_window(label)
                || (label == "main" && window.is_visible().unwrap_or(true)))
    })
}

#[tauri::command]
pub async fn open_workspace_window(
    app_handle: AppHandle,
    registry: State<'_, Arc<ProjectRegistry>>,
    workspace_ref: WorkspaceRef,
    background_color: Option<tauri::webview::Color>,
) -> Result<String, String> {
    let scope = registry
        .resolve_workspace_ref(&workspace_ref)
        .map_err(|error| error.to_string())?;
    let runtime = scope.runtime();
    let label = format!("{WORKSPACE_WINDOW_LABEL_PREFIX}{}", uuid::Uuid::new_v4());
    app_handle
        .state::<Arc<crate::work_state::WorkStateStore>>()
        .register(&label, &label)?;
    if let Err(error) = build_workspace_window(&app_handle, &label, Some(runtime.as_ref())) {
        let _ = app_handle
            .state::<Arc<crate::work_state::WorkStateStore>>()
            .forget(&label);
        return Err(error);
    }
    if let (Some(color), Some(window)) = (background_color, app_handle.get_webview_window(&label)) {
        let _ = window.set_background_color(Some(color));
    }
    Ok(label)
}

pub fn build_workspace_window(
    app_handle: &AppHandle,
    label: &str,
    runtime: Option<&WorkspaceRuntime>,
) -> Result<(), String> {
    let mut url = tauri::Url::parse("http://localhost/").map_err(|error| error.to_string())?;
    url.query_pairs_mut()
        .append_pair("workspaceWindow", "1")
        .append_pair("restore", "1");
    if let Some(runtime) = runtime {
        url.query_pairs_mut()
            .append_pair("checkoutId", runtime.checkout_id().as_str())
            .append_pair("workspaceGeneration", &runtime.generation().to_string())
            .append_pair(
                "materializationEpoch",
                &runtime.materialization_epoch().to_string(),
            );
    }
    // Reuse the main shell's dimensions and native frame, without parenting
    // this window to another workspace window.
    let mut config = app_handle
        .config()
        .app
        .windows
        .iter()
        .find(|config| config.label == "main")
        .cloned()
        .ok_or("Main window configuration is unavailable")?;
    config.label = label.to_string();
    config.url = WebviewUrl::App(format!("/?{}", url.query().unwrap_or_default()).into());
    config.visible = false;
    config.focus = false;
    config.title = runtime
        .map(|runtime| {
            format!(
                "Locus - {}",
                runtime
                    .root()
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
            )
        })
        .unwrap_or_else(|| "Locus".into());
    let popup_app = app_handle.clone();
    let popup_owner_label = label.to_string();
    let window = WebviewWindowBuilder::from_config(app_handle, &config)
        .map_err(|error| error.to_string())?
        .on_new_window(move |url, features| {
            crate::shared_workbench_window::handle_new_window(
                &popup_app,
                &popup_owner_label,
                url,
                features,
            )
        })
        .build()
        .map_err(|error| error.to_string())?;
    if let Some(record) = app_handle
        .state::<Arc<crate::work_state::WorkStateStore>>()
        .snapshot()
        .windows
        .get(label)
    {
        crate::work_state::apply_hidden_geometry(&window, record)?;
    }
    Ok(())
}

pub fn restore_workspace_windows(app: &AppHandle) {
    let state = app
        .state::<Arc<crate::work_state::WorkStateStore>>()
        .snapshot();
    let registry = app.state::<Arc<ProjectRegistry>>();
    let contexts = app.state::<Arc<crate::workspace_service::WindowContextRegistry>>();
    let contexts = contexts.snapshots().unwrap_or_default();
    for record in state
        .windows
        .values()
        .filter(|record| is_workspace_window(&record.label))
    {
        if app.get_webview_window(&record.label).is_some() {
            continue;
        }
        let checkout = record
            .frontend
            .get("activeWorkspaceId")
            .and_then(|value| value.as_str());
        let context = contexts
            .iter()
            .filter(|context| context.window_id == record.label)
            .filter(|context| checkout.is_none_or(|id| context.focused_checkout_id.as_str() == id))
            .max_by_key(|context| context.intent_epoch);
        let runtime = context.and_then(|context| registry.runtime(&context.focused_checkout_id));
        if let Err(error) = build_workspace_window(app, &record.label, runtime.as_deref()) {
            eprintln!("[WorkState] failed to rebuild {}: {error}", record.label);
        }
    }
}
