mod hosts;
mod ssh;

use std::path::PathBuf;

use hosts::{Host, HostStore};
use ssh::{ConnectRequest, SessionManager, SshEvent};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

type CmdResult<T> = Result<T, String>;

fn data_dir(app: &AppHandle) -> CmdResult<PathBuf> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

#[tauri::command]
fn hosts_list(app: AppHandle) -> CmdResult<Vec<Host>> {
    HostStore::new(&data_dir(&app)?)
        .list()
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn hosts_save(app: AppHandle, host: Host) -> CmdResult<Host> {
    HostStore::new(&data_dir(&app)?)
        .save(host)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn hosts_delete(app: AppHandle, id: String) -> CmdResult<()> {
    HostStore::new(&data_dir(&app)?)
        .delete(&id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn ssh_connect(
    app: AppHandle,
    sessions: State<'_, SessionManager>,
    request: ConnectRequest,
    on_event: Channel<SshEvent>,
) -> CmdResult<String> {
    let known_hosts = data_dir(&app)?.join("known_hosts");
    sessions
        .connect(request, known_hosts, on_event)
        .await
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
async fn ssh_write(
    sessions: State<'_, SessionManager>,
    id: String,
    data: Vec<u8>,
) -> CmdResult<()> {
    sessions.write(&id, data).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn ssh_resize(
    sessions: State<'_, SessionManager>,
    id: String,
    cols: u32,
    rows: u32,
) -> CmdResult<()> {
    sessions
        .resize(&id, cols, rows)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn ssh_close(sessions: State<'_, SessionManager>, id: String) -> CmdResult<()> {
    sessions.close(&id).await.map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(SessionManager::default())
        .invoke_handler(tauri::generate_handler![
            hosts_list,
            hosts_save,
            hosts_delete,
            ssh_connect,
            ssh_write,
            ssh_resize,
            ssh_close,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
