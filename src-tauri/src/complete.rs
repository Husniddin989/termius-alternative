//! Server-side data for terminal autocomplete: directory listings and the
//! user's shell history, fetched over a side channel of the SSH connection.

/// Most entries listed for one directory.
const MAX_ENTRIES: usize = 500;
/// Most history lines kept.
const MAX_HISTORY: usize = 3000;

/// Quotes a string for POSIX sh.
fn quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// `dir` as a shell word: `~` and `~/…` expand to the home directory.
fn shell_path(dir: &str) -> String {
    if dir == "~" {
        "\"$HOME\"".into()
    } else if let Some(rest) = dir.strip_prefix("~/") {
        format!("\"$HOME\"/{}", quote(rest))
    } else {
        quote(dir)
    }
}

pub fn list_command(dir: &str) -> String {
    let dir = if dir.is_empty() { "~" } else { dir };
    format!(
        "cd -- {} 2>/dev/null && LC_ALL=C ls -1Ap 2>/dev/null | head -n {MAX_ENTRIES}",
        shell_path(dir)
    )
}

pub fn parse_listing(out: &str) -> Vec<String> {
    out.lines()
        .filter(|l| !l.is_empty() && *l != "./" && *l != "../")
        .map(String::from)
        .collect()
}

pub const HISTORY_COMMAND: &str =
    "tail -n 3000 ~/.bash_history 2>/dev/null; tail -n 3000 ~/.zsh_history 2>/dev/null";

/// History lines, oldest first, without duplicates (the latest use wins).
/// Understands zsh's extended format (`: 1700000000:0;command`).
pub fn parse_history(out: &str) -> Vec<String> {
    let mut lines: Vec<&str> = Vec::new();
    for raw in out.lines() {
        let line = match raw.strip_prefix(": ") {
            Some(rest) => rest.split_once(';').map(|(_, cmd)| cmd).unwrap_or(rest),
            None => raw,
        };
        let line = line.trim();
        // Skip bash timestamps (#1700000000) and multi-line continuations.
        if line.is_empty() || line.starts_with('#') || line.ends_with('\\') || line.len() > 500 {
            continue;
        }
        lines.push(line);
    }
    let mut seen = std::collections::HashSet::new();
    let mut out: Vec<String> = Vec::new();
    for line in lines.into_iter().rev() {
        if seen.insert(line) {
            out.push(line.to_string());
            if out.len() >= MAX_HISTORY {
                break;
            }
        }
    }
    out.reverse();
    out
}

/// Shell history of the local user, for the local terminal.
pub fn local_history() -> Vec<String> {
    let Some(home) = std::env::home_dir() else { return Vec::new() };
    let mut text = String::new();
    for file in [".bash_history", ".zsh_history"] {
        if let Ok(bytes) = std::fs::read(home.join(file)) {
            let s = String::from_utf8_lossy(&bytes);
            let tail: Vec<&str> = s.lines().rev().take(3000).collect();
            for l in tail.into_iter().rev() {
                text.push_str(l);
                text.push('\n');
            }
        }
    }
    parse_history(&text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_are_quoted_safely() {
        assert_eq!(list_command("/var/log").split(" 2>").next().unwrap(), "cd -- '/var/log'");
        assert!(list_command("~").starts_with("cd -- \"$HOME\" "));
        assert!(list_command("~/my dir").starts_with("cd -- \"$HOME\"/'my dir' "));
        assert!(list_command("/tmp/a'b; rm -rf /").starts_with("cd -- '/tmp/a'\\''b; rm -rf /' "));
    }

    #[test]
    fn listing_drops_dot_entries() {
        assert_eq!(parse_listing("./\n../\n.ssh/\nfile.txt\nsrc/\n"), [".ssh/", "file.txt", "src/"]);
    }

    #[test]
    fn history_handles_bash_and_zsh() {
        let out = "#1700000000\nls -la\ncd /var\nls -la\n: 1700000001:0;git status\n: 1700000002:0;docker ps\n";
        assert_eq!(parse_history(out), ["cd /var", "ls -la", "git status", "docker ps"]);
    }
}
