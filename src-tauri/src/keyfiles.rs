//! Private key files referenced by hosts (`keyPath`).
//!
//! A key that arrives through sync is stored in the app's private data
//! directory, never in `~/.ssh`. When connecting, the real file at the host's
//! key path wins; the synced copy is used only where that file doesn't exist
//! (e.g. on a phone).

use std::path::{Path, PathBuf};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;

/// Larger files are not private keys and are not synced.
pub const MAX_KEY_SIZE: u64 = 64 * 1024;

pub fn expand_home(path: &str) -> PathBuf {
    match path.strip_prefix("~/") {
        Some(rest) => std::env::home_dir()
            .map(|home| home.join(rest))
            .unwrap_or_else(|| PathBuf::from(path)),
        None => PathBuf::from(path),
    }
}

/// Where the synced copy of `key_path` lives inside `synced_dir`.
pub fn synced_copy(synced_dir: &Path, key_path: &str) -> PathBuf {
    synced_dir.join(URL_SAFE_NO_PAD.encode(key_path.as_bytes()))
}

/// The file to load for `key_path` on this device.
pub fn resolve(synced_dir: &Path, key_path: &str) -> PathBuf {
    let real = expand_home(key_path);
    if real.exists() {
        return real;
    }
    let copy = synced_copy(synced_dir, key_path);
    if copy.exists() {
        copy
    } else {
        real
    }
}

/// Reads a key file as text, with its modification time in ms. None if it
/// is missing, too large or not text.
pub fn read(path: &Path) -> Option<(String, i64)> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_KEY_SIZE {
        return None;
    }
    let text = std::fs::read_to_string(path).ok()?;
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    Some((text, modified))
}

/// Writes a synced key readable only by this app's user.
pub fn write_private(path: &Path, content: &str) -> anyhow::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, content)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
    }
    std::fs::rename(tmp, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn real_file_wins_over_synced_copy() {
        let dir = std::env::temp_dir().join(format!("keys-{}", uuid::Uuid::new_v4()));
        let real = dir.join("id_test");
        let real_str = real.to_str().unwrap();
        let synced = dir.join("synced");

        // Neither exists: the real path is returned so the error names it.
        assert_eq!(resolve(&synced, real_str), real);

        let copy = synced_copy(&synced, real_str);
        write_private(&copy, "synced key").unwrap();
        assert_eq!(resolve(&synced, real_str), copy);
        assert_eq!(read(&copy).unwrap().0, "synced key");

        std::fs::write(&real, "real key").unwrap();
        assert_eq!(resolve(&synced, real_str), real);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
