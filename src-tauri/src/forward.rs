//! Port forwarding: local (`ssh -L`) and dynamic SOCKS5 (`ssh -D`).
//!
//! Each running rule owns one SSH connection and a local TCP listener; every
//! accepted socket is piped through its own `direct-tcpip` channel.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

use crate::conn::{establish, ConnectContext, ConnectRequest, Connection};
use crate::store::ForwardKind;

#[derive(Debug, Clone)]
pub struct ForwardSpec {
    pub kind: ForwardKind,
    pub bind_host: String,
    pub bind_port: u16,
    pub dest_host: Option<String>,
    pub dest_port: Option<u16>,
}

struct Running {
    listener: JoinHandle<()>,
    conn: Arc<Connection>,
    bound: SocketAddr,
}

#[derive(Default)]
pub struct ForwardManager {
    running: Mutex<HashMap<String, Running>>,
}

impl ForwardManager {
    /// Starts forwarding for `rule_id` and returns the address actually bound.
    pub async fn start(
        &self,
        rule_id: String,
        req: ConnectRequest,
        ctx: &ConnectContext,
        spec: ForwardSpec,
    ) -> anyhow::Result<SocketAddr> {
        if self.running.lock().await.contains_key(&rule_id) {
            anyhow::bail!("this forward is already running");
        }
        if spec.kind == ForwardKind::Local && (spec.dest_host.is_none() || spec.dest_port.is_none())
        {
            anyhow::bail!("local forwarding needs a destination host and port");
        }
        let listener = TcpListener::bind((spec.bind_host.as_str(), spec.bind_port))
            .await
            .map_err(|e| anyhow::anyhow!("cannot listen on {}:{}: {e}", spec.bind_host, spec.bind_port))?;
        let bound = listener.local_addr()?;
        let conn = Arc::new(establish(req, ctx).await?);

        let task_conn = conn.clone();
        let task = tokio::spawn(async move {
            while let Ok((socket, peer)) = listener.accept().await {
                let conn = task_conn.clone();
                let spec = spec.clone();
                tokio::spawn(async move {
                    let _ = serve(socket, peer, &conn, &spec).await;
                });
            }
        });

        self.running.lock().await.insert(
            rule_id,
            Running {
                listener: task,
                conn,
                bound,
            },
        );
        Ok(bound)
    }

    pub async fn stop(&self, rule_id: &str) {
        if let Some(r) = self.running.lock().await.remove(rule_id) {
            r.listener.abort();
            r.conn.disconnect().await;
        }
    }

    /// Ids of running rules with the address each is bound to.
    pub async fn active(&self) -> HashMap<String, String> {
        self.running
            .lock()
            .await
            .iter()
            .map(|(id, r)| (id.clone(), r.bound.to_string()))
            .collect()
    }
}

async fn serve(
    mut socket: TcpStream,
    peer: SocketAddr,
    conn: &Connection,
    spec: &ForwardSpec,
) -> anyhow::Result<()> {
    let (host, port) = match spec.kind {
        ForwardKind::Local => (
            spec.dest_host.clone().unwrap_or_default(),
            spec.dest_port.unwrap_or_default(),
        ),
        ForwardKind::Dynamic => socks5_handshake(&mut socket).await?,
    };
    let channel = conn
        .handle
        .channel_open_direct_tcpip(host, port as u32, peer.ip().to_string(), peer.port() as u32)
        .await;
    let channel = match (spec.kind, channel) {
        (ForwardKind::Dynamic, Ok(ch)) => {
            socket.write_all(&socks5_reply(0)).await?;
            ch
        }
        (ForwardKind::Dynamic, Err(e)) => {
            socket.write_all(&socks5_reply(5)).await?;
            return Err(e.into());
        }
        (ForwardKind::Local, ch) => ch?,
    };
    let mut stream = channel.into_stream();
    tokio::io::copy_bidirectional(&mut socket, &mut stream).await?;
    Ok(())
}

/// Minimal SOCKS5 server side (RFC 1928): no auth, CONNECT only.
async fn socks5_handshake(socket: &mut TcpStream) -> anyhow::Result<(String, u16)> {
    let mut head = [0u8; 2];
    socket.read_exact(&mut head).await?;
    if head[0] != 5 {
        anyhow::bail!("not a SOCKS5 client");
    }
    let mut methods = vec![0u8; head[1] as usize];
    socket.read_exact(&mut methods).await?;
    if !methods.contains(&0) {
        socket.write_all(&[5, 0xff]).await?;
        anyhow::bail!("SOCKS client requires authentication");
    }
    socket.write_all(&[5, 0]).await?;

    let mut req = [0u8; 4];
    socket.read_exact(&mut req).await?;
    if req[1] != 1 {
        socket.write_all(&socks5_reply(7)).await?;
        anyhow::bail!("only SOCKS CONNECT is supported");
    }
    let host = match req[3] {
        1 => {
            let mut ip = [0u8; 4];
            socket.read_exact(&mut ip).await?;
            std::net::Ipv4Addr::from(ip).to_string()
        }
        3 => {
            let len = socket.read_u8().await? as usize;
            let mut name = vec![0u8; len];
            socket.read_exact(&mut name).await?;
            String::from_utf8(name)?
        }
        4 => {
            let mut ip = [0u8; 16];
            socket.read_exact(&mut ip).await?;
            std::net::Ipv6Addr::from(ip).to_string()
        }
        _ => {
            socket.write_all(&socks5_reply(8)).await?;
            anyhow::bail!("unsupported SOCKS address type");
        }
    };
    let port = socket.read_u16().await?;
    Ok((host, port))
}

fn socks5_reply(status: u8) -> [u8; 10] {
    [5, status, 0, 1, 0, 0, 0, 0, 0, 0]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::conn::testing;

    /// A local TCP server that answers every connection with "pong:<input>".
    async fn echo_server() -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut s, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let mut buf = [0u8; 64];
                    let n = s.read(&mut buf).await.unwrap();
                    s.write_all(b"pong:").await.unwrap();
                    s.write_all(&buf[..n]).await.unwrap();
                });
            }
        });
        port
    }

    async fn roundtrip(mut s: TcpStream) -> String {
        s.write_all(b"ping").await.unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).await.unwrap();
        out
    }

    /// Runs against a real sshd, see `conn::testing::target_from_env`.
    #[tokio::test]
    #[ignore]
    async fn local_and_dynamic_forwarding() {
        let ctx = testing::context();
        let echo_port = echo_server().await;
        let manager = ForwardManager::default();

        let local = manager
            .start(
                "local".into(),
                testing::request(),
                &ctx,
                ForwardSpec {
                    kind: ForwardKind::Local,
                    bind_host: "127.0.0.1".into(),
                    bind_port: 0,
                    dest_host: Some("127.0.0.1".into()),
                    dest_port: Some(echo_port),
                },
            )
            .await
            .unwrap();
        let out = roundtrip(TcpStream::connect(local).await.unwrap()).await;
        assert_eq!(out, "pong:ping");

        let socks = manager
            .start(
                "socks".into(),
                testing::request(),
                &ctx,
                ForwardSpec {
                    kind: ForwardKind::Dynamic,
                    bind_host: "127.0.0.1".into(),
                    bind_port: 0,
                    dest_host: None,
                    dest_port: None,
                },
            )
            .await
            .unwrap();
        let mut s = TcpStream::connect(socks).await.unwrap();
        s.write_all(&[5, 1, 0]).await.unwrap();
        let mut greet = [0u8; 2];
        s.read_exact(&mut greet).await.unwrap();
        assert_eq!(greet, [5, 0]);
        let mut req = vec![5, 1, 0, 3, 9];
        req.extend_from_slice(b"localhost");
        req.extend_from_slice(&echo_port.to_be_bytes());
        s.write_all(&req).await.unwrap();
        let mut reply = [0u8; 10];
        s.read_exact(&mut reply).await.unwrap();
        assert_eq!(reply[1], 0, "SOCKS connect failed");
        assert_eq!(roundtrip(s).await, "pong:ping");

        assert_eq!(manager.active().await.len(), 2);
        manager.stop("local").await;
        manager.stop("socks").await;
        assert!(manager.active().await.is_empty());
        assert!(TcpStream::connect(local).await.is_err(), "listener still open");
    }
}
