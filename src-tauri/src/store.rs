//! Saved hosts, snippets and port-forwarding rules, each persisted as a JSON
//! array in the app data directory.
//!
//! Secrets (passwords, key passphrases) are never written here; they live in
//! the OS keychain (see `secrets.rs`) or are asked for at connect time.

use std::marker::PhantomData;
use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

pub trait Record: Serialize + DeserializeOwned + Clone {
    fn id(&self) -> &str;
    fn set_id(&mut self, id: String);
    /// Last local edit, in milliseconds since the Unix epoch (0 = unknown);
    /// sync keeps the newer copy of a record edited on two devices.
    fn updated_at(&self) -> i64;
    fn set_updated_at(&mut self, at: i64);
}

/// Milliseconds since the Unix epoch.
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

macro_rules! record {
    ($t:ty) => {
        impl Record for $t {
            fn id(&self) -> &str {
                &self.id
            }
            fn set_id(&mut self, id: String) {
                self.id = id;
            }
            fn updated_at(&self) -> i64 {
                self.updated_at
            }
            fn set_updated_at(&mut self, at: i64) {
                self.updated_at = at;
            }
        }
    };
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum AuthMethod {
    Password,
    Key,
    Agent,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Host {
    pub id: String,
    pub label: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: AuthMethod,
    #[serde(default)]
    pub key_path: Option<String>,
    #[serde(default)]
    pub group: Option<String>,
    /// Another saved host to tunnel through (like OpenSSH `ProxyJump`).
    #[serde(default)]
    pub jump_host_id: Option<String>,
    /// Distribution id from the server's /etc/os-release (e.g. "ubuntu"),
    /// detected on connect and used for the host icon.
    #[serde(default)]
    pub os: Option<String>,
    #[serde(default)]
    pub updated_at: i64,
}
record!(Host);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Snippet {
    pub id: String,
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub updated_at: i64,
}
record!(Snippet);

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum ForwardKind {
    /// `ssh -L`: a local port forwarded to `dest_host:dest_port` via the server.
    Local,
    /// `ssh -D`: a local SOCKS5 proxy that exits through the server.
    Dynamic,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ForwardRule {
    pub id: String,
    pub label: String,
    pub host_id: String,
    pub kind: ForwardKind,
    pub bind_host: String,
    pub bind_port: u16,
    #[serde(default)]
    pub dest_host: Option<String>,
    #[serde(default)]
    pub dest_port: Option<u16>,
    #[serde(default)]
    pub updated_at: i64,
}
record!(ForwardRule);

pub struct JsonStore<T> {
    path: PathBuf,
    _marker: PhantomData<T>,
}

impl<T: Record> JsonStore<T> {
    pub fn new(dir: &Path, file: &str) -> Self {
        Self {
            path: dir.join(file),
            _marker: PhantomData,
        }
    }

    pub fn list(&self) -> anyhow::Result<Vec<T>> {
        match std::fs::read_to_string(&self.path) {
            Ok(text) => Ok(serde_json::from_str(&text)?),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(e) => Err(e.into()),
        }
    }

    /// Inserts a new record (assigning an id) or replaces the one with the same id.
    pub fn save(&self, mut item: T) -> anyhow::Result<T> {
        if item.id().is_empty() {
            item.set_id(uuid::Uuid::new_v4().to_string());
        }
        item.set_updated_at(now_ms());
        let mut items = self.list()?;
        match items.iter_mut().find(|i| i.id() == item.id()) {
            Some(existing) => *existing = item.clone(),
            None => items.push(item.clone()),
        }
        self.write(&items)?;
        Ok(item)
    }

    /// Appends the items that `is_dup` doesn't match against an existing one,
    /// keeping their ids (or assigning new ones), and returns how many were added.
    pub fn extend(&self, items: Vec<T>, is_dup: impl Fn(&T, &T) -> bool) -> anyhow::Result<usize> {
        let mut existing = self.list()?;
        let mut added = 0;
        for mut item in items {
            if existing.iter().any(|e| is_dup(e, &item) || (!item.id().is_empty() && e.id() == item.id())) {
                continue;
            }
            if item.id().is_empty() {
                item.set_id(uuid::Uuid::new_v4().to_string());
            }
            item.set_updated_at(now_ms());
            existing.push(item);
            added += 1;
        }
        if added > 0 {
            self.write(&existing)?;
        }
        Ok(added)
    }

    pub fn delete(&self, id: &str) -> anyhow::Result<()> {
        let mut items = self.list()?;
        items.retain(|i| i.id() != id);
        self.write(&items)
    }

    /// Replaces the whole collection (used when applying a sync result).
    pub fn write(&self, items: &[T]) -> anyhow::Result<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_string_pretty(items)?)?;
        std::fs::rename(tmp, &self.path)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(id: &str) -> Host {
        Host {
            id: id.into(),
            label: "web".into(),
            host: "10.0.0.1".into(),
            port: 22,
            username: "root".into(),
            auth_method: AuthMethod::Password,
            key_path: None,
            group: None,
            jump_host_id: None,
            os: None,
            updated_at: 0,
        }
    }

    #[test]
    fn save_update_delete_roundtrip() {
        let dir = std::env::temp_dir().join(format!("store-test-{}", uuid::Uuid::new_v4()));
        let store = JsonStore::<Host>::new(&dir, "hosts.json");
        assert!(store.list().unwrap().is_empty());

        let created = store.save(sample("")).unwrap();
        assert!(!created.id.is_empty());

        assert!(created.updated_at > 0, "save stamps the edit time");
        let mut renamed = created.clone();
        renamed.label = "db".into();
        let renamed = store.save(renamed).unwrap();
        assert_eq!(store.list().unwrap(), vec![renamed]);

        store.delete(&created.id).unwrap();
        assert!(store.list().unwrap().is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn extend_skips_duplicates() {
        let dir = std::env::temp_dir().join(format!("store-test-{}", uuid::Uuid::new_v4()));
        let store = JsonStore::<Snippet>::new(&dir, "snippets.json");
        let snip = |cmd: &str| Snippet {
            id: String::new(),
            name: cmd.into(),
            command: cmd.into(),
            category: None,
            updated_at: 0,
        };
        let same_command = |a: &Snippet, b: &Snippet| a.command == b.command;
        assert_eq!(store.extend(vec![snip("df -h"), snip("uptime")], same_command).unwrap(), 2);
        assert_eq!(store.extend(vec![snip("df -h"), snip("free -m")], same_command).unwrap(), 1);
        let all = store.list().unwrap();
        assert_eq!(all.len(), 3);
        assert!(all.iter().all(|s| !s.id.is_empty()));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn hosts_saved_by_older_versions_still_load() {
        let json = r#"[{"id":"1","label":"a","host":"h","port":22,"username":"u","authMethod":"password"}]"#;
        let hosts: Vec<Host> = serde_json::from_str(json).unwrap();
        assert_eq!(hosts[0].jump_host_id, None);
    }
}
