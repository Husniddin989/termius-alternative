//! Natural-language → shell command suggestions using the Claude API.
//!
//! Called from Rust so the API key (kept in the OS keychain) never reaches
//! the webview. There is no official Rust SDK, so this speaks the Messages
//! API over HTTP directly.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const API_URL: &str = "https://api.anthropic.com/v1/messages";
/// Keychain account under which the API key is stored.
pub const API_KEY_ACCOUNT: &str = "anthropic-api-key";

const SYSTEM_PROMPT: &str = "You turn a user's request into one shell command for the terminal they are \
using. Reply with a command that runs as-is on the target system described in the request, using \
tools that are normally installed there. If the request is ambiguous, choose the most common \
interpretation. When the user has already typed part of a command, complete or fix that command. \
Prefer a single line; join steps with && or pipes when needed. Set dangerous to true when the \
command deletes or overwrites data, changes system configuration, stops or restarts services, \
changes permissions recursively, or is otherwise hard to undo. Write the explanation as one short \
sentence in the same language as the user's request.";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuggestRequest {
    pub prompt: String,
    /// Remote OS id (e.g. "ubuntu"), or "local" for the user's own machine.
    pub os: Option<String>,
    /// What the user has typed on the current command line, if known.
    pub current_line: Option<String>,
    /// The last lines of terminal output, when the user opted in.
    pub recent_output: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Suggestion {
    pub command: String,
    pub explanation: String,
    pub dangerous: bool,
}

fn local_os() -> &'static str {
    if cfg!(target_os = "macos") {
        "macOS (zsh by default)"
    } else if cfg!(target_os = "windows") {
        "Windows (PowerShell)"
    } else {
        "Linux"
    }
}

fn user_message(req: &SuggestRequest) -> String {
    let target = match req.os.as_deref() {
        Some("local") => format!("the user's own computer, {}", local_os()),
        Some(os) => format!("a remote server over SSH, OS id \"{os}\" from /etc/os-release"),
        None => "a remote server over SSH, OS unknown (assume Linux)".into(),
    };
    let mut msg = format!("Target system: {target}\n");
    if let Some(line) = req.current_line.as_deref().filter(|l| !l.trim().is_empty()) {
        msg.push_str(&format!("Already typed on the command line: {line}\n"));
    }
    if let Some(out) = req.recent_output.as_deref().filter(|o| !o.trim().is_empty()) {
        msg.push_str(&format!("Recent terminal output:\n<terminal_output>\n{out}\n</terminal_output>\n"));
    }
    msg.push_str(&format!("Request: {}", req.prompt.trim()));
    msg
}

fn request_body(model: &str, req: &SuggestRequest) -> Value {
    json!({
        "model": model,
        "max_tokens": 8000,
        // Server-side fallback if the model declines on policy grounds.
        "fallbacks": "default",
        // Suggestions should feel instant; low effort keeps thinking short.
        "output_config": {
            "effort": "low",
            "format": {
                "type": "json_schema",
                "schema": {
                    "type": "object",
                    "properties": {
                        "command": {"type": "string"},
                        "explanation": {"type": "string"},
                        "dangerous": {"type": "boolean"}
                    },
                    "required": ["command", "explanation", "dangerous"],
                    "additionalProperties": false
                }
            }
        },
        "system": SYSTEM_PROMPT,
        "messages": [{"role": "user", "content": user_message(req)}]
    })
}

/// Extracts the suggestion from a Messages API response body.
fn parse_response(status: u16, body: &Value) -> anyhow::Result<Suggestion> {
    if !(200..300).contains(&status) {
        let message = body["error"]["message"].as_str().unwrap_or("unknown error");
        match status {
            401 => anyhow::bail!("The Anthropic API key was rejected ({message}). Check it in Settings."),
            429 => anyhow::bail!("Rate limited by the Anthropic API — try again in a moment."),
            _ => anyhow::bail!("Anthropic API error {status}: {message}"),
        }
    }
    match body["stop_reason"].as_str() {
        Some("refusal") => anyhow::bail!("The model declined this request."),
        Some("max_tokens") => anyhow::bail!("The answer was cut off; try a shorter request."),
        _ => {}
    }
    let text = body["content"]
        .as_array()
        .and_then(|blocks| {
            blocks
                .iter()
                .rev()
                .find(|b| b["type"] == "text")
                .and_then(|b| b["text"].as_str())
        })
        .ok_or_else(|| anyhow::anyhow!("The response contained no answer."))?;
    let suggestion: Suggestion = serde_json::from_str(text)
        .map_err(|e| anyhow::anyhow!("Could not read the model's answer: {e}"))?;
    if suggestion.command.trim().is_empty() {
        anyhow::bail!("The model did not suggest a command.");
    }
    Ok(suggestion)
}

pub async fn suggest(
    http: &reqwest::Client,
    api_key: &str,
    model: &str,
    req: &SuggestRequest,
) -> anyhow::Result<Suggestion> {
    let response = http
        .post(API_URL)
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .header("anthropic-beta", "server-side-fallback-2026-07-01")
        .json(&request_body(model, req))
        .send()
        .await
        .map_err(|e| anyhow::anyhow!("Could not reach the Anthropic API: {e}"))?;
    let status = response.status().as_u16();
    let body: Value = response.json().await.unwrap_or(Value::Null);
    parse_response(status, &body)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req() -> SuggestRequest {
        SuggestRequest {
            prompt: "eng katta 5 ta faylni top".into(),
            os: Some("ubuntu".into()),
            current_line: Some("du -".into()),
            recent_output: None,
        }
    }

    #[test]
    fn request_uses_structured_output_and_fallbacks() {
        let body = request_body("claude-opus-5-5", &req());
        assert_eq!(body["model"], "claude-opus-5-5");
        assert_eq!(body["fallbacks"], "default");
        assert_eq!(body["output_config"]["format"]["type"], "json_schema");
        assert!(body.get("thinking").is_none(), "Opus 5.5 rejects disabled thinking; omit it");
        let msg = body["messages"][0]["content"].as_str().unwrap();
        assert!(msg.contains("\"ubuntu\""));
        assert!(msg.contains("Already typed on the command line: du -"));
        assert!(!msg.contains("terminal_output"));
    }

    #[test]
    fn parses_text_block_after_thinking() {
        let body = json!({
            "stop_reason": "end_turn",
            "content": [
                {"type": "thinking", "thinking": "", "signature": "x"},
                {"type": "text", "text": "{\"command\":\"du -ah . | sort -rh | head -5\",\"explanation\":\"Eng katta 5 ta fayl.\",\"dangerous\":false}"}
            ]
        });
        let s = parse_response(200, &body).unwrap();
        assert_eq!(s.command, "du -ah . | sort -rh | head -5");
        assert!(!s.dangerous);
    }

    #[test]
    fn reports_refusals_and_api_errors() {
        let refusal = json!({"stop_reason": "refusal", "content": []});
        assert!(parse_response(200, &refusal).unwrap_err().to_string().contains("declined"));

        let unauthorized = json!({"type": "error", "error": {"type": "authentication_error", "message": "invalid x-api-key"}});
        let e = parse_response(401, &unauthorized).unwrap_err().to_string();
        assert!(e.contains("rejected") && e.contains("invalid x-api-key"), "{e}");
    }
}
