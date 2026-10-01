//! Local directory listing for the left pane of the SFTP view.

use std::path::Path;
use std::time::UNIX_EPOCH;

use crate::sftp::Entry;

pub fn home() -> String {
    std::env::home_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| "/".into())
}

pub fn list(dir: &Path) -> anyhow::Result<Vec<Entry>> {
    let mut entries = Vec::new();
    for item in std::fs::read_dir(dir)? {
        let item = item?;
        let Ok(meta) = std::fs::metadata(item.path()) else {
            continue; // dangling symlink or no permission
        };
        let is_symlink = item.file_type().map(|t| t.is_symlink()).unwrap_or(false);
        entries.push(Entry {
            name: item.file_name().to_string_lossy().into_owned(),
            path: item.path().to_string_lossy().into_owned(),
            is_dir: meta.is_dir(),
            is_symlink,
            size: meta.len(),
            modified: meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs()),
            permissions: permissions(&meta),
        });
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

#[cfg(unix)]
fn permissions(meta: &std::fs::Metadata) -> Option<u32> {
    use std::os::unix::fs::PermissionsExt;
    Some(meta.permissions().mode())
}

#[cfg(not(unix))]
fn permissions(_: &std::fs::Metadata) -> Option<u32> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_directories_first() {
        let dir = std::env::temp_dir().join(format!("lfs-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("zdir")).unwrap();
        std::fs::write(dir.join("a.txt"), "hi").unwrap();
        let entries = list(&dir).unwrap();
        assert_eq!(entries[0].name, "zdir");
        assert!(entries[0].is_dir);
        assert_eq!(entries[1].size, 2);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
