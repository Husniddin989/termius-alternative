mod ai;
mod conn;
mod forward;
mod hostkey;
mod knownhosts;
mod localfs;
mod ollama;
mod pty;
mod secrets;
mod settings;
mod sftp;
mod ssh;
mod store;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use conn::{ConnectContext, ConnectRequest};
use forward::{ForwardManager, ForwardSpec};
use hostkey::UiVerifier;
use pty::LocalTerminals;
use settings::Settings;
use sftp::{Entry, Opened, Progress, SftpManager};
use ssh::{SessionManager, SshEvent};
use store::{ForwardRule, Host, JsonStore, Record, Snippet};
use tauri::ipc::Channel;
use tauri::{Manager, State};

type CmdResult<T> = Result<T, String>;

fn err(e: anyhow::Error) -> String {
    format!("{e:#}")
}

struct AppState {
    data_dir: PathBuf,
    ctx: ConnectContext,
    verifier: Arc<UiVerifier>,
    sessions: SessionManager,
    sftp: SftpManager,
    forwards: ForwardManager,
    terms: LocalTerminals,
    http: reqwest::Client,
}

impl AppState {
    fn store<T: Record>(&self, file: &str) -> JsonStore<T> {
        JsonStore::new(&self.data_dir, file)
    }
    fn hosts(&self) -> JsonStore<Host> {
        self.store("hosts.json")
    }
    fn snippets(&self) -> JsonStore<Snippet> {
        self.store("snippets.json")
    }
    fn forward_rules(&self) -> JsonStore<ForwardRule> {
        self.store("forwards.json")
    }
}

// ---- Saved data -----------------------------------------------------------

#[tauri::command]
fn hosts_list(state: State<'_, AppState>) -> CmdResult<Vec<Host>> {
    state.hosts().list().map_err(err)
}

#[tauri::command]
fn hosts_save(state: State<'_, AppState>, host: Host) -> CmdResult<Host> {
    state.hosts().save(host).map_err(err)
}

#[tauri::command]
fn hosts_delete(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    let _ = secrets::delete(&id);
    state.hosts().delete(&id).map_err(err)
}

#[tauri::command]
fn snippets_list(state: State<'_, AppState>) -> CmdResult<Vec<Snippet>> {
    state.snippets().list().map_err(err)
}

#[tauri::command]
fn snippets_save(state: State<'_, AppState>, snippet: Snippet) -> CmdResult<Snippet> {
    state.snippets().save(snippet).map_err(err)
}

/// Adds built-in library snippets that aren't saved yet (matched by command).
#[tauri::command]
fn snippets_seed(state: State<'_, AppState>, snippets: Vec<Snippet>) -> CmdResult<usize> {
    let added = state
        .snippets()
        .extend(snippets, |a, b| a.command.trim() == b.command.trim())
        .map_err(err)?;
    let mut s = settings::load(&state.data_dir).map_err(err)?;
    if !s.library_seeded {
        s.library_seeded = true;
        settings::save(&state.data_dir, &s).map_err(err)?;
    }
    Ok(added)
}

#[tauri::command]
fn snippets_delete(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.snippets().delete(&id).map_err(err)
}

#[tauri::command]
fn forwards_list(state: State<'_, AppState>) -> CmdResult<Vec<ForwardRule>> {
    state.forward_rules().list().map_err(err)
}

#[tauri::command]
fn forwards_save(state: State<'_, AppState>, rule: ForwardRule) -> CmdResult<ForwardRule> {
    state.forward_rules().save(rule).map_err(err)
}

#[tauri::command]
async fn forwards_delete(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.forwards.stop(&id).await;
    state.forward_rules().delete(&id).map_err(err)
}

// ---- Keychain & host keys -------------------------------------------------

#[tauri::command]
fn secret_get(host_id: String) -> CmdResult<Option<String>> {
    secrets::get(&host_id).map_err(err)
}

#[tauri::command]
fn secret_set(host_id: String, secret: String) -> CmdResult<()> {
    secrets::set(&host_id, &secret).map_err(err)
}

#[tauri::command]
fn secret_delete(host_id: String) -> CmdResult<()> {
    secrets::delete(&host_id).map_err(err)
}

#[tauri::command]
async fn host_key_respond(state: State<'_, AppState>, id: String, accept: bool) -> CmdResult<()> {
    state.verifier.respond(&id, accept).await;
    Ok(())
}

#[tauri::command]
fn known_hosts_list(state: State<'_, AppState>) -> CmdResult<Vec<knownhosts::KnownHost>> {
    knownhosts::list(&state.ctx.known_hosts).map_err(err)
}

#[tauri::command]
fn known_hosts_remove(state: State<'_, AppState>, line: usize) -> CmdResult<()> {
    knownhosts::remove(&state.ctx.known_hosts, line).map_err(err)
}

// ---- Local files (left pane of SFTP) ----------------------------------------

#[tauri::command]
fn local_home() -> String {
    localfs::home()
}

#[tauri::command]
fn local_list(path: String) -> CmdResult<Vec<Entry>> {
    localfs::list(path.as_ref()).map_err(err)
}

// ---- Settings & AI --------------------------------------------------------

#[tauri::command]
fn settings_get(state: State<'_, AppState>) -> CmdResult<Settings> {
    settings::load(&state.data_dir).map_err(err)
}

#[tauri::command]
fn settings_set(state: State<'_, AppState>, settings: Settings) -> CmdResult<()> {
    settings::save(&state.data_dir, &settings).map_err(err)
}

#[tauri::command]
fn ai_key_status() -> CmdResult<bool> {
    Ok(secrets::get(ai::API_KEY_ACCOUNT).map_err(err)?.is_some())
}

/// Saves the API key in the keychain; an empty key removes it.
#[tauri::command]
fn ai_key_set(key: String) -> CmdResult<()> {
    let key = key.trim();
    if key.is_empty() {
        secrets::delete(ai::API_KEY_ACCOUNT).map_err(err)
    } else {
        secrets::set(ai::API_KEY_ACCOUNT, key).map_err(err)
    }
}

#[tauri::command]
async fn ai_suggest(state: State<'_, AppState>, request: ai::SuggestRequest) -> CmdResult<ai::Suggestion> {
    let s = settings::load(&state.data_dir).map_err(err)?;
    if s.ai_provider == "anthropic" {
        let key = secrets::get(ai::API_KEY_ACCOUNT)
            .map_err(err)?
            .ok_or("Add your Anthropic API key in Settings, or switch to the free local AI.")?;
        ai::suggest(&state.http, &key, &s.ai_model, &request).await.map_err(err)
    } else {
        ollama::suggest(&state.http, &s.ollama_url, &s.ollama_model, &request)
            .await
            .map_err(err)
    }
}

#[tauri::command]
async fn ollama_models(state: State<'_, AppState>, url: String) -> CmdResult<Vec<ollama::LocalModel>> {
    ollama::list_models(&state.http, &url).await.map_err(err)
}

#[tauri::command]
async fn ollama_pull(
    state: State<'_, AppState>,
    url: String,
    model: String,
    on_progress: Channel<ollama::PullProgress>,
) -> CmdResult<()> {
    ollama::pull(&state.http, &url, &model, |p| {
        let _ = on_progress.send(p);
    })
    .await
    .map_err(err)
}

// ---- Local terminal ---------------------------------------------------------

#[tauri::command]
async fn pty_open(
    state: State<'_, AppState>,
    cols: u32,
    rows: u32,
    on_event: Channel<SshEvent>,
) -> CmdResult<String> {
    state.terms.open(cols, rows, on_event).map_err(err)
}

#[tauri::command]
async fn pty_write(state: State<'_, AppState>, id: String, data: Vec<u8>) -> CmdResult<()> {
    state.terms.write(&id, &data).map_err(err)
}

#[tauri::command]
async fn pty_resize(state: State<'_, AppState>, id: String, cols: u32, rows: u32) -> CmdResult<()> {
    state.terms.resize(&id, cols, rows).map_err(err)
}

#[tauri::command]
async fn pty_close(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.terms.close(&id);
    Ok(())
}

// ---- Terminal -------------------------------------------------------------

#[tauri::command]
async fn ssh_connect(
    state: State<'_, AppState>,
    request: ConnectRequest,
    cols: u32,
    rows: u32,
    on_event: Channel<SshEvent>,
) -> CmdResult<ssh::Opened> {
    state
        .sessions
        .open(request, &state.ctx, cols, rows, on_event)
        .await
        .map_err(err)
}

#[tauri::command]
async fn ssh_write(state: State<'_, AppState>, id: String, data: Vec<u8>) -> CmdResult<()> {
    state.sessions.write(&id, data).await.map_err(err)
}

#[tauri::command]
async fn ssh_resize(state: State<'_, AppState>, id: String, cols: u32, rows: u32) -> CmdResult<()> {
    state.sessions.resize(&id, cols, rows).await.map_err(err)
}

#[tauri::command]
async fn ssh_close(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.sessions.close(&id).await;
    Ok(())
}

// ---- SFTP -----------------------------------------------------------------

#[tauri::command]
async fn sftp_open(state: State<'_, AppState>, request: ConnectRequest) -> CmdResult<Opened> {
    state.sftp.open(request, &state.ctx).await.map_err(err)
}

#[tauri::command]
async fn sftp_list(state: State<'_, AppState>, id: String, path: String) -> CmdResult<Vec<Entry>> {
    state.sftp.list(&id, &path).await.map_err(err)
}

#[tauri::command]
async fn sftp_download(
    state: State<'_, AppState>,
    id: String,
    remote: String,
    local: String,
    on_progress: Channel<Progress>,
) -> CmdResult<()> {
    state
        .sftp
        .download(&id, &remote, local.as_ref(), Some(on_progress))
        .await
        .map_err(err)
}

#[tauri::command]
async fn sftp_upload(
    state: State<'_, AppState>,
    id: String,
    local: String,
    remote: String,
    on_progress: Channel<Progress>,
) -> CmdResult<()> {
    state
        .sftp
        .upload(&id, local.as_ref(), &remote, Some(on_progress))
        .await
        .map_err(err)
}

#[tauri::command]
async fn sftp_mkdir(state: State<'_, AppState>, id: String, path: String) -> CmdResult<()> {
    state.sftp.mkdir(&id, &path).await.map_err(err)
}

#[tauri::command]
async fn sftp_rename(state: State<'_, AppState>, id: String, from: String, to: String) -> CmdResult<()> {
    state.sftp.rename(&id, &from, &to).await.map_err(err)
}

#[tauri::command]
async fn sftp_remove(
    state: State<'_, AppState>,
    id: String,
    path: String,
    is_dir: bool,
) -> CmdResult<()> {
    state.sftp.remove(&id, &path, is_dir).await.map_err(err)
}

#[tauri::command]
async fn sftp_close(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.sftp.close(&id).await;
    Ok(())
}

// ---- Port forwarding ------------------------------------------------------

#[tauri::command]
async fn forward_start(
    state: State<'_, AppState>,
    rule_id: String,
    request: ConnectRequest,
) -> CmdResult<String> {
    let rule = state
        .forward_rules()
        .list()
        .map_err(err)?
        .into_iter()
        .find(|r| r.id == rule_id)
        .ok_or("forwarding rule not found")?;
    let spec = ForwardSpec {
        kind: rule.kind,
        bind_host: rule.bind_host,
        bind_port: rule.bind_port,
        dest_host: rule.dest_host,
        dest_port: rule.dest_port,
    };
    let bound = state
        .forwards
        .start(rule_id, request, &state.ctx, spec)
        .await
        .map_err(err)?;
    Ok(bound.to_string())
}

#[tauri::command]
async fn forward_stop(state: State<'_, AppState>, rule_id: String) -> CmdResult<()> {
    state.forwards.stop(&rule_id).await;
    Ok(())
}

#[tauri::command]
async fn forward_active(state: State<'_, AppState>) -> CmdResult<HashMap<String, String>> {
    Ok(state.forwards.active().await)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let verifier = UiVerifier::new(app.handle().clone());
            app.manage(AppState {
                ctx: ConnectContext {
                    known_hosts: data_dir.join("known_hosts"),
                    verifier: verifier.clone(),
                },
                data_dir,
                verifier,
                sessions: SessionManager::default(),
                sftp: SftpManager::default(),
                forwards: ForwardManager::default(),
                terms: LocalTerminals::default(),
                // Per-request timeouts: model downloads can take many minutes.
                http: reqwest::Client::builder()
                    .connect_timeout(std::time::Duration::from_secs(10))
                    .build()?,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            hosts_list,
            hosts_save,
            hosts_delete,
            snippets_list,
            snippets_save,
            snippets_delete,
            snippets_seed,
            settings_get,
            settings_set,
            ai_key_status,
            ai_key_set,
            ai_suggest,
            ollama_models,
            ollama_pull,
            pty_open,
            pty_write,
            pty_resize,
            pty_close,
            forwards_list,
            forwards_save,
            forwards_delete,
            secret_get,
            secret_set,
            secret_delete,
            host_key_respond,
            known_hosts_list,
            known_hosts_remove,
            local_home,
            local_list,
            ssh_connect,
            ssh_write,
            ssh_resize,
            ssh_close,
            sftp_open,
            sftp_list,
            sftp_download,
            sftp_upload,
            sftp_mkdir,
            sftp_rename,
            sftp_remove,
            sftp_close,
            forward_start,
            forward_stop,
            forward_active,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
