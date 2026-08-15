#![cfg_attr(windows, windows_subsystem = "windows")]

use std::{
    collections::{HashMap, VecDeque},
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
struct GatewayState {
    children: Mutex<HashMap<PathBuf, CommandChild>>,
    /// Pids this window stopped on purpose, so their exit is not reported as a
    /// crash. Keyed by workspace; an entry is consumed when the exit event for
    /// that pid is emitted.
    stopped: Mutex<HashMap<PathBuf, u32>>,
}

fn workspace_root(requested: Option<String>) -> Result<PathBuf, String> {
    if let Some(path) = requested.filter(|value| !value.trim().is_empty()) {
        return canonical_directory(PathBuf::from(path));
    }
    if let Some(path) = env::var_os("FRIDAY_CWD") {
        return canonical_directory(PathBuf::from(path));
    }
    let home = env::var_os("FRIDAY_HOME").map(PathBuf::from).unwrap_or_else(|| {
        env::var_os("USERPROFILE")
            .or_else(|| env::var_os("HOME"))
            .map(PathBuf::from)
            .unwrap_or_else(|| env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
            .join(".friday")
    });
    let workspace = home.join("workspace");
    fs::create_dir_all(&workspace).map_err(|error| error.to_string())?;
    canonical_directory(workspace)
}

fn canonical_directory(path: PathBuf) -> Result<PathBuf, String> {
    // A bare OS error names no path, so a deleted project read as an unexplained
    // "cannot find the path specified" once it reached the window.
    let resolved = path
        .canonicalize()
        .map_err(|error| format!("Cannot open {}: {error}", path.display()))?;
    if !resolved.is_dir() {
        return Err(format!("Workspace is not a directory: {}", resolved.display()));
    }
    Ok(plain_path(resolved))
}

/// Strip Windows' extended-length prefix, which `canonicalize` adds.
///
/// This value is what the window stores and what it names projects by over the
/// gateway, so `\\?\E:\work` becomes a second identity for a directory already
/// known as `E:\work`: the sidebar lists it twice, and closing one leaves the
/// other open.
fn plain_path(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    match text.strip_prefix(r"\\?\") {
        Some(rest) => PathBuf::from(rest.to_string()),
        None => path,
    }
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
fn repository_root() -> Result<PathBuf, String> {
    Ok(plain_path(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .canonicalize()
            .map_err(|error| error.to_string())?,
    ))
}

#[cfg(debug_assertions)]
fn app_server_command(app: &tauri::AppHandle) -> Result<Command, String> {
    let repository = repository_root()?;
    let gateway = repository.join("packages/harness/dist/gateway.js");
    if !gateway.is_file() {
        return Err(format!(
            "Friday gateway is not built: {}. Run npm run build first.",
            gateway.display()
        ));
    }
    Ok(app
        .shell()
        .command("node")
        .args([gateway.to_string_lossy().into_owned()]))
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
    let mut current = state.children.lock().map_err(|error| error.to_string())?;
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
        // Keep the tail of the child stderr so a gateway crash can surface its
        // own reason (traceback, dyld failure, Gatekeeper kill) instead of an
        // opaque "stopped" notice.
        const STDERR_TAIL_LINES: usize = 40;
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut stderr_tail: VecDeque<String> = VecDeque::new();
        let mut termination = String::new();
        let remember = |line: &str, tail: &mut VecDeque<String>| {
            if tail.len() == STDERR_TAIL_LINES {
                tail.pop_front();
            }
            tail.push_back(line.to_string());
        };
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
                            remember(&line, &mut stderr_tail);
                            let _ = app.emit("gateway-stderr", (event_workspace.clone(), line));
                        }
                    }
                }
                CommandEvent::Terminated(payload) => {
                    termination = match (payload.code, payload.signal) {
                        (Some(code), _) => format!("process exited with code {code}"),
                        (None, Some(signal)) => {
                            format!("process killed by signal {signal} (likely macOS Gatekeeper or code signing)")
                        }
                        (None, None) => "process terminated".to_string(),
                    };
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
            let line = String::from_utf8_lossy(&stderr).to_string();
            remember(&line, &mut stderr_tail);
            let _ = app.emit("gateway-stderr", (event_workspace.clone(), line));
        }
        if let Ok(mut gateways) = app.state::<GatewayState>().children.lock() {
            if gateways
                .get(&process_workspace)
                .is_some_and(|current| current.pid() == child_pid)
            {
                gateways.remove(&process_workspace);
            }
        }
        let detail = [termination, stderr_tail.into_iter().collect::<Vec<_>>().join("\n")]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join("\n");
        // A stop this window asked for is housekeeping: the window handles it as
        // an idle reclaim and does not surface it. Anything else is a crash the
        // window has to report, and only a matching pid proves which one it is
        // (the user may have restarted the project while this process was
        // shutting down, so the workspace alone cannot tell them apart).
        let stopped_by_us = app
            .state::<GatewayState>()
            .stopped
            .lock()
            .ok()
            .and_then(|mut stopped| stopped.remove(&process_workspace))
            == Some(child_pid);
        let _ = app.emit(
            if stopped_by_us { "gateway-stopped" } else { "gateway-exit" },
            (event_workspace, detail),
        );
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
    let mut current = state.children.lock().map_err(|error| error.to_string())?;
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
    let mut current = state.children.lock().map_err(|error| error.to_string())?;
    let mut stopped = state.stopped.lock().map_err(|error| error.to_string())?;
    if let Some(workspace) = workspace {
        let workspace = canonical_directory(PathBuf::from(workspace))?;
        if let Some(child) = current.remove(&workspace) {
            stopped.insert(workspace, child.pid());
            let _ = child.kill();
        }
    } else {
        for (workspace, child) in current.drain() {
            stopped.insert(workspace, child.pid());
            let _ = child.kill();
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{canonical_directory, take_lines};
    use std::path::PathBuf;

    #[test]
    fn a_deleted_workspace_fails_to_resolve_and_names_itself() {
        // The desktop reads this failure as "the folder is gone" and takes the
        // project out of the sidebar, so the error has to name the path: it is
        // shown to the user, and a bare OS code identifies nothing.
        let missing = std::env::temp_dir().join("friday-deleted-workspace-3f9a2c");
        let _ = std::fs::remove_dir_all(&missing);

        let error = canonical_directory(missing.clone()).unwrap_err();

        assert!(error.contains(&missing.display().to_string()), "{error}");
    }

    #[test]
    fn a_workspace_that_exists_resolves_without_an_extended_length_prefix() {
        // The window keys projects by this string, so the prefix canonicalize adds
        // would be a second name for a directory the registry already knows.
        let resolved = canonical_directory(std::env::temp_dir()).unwrap();

        assert!(!resolved.to_string_lossy().starts_with(r"\\?\"), "{}", resolved.display());
    }

    #[test]
    fn extended_length_spellings_reduce_to_the_plain_path() {
        assert_eq!(super::plain_path(PathBuf::from(r"\\?\E:\work")), PathBuf::from(r"E:\work"));
        assert_eq!(super::plain_path(PathBuf::from(r"\\?\UNC\host\share")), PathBuf::from(r"\\host\share"));
        assert_eq!(super::plain_path(PathBuf::from("/home/me/work")), PathBuf::from("/home/me/work"));
    }

    #[cfg(windows)]
    #[test]
    fn node_entry_point_uses_a_plain_windows_path() {
        let gateway = super::repository_root()
            .unwrap()
            .join("packages/harness/dist/gateway.js");

        assert!(
            !gateway.to_string_lossy().starts_with(r"\\?\"),
            "{}",
            gateway.display()
        );
    }

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
        .build(tauri::generate_context!())
        .expect("error while running Friday desktop")
        .run(|app, event| {
            // The gateway sidecars (one Bun process per open project) do not
            // die with the window on their own; without this hook every quit
            // leaked them. Exit is the one path every shutdown funnels through.
            if matches!(event, tauri::RunEvent::Exit) {
                if let Ok(mut children) = app.state::<GatewayState>().children.lock() {
                    for (_, child) in children.drain() {
                        let _ = child.kill();
                    }
                }
            }
        });
}
