//! Opt-in Responses Lite contract check for the client `tool_search` round.
//! Reads only the existing Locus OAuth token; never refreshes or writes
//! credentials and sends only the synthetic probe conversation below.
use super::*;
use crate::auth::codex::CodexTokenData;
use crate::commands::CodexTransportMode;
use serde_json::json;

const PROBE_TOOL: &str = "probe_echo";
const DESCRIPTION: &str = "# Deferred tool loading\n\nLoads explicitly named deferred tools by exact wire name and exposes them for the next model call. Use `tool_search` with the exact wire names supplied by the prompt.";

fn existing_auth() -> CodexTokenData {
    let secret = crate::keychain::get_secret(crate::keychain::KEY_CODEX_TOKENS)
        .expect("read Locus OAuth credential")
        .expect("Locus OAuth login required");
    let token: CodexTokenData = serde_json::from_str(&secret).expect("parse OAuth credential");
    assert!(
        !token.validation_failed,
        "OAuth credential requires validation"
    );
    assert!(
        token.expires_at > chrono::Utc::now().timestamp_millis() + 60_000,
        "OAuth token expired; this check does not refresh credentials"
    );
    token
}

fn message(value: serde_json::Value) -> ChatMessage {
    serde_json::from_value(value).expect("chat message")
}

async fn send(
    auth: &CodexTokenData,
    model: &str,
    history: &[ChatMessage],
    metadata: Option<&HashMap<String, serde_json::Value>>,
    session: &str,
    cache_session: Option<&str>,
    turn_state: &mut TurnState,
) -> LlmResponse {
    let options = CodexStreamOptions::default();
    // Mirror the failing app turns: a populated `functions` namespace and the
    // high effort the Lite namespaced call was observed with.
    let tools = [json!({"type":"function", "function":{"name":"status_note",
        "description":"Record a short status note. Not needed for this probe.",
        "parameters":{"type":"object", "properties":{"note":{"type":"string"}},
            "required":["note"]}}})];
    let effort =
        std::env::var("LOCUS_CODEX_TOOL_SEARCH_TEST_EFFORT").unwrap_or_else(|_| "xhigh".into());
    let body = build_request_body_with_tool_search(
        model,
        "You are an automated protocol probe. Follow the user instruction exactly.",
        history,
        &tools,
        Some(DESCRIPTION),
        Some(&effort),
        Some(session),
        metadata,
        options.clone(),
    );
    let mut trace =
        diagnostics::Attempt::new(Some(session), &options, 1, CodexTransportMode::Websocket);
    let result = tokio::time::timeout(
        Duration::from_secs(120),
        stream_chat_websocket_once(
            &auth.access_token,
            auth.account_id.as_deref(),
            None,
            model,
            history,
            &tools,
            Some(session),
            cache_session,
            false,
            body,
            turn_state,
            None,
            &|_| {},
            &|_| {},
            &|_, _| {},
            Duration::from_secs(60),
            Duration::from_secs(90),
            &mut trace,
        ),
    )
    .await
    .expect("tool_search live check timed out")
    .unwrap_or_else(|error| panic!("{}", error.replace(&auth.access_token, "[redacted]")));
    match result {
        CodexTransportAttempt::Response(response) => {
            assert!(response.response_completed, "response did not complete");
            response
        }
        CodexTransportAttempt::FallbackToHttp => {
            panic!("upstream WebSocket unavailable; tool_search round unverified")
        }
    }
}

fn probe_call(response: &LlmResponse) -> bool {
    response
        .tool_calls
        .iter()
        .any(|call| call.name == PROBE_TOOL && call.arguments.contains("lite-ok"))
}

/// Round 1 must surface `tool_search` (typed or Lite-namespaced on the wire);
/// round 2 continues on the cached socket (`previous_response_id`) like the
/// app; round 3 replays the persisted items as a fresh full-input request.
#[tokio::test]
#[ignore = "uses existing OAuth and real inference quota; opt in with --ignored --exact"]
async fn tool_search_live_oauth_lite_round_trip() {
    let auth = existing_auth();
    let model = std::env::var("LOCUS_CODEX_TOOL_SEARCH_TEST_MODEL")
        .unwrap_or_else(|_| "gpt-6-astra".into());
    let session = uuid::Uuid::new_v4().to_string();
    let mut turn_state = TurnState::default();
    let mut history = vec![message(json!({"id":"user-1", "role":"user", "createdAt":0,
        "content":format!("Automated protocol check. Load the deferred tool `{PROBE_TOOL}` with tool_search (exact wire name), then call it with token \"lite-ok\". Do not write any text.")}))];

    let first = send(
        &auth,
        &model,
        &history,
        None,
        &session,
        Some(&session),
        &mut turn_state,
    )
    .await;
    let lite_wire = first.raw_response.contains("\"tool_search_tool\"");
    std::println!(
        "round 1: model={model} lite_namespaced_wire={lite_wire} tool_calls={:?}",
        first
            .tool_calls
            .iter()
            .map(|call| &call.name)
            .collect::<Vec<_>>()
    );
    assert_eq!(
        first.tool_calls.len(),
        1,
        "expected exactly one tool_search call"
    );
    let search = first.tool_calls[0].clone();
    assert_eq!(search.name, TOOL_SEARCH_HISTORY_TOOL_NAME);
    assert!(
        search.arguments.contains(PROBE_TOOL),
        "arguments: {}",
        search.arguments
    );
    assert!(first
        .response_items
        .iter()
        .any(|item| item["type"] == "tool_search_call" && item["call_id"] == search.id.as_str()));

    let output = json!({"tools":[{"type":"function", "name":PROBE_TOOL,
        "description":"Echo the given token back to the harness.",
        "parameters":{"type":"object", "properties":{"token":{"type":"string"}},
            "required":["token"], "additionalProperties":false},
        "defer_loading":true}]});
    history.push(message(
        json!({"id":"assistant-1", "role":"assistant", "createdAt":1,
        "content":first.text, "toolCalls":[search.clone()]}),
    ));
    history.push(message(json!({"id":"tool-1", "role":"tool", "createdAt":2,
        "content":output.to_string(), "toolCallId":search.id})));
    let metadata = HashMap::from([(
        "assistant-1".to_string(),
        first
            .continuation_request
            .clone()
            .expect("persisted provider items"),
    )]);

    let second = send(
        &auth,
        &model,
        &history,
        Some(&metadata),
        &session,
        Some(&session),
        &mut turn_state,
    )
    .await;
    let continued = second.raw_request.contains("previous_response_id");
    std::println!(
        "round 2: continuation={continued} tool_calls={:?}",
        second
            .tool_calls
            .iter()
            .map(|call| (&call.name, &call.arguments))
            .collect::<Vec<_>>()
    );
    assert!(
        probe_call(&second),
        "continued round did not call the loaded tool"
    );

    // Rounds 3–4 replay the Lite namespaced wire item regardless of which
    // shape round 1 produced: normalized (Locus persistence), then raw (what a
    // continued socket holds server-side after a namespaced call).
    for (round, normalize) in [(3, true), (4, false)] {
        let mut replay = metadata.clone();
        let output = replay
            .get_mut("assistant-1")
            .and_then(|metadata| metadata["codex_response"]["output"].as_array_mut());
        for item in output.into_iter().flatten() {
            if item["type"] == "tool_search_call" {
                let suffix = item["id"]
                    .as_str()
                    .and_then(|id| id.split_once('_'))
                    .map_or("probe", |(_, rest)| rest);
                *item = json!({"type":"function_call", "id":format!("fc_{suffix}"),
                    "status":"completed", "namespace":"tool_search", "name":"tool_search_tool",
                    "call_id":item["call_id"], "arguments":item["arguments"].to_string()});
                if normalize {
                    protocol::normalize_tool_search_call(item);
                }
                std::println!("round {round}: replay item {item}");
            }
        }
        let fresh = uuid::Uuid::new_v4().to_string();
        let response = send(
            &auth,
            &model,
            &history,
            Some(&replay),
            &fresh,
            None,
            &mut TurnState::default(),
        )
        .await;
        std::println!(
            "round {round}: full replay tool_calls={:?}",
            response
                .tool_calls
                .iter()
                .map(|call| (&call.name, &call.arguments))
                .collect::<Vec<_>>()
        );
        assert!(
            probe_call(&response),
            "round {round} replay did not call the loaded tool"
        );
    }
}
