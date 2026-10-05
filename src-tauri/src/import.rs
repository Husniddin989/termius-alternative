//! Importing hosts from other SSH clients: OpenSSH config files (also what
//! `termius export-ssh-config` writes) and CSV (Termius' import template and
//! similar spreadsheets).

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::keyfiles;
use crate::secrets;
use crate::store::{AuthMethod, Host, JsonStore};
use crate::sync;

/// A host found in an import source, before it is saved.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportedHost {
    pub label: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub group: Option<String>,
    pub key_path: Option<String>,
    /// Private key text found inline (CSV), saved to a file on import.
    pub key_text: Option<String>,
    pub password: Option<String>,
    /// ProxyJump target: another imported host's label or `user@host:port`.
    pub jump: Option<String>,
}

// ---- ssh_config ------------------------------------------------------------------

/// `*` and `?` wildcards, as in OpenSSH patterns.
fn glob(pattern: &str, text: &str) -> bool {
    fn go(p: &[char], t: &[char]) -> bool {
        match (p.first(), t.first()) {
            (None, None) => true,
            (Some('*'), _) => go(&p[1..], t) || (!t.is_empty() && go(p, &t[1..])),
            (Some('?'), Some(_)) => go(&p[1..], &t[1..]),
            (Some(a), Some(b)) => a.eq_ignore_ascii_case(b) && go(&p[1..], &t[1..]),
            _ => false,
        }
    }
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    go(&p, &t)
}

/// Does a `Host` line (several patterns, `!negations`) match this alias?
fn host_line_matches(patterns: &[String], alias: &str) -> bool {
    let mut matched = false;
    for p in patterns {
        if let Some(neg) = p.strip_prefix('!') {
            if glob(neg, alias) {
                return false;
            }
        } else if glob(p, alias) {
            matched = true;
        }
    }
    matched
}

/// Splits a config line into keyword and arguments (`Key value`, `Key=value`, quotes).
fn split_line(line: &str) -> Option<(String, Vec<String>)> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let (key, rest) = match line.find(|c: char| c.is_whitespace() || c == '=') {
        Some(i) => (&line[..i], line[i..].trim_start_matches(|c: char| c.is_whitespace() || c == '=')),
        None => (line, ""),
    };
    let mut args = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    let mut has = false;
    for c in rest.chars() {
        match c {
            '"' => {
                quoted = !quoted;
                has = true;
            }
            c if c.is_whitespace() && !quoted => {
                if has {
                    args.push(std::mem::take(&mut cur));
                    has = false;
                }
            }
            c => {
                cur.push(c);
                has = true;
            }
        }
    }
    if has {
        args.push(cur);
    }
    Some((key.to_ascii_lowercase(), args))
}

#[derive(Default)]
struct Block {
    /// None for options before the first Host line (they apply to every host).
    patterns: Option<Vec<String>>,
    options: Vec<(String, Vec<String>)>,
}

/// Reads blocks, following `Include` (relative paths are under ~/.ssh).
fn read_blocks(text: &str, ssh_dir: Option<&Path>, depth: usize, out: &mut Vec<Block>) {
    let mut current = Block::default();
    let mut skipping_match = false;
    for raw in text.lines() {
        let Some((key, args)) = split_line(raw) else { continue };
        match key.as_str() {
            "host" => {
                out.push(std::mem::take(&mut current));
                current.patterns = Some(args);
                skipping_match = false;
            }
            // Match blocks depend on runtime conditions; their options are ignored.
            "match" => {
                out.push(std::mem::take(&mut current));
                skipping_match = true;
            }
            "include" if depth < 5 => {
                let Some(dir) = ssh_dir else { continue };
                for pattern in &args {
                    for path in expand_include(dir, pattern) {
                        let Ok(t) = std::fs::read_to_string(&path) else { continue };
                        let mut nested = Vec::new();
                        read_blocks(&t, ssh_dir, depth + 1, &mut nested);
                        // The included text continues the current block until its first Host line.
                        let mut nested = nested.into_iter();
                        if let Some(lead) = nested.next() {
                            current.options.extend(lead.options);
                        }
                        for b in nested {
                            out.push(std::mem::replace(&mut current, b));
                        }
                    }
                }
            }
            _ if !skipping_match => current.options.push((key, args)),
            _ => {}
        }
    }
    out.push(current);
}

fn expand_include(ssh_dir: &Path, pattern: &str) -> Vec<PathBuf> {
    let full = if let Some(rest) = pattern.strip_prefix("~/") {
        keyfiles::expand_home(&format!("~/{rest}"))
    } else if Path::new(pattern).is_absolute() {
        PathBuf::from(pattern)
    } else {
        ssh_dir.join(pattern)
    };
    let (dir, name) = match (full.parent(), full.file_name()) {
        (Some(d), Some(n)) => (d.to_path_buf(), n.to_string_lossy().into_owned()),
        _ => return Vec::new(),
    };
    if !name.contains('*') && !name.contains('?') {
        return vec![full];
    }
    let mut files: Vec<PathBuf> = std::fs::read_dir(&dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter(|e| glob(&name, &e.file_name().to_string_lossy()))
                .map(|e| e.path())
                .collect()
        })
        .unwrap_or_default();
    files.sort();
    files
}

/// Parses an OpenSSH client config. Every concrete `Host` alias becomes a
/// host; settings come from all matching blocks, first value wins (like ssh).
pub fn parse_ssh_config(text: &str, ssh_dir: Option<&Path>) -> Vec<ImportedHost> {
    let mut blocks = Vec::new();
    read_blocks(text, ssh_dir, 0, &mut blocks);

    // (label, alias used to look up settings)
    let mut aliases: Vec<(String, String)> = Vec::new();
    for b in &blocks {
        let plain: Vec<&String> = b.patterns.iter().flatten().filter(|p| !p.contains(['*', '?', '!'])).collect();
        let own_hostname = b.options.iter().any(|(k, _)| k == "hostname");
        // `termius export-ssh-config` writes labels unquoted ("Host My server"); several
        // names on one line that share their own HostName are one server either way.
        let entries: Vec<(String, String)> = if plain.len() > 1 && own_hostname {
            vec![(plain.iter().map(|p| p.as_str()).collect::<Vec<_>>().join(" "), plain[0].clone())]
        } else {
            plain.iter().map(|p| ((*p).clone(), (*p).clone())).collect()
        };
        for (label, key) in entries {
            if !aliases.iter().any(|(_, k)| k.eq_ignore_ascii_case(&key)) {
                aliases.push((label, key));
            }
        }
    }

    aliases
        .into_iter()
        .map(|(label, alias)| {
            let mut opts: HashMap<String, String> = HashMap::new();
            for b in &blocks {
                let applies = match &b.patterns {
                    None => true,
                    Some(p) => host_line_matches(p, &alias),
                };
                if !applies {
                    continue;
                }
                for (key, args) in &b.options {
                    if let Some(first) = args.first() {
                        opts.entry(key.clone()).or_insert_with(|| first.clone());
                    }
                }
            }
            let host = opts
                .get("hostname")
                .map(|h| h.replace("%h", &alias))
                .unwrap_or_else(|| alias.clone());
            let jump = opts
                .get("proxyjump")
                .filter(|j| !j.eq_ignore_ascii_case("none"))
                .map(|j| j.split(',').next().unwrap_or(j).trim().to_string());
            ImportedHost {
                label,
                host,
                port: opts.get("port").and_then(|p| p.parse().ok()).unwrap_or(22),
                username: opts.get("user").cloned().unwrap_or_default(),
                key_path: opts.get("identityfile").cloned(),
                jump,
                ..Default::default()
            }
        })
        .collect()
}

// ---- CSV ---------------------------------------------------------------------------

/// RFC 4180-ish: quoted fields, doubled quotes, newlines inside quotes; `,` or `;`.
fn parse_csv_rows(text: &str) -> Vec<Vec<String>> {
    let text = text.trim_start_matches('\u{feff}');
    let first_line = text.lines().next().unwrap_or("");
    let sep = if first_line.matches(';').count() > first_line.matches(',').count() { ';' } else { ',' };
    let mut rows = Vec::new();
    let mut row = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if quoted {
            match c {
                '"' if chars.peek() == Some(&'"') => {
                    field.push('"');
                    chars.next();
                }
                '"' => quoted = false,
                c => field.push(c),
            }
            continue;
        }
        match c {
            '"' => quoted = true,
            c if c == sep => row.push(std::mem::take(&mut field)),
            '\r' => {}
            '\n' => {
                row.push(std::mem::take(&mut field));
                rows.push(std::mem::take(&mut row));
            }
            c => field.push(c),
        }
    }
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        rows.push(row);
    }
    rows.retain(|r| r.iter().any(|f| !f.trim().is_empty()));
    rows
}

#[derive(Clone, Copy, PartialEq)]
enum Col {
    Label,
    Host,
    Port,
    User,
    Password,
    Group,
    Key,
    Protocol,
}

fn column(header: &str) -> Option<Col> {
    let h: String = header.to_lowercase().chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    Some(match h.as_str() {
        "label" | "name" | "alias" | "title" | "hostlabel" | "sessionname" => Col::Label,
        "hostnameip" | "hostname" | "host" | "ip" | "address" | "ipaddress" | "server" | "hostip" => Col::Host,
        "port" | "sshport" => Col::Port,
        "username" | "user" | "login" => Col::User,
        "password" | "pass" | "pwd" => Col::Password,
        "groups" | "group" | "folder" | "group1" => Col::Group,
        "sshkey" | "key" | "privatekey" | "identityfile" | "keypath" | "keyfile" => Col::Key,
        "protocol" | "type" => Col::Protocol,
        _ => return None,
    })
}

/// Parses a CSV export/template. Rows without an address, or whose protocol
/// isn't SSH (telnet, serial…), are skipped.
pub fn parse_csv(text: &str) -> anyhow::Result<Vec<ImportedHost>> {
    let rows = parse_csv_rows(text);
    let Some((header, data)) = rows.split_first() else { return Ok(Vec::new()) };
    let cols: Vec<Option<Col>> = header.iter().map(|h| column(h)).collect();
    if !cols.contains(&Some(Col::Host)) {
        anyhow::bail!("No hostname/IP column found. The first row must name the columns, e.g. Label,Hostname/IP,Port,Username,Password,Groups.");
    }
    let mut out = Vec::new();
    for row in data {
        let get = |want: Col| -> Option<String> {
            cols.iter()
                .position(|c| *c == Some(want))
                .and_then(|i| row.get(i))
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
        };
        let Some(mut host) = get(Col::Host) else { continue };
        if let Some(proto) = get(Col::Protocol) {
            if !matches!(proto.to_lowercase().as_str(), "ssh" | "mosh" | "sftp" | "ssh/sftp") {
                continue;
            }
        }
        let mut port = get(Col::Port).and_then(|p| p.parse().ok());
        let mut username = get(Col::User);
        // "user@host:port" in the address column.
        if let Some((u, h)) = host.clone().split_once('@') {
            username.get_or_insert_with(|| u.to_string());
            host = h.to_string();
        }
        if let Some((h, p)) = host.clone().rsplit_once(':') {
            if !h.contains(':') {
                if let Ok(p) = p.parse() {
                    port.get_or_insert(p);
                    host = h.to_string();
                }
            }
        }
        let key = get(Col::Key);
        let (key_path, key_text) = match key {
            Some(k) if k.contains("PRIVATE KEY") => (None, Some(k)),
            Some(k) if k.contains('/') || k.contains('\\') || k.starts_with('~') => (Some(k), None),
            _ => (None, None),
        };
        out.push(ImportedHost {
            label: get(Col::Label).unwrap_or_else(|| host.clone()),
            host,
            port: port.unwrap_or(22),
            username: username.unwrap_or_default(),
            group: get(Col::Group).map(|g| g.replace(['\\', '>'], "/")),
            key_path,
            key_text,
            password: get(Col::Password),
            jump: None,
        });
    }
    Ok(out)
}

/// Guesses the format from the content and parses it.
pub fn parse_any(text: &str, file_name: Option<&str>, ssh_dir: Option<&Path>) -> anyhow::Result<Vec<ImportedHost>> {
    let is_csv = file_name.is_some_and(|n| n.to_lowercase().ends_with(".csv"))
        || text
            .lines()
            .find(|l| !l.trim().is_empty())
            .is_some_and(|l| l.split([',', ';']).filter_map(column).any(|c| c == Col::Host));
    if is_csv {
        parse_csv(text)
    } else {
        let hosts = parse_ssh_config(text, ssh_dir);
        if hosts.is_empty() && !text.to_lowercase().contains("host") {
            anyhow::bail!("This file doesn't look like an SSH config or a CSV with hosts.");
        }
        Ok(hosts)
    }
}

// ---- Saving --------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub added: usize,
    pub skipped: usize,
}

fn same_target(h: &Host, i: &ImportedHost) -> bool {
    h.host.eq_ignore_ascii_case(&i.host) && h.port == i.port && h.username == i.username
}

/// Saves the chosen hosts. Hosts already saved (same address, port and user)
/// are skipped; passwords go to the keychain; inline keys are written to
/// private files; ProxyJump references are linked to the matching host.
pub fn save(dir: &Path, items: Vec<ImportedHost>) -> anyhow::Result<ImportResult> {
    let store = JsonStore::<Host>::new(dir, "hosts.json");
    let existing = store.list()?;
    let mut by_label: BTreeMap<String, String> = existing.iter().map(|h| (h.label.to_lowercase(), h.id.clone())).collect();
    let mut created: Vec<(Host, Option<String>)> = Vec::new();
    let mut skipped = 0;

    for item in items {
        if existing.iter().any(|h| same_target(h, &item)) || created.iter().any(|(h, _)| same_target(h, &item)) {
            skipped += 1;
            continue;
        }
        let mut key_path = item.key_path.clone();
        if let Some(text) = &item.key_text {
            let path = dir.join("imported-keys").join(uuid::Uuid::new_v4().to_string());
            keyfiles::write_private(&path, &format!("{}\n", text.trim()))?;
            key_path = Some(path.to_string_lossy().into_owned());
        }
        let auth_method = if key_path.is_some() { AuthMethod::Key } else { AuthMethod::Password };
        let saved = store.save(Host {
            id: String::new(),
            label: if item.label.is_empty() { item.host.clone() } else { item.label.clone() },
            host: item.host.clone(),
            port: item.port,
            username: if item.username.is_empty() { "root".into() } else { item.username.clone() },
            auth_method,
            key_path,
            group: item.group.clone().filter(|g| !g.is_empty()),
            jump_host_id: None,
            os: None,
            updated_at: 0,
        })?;
        if let Some(pw) = item.password.as_deref().filter(|p| !p.is_empty()) {
            secrets::set(&saved.id, pw)?;
            sync::record_secret_change(dir, &saved.id)?;
        }
        by_label.insert(saved.label.to_lowercase(), saved.id.clone());
        created.push((saved, item.jump.clone()));
    }

    // Link ProxyJump to a saved host: by label/alias, else by user@host:port.
    let all = store.list()?;
    for (host, jump) in &created {
        let Some(jump) = jump else { continue };
        let target = by_label.get(&jump.to_lowercase()).cloned().or_else(|| {
            let (user, rest) = jump.split_once('@').map(|(u, r)| (Some(u), r)).unwrap_or((None, jump.as_str()));
            let (h, port) = rest.rsplit_once(':').and_then(|(h, p)| p.parse::<u16>().ok().map(|p| (h, p))).unwrap_or((rest, 22));
            all.iter()
                .find(|x| x.host.eq_ignore_ascii_case(h) && x.port == port && user.is_none_or(|u| x.username == u))
                .map(|x| x.id.clone())
        });
        if let Some(target) = target.filter(|t| *t != host.id) {
            let mut h = host.clone();
            h.jump_host_id = Some(target);
            store.save(h)?;
        }
    }

    Ok(ImportResult { added: created.len(), skipped })
}

#[cfg(test)]
mod tests {
    use super::*;

    const CONFIG: &str = r#"
# Termius CLI export or a hand-written config
Host bastion
    HostName 203.0.113.10
    User jump

Host web-1 web-2
    User deploy
    IdentityFile ~/.ssh/deploy_ed25519

Host web-1
    HostName 10.0.0.11
    ProxyJump bastion

Host web-2
    HostName=10.0.0.12
    Port 2222

Host db
    HostName "10.0.0.20"
    ProxyJump admin@203.0.113.10:22

Match host *.internal
    User nobody

Host *.example.com !secret.example.com
    User wildcard

Host *
    User root
    Port 22
    IdentityFile ~/.ssh/id_rsa
"#;

    #[test]
    fn ssh_config_first_value_wins_and_defaults_apply() {
        let hosts = parse_ssh_config(CONFIG, None);
        let get = |l: &str| hosts.iter().find(|h| h.label == l).unwrap().clone();
        assert_eq!(hosts.len(), 4, "{hosts:#?}");

        let bastion = get("bastion");
        assert_eq!((bastion.host.as_str(), bastion.username.as_str(), bastion.port), ("203.0.113.10", "jump", 22));
        assert_eq!(bastion.key_path.as_deref(), Some("~/.ssh/id_rsa"));

        let web1 = get("web-1");
        assert_eq!((web1.host.as_str(), web1.username.as_str()), ("10.0.0.11", "deploy"));
        assert_eq!(web1.key_path.as_deref(), Some("~/.ssh/deploy_ed25519"));
        assert_eq!(web1.jump.as_deref(), Some("bastion"));

        let web2 = get("web-2");
        assert_eq!((web2.host.as_str(), web2.port), ("10.0.0.12", 2222));

        let db = get("db");
        assert_eq!((db.host.as_str(), db.username.as_str()), ("10.0.0.20", "root"));
        assert_eq!(db.jump.as_deref(), Some("admin@203.0.113.10:22"));
    }

    #[test]
    fn include_files_are_followed() {
        let dir = std::env::temp_dir().join(format!("sshcfg-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("config.d")).unwrap();
        std::fs::write(dir.join("config.d/work"), "Host work\n  HostName 10.1.1.1\n  User me\n").unwrap();
        std::fs::write(dir.join("config.d/home"), "Host nas\n  HostName 192.168.1.5\n").unwrap();
        let hosts = parse_ssh_config("Include config.d/*\nHost *\n  User fallback\n", Some(&dir));
        let users: Vec<_> = hosts.iter().map(|h| (h.label.as_str(), h.username.as_str())).collect();
        assert_eq!(users, [("nas", "fallback"), ("work", "me")]);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn termius_cli_export_with_spaces_in_labels() {
        let export = "\nHost My web server\n    hostname 10.0.0.5\n    user deploy\n    port 22\n    identityfile ~/.termius/ssh_keys/deploy\n\nHost db\n    hostname 10.0.0.6\n    user root\n    port 2222\n";
        let hosts = parse_ssh_config(export, None);
        assert_eq!(hosts.len(), 2, "{hosts:#?}");
        assert_eq!((hosts[0].label.as_str(), hosts[0].host.as_str()), ("My web server", "10.0.0.5"));
        assert_eq!(hosts[0].key_path.as_deref(), Some("~/.termius/ssh_keys/deploy"));
        assert_eq!((hosts[1].label.as_str(), hosts[1].port), ("db", 2222));
    }

    #[test]
    fn negated_patterns() {
        assert!(host_line_matches(&["*.example.com".into(), "!secret.example.com".into()], "a.example.com"));
        assert!(!host_line_matches(&["*.example.com".into(), "!secret.example.com".into()], "secret.example.com"));
    }

    #[test]
    fn termius_csv_template() {
        let csv = "Groups,Label,Tags,Hostname/IP,Protocol,Port,Username,Password,SSH_KEY\n\
                   Production,api,,10.0.0.5,ssh,22,deploy,\"p,a\"\"ss\",\n\
                   Production/DB,db,,10.0.0.6,ssh,2222,root,,~/.ssh/db_key\n\
                   ,router,,192.168.1.1,telnet,23,admin,,\n\
                   ,,,,,,,,\n\
                   ,quick,,ubuntu@10.0.0.9:2200,,,,,\"-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\"\n";
        let hosts = parse_csv(csv).unwrap();
        assert_eq!(hosts.len(), 3, "{hosts:#?}");
        assert_eq!(hosts[0].password.as_deref(), Some("p,a\"ss"));
        assert_eq!(hosts[0].group.as_deref(), Some("Production"));
        assert_eq!((hosts[1].port, hosts[1].key_path.as_deref()), (2222, Some("~/.ssh/db_key")));
        let quick = &hosts[2];
        assert_eq!((quick.host.as_str(), quick.username.as_str(), quick.port), ("10.0.0.9", "ubuntu", 2200));
        assert!(quick.key_text.as_deref().unwrap().contains("abc"));
    }

    #[test]
    fn generic_csv_with_semicolons_and_detection() {
        let csv = "name;ip;user\nnas;192.168.1.50;admin\n";
        let hosts = parse_any(csv, None, None).unwrap();
        assert_eq!(hosts[0].label, "nas");
        assert_eq!(hosts[0].username, "admin");
        assert!(parse_csv("foo,bar\n1,2\n").is_err());
    }

    #[test]
    fn save_dedupes_links_jumps_and_writes_keys() {
        let dir = std::env::temp_dir().join(format!("import-{}", uuid::Uuid::new_v4()));
        let mut items = parse_ssh_config(CONFIG, None);
        items.push(ImportedHost {
            label: "inline".into(),
            host: "10.9.9.9".into(),
            port: 22,
            username: "u".into(),
            key_text: Some("-----BEGIN OPENSSH PRIVATE KEY-----\nxyz\n-----END OPENSSH PRIVATE KEY-----".into()),
            ..Default::default()
        });
        let r = save(&dir, items.clone()).unwrap();
        assert_eq!((r.added, r.skipped), (5, 0));
        // Importing the same file again adds nothing.
        let r = save(&dir, items).unwrap();
        assert_eq!((r.added, r.skipped), (0, 5));

        let hosts = JsonStore::<Host>::new(&dir, "hosts.json").list().unwrap();
        let id = |l: &str| hosts.iter().find(|h| h.label == l).unwrap().id.clone();
        let web1 = hosts.iter().find(|h| h.label == "web-1").unwrap();
        assert_eq!(web1.jump_host_id.as_deref(), Some(id("bastion").as_str()));
        assert_eq!(web1.auth_method, AuthMethod::Key);
        let db = hosts.iter().find(|h| h.label == "db").unwrap();
        assert_eq!(db.jump_host_id, None, "admin@ doesn't match bastion's user");
        let inline = hosts.iter().find(|h| h.label == "inline").unwrap();
        let key = std::fs::read_to_string(inline.key_path.as_ref().unwrap()).unwrap();
        assert!(key.contains("xyz"));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
