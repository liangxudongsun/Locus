//! Bounded plain-text startup diagnostics for the connection UI and turn errors.
use super::*;

pub(super) fn message(summary: &str, bytes: &[u8]) -> String {
    // Keep the leading stage/retry marker even when a peer sends a very long
    // first line. Terminal detail keeps its own bounded tail below.
    let summary = super::super::diagnostics::plain_text(&summary.chars().take(1024).collect::<String>());
    let text = String::from_utf8_lossy(bytes);
    let tail = super::super::diagnostics::plain_text(&text);
    match (summary.is_empty(), tail.is_empty()) {
        (true, _) => tail,
        (_, true) => summary.to_string(),
        _ => format!("{summary}\n{tail}"),
    }
}

pub(super) async fn validate_plugin(cli: &Path, plugin: &Path, env: &HashMap<OsString, OsString>) -> Result<(), String> {
    let mut command = tokio::process::Command::new(cli);
    command.args(["plugin", "validate"]).arg(plugin).env_clear().envs(env)
        .env_remove("CLAUDECODE").env("NO_COLOR", "1")
        .stdin(std::process::Stdio::null()).kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let output = tokio::time::timeout(Duration::from_secs(20), command.output()).await
        .map_err(|_| "Claude plugin validation timed out".to_string())?
        .map_err(|error| format!("Could not validate the Claude plugin: {error}"))?;
    if output.status.success() { return Ok(()); }
    let mut bytes = output.stdout;
    bytes.push(b'\n');
    bytes.extend_from_slice(&output.stderr);
    Err(message("Claude plugin validation failed.", &bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_diagnostics_preserve_the_cause_without_terminal_controls() {
        let output = b"\x1b]0;Claude\x07\x1b[31mregister.js:116: invalid helper\x1b[0m\r\n\x00Validation failed";
        assert_eq!(message("Claude plugin validation failed.", output),
            "Claude plugin validation failed.\nregister.js:116: invalid helper\nValidation failed");
        assert_eq!(message("Claude exited before initialization.", b"\x1b[2J"), "Claude exited before initialization.");
    }

    #[test]
    fn stage_and_retry_marker_survive_oversized_peer_summaries() {
        let summary = format!("Claude transport disconnected: TUI initialization: \x1b[31m{}", "中".repeat(9000));
        let error = message(&summary, b"last remote cause");
        assert!(super::super::super::turn_retry::is_disconnected(&error));
        assert!(error.contains("TUI initialization"));
        assert!(error.ends_with("last remote cause"));
        assert!(!error.contains('\x1b'));
        assert!(error.chars().count() <= 1024 + 1 + "last remote cause".len());
    }

    #[test]
    fn startup_diagnostics_bound_unicode_output_and_keep_the_last_error() {
        let output = format!("{}\nplugin rejected", "中".repeat(9000));
        let error = message("Startup failed.", output.as_bytes());
        assert!(error.ends_with("plugin rejected"));
        assert_eq!(error.chars().count(), "Startup failed.\n".len() + 6000);
    }
}
