#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    collections::HashMap,
    env,
    path::PathBuf,
    sync::Mutex,
};
use tauri::Emitter;
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

#[derive(Default)]
struct GatewayState(Mutex<HashMap<PathBuf, CommandChild>>);

fn workspace_root(requested: Option<String>) -> Result<PathBuf, String> {
    if let Some(path) = requested.filter(|value| !value.trim().is_empty()) {
        return canonical_directory(PathBuf::from(path));
    }
    if let Some(path) = env::var_os("FRIDAY_CWD") {
        return canonical_directory(PathBuf::from(path));
    }
    let cwd = env::current_dir().map_err(|error| error.to_string())?;
    if let Some(root) = cwd
        .ancestors()
        .find(|path| path.join("pyproject.toml").is_file())
    {
        return Ok(root.to_path_buf());
    }
    canonical_directory(
        env::var_os("USERPROFILE")
            .map(PathBuf::from)
            .unwrap_or(cwd),
    )
}

fn canonical_directory(path: PathBuf) -> Result<PathBuf, String> {
    let resolved = path.canonicalize().map_err(|error| error.to_string())?;
    if !resolved.is_dir() {
        return Err(format!("Workspace is not a directory: {}", resolved.display()));
    }
    Ok(resolved)
}

#[tauri::command]
fn gateway_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, GatewayState>,
    workspace: Option<String>,
) -> Result<String, String> {
    let mut current = state.0.lock().map_err(|error| error.to_string())?;
    let workspace = workspace_root(workspace)?;
    if current.contains_key(&workspace) {
        return Ok(workspace.display().to_string());
    }

    let (mut receiver, child) = app
        .shell()
        .sidecar("friday-app-server")
        .map_err(|error| error.to_string())?
        .current_dir(&workspace)
        .spawn()
        .map_err(|error| error.to_string())?;

    let workspace_label = workspace.display().to_string();
    let event_workspace = workspace_label.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = receiver.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    let line = String::from_utf8_lossy(&bytes).trim().to_string();
                    if !line.is_empty() {
                        let _ = app.emit("gateway-line", (event_workspace.clone(), line));
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    let line = String::from_utf8_lossy(&bytes).trim().to_string();
                    if !line.is_empty() {
                        let _ = app.emit("gateway-stderr", (event_workspace.clone(), line));
                    }
                }
                _ => {}
            }
        }
    });

    current.insert(workspace, child);
    Ok(workspace_label)
}

#[tauri::command]
fn gateway_send(
    workspace: String,
    message: String,
    state: tauri::State<'_, GatewayState>,
) -> Result<(), String> {
    let mut current = state.0.lock().map_err(|error| error.to_string())?;
    let workspace = canonical_directory(PathBuf::from(workspace))?;
    let child = current
        .get_mut(&workspace)
        .ok_or("Friday gateway is not running for this project.")?;
    child
        .write(format!("{message}\n").as_bytes())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn gateway_stop(
    workspace: Option<String>,
    state: tauri::State<'_, GatewayState>,
) -> Result<(), String> {
    let mut current = state.0.lock().map_err(|error| error.to_string())?;
    if let Some(workspace) = workspace {
        if let Some(child) = current.remove(&canonical_directory(PathBuf::from(workspace))?) {
            let _ = child.kill();
        }
    } else {
        for (_, child) in current.drain() {
            let _ = child.kill();
        }
    }
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(GatewayState::default())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            gateway_start,
            gateway_send,
            gateway_stop
        ])
        .run(tauri::generate_context!())
        .expect("error while running Friday desktop");
}
