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
}
record!(Host);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Snippet {
    pub id: String,
    pub name: String,
    pub command: String,
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
        let mut items = self.list()?;
        match items.iter_mut().find(|i| i.id() == item.id()) {
            Some(existing) => *existing = item.clone(),
            None => items.push(item.clone()),
        }
        self.write(&items)?;
        Ok(item)
    }

    pub fn delete(&self, id: &str) -> anyhow::Result<()> {
        let mut items = self.list()?;
        items.retain(|i| i.id() != id);
        self.write(&items)
    }

    fn write(&self, items: &[T]) -> anyhow::Result<()> {
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
        }
    }

    #[test]
    fn save_update_delete_roundtrip() {
        let dir = std::env::temp_dir().join(format!("store-test-{}", uuid::Uuid::new_v4()));
        let store = JsonStore::<Host>::new(&dir, "hosts.json");
        assert!(store.list().unwrap().is_empty());

        let created = store.save(sample("")).unwrap();
        assert!(!created.id.is_empty());

        let mut renamed = created.clone();
        renamed.label = "db".into();
        store.save(renamed.clone()).unwrap();
        assert_eq!(store.list().unwrap(), vec![renamed]);

        store.delete(&created.id).unwrap();
        assert!(store.list().unwrap().is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn hosts_saved_by_older_versions_still_load() {
        let json = r#"[{"id":"1","label":"a","host":"h","port":22,"username":"u","authMethod":"password"}]"#;
        let hosts: Vec<Host> = serde_json::from_str(json).unwrap();
        assert_eq!(hosts[0].jump_host_id, None);
    }
}
