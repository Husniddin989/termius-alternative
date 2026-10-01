//! Interactive SSH sessions backed by russh.
//!
//! Each session runs in its own tokio task that owns the SSH channel. The
//! frontend talks to it through an mpsc sender (input, resize, close) and
//! receives terminal output through a Tauri IPC channel.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use russh::keys::{self, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh::{client, ChannelMsg, Disconnect};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tokio::sync::{mpsc, Mutex};

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Auth {
    Password { password: String },
    #[serde(rename_all = "camelCase")]
    Key {
        key_path: String,
        passphrase: Option<String>,
    },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectRequest {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: Auth,
    pub cols: u32,
    pub rows: u32,
}

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

#[derive(Default)]
pub struct SessionManager {
    sessions: Mutex<HashMap<String, mpsc::UnboundedSender<Command>>>,
}

struct ClientHandler {
    host: String,
    port: u16,
    known_hosts: PathBuf,
}

impl client::Handler for ClientHandler {
    type Error = anyhow::Error;

    /// Trust-on-first-use: unknown hosts are recorded, changed keys are rejected.
    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let key = match server_public_key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key,
            PublicKeyOrCertificate::Certificate(_) => {
                anyhow::bail!("host certificates are not supported yet")
            }
        };
        match keys::check_known_hosts_path(&self.host, self.port, key, &self.known_hosts) {
            Ok(true) => Ok(true),
            Ok(false) => {
                keys::known_hosts::learn_known_hosts_path(
                    &self.host,
                    self.port,
                    key,
                    &self.known_hosts,
                )?;
                Ok(true)
            }
            Err(keys::Error::KeyChanged { line }) => anyhow::bail!(
                "HOST KEY CHANGED for {}:{} (known_hosts line {line}). \
                 Possible man-in-the-middle attack — connection refused.",
                self.host,
                self.port
            ),
            Err(e) => Err(e.into()),
        }
    }
}

impl SessionManager {
    pub async fn connect(
        &self,
        req: ConnectRequest,
        known_hosts: PathBuf,
        on_event: Channel<SshEvent>,
    ) -> anyhow::Result<String> {
        let config = Arc::new(client::Config {
            keepalive_interval: Some(Duration::from_secs(30)),
            ..Default::default()
        });
        let handler = ClientHandler {
            host: req.host.clone(),
            port: req.port,
            known_hosts,
        };

        let mut handle = tokio::time::timeout(
            Duration::from_secs(15),
            client::connect(config, (req.host.as_str(), req.port), handler),
        )
        .await
        .map_err(|_| anyhow::anyhow!("connection timed out"))??;

        let auth = match req.auth {
            Auth::Password { password } => {
                handle.authenticate_password(&req.username, password).await?
            }
            Auth::Key {
                key_path,
                passphrase,
            } => {
                let key = keys::load_secret_key(expand_home(&key_path), passphrase.as_deref())?;
                let hash = handle.best_supported_rsa_hash().await?.flatten();
                handle
                    .authenticate_publickey(
                        &req.username,
                        PrivateKeyWithHashAlg::new(Arc::new(key), hash),
                    )
                    .await?
            }
        };
        if !auth.success() {
            anyhow::bail!("authentication failed");
        }

        let mut channel = handle.channel_open_session().await?;
        channel
            .request_pty(false, "xterm-256color", req.cols, req.rows, 0, 0, &[])
            .await?;
        channel.request_shell(false).await?;

        let id = uuid::Uuid::new_v4().to_string();
        let (tx, mut rx) = mpsc::unbounded_channel::<Command>();
        self.sessions.lock().await.insert(id.clone(), tx);

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
            let _ = channel.close().await;
            let _ = handle
                .disconnect(Disconnect::ByApplication, "", "en")
                .await;
            let _ = on_event.send(SshEvent::Closed { reason });
        });

        Ok(id)
    }

    async fn send(&self, id: &str, cmd: Command) -> anyhow::Result<()> {
        let sessions = self.sessions.lock().await;
        let tx = sessions
            .get(id)
            .ok_or_else(|| anyhow::anyhow!("unknown session {id}"))?;
        tx.send(cmd)
            .map_err(|_| anyhow::anyhow!("session {id} is closed"))
    }

    pub async fn write(&self, id: &str, data: Vec<u8>) -> anyhow::Result<()> {
        self.send(id, Command::Input(data)).await
    }

    pub async fn resize(&self, id: &str, cols: u32, rows: u32) -> anyhow::Result<()> {
        self.send(id, Command::Resize { cols, rows }).await
    }

    pub async fn close(&self, id: &str) -> anyhow::Result<()> {
        if let Some(tx) = self.sessions.lock().await.remove(id) {
            let _ = tx.send(Command::Close);
        }
        Ok(())
    }
}

fn expand_home(path: &str) -> PathBuf {
    match path.strip_prefix("~/") {
        Some(rest) => std::env::home_dir()
            .map(|home| home.join(rest))
            .unwrap_or_else(|| PathBuf::from(path)),
        None => PathBuf::from(path),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;
    use tauri::ipc::InvokeResponseBody;

    /// Runs against a real sshd. Example:
    /// `SSH_TEST_ADDR=127.0.0.1:2222 SSH_TEST_USER=tester SSH_TEST_PASSWORD=... cargo test -- --ignored`
    #[tokio::test]
    #[ignore]
    async fn password_shell_roundtrip() {
        let addr = std::env::var("SSH_TEST_ADDR").expect("SSH_TEST_ADDR");
        let (host, port) = addr.rsplit_once(':').unwrap();
        let output = Arc::new(StdMutex::new(String::new()));
        let sink = output.clone();
        let channel = Channel::new(move |body| {
            if let InvokeResponseBody::Json(json) = body {
                sink.lock().unwrap().push_str(&json);
            }
            Ok(())
        });

        let known_hosts = std::env::temp_dir().join(format!("kh-{}", uuid::Uuid::new_v4()));
        let manager = SessionManager::default();
        let request = ConnectRequest {
            host: host.into(),
            port: port.parse().unwrap(),
            username: std::env::var("SSH_TEST_USER").unwrap(),
            auth: Auth::Password {
                password: std::env::var("SSH_TEST_PASSWORD").unwrap(),
            },
            cols: 80,
            rows: 24,
        };
        let id = manager
            .connect(request.clone(), known_hosts.clone(), channel)
            .await
            .unwrap();
        manager.resize(&id, 100, 30).await.unwrap();
        manager
            .write(&id, b"stty size; echo hello-$((40+2)); exit\n".to_vec())
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_secs(2)).await;

        let text = output.lock().unwrap().clone();
        let bytes: Vec<u8> = text
            .split(|c: char| !c.is_ascii_digit())
            .filter_map(|n| n.parse::<u8>().ok())
            .collect();
        let shown = String::from_utf8_lossy(&bytes);
        assert!(shown.contains("hello-42"), "missing command output");
        assert!(shown.contains("30 100"), "pty resize not applied");
        assert!(text.contains("closed"), "no close event: {text}");

        // The host key was learned on first use, so a reconnect is trusted.
        let again = Channel::new(|_| Ok(()));
        manager.connect(request, known_hosts, again).await.unwrap();
    }
}
