//! Local terminal sessions: the user's own shell in a pseudo-terminal.
//!
//! Output is delivered through the same `SshEvent` channel as remote shells,
//! so the frontend renders both the same way. Desktop only — mobile builds
//! report that local terminals are unavailable.

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod imp {
    use std::collections::HashMap;
    use std::io::{Read, Write};
    use std::sync::{Arc, Mutex};

    use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
    use tauri::ipc::Channel;

    use crate::ssh::SshEvent;

    struct Pty {
        master: Box<dyn MasterPty + Send>,
        writer: Box<dyn Write + Send>,
        child: Box<dyn Child + Send + Sync>,
    }

    type Ptys = Arc<Mutex<HashMap<String, Pty>>>;

    #[derive(Default)]
    pub struct LocalTerminals {
        ptys: Ptys,
    }

    fn size(cols: u32, rows: u32) -> PtySize {
        PtySize {
            rows: rows.clamp(1, u16::MAX as u32) as u16,
            cols: cols.clamp(1, u16::MAX as u32) as u16,
            pixel_width: 0,
            pixel_height: 0,
        }
    }

    impl LocalTerminals {
        /// Starts the user's login shell in their home directory.
        pub fn open(&self, cols: u32, rows: u32, on_event: Channel<SshEvent>) -> anyhow::Result<String> {
            let pair = native_pty_system().openpty(size(cols, rows))?;
            let mut cmd = CommandBuilder::new_default_prog();
            if let Some(home) = std::env::home_dir() {
                cmd.cwd(home);
            }
            cmd.env("TERM", "xterm-256color");
            cmd.env("COLORTERM", "truecolor");
            let child = pair.slave.spawn_command(cmd)?;
            // The slave end must be closed in this process, or reads never see EOF.
            drop(pair.slave);

            let mut reader = pair.master.try_clone_reader()?;
            let writer = pair.master.take_writer()?;
            let id = uuid::Uuid::new_v4().to_string();
            self.ptys.lock().unwrap().insert(
                id.clone(),
                Pty {
                    master: pair.master,
                    writer,
                    child,
                },
            );

            let ptys = self.ptys.clone();
            let session_id = id.clone();
            std::thread::spawn(move || {
                let mut buf = [0u8; 16 * 1024];
                let reason = loop {
                    match reader.read(&mut buf) {
                        Ok(0) => break None,
                        Ok(n) => {
                            if on_event.send(SshEvent::Data(buf[..n].to_vec())).is_err() {
                                break None;
                            }
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                        // EIO is how Linux reports that the shell exited.
                        Err(_) => break None,
                    }
                };
                let status = ptys
                    .lock()
                    .unwrap()
                    .remove(&session_id)
                    .and_then(|mut p| p.child.wait().ok())
                    .map(|s| format!("exit status {}", s.exit_code()));
                let _ = on_event.send(SshEvent::Closed {
                    reason: reason.or(status),
                });
            });
            Ok(id)
        }

        fn with<T>(&self, id: &str, f: impl FnOnce(&mut Pty) -> anyhow::Result<T>) -> anyhow::Result<T> {
            let mut ptys = self.ptys.lock().unwrap();
            let pty = ptys
                .get_mut(id)
                .ok_or_else(|| anyhow::anyhow!("terminal {id} is closed"))?;
            f(pty)
        }

        pub fn write(&self, id: &str, data: &[u8]) -> anyhow::Result<()> {
            self.with(id, |p| {
                p.writer.write_all(data)?;
                p.writer.flush()?;
                Ok(())
            })
        }

        pub fn resize(&self, id: &str, cols: u32, rows: u32) -> anyhow::Result<()> {
            self.with(id, |p| p.master.resize(size(cols, rows)))
        }

        pub fn close(&self, id: &str) {
            if let Some(mut p) = self.ptys.lock().unwrap().remove(id) {
                let _ = p.child.kill();
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::sync::Mutex as StdMutex;
        use std::time::Duration;
        use tauri::ipc::InvokeResponseBody;

        #[test]
        fn runs_a_command_in_the_local_shell() {
            let output = Arc::new(StdMutex::new(String::new()));
            let sink = output.clone();
            let channel = Channel::new(move |body| {
                if let InvokeResponseBody::Json(json) = body {
                    sink.lock().unwrap().push_str(&json);
                }
                Ok(())
            });
            let terms = LocalTerminals::default();
            let id = terms.open(80, 24, channel).unwrap();
            terms.resize(&id, 100, 30).unwrap();
            terms.write(&id, b"echo local-$((20+22)); exit\n").unwrap();

            let mut text = String::new();
            for _ in 0..50 {
                std::thread::sleep(Duration::from_millis(100));
                text = output.lock().unwrap().clone();
                if text.contains("closed") {
                    break;
                }
            }
            let bytes: Vec<u8> = text
                .split(|c: char| !c.is_ascii_digit())
                .filter_map(|n| n.parse::<u8>().ok())
                .collect();
            assert!(String::from_utf8_lossy(&bytes).contains("local-42"), "no command output");
            assert!(text.contains("closed"), "shell exit not reported");
            assert!(terms.ptys.lock().unwrap().is_empty());
        }
    }
}

#[cfg(any(target_os = "android", target_os = "ios"))]
mod imp {
    use tauri::ipc::Channel;

    use crate::ssh::SshEvent;

    #[derive(Default)]
    pub struct LocalTerminals;

    const UNSUPPORTED: &str = "local terminals are not available on mobile";

    impl LocalTerminals {
        pub fn open(&self, _: u32, _: u32, _: Channel<SshEvent>) -> anyhow::Result<String> {
            anyhow::bail!(UNSUPPORTED)
        }
        pub fn write(&self, _: &str, _: &[u8]) -> anyhow::Result<()> {
            anyhow::bail!(UNSUPPORTED)
        }
        pub fn resize(&self, _: &str, _: u32, _: u32) -> anyhow::Result<()> {
            anyhow::bail!(UNSUPPORTED)
        }
        pub fn close(&self, _: &str) {}
    }
}

pub use imp::LocalTerminals;
