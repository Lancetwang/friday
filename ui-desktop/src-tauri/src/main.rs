#![cfg_attr(windows, windows_subsystem = "windows")]

use std::{
    collections::HashMap,
    env,
    fs,
    path::PathBuf,
    sync::Mutex,
};
use tauri::{webview::PageLoadEvent, Emitter, Manager};
use tauri_plugin_shell::{
    process::{Command, CommandChild, CommandEvent},
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
    let home = env::var_os("FRIDAY_HOME").map(PathBuf::from).unwrap_or_else(|| {
        env::var_os("USERPROFILE")
            .map(PathBuf::from)
            .unwrap_or_else(|| env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
            .join(".friday")
    });
    let workspace = home.join("workspace");
    fs::create_dir_all(&workspace).map_err(|error| error.to_string())?;
    canonical_directory(workspace)
}

fn canonical_directory(path: PathBuf) -> Result<PathBuf, String> {
    let resolved = path.canonicalize().map_err(|error| error.to_string())?;
    if !resolved.is_dir() {
        return Err(format!("Workspace is not a directory: {}", resolved.display()));
    }
    Ok(resolved)
}

#[tauri::command]
fn resolve_directory(path: String) -> Result<String, String> {
    canonical_directory(PathBuf::from(path)).map(|value| value.display().to_string())
}

fn take_lines(buffer: &mut Vec<u8>, bytes: &[u8]) -> Vec<String> {
    buffer.extend_from_slice(bytes);
    let mut lines = Vec::new();
    while let Some(end) = buffer.iter().position(|byte| *byte == b'\n') {
        let mut raw: Vec<u8> = buffer.drain(..=end).collect();
        raw.pop();
        if raw.last() == Some(&b'\r') {
            raw.pop();
        }
        lines.push(String::from_utf8_lossy(&raw).to_string());
    }
    lines
}

#[cfg(debug_assertions)]
fn app_server_command(app: &tauri::AppHandle) -> Result<Command, String> {
    let repository = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let repository = repository.to_string_lossy().into_owned();
    Ok(app.shell().command("uv").args([
        "run",
        "--project",
        repository.as_str(),
        "--no-sync",
        "friday",
        "app-server",
    ]))
}

#[cfg(not(debug_assertions))]
fn app_server_command(app: &tauri::AppHandle) -> Result<Command, String> {
    app.shell()
        .sidecar("friday-app-server")
        .map_err(|error| error.to_string())
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

    let (mut receiver, child) = app_server_command(&app)?
        .current_dir(&workspace)
        .spawn()
        .map_err(|error| error.to_string())?;
    let child_pid = child.pid();

    let workspace_label = workspace.display().to_string();
    let event_workspace = workspace_label.clone();
    let process_workspace = workspace.clone();
    tauri::async_runtime::spawn(async move {
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        while let Some(event) = receiver.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    for line in take_lines(&mut stdout, &bytes) {
                        if !line.is_empty() {
                            let _ = app.emit("gateway-line", (event_workspace.clone(), line));
                        }
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    for line in take_lines(&mut stderr, &bytes) {
                        if !line.is_empty() {
                            let _ = app.emit("gateway-stderr", (event_workspace.clone(), line));
                        }
                    }
                }
                _ => {}
            }
        }
        if !stdout.is_empty() {
            let _ = app.emit(
                "gateway-line",
                (
                    event_workspace.clone(),
                    String::from_utf8_lossy(&stdout).to_string(),
                ),
            );
        }
        if !stderr.is_empty() {
            let _ = app.emit(
                "gateway-stderr",
                (
                    event_workspace.clone(),
                    String::from_utf8_lossy(&stderr).to_string(),
                ),
            );
        }
        if let Ok(mut gateways) = app.state::<GatewayState>().0.lock() {
            if gateways
                .get(&process_workspace)
                .is_some_and(|current| current.pid() == child_pid)
            {
                gateways.remove(&process_workspace);
            }
        }
        let _ = app.emit("gateway-exit", event_workspace);
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

#[cfg(test)]
mod tests {
    use super::take_lines;

    #[test]
    fn frames_split_utf8_json_lines_without_corruption() {
        let source = "{\"text\":\"你好\"}\n{\"ok\":true}\n".as_bytes();
        let split = source.iter().position(|byte| *byte >= 0x80).unwrap() + 1;
        let mut buffer = Vec::new();

        assert!(take_lines(&mut buffer, &source[..split]).is_empty());
        assert_eq!(
            take_lines(&mut buffer, &source[split..]),
            vec!["{\"text\":\"你好\"}", "{\"ok\":true}"]
        );
        assert!(buffer.is_empty());
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(GatewayState::default())
        .plugin(tauri_plugin_shell::init())
        .on_page_load(|webview, payload| {
            if matches!(payload.event(), PageLoadEvent::Finished) {
                let _ = webview.window().show();
            }
        })
        .invoke_handler(tauri::generate_handler![
            resolve_directory,
            gateway_start,
            gateway_send,
            gateway_stop
        ])
        .run(tauri::generate_context!())
        .expect("error while running Friday desktop");
}
