#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod status;
mod urls;

use status::{AppState, Snapshot};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewWindow, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_opener::OpenerExt;

const POLL_EVERY: Duration = Duration::from_secs(5);
const POPOVER: &str = "popover";
const TRAY: &str = "main";

struct Shared {
    snapshot: Mutex<Snapshot>,
    /// When losing focus last hid the popover: the tray click that caused it must not reopen it.
    hidden_at: Mutex<Option<Instant>>,
}

#[tauri::command]
fn current_state(shared: tauri::State<Shared>) -> Snapshot {
    shared.snapshot.lock().unwrap().clone()
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
    let hidden_at = *app.state::<Shared>().hidden_at.lock().unwrap();
    let just_hidden = hidden_at.is_some_and(|t| t.elapsed() < Duration::from_millis(300));
    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
    } else if !just_hidden {
        show_popover(app, Some(click));
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
        let state = match &status_path {
            Ok(path) => status::poll(path),
            Err(_) => AppState::DaemonNotRunning,
        };
        let snapshot = {
            let shared = app.state::<Shared>();
            let mut current = shared.snapshot.lock().unwrap();
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
            // The title shows next to the icon on macOS and Linux; Windows only has the tooltip,
            // which carries the same count.
            #[cfg(not(windows))]
            let _ = tray.set_title(snapshot.badge());
            let _ = tray.set_tooltip(Some(snapshot.tooltip()));
        }
        let _ = app.emit_to(POPOVER, "snapshot", &snapshot);
        std::thread::sleep(POLL_EVERY);
    });
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
        .manage(Shared {
            snapshot: Mutex::new(Snapshot {
                state: AppState::DaemonNotRunning,
                last_ok_at: None,
            }),
            hidden_at: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            current_state,
            open_url,
            hide_popover,
            autostart_enabled,
            set_autostart,
            quit
        ])
        .on_window_event(|window, event| {
            if let WindowEvent::Focused(false) = event {
                let _ = window.hide();
                *window.state::<Shared>().hidden_at.lock().unwrap() = Some(Instant::now());
            }
        })
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            let open = MenuItem::with_id(app, "open", "Open autoforge", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            TrayIconBuilder::with_id(TRAY)
                .icon(app.default_window_icon().cloned().ok_or("no app icon")?)
                .icon_as_template(true)
                .tooltip("autoforge")
                .menu(&Menu::with_items(app, &[&open, &quit])?)
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
    use super::popover_origin;

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
}
