//! Host passwords, key passphrases and API keys.
//!
//! Desktop and iOS use the OS keychain (macOS/iOS Keychain, Windows
//! Credential Manager, Secret Service on Linux). Android has no keychain the
//! `keyring` crate can reach, so there secrets go into a file in the app's
//! private data directory, which other apps cannot read.

use std::path::PathBuf;
use std::sync::OnceLock;

static DATA_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Must be called once at startup with the app data directory.
pub fn init(data_dir: PathBuf) {
    let _ = DATA_DIR.set(data_dir);
}

#[cfg(not(target_os = "android"))]
mod store {
    const SERVICE: &str = "termius-alternative";

    fn entry(account: &str) -> keyring::Result<keyring::Entry> {
        keyring::Entry::new(SERVICE, account)
    }

    pub fn get(account: &str) -> anyhow::Result<Option<String>> {
        match entry(account)?.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    pub fn set(account: &str, secret: &str) -> anyhow::Result<()> {
        Ok(entry(account)?.set_password(secret)?)
    }

    pub fn delete(account: &str) -> anyhow::Result<()> {
        match entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
}

#[cfg(any(target_os = "android", test))]
mod file_store {
    use std::collections::BTreeMap;
    use std::path::Path;

    type Secrets = BTreeMap<String, String>;

    fn load(path: &Path) -> anyhow::Result<Secrets> {
        match std::fs::read_to_string(path) {
            Ok(text) => Ok(serde_json::from_str(&text)?),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Secrets::new()),
            Err(e) => Err(e.into()),
        }
    }

    fn save(path: &Path, secrets: &Secrets) -> anyhow::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension("tmp");
        std::fs::write(&tmp, serde_json::to_string(secrets)?)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
        }
        std::fs::rename(tmp, path)?;
        Ok(())
    }

    pub fn get(path: &Path, account: &str) -> anyhow::Result<Option<String>> {
        Ok(load(path)?.remove(account))
    }

    pub fn set(path: &Path, account: &str, secret: &str) -> anyhow::Result<()> {
        let mut secrets = load(path)?;
        secrets.insert(account.into(), secret.into());
        save(path, &secrets)
    }

    pub fn delete(path: &Path, account: &str) -> anyhow::Result<()> {
        let mut secrets = load(path)?;
        if secrets.remove(account).is_some() {
            save(path, &secrets)?;
        }
        Ok(())
    }
}

#[cfg(target_os = "android")]
mod store {
    use super::{file_store, DATA_DIR};
    use std::path::PathBuf;

    fn path() -> anyhow::Result<PathBuf> {
        Ok(DATA_DIR
            .get()
            .ok_or_else(|| anyhow::anyhow!("secret storage is not initialised"))?
            .join("secrets.json"))
    }

    pub fn get(account: &str) -> anyhow::Result<Option<String>> {
        file_store::get(&path()?, account)
    }

    pub fn set(account: &str, secret: &str) -> anyhow::Result<()> {
        file_store::set(&path()?, account, secret)
    }

    pub fn delete(account: &str) -> anyhow::Result<()> {
        file_store::delete(&path()?, account)
    }
}

pub fn get(account: &str) -> anyhow::Result<Option<String>> {
    store::get(account)
}

pub fn set(account: &str, secret: &str) -> anyhow::Result<()> {
    store::set(account, secret)
}

pub fn delete(account: &str) -> anyhow::Result<()> {
    store::delete(account)
}

#[cfg(test)]
mod tests {
    use super::file_store;

    #[test]
    fn file_store_roundtrip_is_private() {
        let dir = std::env::temp_dir().join(format!("secrets-{}", uuid::Uuid::new_v4()));
        let path = dir.join("secrets.json");
        assert_eq!(file_store::get(&path, "h1").unwrap(), None);
        file_store::set(&path, "h1", "pw1").unwrap();
        file_store::set(&path, "h2", "pw2").unwrap();
        assert_eq!(file_store::get(&path, "h1").unwrap().as_deref(), Some("pw1"));
        file_store::delete(&path, "h1").unwrap();
        assert_eq!(file_store::get(&path, "h1").unwrap(), None);
        assert_eq!(file_store::get(&path, "h2").unwrap().as_deref(), Some("pw2"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
}
