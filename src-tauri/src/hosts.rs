//! Saved hosts, persisted as JSON in the app data directory.
//!
//! Secrets (passwords, key passphrases) are never written here; the UI asks
//! for them at connect time.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum AuthMethod {
    Password,
    Key,
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
}

pub struct HostStore {
    path: PathBuf,
}

impl HostStore {
    pub fn new(dir: &Path) -> Self {
        Self {
            path: dir.join("hosts.json"),
        }
    }

    pub fn list(&self) -> anyhow::Result<Vec<Host>> {
        match std::fs::read_to_string(&self.path) {
            Ok(text) => Ok(serde_json::from_str(&text)?),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(e) => Err(e.into()),
        }
    }

    /// Inserts a new host or replaces the one with the same id.
    pub fn save(&self, mut host: Host) -> anyhow::Result<Host> {
        if host.id.is_empty() {
            host.id = uuid::Uuid::new_v4().to_string();
        }
        let mut hosts = self.list()?;
        match hosts.iter_mut().find(|h| h.id == host.id) {
            Some(existing) => *existing = host.clone(),
            None => hosts.push(host.clone()),
        }
        self.write(&hosts)?;
        Ok(host)
    }

    pub fn delete(&self, id: &str) -> anyhow::Result<()> {
        let mut hosts = self.list()?;
        hosts.retain(|h| h.id != id);
        self.write(&hosts)
    }

    fn write(&self, hosts: &[Host]) -> anyhow::Result<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_string_pretty(hosts)?)?;
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
        }
    }

    #[test]
    fn save_update_delete_roundtrip() {
        let dir = std::env::temp_dir().join(format!("hosts-test-{}", uuid::Uuid::new_v4()));
        let store = HostStore::new(&dir);
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
}
