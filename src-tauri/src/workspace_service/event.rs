use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock, Weak};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc;

use super::identity::{CheckoutId, ProjectId, ServiceInstanceId};
use super::runtime::ProjectRegistry;
use super::service::ServiceRuntimeIdentity;

mod window_interest;
pub use window_interest::{
    is_high_frequency_stream_type, WindowEventInterestRegistry, WindowEventInterests,
};

/// Global listeners in Tauri also receive `emit_to`. A separate event name is
/// required to avoid delivering/parsing high-frequency payloads in other realms.
pub fn window_event_name(event: &str, window: &str) -> String {
    format!("{event}/{window}")
}

pub fn emit_to_interested_windows(
    app: &AppHandle,
    event: &str,
    payload: &impl Serialize,
    windows: Vec<String>,
) -> Result<(), String> {
    if windows.is_empty() {
        return Ok(());
    }
    // Serialize once even when a session is open in several independent Apps.
    let payload = serde_json::to_string(payload).map_err(|error| error.to_string())?;
    let mut result = Ok(());
    for window in windows {
        if let Err(error) = app.emit_str_to(
            window.as_str(),
            &window_event_name(event, &window),
            payload.clone(),
        ) {
            result = Err(error.to_string());
        }
    }
    result
}

#[tauri::command]
pub fn set_workspace_event_interests(
    window: tauri::WebviewWindow,
    registry: tauri::State<'_, Arc<ProjectRegistry>>,
    interests: WindowEventInterests,
) -> Result<(), String> {
    if interests.checkouts.len() + interests.sessions.len() + interests.stream_checkouts.len()
        > 4096
    {
        return Err("Too many workspace event interests".into());
    }
    let router = registry.event_router();
    router.window_interests.replace(window.label(), interests);
    if window
        .app_handle()
        .get_webview_window(window.label())
        .is_none()
    {
        router.window_interests.remove(window.label());
    }
    Ok(())
}

/// Stable process-level event carrying every current workspace event together
/// with its complete routing scope.
pub const WORKSPACE_EVENT_NAME: &str = "locus://workspace-event";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEventEnvelope<T> {
    pub project_id: ProjectId,
    pub checkout_id: CheckoutId,
    pub workspace_generation: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub materialization_epoch: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service_instance_id: Option<ServiceInstanceId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service_generation: Option<u64>,
    pub payload: T,
}

#[derive(Debug, Clone)]
pub struct WorkspaceEventScope {
    pub project_id: ProjectId,
    pub checkout_id: CheckoutId,
    pub workspace_generation: u64,
    pub materialization_epoch: Option<u64>,
    pub service_instance_id: Option<ServiceInstanceId>,
    pub service_generation: Option<u64>,
}

impl WorkspaceEventScope {
    pub fn for_runtime(runtime: &super::runtime::WorkspaceRuntime) -> Self {
        Self {
            project_id: runtime.project_id().clone(),
            checkout_id: runtime.checkout_id().clone(),
            workspace_generation: runtime.generation(),
            materialization_epoch: Some(runtime.materialization_epoch()),
            service_instance_id: None,
            service_generation: None,
        }
    }

    pub fn for_service(
        runtime: &super::runtime::WorkspaceRuntime,
        service: &ServiceRuntimeIdentity,
    ) -> Self {
        Self {
            project_id: runtime.project_id().clone(),
            checkout_id: runtime.checkout_id().clone(),
            workspace_generation: runtime.generation(),
            materialization_epoch: Some(runtime.materialization_epoch()),
            service_instance_id: Some(service.service_instance_id.clone()),
            service_generation: Some(service.runtime_generation),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutedWorkspaceEvent {
    pub event_name: String,
    pub stream_revision: u64,
    #[serde(flatten)]
    pub envelope: WorkspaceEventEnvelope<serde_json::Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspaceEventPublishOutcome {
    /// The scoped event was published to the process-level frontend stream and
    /// internal subscribers with its complete workspace envelope.
    PublishedScoped,
    /// The workspace or service identity no longer represents the current
    /// runtime and the event was rejected before publication.
    DroppedStale,
    /// The payload could not be represented as JSON and publication was
    /// rejected.
    DroppedSerialization,
}

pub struct WorkspaceEventRouter {
    registry: RwLock<Weak<ProjectRegistry>>,
    subscribers: std::sync::Mutex<Vec<mpsc::UnboundedSender<RoutedWorkspaceEvent>>>,
    stream_revision: AtomicU64,
    publish_gate: std::sync::Mutex<()>,
    pub window_interests: WindowEventInterestRegistry,
}

impl WorkspaceEventRouter {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            registry: RwLock::new(Weak::new()),
            subscribers: std::sync::Mutex::new(Vec::new()),
            stream_revision: AtomicU64::new(0),
            publish_gate: std::sync::Mutex::new(()),
            window_interests: WindowEventInterestRegistry::default(),
        })
    }

    pub(crate) fn attach_registry(&self, registry: &Arc<ProjectRegistry>) {
        if let Ok(mut current) = self.registry.write() {
            *current = Arc::downgrade(registry);
        }
    }

    pub fn subscribe(&self) -> mpsc::UnboundedReceiver<RoutedWorkspaceEvent> {
        let (sender, receiver) = mpsc::unbounded_channel();
        if let Ok(mut subscribers) = self.subscribers.lock() {
            subscribers.push(sender);
        }
        receiver
    }

    pub fn publish<T: Serialize + Clone>(
        &self,
        app_handle: &AppHandle,
        event_name: impl Into<String>,
        envelope: WorkspaceEventEnvelope<T>,
    ) -> WorkspaceEventPublishOutcome {
        self.publish_applied(app_handle, event_name, envelope, || {})
    }

    /// Publish a scoped event and run `apply` inside the publication critical
    /// section, after the event's revision is allocated and before any
    /// delivery. State changed this way is cut consistently by
    /// [`Self::read_at_revision`]: it reflects every applied event at or below
    /// the returned revision and none above it, so a client can combine such a
    /// snapshot with the buffered events above it without gaps or duplicates.
    ///
    /// `apply` runs exactly when the outcome is `PublishedScoped`; callers must
    /// apply a dropped event themselves if its state still matters.
    pub fn publish_applied<T: Serialize + Clone>(
        &self,
        app_handle: &AppHandle,
        event_name: impl Into<String>,
        envelope: WorkspaceEventEnvelope<T>,
        apply: impl FnOnce(),
    ) -> WorkspaceEventPublishOutcome {
        let Some(registry) = self
            .registry
            .read()
            .ok()
            .and_then(|registry| registry.upgrade())
        else {
            return WorkspaceEventPublishOutcome::DroppedStale;
        };
        let Some(runtime) = registry.runtime(&envelope.checkout_id) else {
            return WorkspaceEventPublishOutcome::DroppedStale;
        };
        if !Self::scope_is_current(&runtime, &envelope) {
            tracing::debug!(
                log_module = "WorkspaceEventRouter",
                "dropping stale workspace/service event checkout={} generation={}",
                envelope.checkout_id,
                envelope.workspace_generation
            );
            return WorkspaceEventPublishOutcome::DroppedStale;
        }

        self.publish_current(app_handle, event_name.into(), envelope, apply)
    }

    /// Run `read` inside the publication critical section and return the last
    /// allocated stream revision with its result. See [`Self::publish_applied`].
    pub fn read_at_revision<R>(&self, read: impl FnOnce() -> R) -> (R, u64) {
        let _publication = self
            .publish_gate
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let revision = self.stream_revision.load(Ordering::Relaxed);
        (read(), revision)
    }

    /// Publish a non-`WorkspaceServiceHost` service event after its owning
    /// pool has validated the service generation. The router still enforces
    /// project/checkout/workspace generation and a complete service identity.
    pub(crate) fn publish_prevalidated_external_service<T: Serialize + Clone>(
        &self,
        app_handle: &AppHandle,
        event_name: impl Into<String>,
        envelope: WorkspaceEventEnvelope<T>,
    ) -> WorkspaceEventPublishOutcome {
        if envelope.service_instance_id.is_none() || envelope.service_generation.is_none() {
            return WorkspaceEventPublishOutcome::DroppedStale;
        }
        let Some(registry) = self
            .registry
            .read()
            .ok()
            .and_then(|registry| registry.upgrade())
        else {
            return WorkspaceEventPublishOutcome::DroppedStale;
        };
        let Some(runtime) = registry.runtime(&envelope.checkout_id) else {
            return WorkspaceEventPublishOutcome::DroppedStale;
        };
        if !Self::workspace_scope_is_current(&runtime, &envelope) {
            return WorkspaceEventPublishOutcome::DroppedStale;
        }
        self.publish_current(app_handle, event_name.into(), envelope, || {})
    }

    fn publish_current<T: Serialize + Clone>(
        &self,
        app_handle: &AppHandle,
        event_name: String,
        envelope: WorkspaceEventEnvelope<T>,
        apply: impl FnOnce(),
    ) -> WorkspaceEventPublishOutcome {
        // Serialize outside the publication critical section. Revision
        // allocation, WebView emission, and internal subscriber delivery are
        // linearized below so concurrent publishers cannot expose N+1 before
        // N on either stream.
        let routed = match Self::route_event(&event_name, 0, &envelope) {
            Ok(routed) => routed,
            Err(error) => {
                tracing::debug!(
                    log_module = "WorkspaceEventRouter",
                    "failed to serialize scoped workspace event: {}",
                    error
                );
                return WorkspaceEventPublishOutcome::DroppedSerialization;
            }
        };
        self.publish_routed_with(routed, apply, |routed| {
            match self.window_interests.targets(routed) {
                None => app_handle
                    .emit(WORKSPACE_EVENT_NAME, routed)
                    .map_err(|error| error.to_string()),
                Some(windows) => {
                    emit_to_interested_windows(app_handle, WORKSPACE_EVENT_NAME, routed, windows)
                }
            }
        })
    }

    fn publish_routed_with<A, F>(
        &self,
        mut routed: RoutedWorkspaceEvent,
        apply: A,
        emit: F,
    ) -> WorkspaceEventPublishOutcome
    where
        A: FnOnce(),
        F: FnOnce(&RoutedWorkspaceEvent) -> Result<(), String>,
    {
        let _publication = self
            .publish_gate
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let stream_revision = self.next_stream_revision();
        routed.stream_revision = stream_revision;
        apply();

        if let Err(error) = emit(&routed) {
            tracing::warn!(
                log_module = "WorkspaceEventRouter",
                event_name = WORKSPACE_EVENT_NAME,
                stream_revision,
                "failed to emit process-scoped workspace event: {}",
                error
            );
        }
        if let Ok(mut subscribers) = self.subscribers.lock() {
            subscribers.retain(|subscriber| subscriber.send(routed.clone()).is_ok());
        }

        WorkspaceEventPublishOutcome::PublishedScoped
    }

    fn next_stream_revision(&self) -> u64 {
        self.stream_revision.fetch_add(1, Ordering::Relaxed) + 1
    }

    fn route_event<T: Serialize>(
        event_name: &str,
        stream_revision: u64,
        envelope: &WorkspaceEventEnvelope<T>,
    ) -> Result<RoutedWorkspaceEvent, serde_json::Error> {
        Ok(RoutedWorkspaceEvent {
            event_name: event_name.to_owned(),
            stream_revision,
            envelope: WorkspaceEventEnvelope {
                project_id: envelope.project_id.clone(),
                checkout_id: envelope.checkout_id.clone(),
                workspace_generation: envelope.workspace_generation,
                materialization_epoch: envelope.materialization_epoch,
                service_instance_id: envelope.service_instance_id.clone(),
                service_generation: envelope.service_generation,
                payload: serde_json::to_value(&envelope.payload)?,
            },
        })
    }

    fn scope_is_current<T>(
        runtime: &super::runtime::WorkspaceRuntime,
        envelope: &WorkspaceEventEnvelope<T>,
    ) -> bool {
        if !Self::workspace_scope_is_current(runtime, envelope) {
            return false;
        }
        match (
            envelope.service_instance_id.as_ref(),
            envelope.service_generation,
        ) {
            (Some(service_instance_id), Some(service_generation)) => {
                let identity = ServiceRuntimeIdentity {
                    project_id: envelope.project_id.clone(),
                    checkout_id: envelope.checkout_id.clone(),
                    service_instance_id: service_instance_id.clone(),
                    runtime_generation: service_generation,
                };
                if !runtime.services().is_current_identity(&identity) {
                    return false;
                }
            }
            (None, None) => {}
            _ => {
                return false;
            }
        }
        true
    }

    fn workspace_scope_is_current<T>(
        runtime: &super::runtime::WorkspaceRuntime,
        envelope: &WorkspaceEventEnvelope<T>,
    ) -> bool {
        if runtime.generation() != envelope.workspace_generation
            || super::scope::WorkspaceRef::new(envelope.checkout_id.clone(), None)
                .with_materialization_epoch(envelope.materialization_epoch)
                .validate_materialization_epoch(runtime.materialization_epoch())
                .is_err()
            || runtime.project_id() != &envelope.project_id
            || runtime.checkout_id() != &envelope.checkout_id
        {
            return false;
        }
        true
    }

    pub fn publish_for_scope<T: Serialize + Clone>(
        &self,
        app_handle: &AppHandle,
        scope: &WorkspaceEventScope,
        event_name: impl Into<String>,
        payload: T,
    ) -> WorkspaceEventPublishOutcome {
        self.publish(
            app_handle,
            event_name,
            WorkspaceEventEnvelope {
                project_id: scope.project_id.clone(),
                checkout_id: scope.checkout_id.clone(),
                workspace_generation: scope.workspace_generation,
                materialization_epoch: scope.materialization_epoch,
                service_instance_id: scope.service_instance_id.clone(),
                service_generation: scope.service_generation,
                payload,
            },
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registry() -> (Arc<ProjectRegistry>, tempfile::TempDir) {
        let dir = tempfile::tempdir().expect("workspace");
        let config = Arc::new(crate::config::AppConfig::load_from_path(
            &dir.path().join("config.json"),
        ));
        let policy = Arc::new(
            crate::resource_policy::ResourcePolicyStore::from_config(config).expect("policy"),
        );
        (ProjectRegistry::new(policy, Vec::new()), dir)
    }

    #[test]
    fn current_workspace_scope_is_accepted_and_old_generation_is_rejected() {
        let (registry, dir) = registry();
        let runtime = registry.register(dir.path()).expect("runtime");
        let envelope = WorkspaceEventEnvelope {
            project_id: runtime.project_id().clone(),
            checkout_id: runtime.checkout_id().clone(),
            workspace_generation: runtime.generation(),
            materialization_epoch: Some(runtime.materialization_epoch()),
            service_instance_id: None,
            service_generation: None,
            payload: true,
        };
        assert!(WorkspaceEventRouter::scope_is_current(&runtime, &envelope));
        let mut previous_assignment = envelope.clone();
        previous_assignment.materialization_epoch = Some(runtime.materialization_epoch() + 1);
        assert!(!WorkspaceEventRouter::scope_is_current(
            &runtime,
            &previous_assignment
        ));
        let mut stale = envelope.clone();
        stale.workspace_generation = envelope.workspace_generation.saturating_sub(1);
        assert_ne!(stale.workspace_generation, envelope.workspace_generation);
        assert!(!WorkspaceEventRouter::scope_is_current(&runtime, &stale));

        let mut wrong_project = envelope.clone();
        wrong_project.project_id = ProjectId::new("different-project").expect("project id");
        assert!(!WorkspaceEventRouter::scope_is_current(
            &runtime,
            &wrong_project
        ));

        let mut wrong_checkout = envelope;
        wrong_checkout.checkout_id = CheckoutId::new("different-checkout").expect("checkout id");
        assert!(!WorkspaceEventRouter::scope_is_current(
            &runtime,
            &wrong_checkout
        ));
    }

    #[test]
    fn routed_event_preserves_complete_scope_and_stable_shape() {
        let (registry, dir) = registry();
        let runtime = registry.register(dir.path()).expect("runtime");
        let envelope = WorkspaceEventEnvelope {
            project_id: runtime.project_id().clone(),
            checkout_id: runtime.checkout_id().clone(),
            workspace_generation: runtime.generation(),
            materialization_epoch: Some(runtime.materialization_epoch()),
            service_instance_id: Some(ServiceInstanceId::for_service(
                runtime.checkout_id(),
                "unity",
            )),
            service_generation: Some(7),
            payload: serde_json::json!({ "status": "ready" }),
        };

        let routed =
            WorkspaceEventRouter::route_event("unity-status", 41, &envelope).expect("routed event");
        assert_eq!(routed.event_name, "unity-status");
        assert_eq!(routed.stream_revision, 41);
        assert_eq!(routed.envelope.project_id, envelope.project_id);
        assert_eq!(routed.envelope.checkout_id, envelope.checkout_id);
        assert_eq!(
            routed.envelope.workspace_generation,
            envelope.workspace_generation
        );
        assert_eq!(
            routed.envelope.service_instance_id,
            envelope.service_instance_id
        );
        assert_eq!(routed.envelope.service_generation, Some(7));
        assert_eq!(routed.envelope.payload, envelope.payload);

        let serialized = serde_json::to_value(routed).expect("serialized event");
        assert_eq!(serialized["eventName"], "unity-status");
        assert_eq!(serialized["streamRevision"], 41);
        assert_eq!(serialized["projectId"], envelope.project_id.as_str());
        assert_eq!(serialized["checkoutId"], envelope.checkout_id.as_str());
        assert_eq!(
            serialized["workspaceGeneration"],
            envelope.workspace_generation
        );
        assert_eq!(serialized["serviceGeneration"], 7);
        assert_eq!(
            serialized["materializationEpoch"],
            runtime.materialization_epoch()
        );
        assert_eq!(serialized["payload"]["status"], "ready");
        assert!(serialized.get("envelope").is_none());
    }

    #[test]
    fn stream_revisions_are_process_router_monotonic() {
        let router = WorkspaceEventRouter::new();
        assert_eq!(router.next_stream_revision(), 1);
        assert_eq!(router.next_stream_revision(), 2);
        assert_eq!(router.next_stream_revision(), 3);
    }

    #[test]
    fn concurrent_publication_linearizes_revision_emit_and_subscriber_order() {
        let router = WorkspaceEventRouter::new();
        let mut subscriber = router.subscribe();
        let emitted = Arc::new(std::sync::Mutex::new(Vec::new()));
        let barrier = Arc::new(std::sync::Barrier::new(24));

        std::thread::scope(|scope| {
            for payload in 0..24_u64 {
                let router = Arc::clone(&router);
                let emitted = Arc::clone(&emitted);
                let barrier = Arc::clone(&barrier);
                scope.spawn(move || {
                    let routed = RoutedWorkspaceEvent {
                        event_name: "same-event".to_string(),
                        stream_revision: 0,
                        envelope: WorkspaceEventEnvelope {
                            project_id: ProjectId::new("linearized-project").expect("project id"),
                            checkout_id: CheckoutId::new("linearized-checkout")
                                .expect("checkout id"),
                            workspace_generation: 1,
                            materialization_epoch: None,
                            service_instance_id: None,
                            service_generation: None,
                            payload: serde_json::json!(payload),
                        },
                    };
                    barrier.wait();
                    let outcome = router.publish_routed_with(routed, || {}, |event| {
                        // Make the first publisher selected by the scheduler
                        // hold the emitter briefly; later publishers must stay
                        // behind its revision and delivery.
                        if event.stream_revision == 1 {
                            std::thread::sleep(std::time::Duration::from_millis(20));
                        }
                        emitted
                            .lock()
                            .expect("emitted order")
                            .push(event.stream_revision);
                        Ok(())
                    });
                    assert_eq!(outcome, WorkspaceEventPublishOutcome::PublishedScoped);
                });
            }
        });

        let emitted = emitted.lock().expect("emitted order").clone();
        assert_eq!(emitted, (1..=24).collect::<Vec<_>>());
        let received = (0..24)
            .map(|_| {
                subscriber
                    .try_recv()
                    .expect("subscriber event")
                    .stream_revision
            })
            .collect::<Vec<_>>();
        assert_eq!(received, emitted);
    }

    #[test]
    fn applied_state_is_cut_exactly_at_the_read_revision() {
        // A reader must never observe applied state for an event whose revision
        // is above the cut, nor miss one at or below it, under any interleaving.
        let router = WorkspaceEventRouter::new();
        let applied = Arc::new(std::sync::atomic::AtomicU64::new(0));
        let max_applied_revision = Arc::new(std::sync::atomic::AtomicU64::new(0));
        let routed = || RoutedWorkspaceEvent {
            event_name: "stream-event".to_string(),
            stream_revision: 0,
            envelope: WorkspaceEventEnvelope {
                project_id: ProjectId::new("cut-project").expect("project id"),
                checkout_id: CheckoutId::new("cut-checkout").expect("checkout id"),
                workspace_generation: 1,
                materialization_epoch: None,
                service_instance_id: None,
                service_generation: None,
                payload: serde_json::json!({}),
            },
        };
        std::thread::scope(|scope| {
            for _ in 0..8 {
                let router = Arc::clone(&router);
                let applied = Arc::clone(&applied);
                let max_applied_revision = Arc::clone(&max_applied_revision);
                scope.spawn(move || {
                    for _ in 0..500 {
                        router.publish_routed_with(
                            routed(),
                            || {
                                applied.fetch_add(1, Ordering::SeqCst);
                            },
                            |event| {
                                max_applied_revision.fetch_max(event.stream_revision, Ordering::SeqCst);
                                Ok(())
                            },
                        );
                    }
                });
            }
            for _ in 0..2 {
                let router = Arc::clone(&router);
                let applied = Arc::clone(&applied);
                scope.spawn(move || {
                    for _ in 0..2000 {
                        let (count, revision) =
                            router.read_at_revision(|| applied.load(Ordering::SeqCst));
                        assert_eq!(count, revision, "applied state must match the cut revision");
                    }
                });
            }
        });
        assert_eq!(applied.load(Ordering::SeqCst), 4000);
        assert_eq!(max_applied_revision.load(Ordering::SeqCst), 4000);
    }

    #[test]
    fn partial_or_unknown_service_scope_is_rejected() {
        let (registry, dir) = registry();
        let runtime = registry.register(dir.path()).expect("runtime");
        let mut envelope = WorkspaceEventEnvelope {
            project_id: runtime.project_id().clone(),
            checkout_id: runtime.checkout_id().clone(),
            workspace_generation: runtime.generation(),
            materialization_epoch: Some(runtime.materialization_epoch()),
            service_instance_id: Some(ServiceInstanceId::for_service(
                runtime.checkout_id(),
                "unity",
            )),
            service_generation: None,
            payload: true,
        };
        assert!(!WorkspaceEventRouter::scope_is_current(&runtime, &envelope));
        envelope.service_generation = Some(1);
        assert!(!WorkspaceEventRouter::scope_is_current(&runtime, &envelope));
    }
}

pub fn emit_for_workspace_scope<T: Serialize + Clone>(
    app_handle: &AppHandle,
    scope: &WorkspaceEventScope,
    event_name: &str,
    payload: T,
) -> WorkspaceEventPublishOutcome {
    if let Some(registry) = app_handle.try_state::<Arc<ProjectRegistry>>() {
        return registry
            .event_router()
            .publish_for_scope(app_handle, scope, event_name, payload);
    }
    WorkspaceEventPublishOutcome::DroppedStale
}
