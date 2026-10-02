//! End-to-end encrypted sync of hosts, snippets, forwarding rules and saved
//! host passwords between devices, through a secret GitHub Gist.
//!
//! Everything is encrypted on the device with a key derived from the user's
//! sync password (Argon2id → XChaCha20-Poly1305); GitHub only ever stores
//! ciphertext. Devices merge record by record: the newer edit wins, and
//! deletions travel as tombstones.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use argon2::{Algorithm, Argon2, Params, Version};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::keyfiles;
use crate::secrets;
use crate::store::{now_ms, AuthMethod, ForwardRule, Host, JsonStore, Record, Snippet};

/// Keychain accounts for the sync credentials.
pub const TOKEN_ACCOUNT: &str = "sync-github-token";
pub const PASSPHRASE_ACCOUNT: &str = "sync-passphrase";

pub const GITHUB_API: &str = "https://api.github.com";
const VAULT_FILE: &str = "termius-alternative-vault.json";
const FORMAT: &str = "termius-alternative-vault";
const AAD: &[u8] = b"termius-alternative-vault-v1";

// ---- Local sync state ----------------------------------------------------------

/// Per-device sync bookkeeping, kept in sync.json next to the other stores.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct SyncMeta {
    /// GitHub account the vault lives in; None while sync is off.
    pub login: Option<String>,
    pub gist_id: Option<String>,
    pub last_sync: Option<i64>,
    pub last_error: Option<String>,
    /// Record id (or "secret:<host id>") → when it was deleted.
    pub tombstones: BTreeMap<String, i64>,
    /// Host id → when its saved password last changed on this device.
    pub secret_times: BTreeMap<String, i64>,
    /// Key path → version of the synced copy stored on this device.
    pub key_times: BTreeMap<String, i64>,
}

/// Private keys received from other devices.
pub fn synced_keys_dir(dir: &Path) -> PathBuf {
    dir.join("keys")
}

fn meta_path(dir: &Path) -> PathBuf {
    dir.join("sync.json")
}

pub fn load_meta(dir: &Path) -> anyhow::Result<SyncMeta> {
    match std::fs::read_to_string(meta_path(dir)) {
        Ok(text) => Ok(serde_json::from_str(&text)?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(SyncMeta::default()),
        Err(e) => Err(e.into()),
    }
}

pub fn save_meta(dir: &Path, meta: &SyncMeta) -> anyhow::Result<()> {
    std::fs::create_dir_all(dir)?;
    std::fs::write(meta_path(dir), serde_json::to_string_pretty(meta)?)?;
    Ok(())
}

fn update_meta(dir: &Path, f: impl FnOnce(&mut SyncMeta)) -> anyhow::Result<()> {
    let mut meta = load_meta(dir)?;
    f(&mut meta);
    save_meta(dir, &meta)
}

/// Remembers a deleted host, snippet or rule so other devices delete it too.
pub fn record_deletion(dir: &Path, id: &str) -> anyhow::Result<()> {
    update_meta(dir, |m| {
        m.tombstones.insert(id.to_string(), now_ms());
    })
}

pub fn record_secret_change(dir: &Path, host_id: &str) -> anyhow::Result<()> {
    update_meta(dir, |m| {
        m.secret_times.insert(host_id.to_string(), now_ms());
        m.tombstones.remove(&secret_key(host_id));
    })
}

pub fn record_secret_deletion(dir: &Path, host_id: &str) -> anyhow::Result<()> {
    update_meta(dir, |m| {
        m.secret_times.remove(host_id);
        m.tombstones.insert(secret_key(host_id), now_ms());
    })
}

fn secret_key(host_id: &str) -> String {
    format!("secret:{host_id}")
}

// ---- Vault -----------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SecretEntry {
    pub value: String,
    pub updated_at: i64,
}

/// Everything that syncs, as stored (encrypted) in the gist.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Vault {
    pub hosts: Vec<Host>,
    pub snippets: Vec<Snippet>,
    pub forwards: Vec<ForwardRule>,
    /// Host id → saved password or key passphrase.
    pub secrets: BTreeMap<String, SecretEntry>,
    /// Key path as written in hosts (e.g. "~/.ssh/id_ed25519") → private key file.
    pub keys: BTreeMap<String, SecretEntry>,
    pub tombstones: BTreeMap<String, i64>,
}

// ---- Encryption ------------------------------------------------------------------

#[derive(Serialize, Deserialize)]
struct KdfParams {
    alg: String,
    m: u32,
    t: u32,
    p: u32,
    salt: String,
}

#[derive(Serialize, Deserialize)]
struct Envelope {
    format: String,
    version: u32,
    kdf: KdfParams,
    nonce: String,
    ciphertext: String,
}

/// OWASP-recommended Argon2id settings; light enough for phones.
const KDF_M: u32 = 19 * 1024;
const KDF_T: u32 = 2;
const KDF_P: u32 = 1;

fn derive_key(passphrase: &str, salt: &[u8], m: u32, t: u32, p: u32) -> anyhow::Result<[u8; 32]> {
    let params = Params::new(m, t, p, Some(32)).map_err(|e| anyhow::anyhow!("bad KDF parameters: {e}"))?;
    let mut key = [0u8; 32];
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(passphrase.as_bytes(), salt, &mut key)
        .map_err(|e| anyhow::anyhow!("key derivation failed: {e}"))?;
    Ok(key)
}

fn random<const N: usize>() -> anyhow::Result<[u8; N]> {
    let mut buf = [0u8; N];
    getrandom::getrandom(&mut buf).map_err(|e| anyhow::anyhow!("no system randomness: {e}"))?;
    Ok(buf)
}

pub fn encrypt(vault: &Vault, passphrase: &str) -> anyhow::Result<String> {
    let salt = random::<16>()?;
    let nonce = random::<24>()?;
    let key = derive_key(passphrase, &salt, KDF_M, KDF_T, KDF_P)?;
    let cipher = XChaCha20Poly1305::new(&Key::from(key));
    let plaintext = serde_json::to_vec(vault)?;
    let ciphertext = cipher
        .encrypt(&XNonce::from(nonce), Payload { msg: &plaintext, aad: AAD })
        .map_err(|_| anyhow::anyhow!("encryption failed"))?;
    let envelope = Envelope {
        format: FORMAT.into(),
        version: 1,
        kdf: KdfParams {
            alg: "argon2id".into(),
            m: KDF_M,
            t: KDF_T,
            p: KDF_P,
            salt: B64.encode(salt),
        },
        nonce: B64.encode(nonce),
        ciphertext: B64.encode(ciphertext),
    };
    Ok(serde_json::to_string_pretty(&envelope)?)
}

pub fn decrypt(text: &str, passphrase: &str) -> anyhow::Result<Vault> {
    let env: Envelope =
        serde_json::from_str(text).map_err(|_| anyhow::anyhow!("The sync file on GitHub is not a vault from this app."))?;
    if env.format != FORMAT || env.version != 1 || env.kdf.alg != "argon2id" {
        anyhow::bail!("The sync file was made by a newer version of the app. Update the app on this device.");
    }
    let salt = B64.decode(&env.kdf.salt)?;
    let nonce = B64.decode(&env.nonce)?;
    let ciphertext = B64.decode(&env.ciphertext)?;
    let nonce: [u8; 24] = nonce.try_into().map_err(|_| anyhow::anyhow!("The sync file is damaged."))?;
    // Refuse absurd KDF costs from a tampered file instead of hanging.
    if env.kdf.m > 1 << 20 || env.kdf.t > 16 || env.kdf.p > 8 {
        anyhow::bail!("The sync file is damaged.");
    }
    let key = derive_key(passphrase, &salt, env.kdf.m, env.kdf.t, env.kdf.p)?;
    let plaintext = XChaCha20Poly1305::new(&Key::from(key))
        .decrypt(&XNonce::from(nonce), Payload { msg: &ciphertext, aad: AAD })
        .map_err(|_| anyhow::anyhow!("Wrong sync password."))?;
    Ok(serde_json::from_slice(&plaintext)?)
}

// ---- Merge -------------------------------------------------------------------------

/// Union by id; the newer edit wins (ties broken by content so every device
/// picks the same copy); records deleted after their last edit are dropped.
fn merge_records<T: Record>(a: Vec<T>, b: Vec<T>, tombstones: &BTreeMap<String, i64>) -> Vec<T> {
    let mut by_id: BTreeMap<String, T> = BTreeMap::new();
    for item in a.into_iter().chain(b) {
        let id = item.id().to_string();
        let keep_new = match by_id.get(&id) {
            None => true,
            Some(old) => match item.updated_at().cmp(&old.updated_at()) {
                std::cmp::Ordering::Greater => true,
                std::cmp::Ordering::Less => false,
                std::cmp::Ordering::Equal => {
                    serde_json::to_string(&item).unwrap_or_default() > serde_json::to_string(old).unwrap_or_default()
                }
            },
        };
        if keep_new {
            by_id.insert(id, item);
        }
    }
    by_id
        .into_values()
        .filter(|item| tombstones.get(item.id()).is_none_or(|&deleted| deleted < item.updated_at()))
        .collect()
}

/// The same built-in snippet added on two devices under different ids is
/// kept once (the one with the smallest id, so all devices agree).
fn dedupe_snippets(snippets: Vec<Snippet>) -> Vec<Snippet> {
    let mut seen = BTreeSet::new();
    let mut sorted = snippets;
    sorted.sort_by(|a, b| a.id.cmp(&b.id));
    sorted
        .into_iter()
        .filter(|s| seen.insert((s.name.clone(), s.command.clone(), s.category.clone())))
        .collect()
}

/// Per key, the newer entry wins (ties broken by value, so every device agrees).
fn merge_entries(
    a: BTreeMap<String, SecretEntry>,
    b: BTreeMap<String, SecretEntry>,
) -> BTreeMap<String, SecretEntry> {
    let mut out = a;
    for (k, entry) in b {
        match out.get(&k) {
            Some(mine) if (mine.updated_at, &mine.value) >= (entry.updated_at, &entry.value) => {}
            _ => {
                out.insert(k, entry);
            }
        }
    }
    out
}

fn key_paths(hosts: &[Host]) -> BTreeSet<String> {
    hosts
        .iter()
        .filter(|h| h.auth_method == AuthMethod::Key)
        .filter_map(|h| h.key_path.clone())
        .filter(|p| !p.trim().is_empty())
        .collect()
}

pub fn merge(local: Vault, remote: Vault) -> Vault {
    let mut tombstones = local.tombstones;
    for (id, at) in remote.tombstones {
        let entry = tombstones.entry(id).or_insert(at);
        *entry = (*entry).max(at);
    }
    let hosts = merge_records(local.hosts, remote.hosts, &tombstones);
    let snippets = dedupe_snippets(merge_records(local.snippets, remote.snippets, &tombstones));
    let forwards = merge_records(local.forwards, remote.forwards, &tombstones);

    let host_ids: BTreeSet<&str> = hosts.iter().map(|h| h.id.as_str()).collect();
    let mut secrets = merge_entries(local.secrets, remote.secrets);
    secrets.retain(|id, entry| {
        host_ids.contains(id.as_str())
            && tombstones.get(&secret_key(id)).is_none_or(|&deleted| deleted < entry.updated_at)
    });

    // Keys travel while some host still uses them.
    let used = key_paths(&hosts);
    let mut keys = merge_entries(local.keys, remote.keys);
    keys.retain(|path, _| used.contains(path));

    Vault {
        hosts,
        snippets,
        forwards,
        secrets,
        keys,
        tombstones,
    }
}

// ---- Local data <-> vault ------------------------------------------------------------

/// Where saved host passwords live on this device.
pub trait SecretStore: Sync {
    fn get(&self, account: &str) -> anyhow::Result<Option<String>>;
    fn set(&self, account: &str, secret: &str) -> anyhow::Result<()>;
    fn delete(&self, account: &str) -> anyhow::Result<()>;
}

/// The real store: the OS keychain (or the private file on Android).
pub struct Keychain;

impl SecretStore for Keychain {
    fn get(&self, account: &str) -> anyhow::Result<Option<String>> {
        secrets::get(account)
    }
    fn set(&self, account: &str, secret: &str) -> anyhow::Result<()> {
        secrets::set(account, secret)
    }
    fn delete(&self, account: &str) -> anyhow::Result<()> {
        secrets::delete(account)
    }
}

pub fn local_vault(dir: &Path, store: &dyn SecretStore) -> anyhow::Result<Vault> {
    let meta = load_meta(dir)?;
    let hosts = JsonStore::<Host>::new(dir, "hosts.json").list()?;
    let mut secrets = BTreeMap::new();
    for host in &hosts {
        if let Some(value) = store.get(&host.id)? {
            let updated_at = meta.secret_times.get(&host.id).copied().unwrap_or(0);
            secrets.insert(host.id.clone(), SecretEntry { value, updated_at });
        }
    }
    // The real key file if this device has one, else the copy synced earlier.
    let synced = synced_keys_dir(dir);
    let mut keys = BTreeMap::new();
    for path in key_paths(&hosts) {
        let entry = match keyfiles::read(&keyfiles::expand_home(&path)) {
            Some((value, modified)) => Some(SecretEntry { value, updated_at: modified }),
            None => keyfiles::read(&keyfiles::synced_copy(&synced, &path)).map(|(value, _)| SecretEntry {
                value,
                updated_at: meta.key_times.get(&path).copied().unwrap_or(0),
            }),
        };
        if let Some(entry) = entry {
            keys.insert(path, entry);
        }
    }
    Ok(Vault {
        hosts,
        keys,
        snippets: JsonStore::<Snippet>::new(dir, "snippets.json").list()?,
        forwards: JsonStore::<ForwardRule>::new(dir, "forwards.json").list()?,
        secrets,
        tombstones: meta.tombstones,
    })
}

/// Writes the merged vault to this device. Returns whether anything changed.
fn apply(dir: &Path, store: &dyn SecretStore, merged: &Vault, local: &Vault) -> anyhow::Result<bool> {
    let mut changed = false;
    if merged.hosts != local.hosts {
        JsonStore::<Host>::new(dir, "hosts.json").write(&merged.hosts)?;
        changed = true;
    }
    if merged.snippets != local.snippets {
        JsonStore::<Snippet>::new(dir, "snippets.json").write(&merged.snippets)?;
        changed = true;
    }
    if merged.forwards != local.forwards {
        JsonStore::<ForwardRule>::new(dir, "forwards.json").write(&merged.forwards)?;
        changed = true;
    }
    let mut meta = load_meta(dir)?;
    for (id, entry) in &merged.secrets {
        if local.secrets.get(id) != Some(entry) {
            store.set(id, &entry.value)?;
            meta.secret_times.insert(id.clone(), entry.updated_at);
            changed = true;
        }
    }
    for id in local.secrets.keys() {
        if !merged.secrets.contains_key(id) {
            store.delete(id)?;
            meta.secret_times.remove(id);
            changed = true;
        }
    }
    // Never touch a real key file; only the app's own synced copies.
    let synced = synced_keys_dir(dir);
    for (path, entry) in &merged.keys {
        if keyfiles::expand_home(path).exists() || local.keys.get(path) == Some(entry) {
            continue;
        }
        keyfiles::write_private(&keyfiles::synced_copy(&synced, path), &entry.value)?;
        meta.key_times.insert(path.clone(), entry.updated_at);
        changed = true;
    }
    for path in meta.key_times.keys().cloned().collect::<Vec<_>>() {
        if !merged.keys.contains_key(&path) {
            let _ = std::fs::remove_file(keyfiles::synced_copy(&synced, &path));
            meta.key_times.remove(&path);
        }
    }
    meta.tombstones = merged.tombstones.clone();
    save_meta(dir, &meta)?;
    Ok(changed)
}

// ---- GitHub Gist client ---------------------------------------------------------------

pub struct GitHub<'a> {
    pub http: &'a reqwest::Client,
    pub api: &'a str,
    pub token: &'a str,
}

impl GitHub<'_> {
    async fn call(&self, method: reqwest::Method, path: &str, body: Option<Value>) -> anyhow::Result<(u16, Value)> {
        let mut req = self
            .http
            .request(method, format!("{}{path}", self.api))
            .bearer_auth(self.token)
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .header("User-Agent", "termius-alternative")
            .timeout(std::time::Duration::from_secs(30));
        if let Some(body) = body {
            req = req.json(&body);
        }
        let resp = req.send().await.map_err(|e| anyhow::anyhow!("Could not reach GitHub: {e}"))?;
        let status = resp.status().as_u16();
        let value = resp.json().await.unwrap_or(Value::Null);
        match status {
            401 => anyhow::bail!("The GitHub token is invalid or expired. Create a new one in Settings → Sync."),
            403 if value["message"].as_str().is_some_and(|m| m.contains("rate limit")) => {
                anyhow::bail!("GitHub rate limit reached; sync will retry later.")
            }
            403 => anyhow::bail!("The GitHub token is missing the \"gist\" permission."),
            _ => Ok((status, value)),
        }
    }

    /// The account the token belongs to (validates the token).
    pub async fn login(&self) -> anyhow::Result<String> {
        let (status, user) = self.call(reqwest::Method::GET, "/user", None).await?;
        if status != 200 {
            anyhow::bail!("GitHub returned {status} when checking the token.");
        }
        Ok(user["login"].as_str().unwrap_or("unknown").to_string())
    }

    /// Finds this app's vault among the user's gists.
    pub async fn find_vault(&self) -> anyhow::Result<Option<String>> {
        for page in 1..=10 {
            let (status, gists) = self
                .call(reqwest::Method::GET, &format!("/gists?per_page=100&page={page}"), None)
                .await?;
            if status != 200 {
                anyhow::bail!("GitHub returned {status} when listing gists.");
            }
            let Some(list) = gists.as_array() else { break };
            if let Some(g) = list.iter().find(|g| g["files"].get(VAULT_FILE).is_some()) {
                return Ok(g["id"].as_str().map(String::from));
            }
            if list.len() < 100 {
                break;
            }
        }
        Ok(None)
    }

    pub async fn create(&self, content: &str) -> anyhow::Result<String> {
        let body = json!({
            "description": "Termius Alternative — encrypted sync vault (do not edit)",
            "public": false,
            "files": { VAULT_FILE: { "content": content } }
        });
        let (status, gist) = self.call(reqwest::Method::POST, "/gists", Some(body)).await?;
        if status != 201 {
            anyhow::bail!("GitHub returned {status} when creating the sync gist.");
        }
        gist["id"].as_str().map(String::from).ok_or_else(|| anyhow::anyhow!("GitHub returned no gist id."))
    }

    /// The vault text, or None if the gist no longer exists.
    pub async fn read(&self, id: &str) -> anyhow::Result<Option<String>> {
        let (status, gist) = self.call(reqwest::Method::GET, &format!("/gists/{id}"), None).await?;
        if status == 404 {
            return Ok(None);
        }
        if status != 200 {
            anyhow::bail!("GitHub returned {status} when reading the sync gist.");
        }
        let file = &gist["files"][VAULT_FILE];
        if file.is_null() {
            return Ok(None);
        }
        if file["truncated"].as_bool() == Some(true) {
            let url = file["raw_url"].as_str().unwrap_or_default();
            let text = self
                .http
                .get(url)
                .bearer_auth(self.token)
                .header("User-Agent", "termius-alternative")
                .send()
                .await?
                .text()
                .await?;
            return Ok(Some(text));
        }
        Ok(file["content"].as_str().map(String::from))
    }

    pub async fn update(&self, id: &str, content: &str) -> anyhow::Result<()> {
        let body = json!({ "files": { VAULT_FILE: { "content": content } } });
        let (status, _) = self
            .call(reqwest::Method::PATCH, &format!("/gists/{id}"), Some(body))
            .await?;
        if status != 200 {
            anyhow::bail!("GitHub returned {status} when saving the sync gist.");
        }
        Ok(())
    }
}

// ---- Sync --------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    /// Data on this device changed (the UI should reload).
    pub changed: bool,
    pub pushed: bool,
    pub hosts: usize,
    pub at: i64,
}

/// One full round: pull, merge, apply locally, push if the gist is behind.
pub async fn sync(
    dir: &Path,
    store: &dyn SecretStore,
    gh: &GitHub<'_>,
    passphrase: &str,
) -> anyhow::Result<SyncReport> {
    let mut meta = load_meta(dir)?;
    let local = local_vault(dir, store)?;

    let mut gist_id = meta.gist_id.clone();
    if gist_id.is_none() {
        gist_id = gh.find_vault().await?;
    }
    let remote_text = match &gist_id {
        Some(id) => gh.read(id).await?,
        None => None,
    };

    let (merged, changed, pushed) = match remote_text {
        None => {
            // First device, or the gist was deleted: publish what we have.
            let id = gh.create(&encrypt(&local, passphrase)?).await?;
            gist_id = Some(id);
            (local, false, true)
        }
        Some(text) => {
            let remote = decrypt(&text, passphrase)?;
            let merged = merge(local.clone(), remote.clone());
            let changed = apply(dir, store, &merged, &local)?;
            let pushed = merged != remote;
            if pushed {
                gh.update(gist_id.as_deref().unwrap(), &encrypt(&merged, passphrase)?).await?;
            }
            (merged, changed, pushed)
        }
    };

    meta = load_meta(dir)?; // apply() may have updated it
    meta.gist_id = gist_id;
    meta.last_sync = Some(now_ms());
    meta.last_error = None;
    save_meta(dir, &meta)?;
    Ok(SyncReport {
        changed,
        pushed,
        hosts: merged.hosts.len(),
        at: meta.last_sync.unwrap_or_default(),
    })
}

/// Checks the token and, if this account already has a vault, the password.
pub async fn check_setup(gh: &GitHub<'_>, passphrase: &str) -> anyhow::Result<(String, Option<String>)> {
    let login = gh.login().await?;
    let gist_id = gh.find_vault().await?;
    if let Some(id) = &gist_id {
        if let Some(text) = gh.read(id).await? {
            decrypt(&text, passphrase).map_err(|e| {
                if e.to_string().contains("Wrong sync password") {
                    anyhow::anyhow!(
                        "This GitHub account already has a sync vault, and this sync password does not open it. \
                         Use the same sync password as on your other device."
                    )
                } else {
                    e
                }
            })?;
        }
    }
    Ok((login, gist_id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::AuthMethod;

    fn host(id: &str, label: &str, at: i64) -> Host {
        Host {
            id: id.into(),
            label: label.into(),
            host: "10.0.0.1".into(),
            port: 22,
            username: "root".into(),
            auth_method: AuthMethod::Password,
            key_path: None,
            group: None,
            jump_host_id: None,
            os: None,
            updated_at: at,
        }
    }

    fn snippet(id: &str, name: &str, at: i64) -> Snippet {
        Snippet {
            id: id.into(),
            name: name.into(),
            command: "df -h".into(),
            category: Some("System".into()),
            updated_at: at,
        }
    }

    fn secret(value: &str, at: i64) -> SecretEntry {
        SecretEntry {
            value: value.into(),
            updated_at: at,
        }
    }

    #[test]
    fn encryption_roundtrip_and_wrong_password() {
        let mut vault = Vault::default();
        vault.hosts.push(host("h1", "web", 5));
        vault.secrets.insert("h1".into(), secret("hunter2", 5));
        let text = encrypt(&vault, "correct horse").unwrap();
        assert!(!text.contains("hunter2") && !text.contains("web"), "plaintext leaked");
        assert_eq!(decrypt(&text, "correct horse").unwrap(), vault);
        let e = decrypt(&text, "wrong").unwrap_err().to_string();
        assert!(e.contains("Wrong sync password"), "{e}");
        // Fresh salt and nonce every time.
        assert_ne!(encrypt(&vault, "correct horse").unwrap(), text);
    }

    #[test]
    fn newer_edit_wins_and_both_sides_contribute() {
        let local = Vault {
            hosts: vec![host("a", "local-a", 10), host("b", "old-b", 1)],
            ..Default::default()
        };
        let remote = Vault {
            hosts: vec![host("b", "new-b", 20), host("c", "remote-c", 5)],
            ..Default::default()
        };
        let merged = merge(local, remote);
        let labels: Vec<_> = merged.hosts.iter().map(|h| h.label.as_str()).collect();
        assert_eq!(labels, ["local-a", "new-b", "remote-c"]);
    }

    #[test]
    fn deletions_propagate_but_later_edits_survive() {
        let local = Vault {
            hosts: vec![host("a", "a", 10), host("b", "b", 50)],
            tombstones: BTreeMap::new(),
            ..Default::default()
        };
        let remote = Vault {
            tombstones: BTreeMap::from([("a".into(), 20), ("b".into(), 30)]),
            ..Default::default()
        };
        let merged = merge(local, remote);
        // "a" was deleted after its last edit; "b" was edited after the deletion.
        assert_eq!(merged.hosts.iter().map(|h| h.id.as_str()).collect::<Vec<_>>(), ["b"]);
        assert_eq!(merged.tombstones.len(), 2);
    }

    #[test]
    fn secrets_follow_hosts_and_timestamps() {
        let local = Vault {
            hosts: vec![host("a", "a", 1), host("b", "b", 1)],
            secrets: BTreeMap::from([("a".into(), secret("old", 1)), ("b".into(), secret("mine", 9))]),
            ..Default::default()
        };
        let remote = Vault {
            hosts: vec![host("a", "a", 1), host("b", "b", 1)],
            secrets: BTreeMap::from([
                ("a".into(), secret("new", 5)),
                ("b".into(), secret("theirs", 2)),
                ("gone".into(), secret("x", 9)),
            ]),
            tombstones: BTreeMap::new(),
            ..Default::default()
        };
        let merged = merge(local, remote);
        assert_eq!(merged.secrets["a"].value, "new");
        assert_eq!(merged.secrets["b"].value, "mine");
        assert!(!merged.secrets.contains_key("gone"), "secret of an unknown host must not sync");

        let deleted = Vault {
            tombstones: BTreeMap::from([("secret:a".into(), 100)]),
            ..Default::default()
        };
        assert!(!merge(merged, deleted).secrets.contains_key("a"));
    }

    #[test]
    fn same_builtin_snippet_on_two_devices_is_kept_once() {
        let local = Vault {
            snippets: vec![snippet("lib-disk", "Disk usage", 0)],
            ..Default::default()
        };
        let remote = Vault {
            snippets: vec![snippet("7f3c-uuid", "Disk usage", 0), snippet("x", "Other", 0)],
            ..Default::default()
        };
        let merged = merge(local, remote);
        let ids: Vec<_> = merged.snippets.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, ["7f3c-uuid", "x"], "one 'Disk usage' left, chosen deterministically");
    }

    #[test]
    fn merge_is_symmetric() {
        let a = Vault {
            hosts: vec![host("a", "1", 3), host("b", "2", 4)],
            tombstones: BTreeMap::from([("z".into(), 1)]),
            ..Default::default()
        };
        let b = Vault {
            hosts: vec![host("a", "1b", 3), host("c", "3", 1)],
            ..Default::default()
        };
        assert_eq!(merge(a.clone(), b.clone()), merge(b, a));
    }

    // ---- GitHub client against a fake API ------------------------------------------

    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// Minimal in-memory imitation of the gist endpoints we use.
    async fn fake_github(token: &'static str) -> (String, Arc<Mutex<BTreeMap<String, String>>>) {
        let gists: Arc<Mutex<BTreeMap<String, String>>> = Arc::default();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let store = gists.clone();
        tokio::spawn(async move {
            while let Ok((mut sock, _)) = listener.accept().await {
                let store = store.clone();
                tokio::spawn(async move {
                    let mut buf = Vec::new();
                    let mut chunk = [0u8; 8192];
                    let (head_end, len) = loop {
                        let n = sock.read(&mut chunk).await.unwrap();
                        buf.extend_from_slice(&chunk[..n]);
                        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                            let head = String::from_utf8_lossy(&buf[..i]).to_lowercase();
                            let len = head
                                .lines()
                                .find_map(|l| l.strip_prefix("content-length:"))
                                .map(|v| v.trim().parse::<usize>().unwrap())
                                .unwrap_or(0);
                            break (i + 4, len);
                        }
                    };
                    while buf.len() < head_end + len {
                        let n = sock.read(&mut chunk).await.unwrap();
                        buf.extend_from_slice(&chunk[..n]);
                    }
                    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
                    let body: Value = serde_json::from_slice(&buf[head_end..]).unwrap_or(Value::Null);
                    let line = head.lines().next().unwrap_or_default().to_string();
                    let authorized = head.to_lowercase().contains(&format!("authorization: bearer {token}"));
                    let content_of = |b: &Value| b["files"][VAULT_FILE]["content"].as_str().unwrap().to_string();
                    let (status, payload) = if !authorized {
                        (401, json!({"message": "Bad credentials"}))
                    } else if line.starts_with("GET /user ") {
                        (200, json!({"login": "husniddin989"}))
                    } else if line.starts_with("GET /gists?") {
                        let list: Vec<Value> = store
                            .lock()
                            .unwrap()
                            .keys()
                            .map(|id| json!({"id": id, "files": {VAULT_FILE: {}}}))
                            .collect();
                        (200, Value::Array(list))
                    } else if line.starts_with("POST /gists ") {
                        assert_eq!(body["public"], false, "vault gist must be secret");
                        let id = format!("g{}", store.lock().unwrap().len() + 1);
                        store.lock().unwrap().insert(id.clone(), content_of(&body));
                        (201, json!({"id": id}))
                    } else if let Some(rest) = line.strip_prefix("GET /gists/") {
                        let id = rest.split(' ').next().unwrap();
                        match store.lock().unwrap().get(id) {
                            Some(c) => (200, json!({"id": id, "files": {VAULT_FILE: {"content": c, "truncated": false}}})),
                            None => (404, json!({"message": "Not Found"})),
                        }
                    } else if let Some(rest) = line.strip_prefix("PATCH /gists/") {
                        let id = rest.split(' ').next().unwrap().to_string();
                        store.lock().unwrap().insert(id, content_of(&body));
                        (200, json!({}))
                    } else {
                        (404, json!({"message": "Not Found"}))
                    };
                    let payload = payload.to_string();
                    let reply = format!(
                        "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{payload}",
                        payload.len()
                    );
                    sock.write_all(reply.as_bytes()).await.unwrap();
                });
            }
        });
        (base, gists)
    }

    /// One device's keychain.
    #[derive(Default)]
    struct MemSecrets(Mutex<BTreeMap<String, String>>);

    impl SecretStore for MemSecrets {
        fn get(&self, account: &str) -> anyhow::Result<Option<String>> {
            Ok(self.0.lock().unwrap().get(account).cloned())
        }
        fn set(&self, account: &str, secret: &str) -> anyhow::Result<()> {
            self.0.lock().unwrap().insert(account.into(), secret.into());
            Ok(())
        }
        fn delete(&self, account: &str) -> anyhow::Result<()> {
            self.0.lock().unwrap().remove(account);
            Ok(())
        }
    }

    fn temp_dir() -> PathBuf {
        std::env::temp_dir().join(format!("sync-{}", uuid::Uuid::new_v4()))
    }

    #[tokio::test]
    async fn two_devices_converge_through_the_gist() {
        let (api, gists) = fake_github("tok").await;
        let http = reqwest::Client::new();
        let gh = GitHub { http: &http, api: &api, token: "tok" };
        let (laptop, phone) = (temp_dir(), temp_dir());
        let (laptop_keys, phone_keys) = (MemSecrets::default(), MemSecrets::default());

        // Laptop has hosts; first sync creates the vault.
        let laptop_hosts = JsonStore::<Host>::new(&laptop, "hosts.json");
        laptop_hosts.write(&[host("h1", "web", 0), host("h2", "db", 0)]).unwrap();
        laptop_keys.set("h1", "s3cret").unwrap();
        record_secret_change(&laptop, "h1").unwrap();
        let r = sync(&laptop, &laptop_keys, &gh, "pw").await.unwrap();
        assert!(r.pushed && !r.changed);
        assert_eq!(gists.lock().unwrap().len(), 1);

        // A fresh phone finds the vault on its own and receives the hosts.
        let r = sync(&phone, &phone_keys, &gh, "pw").await.unwrap();
        assert!(r.changed);
        let phone_hosts = JsonStore::<Host>::new(&phone, "hosts.json");
        assert_eq!(phone_hosts.list().unwrap().len(), 2);
        assert_eq!(phone_keys.get("h1").unwrap().as_deref(), Some("s3cret"));
        // GitHub only ever sees ciphertext.
        let stored = gists.lock().unwrap().values().next().unwrap().clone();
        assert!(!stored.contains("s3cret") && !stored.contains("web"));

        // Phone renames one host and deletes the other; laptop picks both up.
        let mut web = phone_hosts.list().unwrap().into_iter().find(|h| h.id == "h1").unwrap();
        web.label = "web (renamed)".into();
        phone_hosts.save(web).unwrap();
        phone_hosts.delete("h2").unwrap();
        record_deletion(&phone, "h2").unwrap();
        phone_keys.set("h1", "changed").unwrap();
        record_secret_change(&phone, "h1").unwrap();
        sync(&phone, &phone_keys, &gh, "pw").await.unwrap();
        let r = sync(&laptop, &laptop_keys, &gh, "pw").await.unwrap();
        assert!(r.changed);
        let labels: Vec<_> = laptop_hosts.list().unwrap().into_iter().map(|h| h.label).collect();
        assert_eq!(labels, ["web (renamed)"]);
        assert_eq!(laptop_keys.get("h1").unwrap().as_deref(), Some("changed"));

        // Nothing new: the next round neither changes nor pushes anything.
        let r = sync(&laptop, &laptop_keys, &gh, "pw").await.unwrap();
        assert!(!r.changed && !r.pushed);

        // The wrong password is caught before anything is overwritten.
        let e = check_setup(&gh, "nope").await.unwrap_err().to_string();
        assert!(e.contains("does not open it"), "{e}");
        let bad = GitHub { http: &http, api: &api, token: "bad" };
        assert!(bad.login().await.unwrap_err().to_string().contains("invalid or expired"));

        for d in [laptop, phone] {
            std::fs::remove_dir_all(d).unwrap();
        }
    }
    #[tokio::test]
    async fn private_keys_reach_devices_without_them() {
        let (api, gists) = fake_github("tok").await;
        let http = reqwest::Client::new();
        let gh = GitHub { http: &http, api: &api, token: "tok" };
        let (laptop, phone) = (temp_dir(), temp_dir());
        let keys = MemSecrets::default();

        // The laptop has a real key file at the host's key path.
        let real_key = laptop.join("id_ed25519");
        let key_path = real_key.to_str().unwrap().to_string();
        std::fs::create_dir_all(&laptop).unwrap();
        std::fs::write(&real_key, "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n").unwrap();
        let mut server = host("h1", "web", 0);
        server.auth_method = AuthMethod::Key;
        server.key_path = Some(key_path.clone());
        JsonStore::<Host>::new(&laptop, "hosts.json").write(&[server]).unwrap();
        sync(&laptop, &keys, &gh, "pw").await.unwrap();
        let stored = gists.lock().unwrap().values().next().unwrap().clone();
        assert!(!stored.contains("OPENSSH"));

        // The phone has no file at that path: it gets a private synced copy,
        // and connecting resolves the key path to it.
        std::fs::rename(&real_key, laptop.join("moved")).unwrap();
        let r = sync(&phone, &keys, &gh, "pw").await.unwrap();
        assert!(r.changed);
        let synced = synced_keys_dir(&phone);
        let resolved = keyfiles::resolve(&synced, &key_path);
        assert!(resolved.starts_with(&synced));
        assert!(std::fs::read_to_string(&resolved).unwrap().contains("abc"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&resolved).unwrap().permissions().mode() & 0o777, 0o600);
        }

        // Steady state: nothing to change or push.
        let r = sync(&phone, &keys, &gh, "pw").await.unwrap();
        assert!(!r.changed && !r.pushed);

        // Switching the host to password login drops the key everywhere.
        let phone_hosts = JsonStore::<Host>::new(&phone, "hosts.json");
        let mut h = phone_hosts.list().unwrap().remove(0);
        h.auth_method = AuthMethod::Password;
        phone_hosts.save(h).unwrap();
        sync(&phone, &keys, &gh, "pw").await.unwrap();
        assert!(!resolved.exists());

        for d in [laptop, phone] {
            std::fs::remove_dir_all(d).unwrap();
        }
    }
}
