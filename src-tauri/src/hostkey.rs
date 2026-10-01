//! Asks the user, through the UI, whether to trust a new host key.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::{oneshot, Mutex};

use crate::conn::{HostKeyInfo, HostKeyVerifier};

pub const PROMPT_EVENT: &str = "host-key-prompt";
const ANSWER_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Prompt {
    id: String,
    #[serde(flatten)]
    info: HostKeyInfo,
}

pub struct UiVerifier {
    app: AppHandle,
    pending: Mutex<HashMap<String, oneshot::Sender<bool>>>,
}

impl UiVerifier {
    pub fn new(app: AppHandle) -> Arc<Self> {
        Arc::new(Self {
            app,
            pending: Mutex::new(HashMap::new()),
        })
    }

    /// Delivers the user's answer to a pending prompt.
    pub async fn respond(&self, id: &str, accept: bool) {
        if let Some(tx) = self.pending.lock().await.remove(id) {
            let _ = tx.send(accept);
        }
    }
}

#[async_trait]
impl HostKeyVerifier for UiVerifier {
    async fn confirm_new_host(&self, info: HostKeyInfo) -> bool {
        let id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id.clone(), tx);
        if self
            .app
            .emit(PROMPT_EVENT, Prompt { id: id.clone(), info })
            .is_err()
        {
            self.pending.lock().await.remove(&id);
            return false;
        }
        let accepted = matches!(tokio::time::timeout(ANSWER_TIMEOUT, rx).await, Ok(Ok(true)));
        self.pending.lock().await.remove(&id);
        accepted
    }
}
