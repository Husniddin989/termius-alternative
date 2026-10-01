//! Interactive SSH shell sessions.
//!
//! Each session runs in its own tokio task that owns the SSH channel. The
//! frontend talks to it through an mpsc sender (input, resize, close) and
//! receives terminal output through a Tauri IPC channel.

use std::collections::HashMap;
use std::sync::Arc;

use russh::ChannelMsg;
use serde::Serialize;
use tauri::ipc::Channel;
use tokio::sync::{mpsc, Mutex};

use crate::conn::{establish, ConnectContext, ConnectRequest};

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "event", content = "data", rename_all = "camelCase")]
pub enum SshEvent {
    Data(Vec<u8>),
    Closed { reason: Option<String> },
}

enum Command {
    Input(Vec<u8>),
    Resize { cols: u32, rows: u32 },
    Close,
}

type Sessions = Arc<Mutex<HashMap<String, mpsc::UnboundedSender<Command>>>>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Opened {
    pub id: String,
    pub os: Option<String>,
}

#[derive(Default)]
pub struct SessionManager {
    sessions: Sessions,
}

impl SessionManager {
    pub async fn open(
        &self,
        req: ConnectRequest,
        ctx: &ConnectContext,
        cols: u32,
        rows: u32,
        on_event: Channel<SshEvent>,
    ) -> anyhow::Result<Opened> {
        let conn = establish(req, ctx).await?;
        let os = conn.detect_os().await;
        let mut channel = conn.handle.channel_open_session().await?;
        channel
            .request_pty(false, "xterm-256color", cols, rows, 0, 0, &[])
            .await?;
        channel.request_shell(false).await?;

        let id = uuid::Uuid::new_v4().to_string();
        let (tx, mut rx) = mpsc::unbounded_channel::<Command>();
        self.sessions.lock().await.insert(id.clone(), tx);

        let sessions = self.sessions.clone();
        let session_id = id.clone();
        tokio::spawn(async move {
            let reason = loop {
                tokio::select! {
                    cmd = rx.recv() => match cmd {
                        Some(Command::Input(bytes)) => {
                            if let Err(e) = channel.data(&bytes[..]).await {
                                break Some(e.to_string());
                            }
                        }
                        Some(Command::Resize { cols, rows }) => {
                            let _ = channel.window_change(cols, rows, 0, 0).await;
                        }
                        Some(Command::Close) | None => break None,
                    },
                    msg = channel.wait() => match msg {
                        Some(ChannelMsg::Data { data })
                        | Some(ChannelMsg::ExtendedData { data, .. }) => {
                            if on_event.send(SshEvent::Data(data.to_vec())).is_err() {
                                break None;
                            }
                        }
                        Some(ChannelMsg::ExitStatus { exit_status }) => {
                            break Some(format!("exit status {exit_status}"));
                        }
                        Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break None,
                        Some(_) => {}
                    },
                }
            };
            sessions.lock().await.remove(&session_id);
            let _ = channel.close().await;
            conn.disconnect().await;
            let _ = on_event.send(SshEvent::Closed { reason });
        });

        Ok(Opened { id, os })
    }

    async fn send(&self, id: &str, cmd: Command) -> anyhow::Result<()> {
        let sessions = self.sessions.lock().await;
        let tx = sessions
            .get(id)
            .ok_or_else(|| anyhow::anyhow!("session {id} is closed"))?;
        tx.send(cmd)
            .map_err(|_| anyhow::anyhow!("session {id} is closed"))
    }

    pub async fn write(&self, id: &str, data: Vec<u8>) -> anyhow::Result<()> {
        self.send(id, Command::Input(data)).await
    }

    pub async fn resize(&self, id: &str, cols: u32, rows: u32) -> anyhow::Result<()> {
        self.send(id, Command::Resize { cols, rows }).await
    }

    pub async fn close(&self, id: &str) {
        if let Some(tx) = self.sessions.lock().await.remove(id) {
            let _ = tx.send(Command::Close);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::conn::testing;
    use std::sync::Mutex as StdMutex;
    use std::time::Duration;
    use tauri::ipc::InvokeResponseBody;

    fn collecting_channel() -> (Channel<SshEvent>, Arc<StdMutex<String>>) {
        let output = Arc::new(StdMutex::new(String::new()));
        let sink = output.clone();
        let channel = Channel::new(move |body| {
            if let InvokeResponseBody::Json(json) = body {
                sink.lock().unwrap().push_str(&json);
            }
            Ok(())
        });
        (channel, output)
    }

    /// Decodes the JSON byte arrays of `Data` events back into text.
    fn decoded(json: &str) -> String {
        let bytes: Vec<u8> = json
            .split(|c: char| !c.is_ascii_digit())
            .filter_map(|n| n.parse::<u8>().ok())
            .collect();
        String::from_utf8_lossy(&bytes).into_owned()
    }

    /// Runs against a real sshd, see `conn::testing::target_from_env`.
    #[tokio::test]
    #[ignore]
    async fn password_shell_roundtrip() {
        let ctx = testing::context();
        let (channel, output) = collecting_channel();
        let manager = SessionManager::default();
        let Opened { id, os } = manager
            .open(testing::request(), &ctx, 80, 24, channel)
            .await
            .unwrap();
        assert!(os.is_some(), "OS not detected");
        manager.resize(&id, 100, 30).await.unwrap();
        manager
            .write(&id, b"stty size; echo hello-$((40+2)); exit\n".to_vec())
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_secs(2)).await;

        let text = output.lock().unwrap().clone();
        let shown = decoded(&text);
        assert!(shown.contains("hello-42"), "missing command output");
        assert!(shown.contains("30 100"), "pty resize not applied");
        assert!(text.contains("closed"), "no close event: {text}");
        assert!(manager.sessions.lock().await.is_empty(), "session not cleaned up");

        // The host key was learned on first use, so a reconnect is trusted.
        manager
            .open(testing::request(), &ctx, 80, 24, Channel::new(|_| Ok(())))
            .await
            .unwrap();
    }

    #[tokio::test]
    #[ignore]
    async fn shell_through_jump_host() {
        let ctx = testing::context();
        let (channel, output) = collecting_channel();
        let mut req = testing::request();
        req.jump = Some(testing::target_from_env());
        req.target.host = "localhost".into();
        let manager = SessionManager::default();
        let id = manager.open(req, &ctx, 80, 24, channel).await.unwrap().id;
        manager
            .write(&id, b"echo via-$((1+1))-jump; exit\n".to_vec())
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_secs(2)).await;
        assert!(decoded(&output.lock().unwrap()).contains("via-2-jump"));
    }
}
