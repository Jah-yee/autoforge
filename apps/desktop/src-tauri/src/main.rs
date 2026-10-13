#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod status;
mod urls;

use status::{AppState, Snapshot};
use std::panic::AssertUnwindSafe;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, Url, WebviewWindow, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_opener::OpenerExt;

const POLL_EVERY: Duration = Duration::from_secs(5);
const POPOVER: &str = "popover";
const TRAY: &str = "main";

struct Shared {
    snapshot: Mutex<Snapshot>,
    /// When losing focus last hid the popover: the tray click that caused it must not reopen it.
    hidden_at: Mutex<Option<Instant>>,
    /// The tray menu's first line. Linux AppIndicator has no tooltip and some desktops draw no
    /// title, so the summary lives here too.
    summary: MenuItem<tauri::Wry>,
}

#[tauri::command]
fn current_state(shared: tauri::State<Shared>) -> Snapshot {
    shared
        .snapshot
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
}

#[tauri::command]
fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    // Open the normalised URL the allowlist returns, never the raw input.
    let safe = urls::allowed(&url).ok_or("only https links to linear.app and github.com open")?;
    app.opener()
        .open_url(safe, None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn hide_popover(window: WebviewWindow) {
    let _ = window.hide();
}

#[tauri::command]
fn autostart_enabled(app: AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    let launcher = app.autolaunch();
    let result = if enabled {
        launcher.enable()
    } else {
        launcher.disable()
    };
    result.map_err(|e| e.to_string())
}

#[tauri::command]
fn quit(app: AppHandle) {
    app.exit(0);
}

/// Top-left corner for a popover of `size` near a tray click, kept inside the monitor
/// `(x, y, width, height)`. A menu bar at the top opens it below the click, a taskbar at the
/// bottom above it. All values are physical pixels.
fn popover_origin(
    click: (f64, f64),
    size: (f64, f64),
    monitor: (f64, f64, f64, f64),
) -> (f64, f64) {
    let (mx, my, mw, mh) = monitor;
    let fit = |v: f64, start: f64, len: f64, span: f64| v.min(start + span - len).max(start);
    let y = if click.1 < my + mh / 2.0 {
        click.1
    } else {
        click.1 - size.1
    };
    (
        fit(click.0 - size.0 / 2.0, mx, size.0, mw),
        fit(y, my, size.1, mh),
    )
}

/// New top edge for a popover resized from `old_h` to `new_h`: one in the top half of its monitor
/// grows down (the menu bar edge stays put), one in the bottom half grows up (the taskbar edge
/// stays put), and either way it stays on screen. Physical pixels.
fn refit_top(top: f64, old_h: f64, new_h: f64, monitor_top: f64, monitor_h: f64) -> f64 {
    let y = if top + old_h / 2.0 < monitor_top + monitor_h / 2.0 {
        top
    } else {
        top + old_h - new_h
    };
    y.min(monitor_top + monitor_h - new_h).max(monitor_top)
}

/// Resizes the popover to `height` logical pixels of content, keeping its tray-side edge in place.
#[tauri::command]
fn fit_popover(window: WebviewWindow, height: f64) {
    let resize = || -> Option<()> {
        let scale = window.scale_factor().ok()?;
        let new_h = (height.clamp(120.0, 640.0) * scale).round();
        let size = window.outer_size().ok()?;
        let pos = window.outer_position().ok()?;
        let monitor = window.current_monitor().ok()??;
        let top = refit_top(
            pos.y.into(),
            size.height.into(),
            new_h,
            monitor.position().y.into(),
            monitor.size().height.into(),
        );
        window
            .set_size(tauri::PhysicalSize::new(size.width, new_h as u32))
            .ok()?;
        window
            .set_position(PhysicalPosition::new(pos.x, top as i32))
            .ok()
    };
    resize();
}

/// Shows the popover near `near` (a tray click), or centred when there is no click position
/// (the tray menu, a second launch, Linux where tray clicks are not reported).
fn show_popover(app: &AppHandle, near: Option<PhysicalPosition<f64>>) {
    let Some(window) = app.get_webview_window(POPOVER) else {
        return;
    };
    let placed = near.and_then(|p| {
        let monitor = app.monitor_from_point(p.x, p.y).ok()??;
        let size = window.outer_size().ok()?;
        let (pos, area) = (monitor.position(), monitor.size());
        let (x, y) = popover_origin(
            (p.x, p.y),
            (size.width.into(), size.height.into()),
            (
                pos.x.into(),
                pos.y.into(),
                area.width.into(),
                area.height.into(),
            ),
        );
        window.set_position(PhysicalPosition::new(x, y)).ok()
    });
    if placed.is_none() {
        let _ = window.center();
    }
    let _ = window.show();
    let _ = window.set_focus();
}

fn toggle_popover(app: &AppHandle, click: PhysicalPosition<f64>) {
    let Some(window) = app.get_webview_window(POPOVER) else {
        return;
    };
    let hidden_at = *app
        .state::<Shared>()
        .hidden_at
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let just_hidden = hidden_at.is_some_and(|t| t.elapsed() < Duration::from_millis(300));
    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
    } else if !just_hidden {
        show_popover(app, Some(click));
    }
}

/// Whether the webview may navigate to `url`: only the app's own bundled page
/// (`tauri://localhost` on macOS and Linux, `http(s)://tauri.localhost` on Windows), plus the
/// Vite dev server under `tauri dev`. Links leave through `open_url`, never by navigating.
fn own_page(url: &Url, dev: bool) -> bool {
    match (url.scheme(), url.host_str(), url.port()) {
        ("tauri", Some("localhost"), None) => true,
        ("http" | "https", Some("tauri.localhost"), None) => true,
        ("http", Some("localhost"), Some(1420)) => dev,
        _ => false,
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Polls the daemon every 5 seconds, popover open or not: the badge needs it.
fn start_polling(app: AppHandle) {
    let status_path = app
        .path()
        .home_dir()
        .map(|home| home.join(".autoforge").join("status.json"));
    std::thread::spawn(move || loop {
        let started = Instant::now();
        // A panic in one poll must not stop the badge for good: log it and poll again.
        if std::panic::catch_unwind(AssertUnwindSafe(|| poll_once(&app, &status_path))).is_err() {
            eprintln!("autoforge: a poll panicked; polling continues");
        }
        std::thread::sleep(POLL_EVERY.saturating_sub(started.elapsed()));
    });
}

/// One poll: update the shared snapshot, the tray and the popover.
fn poll_once(app: &AppHandle, status_path: &tauri::Result<PathBuf>) {
    let state = match status_path {
        Ok(path) => status::poll(path),
        Err(_) => AppState::DaemonNotRunning,
    };
    let snapshot = {
        let shared = app.state::<Shared>();
        let mut current = shared.snapshot.lock().unwrap_or_else(|e| e.into_inner());
        let ok = matches!(state, AppState::Ok { .. });
        let last_ok_at = if ok {
            Some(now_ms())
        } else {
            current.last_ok_at
        };
        *current = Snapshot { state, last_ok_at };
        current.clone()
    };
    if let Some(tray) = app.tray_by_id(TRAY) {
        // The title shows next to the icon on macOS and Linux. set_title is a no-op on Windows,
        // where the count is in the tooltip only.
        let _ = tray.set_title(snapshot.badge());
        let _ = tray.set_tooltip(Some(snapshot.tooltip()));
    }
    let _ = app.state::<Shared>().summary.set_text(snapshot.tooltip());
    let _ = app.emit_to(POPOVER, "snapshot", &snapshot);
}

fn main() {
    tauri::Builder::default()
        // First, so a second launch exits before anything else starts.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_popover(app, None)
        }))
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri::plugin::Builder::<tauri::Wry>::new("navigation-guard")
                .on_navigation(|_, url| own_page(url, tauri::is_dev()))
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            current_state,
            open_url,
            hide_popover,
            fit_popover,
            autostart_enabled,
            set_autostart,
            quit
        ])
        .on_window_event(|window, event| {
            if let WindowEvent::Focused(false) = event {
                let _ = window.hide();
                *window
                    .state::<Shared>()
                    .hidden_at
                    .lock()
                    .unwrap_or_else(|e| e.into_inner()) = Some(Instant::now());
            }
        })
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            let summary = MenuItem::with_id(app, "summary", "autoforge", false, None::<&str>)?;
            let open = MenuItem::with_id(app, "open", "Open autoforge", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            app.manage(Shared {
                snapshot: Mutex::new(Snapshot {
                    state: AppState::DaemonNotRunning,
                    last_ok_at: None,
                }),
                hidden_at: Mutex::new(None),
                summary: summary.clone(),
            });
            TrayIconBuilder::with_id(TRAY)
                .icon(app.default_window_icon().cloned().ok_or("no app icon")?)
                .icon_as_template(true)
                .tooltip("autoforge")
                .menu(&Menu::with_items(app, &[&summary, &open, &quit])?)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => show_popover(app, None),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        position,
                        ..
                    } = event
                    {
                        toggle_popover(tray.app_handle(), position);
                    }
                })
                .build(app)?;
            start_polling(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running autoforge desktop");
}

#[cfg(test)]
mod tests {
    use super::{own_page, popover_origin, refit_top};
    use tauri::Url;

    fn page(url: &str, dev: bool) -> bool {
        own_page(&Url::parse(url).unwrap(), dev)
    }

    #[test]
    fn navigation_stays_on_the_bundled_app() {
        assert!(page("tauri://localhost/index.html", false));
        assert!(page("http://tauri.localhost/", false));
        assert!(page("https://tauri.localhost/", false));
        assert!(page("http://localhost:1420/", true));
        for url in [
            "http://localhost:1420/",
            "https://github.com/o/r",
            "https://linear.app/x",
            "http://tauri.localhost.evil.com/",
            "http://tauri.localhost:8080/",
            "tauri://evil/",
            "http://127.0.0.1:4100/runs",
            "file:///etc/passwd",
            "data:text/html,x",
        ] {
            assert!(!page(url, false), "{url}");
        }
        assert!(!page("http://localhost:1421/", true));
    }

    const SIZE: (f64, f64) = (360.0, 480.0);
    const SCREEN: (f64, f64, f64, f64) = (0.0, 0.0, 1920.0, 1080.0);

    #[test]
    fn opens_below_a_menu_bar_click_centred_on_it() {
        assert_eq!(popover_origin((1000.0, 12.0), SIZE, SCREEN), (820.0, 12.0));
    }

    #[test]
    fn opens_above_a_taskbar_click_and_stays_on_screen_at_the_right_edge() {
        assert_eq!(
            popover_origin((1900.0, 1060.0), SIZE, SCREEN),
            (1560.0, 580.0)
        );
    }

    #[test]
    fn stays_on_screen_at_the_left_edge_and_on_a_second_monitor() {
        assert_eq!(popover_origin((5.0, 12.0), SIZE, SCREEN), (0.0, 12.0));
        let right = (1920.0, 0.0, 1280.0, 800.0);
        assert_eq!(
            popover_origin((1925.0, 790.0), SIZE, right),
            (1920.0, 310.0)
        );
    }

    #[test]
    fn grows_down_from_a_menu_bar_and_up_from_a_taskbar() {
        // (window top, old height, new height, monitor top, monitor height)
        assert_eq!(refit_top(12.0, 200.0, 420.0, 0.0, 1080.0), 12.0);
        assert_eq!(refit_top(820.0, 200.0, 420.0, 0.0, 1080.0), 600.0);
        assert_eq!(refit_top(600.0, 420.0, 200.0, 0.0, 1080.0), 820.0);
    }

    #[test]
    fn keeps_a_grown_window_on_screen() {
        assert_eq!(refit_top(12.0, 200.0, 1200.0, 0.0, 1080.0), 0.0);
        assert_eq!(refit_top(700.0, 100.0, 300.0, 0.0, 1080.0), 500.0);
        assert_eq!(refit_top(400.0, 100.0, 800.0, 0.0, 1080.0), 280.0);
    }
}
