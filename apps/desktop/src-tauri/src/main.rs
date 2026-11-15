// Warren's desktop shell: a native window and a menu bar item around the web interface that the
// daemon serves. The shell holds no state and no logic of its own; closing it never stops work,
// because the daemon (launchd) does the work.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    fs,
    net::{SocketAddr, TcpStream},
    path::PathBuf,
    time::Duration,
};

use serde::Deserialize;
use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    webview::NewWindowResponse,
    AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    WindowEvent,
};

const WINDOW: &str = "main";

/// What a running daemon writes to `<WARREN_HOME>/daemon.json`.
#[derive(Deserialize)]
struct DaemonInfo {
    port: u16,
    token: String,
}

fn warren_home() -> PathBuf {
    if let Some(home) = std::env::var_os("WARREN_HOME") {
        return PathBuf::from(home);
    }
    PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".warren")
}

/// The interface URL of a daemon that is running and accepting connections, if there is one.
/// The token travels in the fragment, which the webview never sends to the server.
fn daemon_url() -> Option<tauri::Url> {
    let text = fs::read_to_string(warren_home().join("daemon.json")).ok()?;
    let info: DaemonInfo = serde_json::from_str(&text).ok()?;
    let address = SocketAddr::from(([127, 0, 0, 1], info.port));
    TcpStream::connect_timeout(&address, Duration::from_millis(300)).ok()?;
    format!("http://127.0.0.1:{}/#token={}", info.port, info.token)
        .parse()
        .ok()
}

/// Whether a page belongs to the interface: the daemon's (on this machine, at the port it wrote
/// to daemon.json) or the local fallback page. Everything else is the web.
fn is_interface(url: &Url) -> bool {
    match url.scheme() {
        "tauri" => true,
        "http" => {
            let port = fs::read_to_string(warren_home().join("daemon.json"))
                .ok()
                .and_then(|text| serde_json::from_str::<DaemonInfo>(&text).ok())
                .map(|info| info.port);
            url.host_str() == Some("127.0.0.1") && url.port().is_some() && url.port() == port
        }
        _ => false,
    }
}

/// Opens a web link in the person's browser. Links come from text the model wrote, so only
/// http and https go out (never file:, javascript: or app schemes), and the URL is an argument
/// to `open`, never part of a shell command.
fn open_in_browser(url: &Url) {
    if matches!(url.scheme(), "http" | "https") {
        let _ = std::process::Command::new("/usr/bin/open").arg(url.as_str()).spawn();
    }
}

/// Called by the local fallback page: switch to the daemon's interface once it is up.
#[tauri::command]
fn connect(window: WebviewWindow) -> Result<(), String> {
    let url = daemon_url().ok_or("daemon not running")?;
    window.navigate(url).map_err(|error| error.to_string())
}

fn show(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(WINDOW) {
        // A window left on the fallback page reconnects when it comes back.
        if window
            .url()
            .map(|url| url.scheme() == "tauri")
            .unwrap_or(false)
        {
            if let Some(url) = daemon_url() {
                let _ = window.navigate(url);
            }
        }
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn main() {
    let app = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![connect])
        .setup(|app| {
            let url = match daemon_url() {
                Some(url) => WebviewUrl::External(url),
                None => WebviewUrl::App("index.html".into()),
            };
            WebviewWindowBuilder::new(app, WINDOW, url)
                // The web view drops requests for new windows (links with target="_blank"), and a
                // plain link would replace the interface: both go to the browser instead.
                .on_navigation(|url| {
                    if is_interface(url) {
                        return true;
                    }
                    open_in_browser(url);
                    false
                })
                .on_new_window(|url, _| {
                    open_in_browser(&url);
                    NewWindowResponse::Deny
                })
                // Files dropped on the window reach the page as ordinary drop events, so they can
                // be attached to a task.
                .disable_drag_drop_handler()
                .title("Warren")
                .inner_size(1240.0, 820.0)
                .min_inner_size(720.0, 480.0)
                .build()?;

            let open = MenuItem::with_id(app, "open", "打开 Warren", true, None::<&str>)?;
            let quit =
                MenuItem::with_id(app, "quit", "退出（后台任务继续运行）", true, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(app, &[&open, &separator, &quit])?;
            TrayIconBuilder::with_id("warren")
                .icon(Image::from_bytes(include_bytes!("../icons/tray.png"))?)
                .icon_as_template(true)
                .tooltip("Warren")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing hides: Warren stays in the menu bar, as the work goes on in the daemon.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build the Warren shell");

    app.run(|app, event| {
        // Clicking the Dock icon brings the hidden window back.
        if let RunEvent::Reopen { .. } = event {
            show(app);
        }
    });
}
