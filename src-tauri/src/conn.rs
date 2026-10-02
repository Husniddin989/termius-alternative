//! Establishing authenticated SSH connections, optionally through a jump host.
//!
//! Terminal sessions, SFTP and port forwarding all go through `establish`.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use russh::keys::{self, HashAlg, PrivateKeyWithHashAlg, PublicKey, PublicKeyOrCertificate};
use russh::{client, Disconnect};
use serde::{Deserialize, Serialize};

use crate::keyfiles;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Auth {
    Password {
        password: String,
    },
    #[serde(rename_all = "camelCase")]
    Key {
        key_path: String,
        passphrase: Option<String>,
    },
    /// Keys held by the running SSH agent (`SSH_AUTH_SOCK`, or the OpenSSH
    /// agent pipe on Windows).
    Agent,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: Auth,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectRequest {
    pub target: Target,
    #[serde(default)]
    pub jump: Option<Target>,
}

/// Shown to the user before trusting a host key seen for the first time.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyInfo {
    pub host: String,
    pub port: u16,
    pub algorithm: String,
    pub fingerprint: String,
}

#[async_trait]
pub trait HostKeyVerifier: Send + Sync {
    /// Returns true if the user trusts this previously unknown host key.
    async fn confirm_new_host(&self, info: HostKeyInfo) -> bool;
}

#[derive(Clone)]
pub struct ConnectContext {
    pub known_hosts: PathBuf,
    /// Key files received through sync (see keyfiles.rs).
    pub synced_keys: PathBuf,
    pub verifier: Arc<dyn HostKeyVerifier>,
}

pub struct ClientHandler {
    host: String,
    port: u16,
    ctx: ConnectContext,
}

impl client::Handler for ClientHandler {
    type Error = anyhow::Error;

    /// Known keys must match; unknown keys are recorded once the user accepts them.
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
        match keys::check_known_hosts_path(&self.host, self.port, key, &self.ctx.known_hosts) {
            Ok(true) => Ok(true),
            Ok(false) => {
                let info = HostKeyInfo {
                    host: self.host.clone(),
                    port: self.port,
                    algorithm: key.algorithm().to_string(),
                    fingerprint: key.fingerprint(HashAlg::Sha256).to_string(),
                };
                if !self.ctx.verifier.confirm_new_host(info).await {
                    anyhow::bail!("host key for {}:{} was not accepted", self.host, self.port);
                }
                keys::known_hosts::learn_known_hosts_path(
                    &self.host,
                    self.port,
                    key,
                    &self.ctx.known_hosts,
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

pub type Handle = client::Handle<ClientHandler>;

/// An authenticated connection. Keeps the jump-host connection (if any) alive
/// for as long as the tunnelled one is in use.
pub struct Connection {
    pub handle: Handle,
    jump: Option<Handle>,
}

impl Connection {
    /// Best-effort guess of the remote OS: the `ID` from /etc/os-release
    /// (lowercased), or the kernel name from `uname` on systems without it.
    pub async fn detect_os(&self) -> Option<String> {
        let out = self
            .exec(
                "sh -c '. /etc/os-release 2>/dev/null && echo \"$ID\" || uname -s'",
                Duration::from_secs(4),
                64,
            )
            .await?;
        let id = out.trim().to_lowercase();
        let valid = !id.is_empty()
            && id.len() <= 32
            && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
        valid.then_some(id)
    }

    /// Runs a command on a separate channel of this connection and returns
    /// its stdout (at most `max_bytes`), or None on error or timeout.
    pub async fn exec(&self, command: &str, timeout: Duration, max_bytes: usize) -> Option<String> {
        let run = async {
            let mut channel = self.handle.channel_open_session().await.ok()?;
            channel.exec(true, command).await.ok()?;
            let mut out = Vec::new();
            while let Some(msg) = channel.wait().await {
                match msg {
                    russh::ChannelMsg::Data { data } => {
                        out.extend_from_slice(&data);
                        if out.len() >= max_bytes {
                            out.truncate(max_bytes);
                            break;
                        }
                    }
                    russh::ChannelMsg::Eof | russh::ChannelMsg::Close => break,
                    _ => {}
                }
            }
            let _ = channel.close().await;
            Some(String::from_utf8_lossy(&out).into_owned())
        };
        tokio::time::timeout(timeout, run).await.ok().flatten()
    }

    pub async fn disconnect(&self) {
        let _ = self
            .handle
            .disconnect(Disconnect::ByApplication, "", "en")
            .await;
        if let Some(jump) = &self.jump {
            let _ = jump.disconnect(Disconnect::ByApplication, "", "en").await;
        }
    }
}

fn config() -> Arc<client::Config> {
    Arc::new(client::Config {
        // Short enough to keep mobile-carrier NAT mappings open, and to notice
        // a dead connection within a minute.
        keepalive_interval: Some(Duration::from_secs(20)),
        ..Default::default()
    })
}

pub async fn establish(req: ConnectRequest, ctx: &ConnectContext) -> anyhow::Result<Connection> {
    let t = &req.target;
    let handler = ClientHandler {
        host: t.host.clone(),
        port: t.port,
        ctx: ctx.clone(),
    };

    let (mut handle, jump) = match &req.jump {
        None => {
            let handle = with_timeout(client::connect(config(), (t.host.as_str(), t.port), handler))
                .await?;
            (handle, None)
        }
        Some(j) => {
            let mut jump = with_timeout(client::connect(
                config(),
                (j.host.as_str(), j.port),
                ClientHandler {
                    host: j.host.clone(),
                    port: j.port,
                    ctx: ctx.clone(),
                },
            ))
            .await
            .map_err(|e| e.context("jump host"))?;
            authenticate(&mut jump, j, ctx)
                .await
                .map_err(|e| e.context("jump host"))?;
            let tunnel = jump
                .channel_open_direct_tcpip(t.host.clone(), t.port as u32, "127.0.0.1", 0)
                .await
                .map_err(|e| anyhow::anyhow!("could not reach {}:{} through the jump host: {e}", t.host, t.port))?;
            let handle =
                with_timeout(client::connect_stream(config(), tunnel.into_stream(), handler))
                    .await?;
            (handle, Some(jump))
        }
    };

    authenticate(&mut handle, t, ctx).await?;
    Ok(Connection { handle, jump })
}

async fn with_timeout<T>(
    fut: impl std::future::Future<Output = anyhow::Result<T>>,
) -> anyhow::Result<T> {
    tokio::time::timeout(CONNECT_TIMEOUT, fut)
        .await
        .map_err(|_| anyhow::anyhow!("connection timed out"))?
}

async fn authenticate(handle: &mut Handle, t: &Target, ctx: &ConnectContext) -> anyhow::Result<()> {
    let ok = match &t.auth {
        Auth::Password { password } => handle
            .authenticate_password(&t.username, password)
            .await?
            .success(),
        Auth::Key {
            key_path,
            passphrase,
        } => {
            let key = keys::load_secret_key(keyfiles::resolve(&ctx.synced_keys, key_path), passphrase.as_deref())
                .map_err(|e| anyhow::anyhow!("could not load key {key_path}: {e}"))?;
            let hash = handle.best_supported_rsa_hash().await?.flatten();
            handle
                .authenticate_publickey(&t.username, PrivateKeyWithHashAlg::new(Arc::new(key), hash))
                .await?
                .success()
        }
        Auth::Agent => authenticate_agent(handle, &t.username).await?,
    };
    if !ok {
        anyhow::bail!("authentication failed for {}@{}", t.username, t.host);
    }
    Ok(())
}

#[cfg(unix)]
async fn authenticate_agent(handle: &mut Handle, user: &str) -> anyhow::Result<bool> {
    let agent = keys::agent::client::AgentClient::connect_env()
        .await
        .map_err(|e| anyhow::anyhow!("SSH agent unavailable: {e}"))?;
    try_agent_keys(handle, user, agent).await
}

#[cfg(windows)]
async fn authenticate_agent(handle: &mut Handle, user: &str) -> anyhow::Result<bool> {
    let agent = keys::agent::client::AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent")
        .await
        .map_err(|e| anyhow::anyhow!("SSH agent unavailable: {e}"))?;
    try_agent_keys(handle, user, agent).await
}

async fn try_agent_keys<S>(
    handle: &mut Handle,
    user: &str,
    mut agent: keys::agent::client::AgentClient<S>,
) -> anyhow::Result<bool>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send,
{
    let identities = agent.request_identities().await?;
    if identities.is_empty() {
        anyhow::bail!("the SSH agent has no keys loaded (try `ssh-add`)");
    }
    let hash = handle.best_supported_rsa_hash().await?.flatten();
    for identity in identities {
        let key: PublicKey = identity.public_key().into_owned();
        let result = handle
            .authenticate_publickey_with(user, key, hash, &mut agent)
            .await
            .map_err(|e| anyhow::anyhow!("SSH agent error: {e:?}"))?;
        if result.success() {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(test)]
pub mod testing {
    use super::*;

    pub struct AcceptAll;

    #[async_trait]
    impl HostKeyVerifier for AcceptAll {
        async fn confirm_new_host(&self, _: HostKeyInfo) -> bool {
            true
        }
    }

    pub fn context() -> ConnectContext {
        ConnectContext {
            known_hosts: std::env::temp_dir().join(format!("kh-{}", uuid::Uuid::new_v4())),
            synced_keys: std::env::temp_dir().join(format!("keys-{}", uuid::Uuid::new_v4())),
            verifier: Arc::new(AcceptAll),
        }
    }

    /// Reads `SSH_TEST_ADDR`, `SSH_TEST_USER` and `SSH_TEST_PASSWORD`.
    pub fn target_from_env() -> Target {
        let addr = std::env::var("SSH_TEST_ADDR").expect("SSH_TEST_ADDR");
        let (host, port) = addr.rsplit_once(':').unwrap();
        Target {
            host: host.into(),
            port: port.parse().unwrap(),
            username: std::env::var("SSH_TEST_USER").unwrap(),
            auth: Auth::Password {
                password: std::env::var("SSH_TEST_PASSWORD").unwrap(),
            },
        }
    }

    pub fn request() -> ConnectRequest {
        ConnectRequest {
            target: target_from_env(),
            jump: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Needs a running agent (`SSH_AUTH_SOCK`) holding a key the test user accepts.
    #[cfg(unix)]
    #[tokio::test]
    #[ignore]
    async fn agent_authentication() {
        let mut req = testing::request();
        req.target.auth = Auth::Agent;
        let conn = establish(req, &testing::context()).await.unwrap();
        conn.disconnect().await;
    }

    #[tokio::test]
    #[ignore]
    async fn wrong_password_is_reported() {
        let mut req = testing::request();
        req.target.auth = Auth::Password {
            password: "definitely-wrong".into(),
        };
        let e = establish(req, &testing::context()).await.err().unwrap();
        assert!(e.to_string().contains("authentication failed"), "{e:#}");
    }

    #[tokio::test]
    #[ignore]
    async fn rejected_host_key_aborts() {
        struct RejectAll;
        #[async_trait]
        impl HostKeyVerifier for RejectAll {
            async fn confirm_new_host(&self, _: HostKeyInfo) -> bool {
                false
            }
        }
        let mut ctx = testing::context();
        ctx.verifier = Arc::new(RejectAll);
        let e = establish(testing::request(), &ctx).await.err().unwrap();
        assert!(format!("{e:#}").contains("not accepted"), "{e:#}");
        assert!(!ctx.known_hosts.exists(), "rejected key must not be recorded");
    }
}
