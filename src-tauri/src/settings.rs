//! App preferences, persisted as settings.json in the app data directory.
//! The Anthropic API key is not stored here — it lives in the OS keychain.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const DEFAULT_AI_MODEL: &str = "claude-opus-5-5";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// "ollama" (free, runs locally) or "anthropic" (Claude API, needs a key).
    pub ai_provider: String,
    pub ollama_url: String,
    pub ollama_model: String,
    /// Claude model used when the provider is "anthropic".
    pub ai_model: String,
    /// Send the last lines of terminal output along with AI requests.
    pub ai_include_output: bool,
    /// The built-in snippet library has been added once (so deleting
    /// library snippets doesn't bring them back on the next start).
    pub library_seeded: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            ai_provider: "ollama".into(),
            ollama_url: crate::ollama::DEFAULT_URL.into(),
            ollama_model: crate::ollama::DEFAULT_MODEL.into(),
            ai_model: DEFAULT_AI_MODEL.into(),
            ai_include_output: false,
            library_seeded: false,
        }
    }
}

fn path(dir: &Path) -> PathBuf {
    dir.join("settings.json")
}

pub fn load(dir: &Path) -> anyhow::Result<Settings> {
    match std::fs::read_to_string(path(dir)) {
        Ok(text) => Ok(serde_json::from_str(&text)?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Settings::default()),
        Err(e) => Err(e.into()),
    }
}

pub fn save(dir: &Path, settings: &Settings) -> anyhow::Result<()> {
    std::fs::create_dir_all(dir)?;
    std::fs::write(path(dir), serde_json::to_string_pretty(settings)?)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_fields_fall_back_to_defaults() {
        let s: Settings = serde_json::from_str(r#"{"aiIncludeOutput": true}"#).unwrap();
        assert_eq!(s.ai_model, DEFAULT_AI_MODEL);
        assert_eq!(s.ai_provider, "ollama");
        assert!(s.ai_include_output);
        assert!(!s.library_seeded);
    }
}
