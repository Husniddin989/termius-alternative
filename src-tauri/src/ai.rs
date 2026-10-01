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

pub(crate) const SYSTEM_PROMPT: &str = "You turn a user's request into one shell command for the terminal they are \
using. The terminal is already open on the target system, so never wrap the command in ssh. The \
request may be in any language, such as English, Uzbek or Russian. Reply with a command that runs \
as-is on the target system described in the request, using \
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

pub(crate) fn user_message(req: &SuggestRequest) -> String {
    let target = match req.os.as_deref() {
        Some("local") => format!("the user's own computer, {}", local_os()),
        Some(os) => format!("a Linux server (os-release id \"{os}\"); the shell is already running on it"),
        None => "a server, probably Linux; the shell is already running on it".into(),
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
                "schema": suggestion_schema()
            }
        },
        "system": SYSTEM_PROMPT,
        "messages": [{"role": "user", "content": user_message(req)}]
    })
}

/// JSON schema of a suggestion, shared by every provider's structured output.
pub(crate) fn suggestion_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "command": {"type": "string"},
            "explanation": {"type": "string"},
            "dangerous": {"type": "boolean"}
        },
        "required": ["command", "explanation", "dangerous"],
        "additionalProperties": false
    })
}

/// Commands we always treat as destructive, whatever the model said —
/// small local models in particular don't flag these reliably.
fn looks_destructive(command: &str) -> bool {
    const PATTERNS: &[&str] = &[
        r"\brm\s+(\S+\s+)*-[a-zA-Z]*[rRf]",
        r"\brm\s+.*--(recursive|force)",
        r"\b(mkfs|fdisk|parted|wipefs|shred)\b",
        r"\bdd\s+.*of=",
        r">\s*/dev/(sd|nvme|disk|hd)",
        r"\b(shutdown|reboot|halt|poweroff)\b",
        r"\bsystemctl\s+(stop|restart|disable|mask|kill)\b",
        r"\b(chmod|chown|chgrp)\s+(-\w*R|--recursive)",
        r"\b(kill|pkill|killall)\s+-(9|KILL)\b",
        r"\bgit\s+(reset\s+--hard|clean\s+-\w*f|push\s+.*--force)",
        r"\bdocker\s+(system\s+prune|volume\s+(rm|prune)|rm\s+-f)",
        r"\b(drop|truncate)\s+(table|database)\b",
        r"\buserdel\b|\bdeluser\b",
        r":\(\)\s*\{",
    ];
    PATTERNS.iter().any(|p| {
        regex::RegexBuilder::new(p)
            .case_insensitive(true)
            .build()
            .map(|re| re.is_match(command))
            .unwrap_or(false)
    })
}

/// Parses a model's JSON answer, tolerating text around the JSON object.
pub(crate) fn suggestion_from_text(text: &str) -> anyhow::Result<Suggestion> {
    let json = match (text.find('{'), text.rfind('}')) {
        (Some(start), Some(end)) if end > start => &text[start..=end],
        _ => text,
    };
    let mut suggestion: Suggestion = serde_json::from_str(json)
        .map_err(|e| anyhow::anyhow!("Could not read the model's answer: {e}"))?;
    suggestion.command = suggestion.command.trim().to_string();
    if suggestion.command.is_empty() {
        anyhow::bail!("The model did not suggest a command.");
    }
    suggestion.dangerous |= looks_destructive(&suggestion.command);
    Ok(suggestion)
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
    suggestion_from_text(text)
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
        .timeout(std::time::Duration::from_secs(90))
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
    fn destructive_commands_are_flagged_even_if_the_model_says_otherwise() {
        let safe = |cmd: &str| {
            suggestion_from_text(&format!(r#"{{"command":{cmd:?},"explanation":"x","dangerous":false}}"#))
                .unwrap()
                .dangerous
        };
        for cmd in [
            "rm -rf /var/www",
            "sudo rm -fr ./build",
            "rm -r old",
            "sudo systemctl restart nginx",
            "chmod -R 777 /srv",
            "dd if=/dev/zero of=/dev/sda",
            "sudo reboot",
            "git reset --hard HEAD~3",
            "docker system prune -af",
            "psql -c 'DROP TABLE users'",
        ] {
            assert!(safe(cmd), "{cmd} should be flagged");
        }
        for cmd in ["ls -la", "df -h", "systemctl status nginx", "docker ps", "grep -r foo .", "rm file.txt"] {
            assert!(!safe(cmd), "{cmd} should not be flagged");
        }
    }

    #[test]
    fn tolerates_text_around_the_json() {
        let s = suggestion_from_text("Here you go:\n{\"command\":\" uptime \",\"explanation\":\"Load.\",\"dangerous\":false}\nDone").unwrap();
        assert_eq!(s.command, "uptime");
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
