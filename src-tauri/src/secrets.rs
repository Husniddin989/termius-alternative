//! Host passwords and key passphrases, kept in the OS keychain
//! (macOS Keychain, Windows Credential Manager, Secret Service on Linux).

const SERVICE: &str = "termius-alternative";

fn entry(host_id: &str) -> keyring::Result<keyring::Entry> {
    keyring::Entry::new(SERVICE, host_id)
}

pub fn get(host_id: &str) -> anyhow::Result<Option<String>> {
    match entry(host_id)?.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn set(host_id: &str, secret: &str) -> anyhow::Result<()> {
    Ok(entry(host_id)?.set_password(secret)?)
}

pub fn delete(host_id: &str) -> anyhow::Result<()> {
    match entry(host_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}
