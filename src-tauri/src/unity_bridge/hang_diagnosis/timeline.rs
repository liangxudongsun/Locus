//! Low-rate main-thread sampling during an unresponsive incident.
//!
//! Cost model (healthy editors pay nothing): this code only runs after the
//! broker heartbeat has been silent for 30s. Each sample suspends the main
//! thread once for a register + stack copy (the broker's `main_thread_stack`
//! with one sample), managed names come from the broker's per-generation cache
//! (no Mono attach for addresses it has already named), and native frames are
//! never symbolized here — the incident's first full diagnosis does that once.
//! Samples are 5s apart for the first two minutes, then 30s apart.
//!
//! The assessment cannot prove an infinite loop (a long finite loop looks the
//! same). It reports how long the same project/agent call has failed to
//! return and whether the thread burned CPU or sat in a wait, and only marks
//! `blocks_progress` once that evidence has held for a long time.

use serde::{Deserialize, Serialize};

pub(super) const FAST_INTERVAL_MS: u64 = 5_000;
pub(super) const FAST_SAMPLES: u32 = 24;
pub(super) const SLOW_INTERVAL_MS: u64 = 30_000;
pub(super) const MAX_RETAINED: usize = 48;
/// An identical stack with no CPU for this long is treated as a deadlock.
pub(super) const BLOCKED_WAIT_MIN_MS: u64 = 60_000;
/// The same busy project/agent call for this long is a suspected endless loop.
pub(super) const SUSPECTED_LOOP_MIN_MS: u64 = 120_000;
const IDLE_CPU_RATIO: f64 = 0.05;
const BUSY_CPU_RATIO: f64 = 0.25;

#[derive(Debug, Clone)]
pub(super) struct TimelineFrame {
    pub ip: u64,
    pub sp: u64,
    pub method: Option<String>,
    /// `user` | `agent` | `locus` | `unity` | `system` | `runtime` | `unknown`.
    pub origin: &'static str,
    pub display: String,
}

#[derive(Debug, Clone)]
pub(super) struct TimelineSample {
    pub at_ms: u64,
    /// Main-thread CPU time (kernel + user) at the capture, 100ns units.
    pub cpu_100ns: Option<u64>,
    pub frames: Vec<TimelineFrame>,
    /// Managed names were resolved for this sample (owner is knowable).
    pub names_ok: bool,
    pub suspend_us: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnityStallAssessment {
    /// `unity_work` | `user_code_busy` | `user_code_waiting` | `blocked_wait`
    /// | `suspected_infinite_loop` | `unknown`.
    pub kind: String,
    /// `unity` | `user` | `agent` | `unknown`.
    pub owner: String,
    /// How long the evidence behind `kind` has held.
    pub for_ms: u64,
    pub samples: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu_percent: Option<f32>,
    /// The longest-lived project/agent call still on the stack.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frame: Option<String>,
    /// The evidence says the editor will not get back to its loop by itself.
    pub blocks_progress: bool,
    /// Longest main-thread suspension any timeline sample cost.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_suspend_us: Option<u64>,
}

fn owned_by_project(frame: &TimelineFrame) -> bool {
    matches!(frame.origin, "user" | "agent") && frame.method.is_some()
}

/// Index of the first sample of the unbroken run, ending at the last sample,
/// in which the call `(method, sp)` stays on the stack. The stack pointer
/// separates one long call from repeated calls to the same method.
fn streak_start(samples: &[TimelineSample], method: &str, sp: u64) -> usize {
    let mut start = samples.len() - 1;
    while start > 0 {
        let present = samples[start - 1]
            .frames
            .iter()
            .any(|frame| frame.sp == sp && frame.method.as_deref() == Some(method));
        if !present {
            break;
        }
        start -= 1;
    }
    start
}

fn cpu_ratio(first: &TimelineSample, last: &TimelineSample) -> Option<f64> {
    let wall_ms = last.at_ms.checked_sub(first.at_ms).filter(|ms| *ms > 0)?;
    let cpu = last.cpu_100ns?.checked_sub(first.cpu_100ns?)?;
    Some((cpu as f64 / (wall_ms as f64 * 10_000.0)).clamp(0.0, 1.0))
}

pub(super) fn assess(samples: &[TimelineSample]) -> Option<UnityStallAssessment> {
    if samples.len() < 2 {
        return None;
    }
    let first = samples.first()?;
    let last = samples.last()?;
    let max_suspend_us = samples.iter().map(|sample| sample.suspend_us).max();
    let span_ms = last.at_ms.saturating_sub(first.at_ms);
    let base = |kind: &str, owner: &str, for_ms: u64, ratio: Option<f64>| UnityStallAssessment {
        kind: kind.to_string(),
        owner: owner.to_string(),
        for_ms,
        samples: samples.len().min(u32::MAX as usize) as u32,
        cpu_percent: ratio.map(|ratio| (ratio * 100.0) as f32),
        frame: None,
        blocks_progress: false,
        max_suspend_us,
    };

    if !last.names_ok {
        return Some(base("unknown", "unknown", span_ms, cpu_ratio(first, last)));
    }

    // The longest-lived project/agent call still running; ties go to the
    // outermost frame (larger stack pointer).
    let oldest = last
        .frames
        .iter()
        .filter(|frame| owned_by_project(frame))
        .map(|frame| {
            let method = frame.method.as_deref().unwrap_or_default();
            (streak_start(samples, method, frame.sp), frame)
        })
        .min_by(|(a_start, a), (b_start, b)| a_start.cmp(b_start).then(b.sp.cmp(&a.sp)));

    let Some((start, frame)) = oldest else {
        // Nothing of the project's on the stack: compile, import, reload,
        // repaint or other engine work. Never a reason to give up early.
        return Some(base("unity_work", "unity", span_ms, cpu_ratio(first, last)));
    };

    let streak = &samples[start..];
    let for_ms = last.at_ms.saturating_sub(streak[0].at_ms);
    let ratio = cpu_ratio(&streak[0], last);
    let identical_stack = streak.len() >= 3
        && streak.windows(2).all(|pair| {
            pair[0].frames.len() == pair[1].frames.len()
                && pair[0]
                    .frames
                    .iter()
                    .zip(&pair[1].frames)
                    .all(|(a, b)| a.ip == b.ip && a.sp == b.sp)
        });

    let idle = ratio.is_some_and(|ratio| ratio < IDLE_CPU_RATIO);
    let busy = ratio.is_some_and(|ratio| ratio >= BUSY_CPU_RATIO);
    let (kind, blocks_progress) = if idle && identical_stack && for_ms >= BLOCKED_WAIT_MIN_MS {
        ("blocked_wait", true)
    } else if busy && for_ms >= SUSPECTED_LOOP_MIN_MS {
        ("suspected_infinite_loop", true)
    } else if idle {
        ("user_code_waiting", false)
    } else {
        ("user_code_busy", false)
    };
    let mut assessment = base(kind, frame.origin, for_ms, ratio);
    assessment.frame = Some(frame.display.clone());
    assessment.blocks_progress = blocks_progress;
    Some(assessment)
}

/// Delay before the next sample, given how many have been taken.
pub(super) fn next_interval_ms(taken: u32) -> u64 {
    if taken < FAST_SAMPLES {
        FAST_INTERVAL_MS
    } else {
        SLOW_INTERVAL_MS
    }
}

/// One-line agent/UI wording for an assessment.
pub(crate) fn describe(assessment: &UnityStallAssessment) -> String {
    let seconds = assessment.for_ms / 1_000;
    let cpu = assessment
        .cpu_percent
        .map(|percent| format!(", main-thread CPU {percent:.0}%"))
        .unwrap_or_default();
    let frame = assessment.frame.as_deref().unwrap_or("an unknown frame");
    match assessment.kind.as_str() {
        "unity_work" => format!(
            "Unity engine work with no project code on the stack for {seconds}s{cpu} (compile, import, reload or repaint); this usually finishes on its own"
        ),
        "blocked_wait" => format!(
            "the same call has been blocked waiting with an unchanged stack for {seconds}s{cpu}: {frame}. This is almost certainly a deadlock; the editor will not recover by itself"
        ),
        "suspected_infinite_loop" => format!(
            "the same call has been running for {seconds}s without returning{cpu}: {frame}. This may be an endless loop (a very long loop looks the same)"
        ),
        "user_code_waiting" => format!(
            "project code is waiting for {seconds}s{cpu}: {frame}"
        ),
        "user_code_busy" => format!(
            "project code has been running for {seconds}s{cpu}: {frame}"
        ),
        _ => format!("main-thread owner could not be determined (managed frames unnamed){cpu}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(ip: u64, sp: u64, method: Option<&str>, origin: &'static str) -> TimelineFrame {
        TimelineFrame {
            ip,
            sp,
            method: method.map(str::to_string),
            origin,
            display: method.unwrap_or("native").to_string(),
        }
    }

    fn sample(at_s: u64, cpu_s: f64, frames: Vec<TimelineFrame>) -> TimelineSample {
        TimelineSample {
            at_ms: at_s * 1_000,
            cpu_100ns: Some((cpu_s * 10_000_000.0) as u64),
            frames,
            names_ok: true,
            suspend_us: 80,
        }
    }

    #[test]
    fn engine_only_stacks_are_unity_work_and_never_block() {
        let samples: Vec<_> = (0..40)
            .map(|i| sample(i * 5, i as f64 * 4.0, vec![frame(0x10 + i, 0x1000, None, "native")]))
            .collect();
        let assessment = assess(&samples).unwrap();
        assert_eq!(assessment.kind, "unity_work");
        assert_eq!(assessment.owner, "unity");
        assert!(!assessment.blocks_progress);
        assert_eq!(assessment.max_suspend_us, Some(80));
    }

    #[test]
    fn identical_idle_stack_in_project_code_becomes_a_deadlock_after_a_minute() {
        let stack = || {
            vec![
                frame(0x10, 0x100, None, "native"),
                frame(0x20, 0x200, Some("Game.Net:Fetch ()"), "user"),
                frame(0x30, 0x300, Some("Game.Boot:.cctor ()"), "user"),
            ]
        };
        let early: Vec<_> = (0..6).map(|i| sample(i * 5, 0.01, stack())).collect();
        let assessment = assess(&early).unwrap();
        assert_eq!(assessment.kind, "user_code_waiting");
        assert!(!assessment.blocks_progress);

        let late: Vec<_> = (0..14).map(|i| sample(i * 5, 0.01, stack())).collect();
        let assessment = assess(&late).unwrap();
        assert_eq!(assessment.kind, "blocked_wait");
        assert!(assessment.blocks_progress);
        assert_eq!(assessment.owner, "user");
        // The outermost long-lived project call is reported.
        assert_eq!(assessment.frame.as_deref(), Some("Game.Boot:.cctor ()"));
    }

    #[test]
    fn same_busy_call_instance_becomes_a_suspected_loop_after_two_minutes() {
        let samples: Vec<_> = (0..26)
            .map(|i| {
                sample(
                    i * 5,
                    i as f64 * 5.0,
                    vec![
                        frame(0x40 + i % 3, 0x80, Some("Game.Hash:Step ()"), "user"),
                        frame(0x50, 0x400, Some("__LocusSnippet:ExecuteSync ()"), "agent"),
                    ],
                )
            })
            .collect();
        let assessment = assess(&samples).unwrap();
        assert_eq!(assessment.kind, "suspected_infinite_loop");
        assert_eq!(assessment.owner, "agent");
        assert!(assessment.blocks_progress);
        assert_eq!(assessment.frame.as_deref(), Some("__LocusSnippet:ExecuteSync ()"));
        assert!(assessment.cpu_percent.unwrap() > 90.0);
    }

    #[test]
    fn a_new_call_instance_restarts_the_clock() {
        // Same method, but re-entered at a different stack depth each time:
        // repeated short calls are progress, not one stuck call.
        let samples: Vec<_> = (0..30)
            .map(|i| {
                sample(
                    i * 5,
                    i as f64 * 5.0,
                    vec![frame(0x40, 0x80 + i * 0x10, Some("Game.Importer:OnPostprocess ()"), "user")],
                )
            })
            .collect();
        let assessment = assess(&samples).unwrap();
        assert_eq!(assessment.kind, "user_code_busy");
        assert_eq!(assessment.for_ms, 0);
        assert!(!assessment.blocks_progress);
    }

    #[test]
    fn unnamed_managed_frames_leave_the_owner_unknown() {
        let mut samples: Vec<_> = (0..3).map(|i| sample(i * 5, 1.0, vec![frame(0x10, 0x10, None, "unknown")])).collect();
        samples.last_mut().unwrap().names_ok = false;
        let assessment = assess(&samples).unwrap();
        assert_eq!(assessment.kind, "unknown");
        assert!(!assessment.blocks_progress);
    }

    #[test]
    fn sampling_slows_down_after_the_fast_window() {
        assert_eq!(next_interval_ms(0), FAST_INTERVAL_MS);
        assert_eq!(next_interval_ms(FAST_SAMPLES - 1), FAST_INTERVAL_MS);
        assert_eq!(next_interval_ms(FAST_SAMPLES), SLOW_INTERVAL_MS);
    }
}
