//! SFTP file browsing and transfers over a dedicated SSH connection.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::UNIX_EPOCH;

use russh_sftp::client::SftpSession;
use russh_sftp::protocol::FileType;
use serde::Serialize;
use tauri::ipc::Channel;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex;

use crate::conn::{establish, ConnectContext, ConnectRequest, Connection};

const CHUNK: usize = 256 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    /// Seconds since the Unix epoch.
    pub modified: Option<u64>,
    pub permissions: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub done: u64,
    pub total: u64,
}

struct Session {
    sftp: Arc<SftpSession>,
    conn: Connection,
}

#[derive(Default)]
pub struct SftpManager {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Opened {
    pub id: String,
    pub home: String,
}

pub fn join(dir: &str, name: &str) -> String {
    if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

impl SftpManager {
    pub async fn open(&self, req: ConnectRequest, ctx: &ConnectContext) -> anyhow::Result<Opened> {
        let conn = establish(req, ctx).await?;
        let channel = conn.handle.channel_open_session().await?;
        channel.request_subsystem(true, "sftp").await?;
        let sftp = SftpSession::new(channel.into_stream()).await?;
        let home = sftp.canonicalize(".").await?;
        let id = uuid::Uuid::new_v4().to_string();
        self.sessions.lock().await.insert(
            id.clone(),
            Arc::new(Session {
                sftp: Arc::new(sftp),
                conn,
            }),
        );
        Ok(Opened { id, home })
    }

    async fn get(&self, id: &str) -> anyhow::Result<Arc<SftpSession>> {
        self.sessions
            .lock()
            .await
            .get(id)
            .map(|s| s.sftp.clone())
            .ok_or_else(|| anyhow::anyhow!("SFTP session {id} is closed"))
    }

    pub async fn list(&self, id: &str, path: &str) -> anyhow::Result<Vec<Entry>> {
        let sftp = self.get(id).await?;
        let mut entries: Vec<Entry> = sftp
            .read_dir(path)
            .await?
            .filter(|e| e.file_name() != "." && e.file_name() != "..")
            .map(|e| {
                let meta = e.metadata();
                let name = e.file_name();
                Entry {
                    path: join(path, &name),
                    name,
                    is_dir: meta.is_dir(),
                    is_symlink: e.file_type() == FileType::Symlink,
                    size: meta.len(),
                    modified: meta
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                        .map(|d| d.as_secs()),
                    permissions: meta.permissions,
                }
            })
            .collect();
        entries.sort_by(|a, b| {
            b.is_dir
                .cmp(&a.is_dir)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        Ok(entries)
    }

    pub async fn download(
        &self,
        id: &str,
        remote: &str,
        local: &Path,
        progress: Option<Channel<Progress>>,
    ) -> anyhow::Result<()> {
        let sftp = self.get(id).await?;
        let total = sftp.metadata(remote).await?.len();
        let mut src = sftp.open(remote).await?;
        let mut dst = tokio::fs::File::create(local).await?;
        copy(&mut src, &mut dst, total, progress).await?;
        dst.flush().await?;
        Ok(())
    }

    pub async fn upload(
        &self,
        id: &str,
        local: &Path,
        remote: &str,
        progress: Option<Channel<Progress>>,
    ) -> anyhow::Result<()> {
        let sftp = self.get(id).await?;
        let mut src = tokio::fs::File::open(local).await?;
        let total = src.metadata().await?.len();
        let mut dst = sftp.create(remote).await?;
        copy(&mut src, &mut dst, total, progress).await?;
        dst.shutdown().await?;
        Ok(())
    }

    pub async fn mkdir(&self, id: &str, path: &str) -> anyhow::Result<()> {
        Ok(self.get(id).await?.create_dir(path).await?)
    }

    pub async fn rename(&self, id: &str, from: &str, to: &str) -> anyhow::Result<()> {
        Ok(self.get(id).await?.rename(from, to).await?)
    }

    /// Removes a file, or a directory with everything inside it.
    pub async fn remove(&self, id: &str, path: &str, is_dir: bool) -> anyhow::Result<()> {
        let sftp = self.get(id).await?;
        if is_dir {
            remove_tree(&sftp, path).await
        } else {
            Ok(sftp.remove_file(path).await?)
        }
    }

    pub async fn close(&self, id: &str) {
        if let Some(session) = self.sessions.lock().await.remove(id) {
            let _ = session.sftp.close().await;
            session.conn.disconnect().await;
        }
    }
}

async fn remove_tree(sftp: &SftpSession, dir: &str) -> anyhow::Result<()> {
    // Iterative depth-first walk: collect directories, then delete deepest first.
    let mut dirs = vec![dir.to_string()];
    let mut i = 0;
    while i < dirs.len() {
        let current = dirs[i].clone();
        for e in sftp.read_dir(&current).await? {
            let name = e.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let path = join(&current, &name);
            if e.file_type() == FileType::Dir {
                dirs.push(path);
            } else {
                sftp.remove_file(path).await?;
            }
        }
        i += 1;
    }
    for d in dirs.iter().rev() {
        sftp.remove_dir(d).await?;
    }
    Ok(())
}

async fn copy<R, W>(
    src: &mut R,
    dst: &mut W,
    total: u64,
    progress: Option<Channel<Progress>>,
) -> anyhow::Result<()>
where
    R: tokio::io::AsyncRead + Unpin,
    W: tokio::io::AsyncWrite + Unpin,
{
    let mut buf = vec![0u8; CHUNK];
    let mut done = 0u64;
    loop {
        let n = src.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        dst.write_all(&buf[..n]).await?;
        done += n as u64;
        if let Some(p) = &progress {
            let _ = p.send(Progress { done, total });
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::conn::testing;

    #[test]
    fn join_handles_trailing_slash() {
        assert_eq!(join("/", "etc"), "/etc");
        assert_eq!(join("/home/u", "a.txt"), "/home/u/a.txt");
    }

    /// Runs against a real sshd, see `conn::testing::target_from_env`.
    #[tokio::test]
    #[ignore]
    async fn browse_upload_download_remove() {
        let ctx = testing::context();
        let manager = SftpManager::default();
        let Opened { id, home } = manager.open(testing::request(), &ctx).await.unwrap();

        let tmp = std::env::temp_dir().join(format!("sftp-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        let payload: Vec<u8> = (0..700_000u32).map(|i| (i % 251) as u8).collect();
        std::fs::write(tmp.join("up.bin"), &payload).unwrap();

        let dir = join(&home, "sftp-test-dir");
        manager.mkdir(&id, &dir).await.unwrap();
        let remote = join(&dir, "up.bin");
        manager
            .upload(&id, &tmp.join("up.bin"), &remote, None)
            .await
            .unwrap();
        manager
            .mkdir(&id, &join(&dir, "nested"))
            .await
            .unwrap();

        let listing = manager.list(&id, &dir).await.unwrap();
        assert_eq!(listing[0].name, "nested", "directories sort first");
        assert!(listing[0].is_dir);
        assert_eq!(listing[1].size, payload.len() as u64);

        let renamed = join(&dir, "renamed.bin");
        manager.rename(&id, &remote, &renamed).await.unwrap();
        manager
            .download(&id, &renamed, &tmp.join("down.bin"), None)
            .await
            .unwrap();
        assert_eq!(std::fs::read(tmp.join("down.bin")).unwrap(), payload);

        manager.remove(&id, &dir, true).await.unwrap();
        let names: Vec<String> = manager
            .list(&id, &home)
            .await
            .unwrap()
            .into_iter()
            .map(|e| e.name)
            .collect();
        assert!(!names.contains(&"sftp-test-dir".to_string()));
        manager.close(&id).await;
        std::fs::remove_dir_all(tmp).unwrap();
    }
}
