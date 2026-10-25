//! The Mod's liveness is independent of the persistent CLI/SSH process. Current
//! turn callbacks and independent heartbeats renew its lease; tool duration is
//! never capped. Ordinary activity cannot clear a fault or a terminal deadline.
use std::time::{Duration, Instant};

pub(super) const HEARTBEAT_LEASE: Duration = Duration::from_secs(45);
const TERMINAL_GRACE: Duration = Duration::from_secs(15);
const RECOVERY: &str = "Resume from native history; do not repeat a tool whose outcome is unknown.";

#[derive(Default)]
pub(super) struct BridgeHealth {
    worker_session: Option<String>,
    turn: Option<TurnHealth>,
}
struct TurnHealth {
    id: String,
    last_seen: Instant,
    terminal_since: Option<Instant>,
    fault: Option<String>,
}
impl BridgeHealth {
    pub fn begin_turn(&mut self, id: &str, now: Instant) {
        self.turn = Some(TurnHealth { id: id.into(), last_seen: now, terminal_since: None, fault: None });
    }
    /// First startup must still pass through await_ready. Idle reloads can be
    /// acknowledged here; an active reload cannot reconstruct in-flight writes,
    /// stream consumers or cancellation scopes, so it must stop, not guess.
    pub fn worker_ready(&mut self, session: &str, active: bool) -> Result<bool, String> {
        if let Some(previous) = &self.worker_session {
            let reason = if previous != session {
                Some("Claude hooks worker changed native conversation identity")
            } else if active {
                Some("Claude hooks worker restarted during an active turn")
            } else { None };
            if let Some(reason) = reason {
                let error = format!("{reason}. {RECOVERY}");
                if let Some(turn) = &mut self.turn { turn.fault = Some(error.clone()); }
                return Err(error);
            }
            return Ok(false);
        }
        self.worker_session = Some(session.into());
        Ok(true)
    }
    pub fn activity(&mut self, id: &str, now: Instant) {
        if let Some(turn) = self.turn.as_mut().filter(|turn| turn.id == id) {
            turn.last_seen = now;
        }
    }
    pub fn observe(&mut self, id: &str, state: &str, now: Instant) {
        let Some(turn) = self.turn.as_mut().filter(|turn| turn.id == id) else { return; };
        if !matches!(state, "running" | "complete") { return; }
        turn.last_seen = now;
        // SSH/control callbacks can arrive out of order. A delayed running
        // sample must not erase a terminal receipt; only begin_turn resets it.
        if state == "complete" { turn.terminal_since.get_or_insert(now); }
    }
    pub fn fault(&mut self, id: &str, error: &str) {
        if let Some(turn) = self.turn.as_mut().filter(|turn| turn.id == id) {
            turn.fault.get_or_insert_with(|| format!("Claude bridge failed: {}. {RECOVERY}", error.chars().take(2048).collect::<String>()));
        }
    }
    #[cfg(test)]
    pub fn error(&self, id: &str, now: Instant) -> Option<String> {
        self.error_with_transport(id, now, None)
    }
    pub fn error_with_transport(&self, id: &str, now: Instant, transport_failure: Option<&str>) -> Option<String> {
        let turn = self.turn.as_ref().filter(|turn| turn.id == id)?;
        if let Some(error) = &turn.fault { return Some(error.clone()); }
        let reason = if now.saturating_duration_since(turn.last_seen) >= HEARTBEAT_LEASE {
            "Claude hooks stopped reporting health or activity"
        } else if turn.terminal_since.is_some_and(|at| now.saturating_duration_since(at) >= TERMINAL_GRACE) {
            "Claude finished its turn but Locus did not receive its completion"
        } else { return None; };
        let error = format!("{reason} (last activity {}s ago). {RECOVERY}", now.saturating_duration_since(turn.last_seen).as_secs());
        // Only a silent worker together with transport-level evidence enters
        // native-history recovery. Explicit hook faults, worker replacement and
        // missing terminal receipts remain fatal; never retry their text by keyword.
        Some(match transport_failure.filter(|_| turn.terminal_since.is_none()) {
            Some(failure) => format!("{failure}\n{error}"),
            None => error,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hook_silence_recovers_only_with_transport_evidence() {
        use super::super::turn_retry;
        let now = Instant::now();
        let mut health = BridgeHealth::default();
        health.begin_turn("run", now);
        let disconnected = turn_retry::disconnected("SSH transport heartbeat received no response for 30s");
        assert!(health.error_with_transport("run", now, Some(&disconnected)).is_none());
        let silent = now + HEARTBEAT_LEASE;
        // Both a responsive transport and a missing/unproven RTT pass no failure.
        assert!(!turn_retry::is_disconnected(&health.error_with_transport("run", silent, None).unwrap()));
        let error = health.error_with_transport("run", silent, Some(&disconnected)).unwrap();
        assert!(turn_retry::is_disconnected(&error));
        assert!(error.contains("hooks stopped reporting") && error.contains("heartbeat"));
        assert!(health.error_with_transport("old-run", silent, Some(&disconnected)).is_none());
        for failure in ["Invalid SSH protocol frame", "Permission denied", "Claude plugin validation failed"] {
            assert!(!turn_retry::is_disconnected(&health.error_with_transport("run", silent, Some(failure)).unwrap()));
        }
    }

    #[test]
    fn transport_loss_does_not_override_explicit_hook_faults_or_terminal_receipts() {
        use super::super::turn_retry;
        let now = Instant::now();
        let disconnected = turn_retry::disconnected("SSH output closed");
        for fault in ["tool connection timed out", "unknown tool outcome", "plugin validation failed"] {
            let mut health = BridgeHealth::default();
            health.begin_turn("run", now);
            health.fault("run", fault);
            let error = health.error_with_transport("run", now + HEARTBEAT_LEASE, Some(&disconnected)).unwrap();
            assert!(!turn_retry::is_disconnected(&error) && error.contains(fault));
        }
        let mut health = BridgeHealth::default();
        health.worker_ready("native", false).unwrap();
        health.begin_turn("run", now);
        health.worker_ready("native", true).unwrap_err();
        assert!(!turn_retry::is_disconnected(&health.error_with_transport("run", now + HEARTBEAT_LEASE, Some(&disconnected)).unwrap()));
        health.begin_turn("next", now);
        health.observe("next", "complete", now);
        assert!(!turn_retry::is_disconnected(&health.error_with_transport("next", now + HEARTBEAT_LEASE, Some(&disconnected)).unwrap()));
    }

    #[test]
    fn long_tools_keep_the_lease_alive_but_a_live_process_without_mod_does_not() {
        let mut health = BridgeHealth::default();
        let start = Instant::now();
        health.begin_turn("run", start);
        for seconds in (2..7200).step_by(2) {
            let now = start + Duration::from_secs(seconds);
            health.observe("run", "running", now);
            assert_eq!(health.error("run", now), None);
        }
        let last = start + Duration::from_secs(7198);
        assert!(health.error("run", last + HEARTBEAT_LEASE).unwrap().contains("stopped reporting health"));
    }
    #[test]
    fn active_worker_replacement_fails_closed_but_idle_reload_is_allowed() {
        let mut health = BridgeHealth::default();
        assert_eq!(health.worker_ready("native", false), Ok(true));
        assert_eq!(health.worker_ready("native", false), Ok(false));
        health.begin_turn("run", Instant::now());
        assert!(health.worker_ready("native", true).unwrap_err().contains("restarted"));
        health.observe("run", "running", Instant::now());
        assert!(health.error("run", Instant::now()).is_some()); // heartbeats cannot cure a lost scope
        assert!(health.worker_ready("different", false).is_err());
    }
    #[test]
    fn old_heartbeats_faults_and_completions_cannot_change_the_next_run() {
        let mut health = BridgeHealth::default();
        let now = Instant::now();
        health.begin_turn("new", now);
        health.observe("old", "complete", now);
        health.fault("old", "old error");
        assert_eq!(health.error("new", now + TERMINAL_GRACE), None);
        health.observe("old", "running", now + HEARTBEAT_LEASE);
        assert!(health.error("new", now + HEARTBEAT_LEASE).is_some());
    }
    #[test]
    fn activity_renews_only_its_own_lease_and_preserves_faults_and_completion() {
        let mut health = BridgeHealth::default();
        let now = Instant::now();
        health.begin_turn("run", now);
        for seconds in (2..7200).step_by(2) {
            let at = now + Duration::from_secs(seconds);
            health.activity("run", at);
            assert_eq!(health.error("run", at), None);
        }
        let last = now + Duration::from_secs(7198);
        health.activity("old", last + HEARTBEAT_LEASE);
        assert!(health.error("run", last + HEARTBEAT_LEASE).is_some());
        health.observe("run", "complete", last);
        health.activity("run", last + TERMINAL_GRACE);
        assert!(health.error("run", last + TERMINAL_GRACE).unwrap().contains("did not receive its completion"));
        health.begin_turn("next", last);
        health.fault("next", "unknown tool outcome");
        health.activity("next", last);
        assert!(health.error("next", last).unwrap().contains("unknown tool outcome"));
    }
    #[test]
    fn delayed_running_heartbeat_cannot_reopen_a_completed_turn() {
        let mut health = BridgeHealth::default();
        let now = Instant::now();
        health.begin_turn("run", now);
        health.observe("run", "complete", now);
        health.observe("run", "running", now + TERMINAL_GRACE);
        assert!(health.error("run", now + TERMINAL_GRACE).unwrap().contains("did not receive its completion"));
    }
    #[test]
    fn missing_completion_is_bounded_even_when_heartbeats_continue() {
        let mut health = BridgeHealth::default();
        let now = Instant::now();
        health.begin_turn("run", now);
        health.observe("run", "complete", now);
        health.observe("run", "complete", now + TERMINAL_GRACE);
        assert!(health.error("run", now + TERMINAL_GRACE).unwrap().contains("did not receive its completion"));
        health.begin_turn("next", now + TERMINAL_GRACE);
        assert_eq!(health.error("next", now + TERMINAL_GRACE), None);
    }
}
