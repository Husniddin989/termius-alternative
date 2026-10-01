//! Listing and forgetting entries of the app's own known_hosts file.

use std::path::Path;

use russh::keys::{parse_public_key_base64, HashAlg};
use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KnownHost {
    /// 1-based line number, as reported in "host key changed" errors.
    pub line: usize,
    pub host: String,
    pub algorithm: String,
    pub fingerprint: String,
}

pub fn list(path: &Path) -> anyhow::Result<Vec<KnownHost>> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.into()),
    };
    let mut out = Vec::new();
    for (i, line) in text.lines().enumerate() {
        if line.starts_with('#') {
            continue;
        }
        let mut parts = line.split_whitespace();
        let (Some(host), Some(_), Some(key)) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        let Ok(key) = parse_public_key_base64(key) else {
            continue;
        };
        out.push(KnownHost {
            line: i + 1,
            host: host.to_string(),
            algorithm: key.algorithm().to_string(),
            fingerprint: key.fingerprint(HashAlg::Sha256).to_string(),
        });
    }
    Ok(out)
}

/// Removes the entry on `line` (1-based).
pub fn remove(path: &Path, line: usize) -> anyhow::Result<()> {
    let text = std::fs::read_to_string(path)?;
    let kept: Vec<&str> = text
        .lines()
        .enumerate()
        .filter(|(i, _)| i + 1 != line)
        .map(|(_, l)| l)
        .collect();
    let mut joined = kept.join("\n");
    if !joined.is_empty() {
        joined.push('\n');
    }
    std::fs::write(path, joined)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_and_remove() {
        let path = std::env::temp_dir().join(format!("kh-{}", uuid::Uuid::new_v4()));
        std::fs::write(
            &path,
            "\n[localhost]:2222 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJdD7y3aLq454yWBdwLWbieU1ebz9/cu7/QEXn9OIeZJ\n\
             # comment\n\
             example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA6rWI3G2sz07DnfFlrouTcysQlj2P+jpNSOEWD9OJ3X\n",
        )
        .unwrap();
        let entries = list(&path).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].host, "[localhost]:2222");
        assert_eq!(entries[0].line, 2);
        assert!(entries[0].fingerprint.starts_with("SHA256:"));

        remove(&path, entries[0].line).unwrap();
        let left = list(&path).unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].host, "example.com");
        std::fs::remove_file(path).unwrap();
    }
}
