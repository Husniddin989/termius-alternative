//! Free, offline command suggestions through a local Ollama server
//! (https://ollama.com), which runs open models on the user's machine.

use serde::Serialize;
use serde_json::{json, Value};
use std::time::Duration;

use crate::ai::{suggestion_from_text, suggestion_schema, user_message, SuggestRequest, Suggestion, SYSTEM_PROMPT};

pub const DEFAULT_URL: &str = "http://127.0.0.1:11434";
/// Small code model that is good at shell commands and runs on most laptops.
pub const DEFAULT_MODEL: &str = "qwen2.5-coder:3b";

/// The first answer includes loading the model into memory, which on a
/// CPU-only machine can take a while.
const ANSWER_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LocalModel {
    pub name: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullProgress {
    pub status: String,
    pub completed: u64,
    pub total: u64,
}

fn endpoint(base: &str, path: &str) -> String {
    format!("{}{path}", base.trim_end_matches('/'))
}

fn unreachable(base: &str, e: reqwest::Error) -> anyhow::Error {
    if e.is_timeout() {
        anyhow::anyhow!("The local model took too long to answer. Try a smaller model in Settings.")
    } else {
        anyhow::anyhow!(
            "Ollama is not running at {base}. Install it from https://ollama.com and start it \
             (open the Ollama app, or run `ollama serve`)."
        )
    }
}

fn api_error(status: u16, body: &Value, model: &str) -> anyhow::Error {
    let message = body["error"].as_str().unwrap_or("unknown error");
    if status == 404 || message.contains("not found") {
        anyhow::anyhow!("The model \"{model}\" is not downloaded yet. Download it in Settings → AI.")
    } else {
        anyhow::anyhow!("Ollama error {status}: {message}")
    }
}

pub async fn list_models(http: &reqwest::Client, base: &str) -> anyhow::Result<Vec<LocalModel>> {
    let response = http
        .get(endpoint(base, "/api/tags"))
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .map_err(|e| unreachable(base, e))?;
    let body: Value = response.json().await?;
    let mut models: Vec<LocalModel> = body["models"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|m| {
                    Some(LocalModel {
                        name: m["name"].as_str()?.to_string(),
                        size: m["size"].as_u64().unwrap_or(0),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    models.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(models)
}

/// Downloads a model, reporting progress as Ollama streams it.
pub async fn pull(
    http: &reqwest::Client,
    base: &str,
    model: &str,
    mut on_progress: impl FnMut(PullProgress),
) -> anyhow::Result<()> {
    let mut response = http
        .post(endpoint(base, "/api/pull"))
        .json(&json!({ "model": model, "stream": true }))
        .send()
        .await
        .map_err(|e| unreachable(base, e))?;
    let status = response.status().as_u16();
    let mut pending = Vec::new();
    let mut handle_line = |line: &[u8]| -> anyhow::Result<bool> {
        if line.iter().all(u8::is_ascii_whitespace) {
            return Ok(false);
        }
        let msg: Value = serde_json::from_slice(line)?;
        if let Some(err) = msg["error"].as_str() {
            anyhow::bail!("Could not download {model}: {err}");
        }
        let status = msg["status"].as_str().unwrap_or("").to_string();
        on_progress(PullProgress {
            completed: msg["completed"].as_u64().unwrap_or(0),
            total: msg["total"].as_u64().unwrap_or(0),
            status: status.clone(),
        });
        Ok(status == "success")
    };
    let mut done = false;
    while let Some(chunk) = response.chunk().await.map_err(|e| unreachable(base, e))? {
        pending.extend_from_slice(&chunk);
        while let Some(pos) = pending.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = pending.drain(..=pos).collect();
            done |= handle_line(&line)?;
        }
    }
    done |= handle_line(&pending)?;
    if !(200..300).contains(&status) && !done {
        anyhow::bail!("Could not download {model} (Ollama returned {status}).");
    }
    if !done {
        anyhow::bail!("The download of {model} did not finish.");
    }
    Ok(())
}

/// Worked examples for small local models, which follow examples far
/// better than instructions. Sent as earlier turns of the chat.
fn examples() -> Vec<Value> {
    let target = "Target system: a Linux server (os-release id \"ubuntu\"); the shell is already running on it\n";
    let pairs = [
        ("show free memory", r#"{"command":"free -h","explanation":"Shows used and free memory in human-readable units.","dangerous":false}"#),
        ("nginx ni qayta ishga tushir", r#"{"command":"sudo systemctl restart nginx","explanation":"Nginx xizmatini qayta ishga tushiradi.","dangerous":true}"#),
        ("joriy papkadagi eng katta 10 ta papkani ko'rsat", r#"{"command":"du -h --max-depth=1 . | sort -rh | head -10","explanation":"Joriy papkadagi eng katta 10 ta papkani hajmi bo'yicha ko'rsatadi.","dangerous":false}"#),
        ("покажи открытые порты", r#"{"command":"sudo ss -tulpn","explanation":"Показывает открытые порты и процессы, которые их слушают.","dangerous":false}"#),
    ];
    pairs
        .iter()
        .flat_map(|(request, answer)| {
            [
                json!({ "role": "user", "content": format!("{target}Request: {request}") }),
                json!({ "role": "assistant", "content": answer }),
            ]
        })
        .collect()
}

pub async fn suggest(
    http: &reqwest::Client,
    base: &str,
    model: &str,
    req: &SuggestRequest,
) -> anyhow::Result<Suggestion> {
    let body = json!({
        "model": model,
        "stream": false,
        "format": suggestion_schema(),
        "keep_alive": "30m",
        // Small models sometimes keep emitting whitespace inside JSON mode;
        // a token cap guarantees an answer (or a clear error) in seconds.
        "options": { "temperature": 0.1, "num_predict": 400 },
        "messages": std::iter::once(json!({ "role": "system", "content": SYSTEM_PROMPT }))
            .chain(examples())
            .chain(std::iter::once(json!({ "role": "user", "content": user_message(req) })))
            .collect::<Vec<_>>()
    });
    let response = http
        .post(endpoint(base, "/api/chat"))
        .json(&body)
        .timeout(ANSWER_TIMEOUT)
        .send()
        .await
        .map_err(|e| unreachable(base, e))?;
    let status = response.status().as_u16();
    let body: Value = response.json().await.unwrap_or(Value::Null);
    if !(200..300).contains(&status) {
        return Err(api_error(status, &body, model));
    }
    let text = body["message"]["content"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("The local model returned no answer."))?;
    suggestion_from_text(text).map_err(|e| {
        if body["done_reason"] == "length" {
            anyhow::anyhow!("The local model's answer was cut off. Try again, or pick a larger model in Settings.")
        } else {
            e
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// A tiny stand-in for the Ollama HTTP API. Returns its base URL.
    async fn fake_ollama() -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            while let Ok((mut sock, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let mut buf = Vec::new();
                    let mut chunk = [0u8; 4096];
                    // Read headers, then the body announced by Content-Length.
                    let (head_end, len) = loop {
                        let n = sock.read(&mut chunk).await.unwrap();
                        buf.extend_from_slice(&chunk[..n]);
                        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                            let head = String::from_utf8_lossy(&buf[..i]).to_lowercase();
                            let len = head
                                .lines()
                                .find_map(|l| l.strip_prefix("content-length:"))
                                .map(|v| v.trim().parse::<usize>().unwrap())
                                .unwrap_or(0);
                            break (i + 4, len);
                        }
                    };
                    while buf.len() < head_end + len {
                        let n = sock.read(&mut chunk).await.unwrap();
                        buf.extend_from_slice(&chunk[..n]);
                    }
                    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
                    let body: Value = serde_json::from_slice(&buf[head_end..]).unwrap_or(Value::Null);
                    let (status, payload) = if head.starts_with("GET /api/tags") {
                        (200, r#"{"models":[{"name":"qwen2.5-coder:3b","size":1900000000},{"name":"llama3.2:1b","size":1300000000}]}"#.to_string())
                    } else if head.starts_with("POST /api/pull") {
                        (200, [
                            r#"{"status":"pulling manifest"}"#,
                            r#"{"status":"pulling abc","total":100,"completed":40}"#,
                            r#"{"status":"pulling abc","total":100,"completed":100}"#,
                            r#"{"status":"success"}"#,
                        ].join("\n") + "\n")
                    } else if body["model"] == "missing" {
                        (404, r#"{"error":"model \"missing\" not found, try pulling it first"}"#.to_string())
                    } else {
                        assert_eq!(body["format"]["required"][0], "command");
                        let messages = body["messages"].as_array().unwrap();
                        assert_eq!(messages[0]["role"], "system");
                        assert_eq!(messages.last().unwrap()["role"], "user");
                        // Every example answer must itself be a valid suggestion.
                        for m in messages.iter().filter(|m| m["role"] == "assistant") {
                            crate::ai::suggestion_from_text(m["content"].as_str().unwrap()).unwrap();
                        }
                        let content = r#"{"command":"sudo rm -rf /tmp/cache","explanation":"Keshni o'chiradi.","dangerous":false}"#;
                        (200, json!({"message": {"role": "assistant", "content": content}, "done": true}).to_string())
                    };
                    let reply = format!(
                        "HTTP/1.1 {status} OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{payload}",
                        payload.len()
                    );
                    sock.write_all(reply.as_bytes()).await.unwrap();
                });
            }
        });
        base
    }

    fn req() -> SuggestRequest {
        SuggestRequest {
            prompt: "keshni tozala".into(),
            os: Some("local".into()),
            current_line: None,
            recent_output: None,
        }
    }

    #[tokio::test]
    async fn lists_pulls_and_suggests() {
        let base = fake_ollama().await;
        let http = reqwest::Client::new();

        let models = list_models(&http, &base).await.unwrap();
        assert_eq!(models[0].name, "llama3.2:1b", "sorted by name");

        let mut seen = Vec::new();
        pull(&http, &base, "qwen2.5-coder:3b", |p| seen.push((p.status, p.completed, p.total)))
            .await
            .unwrap();
        assert!(seen.contains(&("pulling abc".into(), 40, 100)));
        assert_eq!(seen.last().unwrap().0, "success");

        let s = suggest(&http, &base, "qwen2.5-coder:3b", &req()).await.unwrap();
        assert_eq!(s.command, "sudo rm -rf /tmp/cache");
        assert!(s.dangerous, "rm -rf must be flagged even though the model said false");
    }

    #[tokio::test]
    async fn explains_missing_model_and_stopped_server() {
        let base = fake_ollama().await;
        let http = reqwest::Client::new();
        let e = suggest(&http, &base, "missing", &req()).await.unwrap_err().to_string();
        assert!(e.contains("not downloaded"), "{e}");

        let closed = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let dead = format!("http://{}", closed.local_addr().unwrap());
        drop(closed);
        let e = list_models(&http, &dead).await.unwrap_err().to_string();
        assert!(e.contains("Ollama is not running"), "{e}");
    }

    /// Needs a running Ollama: `OLLAMA_TEST_URL=http://127.0.0.1:11434
    /// OLLAMA_TEST_MODEL=qwen2.5-coder:0.5b cargo test -- --ignored real_ollama`
    #[tokio::test]
    #[ignore]
    async fn real_ollama() {
        let base = std::env::var("OLLAMA_TEST_URL").unwrap_or_else(|_| DEFAULT_URL.into());
        let model = std::env::var("OLLAMA_TEST_MODEL").expect("OLLAMA_TEST_MODEL");
        let http = reqwest::Client::new();

        let mut statuses = Vec::new();
        pull(&http, &base, &model, |p| statuses.push(p.status)).await.unwrap();
        assert_eq!(statuses.last().map(String::as_str), Some("success"));
        assert!(list_models(&http, &base).await.unwrap().iter().any(|m| m.name == model));

        for (prompt, os) in [
            ("show disk usage of all filesystems in human readable form", "ubuntu"),
            ("eng ko'p xotira ishlatayotgan 5 ta jarayonni ko'rsat", "ubuntu"),
            ("docker konteynerlarni ro'yxatini chiqar", "ubuntu"),
            ("найди файлы больше 100 мегабайт", "ubuntu"),
            ("list listening TCP ports", "local"),
        ] {
            let started = std::time::Instant::now();
            let s = suggest(
                &http,
                &base,
                &model,
                &SuggestRequest {
                    prompt: prompt.into(),
                    os: Some(os.into()),
                    current_line: None,
                    recent_output: None,
                },
            )
            .await
            .unwrap();
            println!("{prompt:?} -> {:?} ({:.1}s) — {}", s.command, started.elapsed().as_secs_f32(), s.explanation);
            assert!(!s.command.is_empty());
        }
    }
}
