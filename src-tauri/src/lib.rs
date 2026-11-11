mod cursor;
mod sys;
mod types;

use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, PhysicalPosition, State, WebviewWindow};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

use types::{Cmd, Geometry, MediaAction, Rect, Snapshot};

/// Logical size of the transparent window that hosts the island.
pub const WINDOW_W: f64 = 640.0;
pub const WINDOW_H: f64 = 300.0;

#[derive(Default)]
pub struct Shared {
    pub snap: Mutex<Snapshot>,
    pub hit: Mutex<Rect>,
    pub geom: Mutex<Geometry>,
}

struct Ctl {
    shared: Arc<Shared>,
    tx: Mutex<Sender<Cmd>>,
}

impl Ctl {
    fn send(&self, cmd: Cmd) {
        if let Ok(tx) = self.tx.lock() {
            let _ = tx.send(cmd);
        }
    }
}

#[tauri::command]
fn get_state(ctl: State<'_, Ctl>) -> Snapshot {
    ctl.shared.snap.lock().map(|s| s.clone()).unwrap_or_default()
}

#[tauri::command]
fn set_hit_rect(ctl: State<'_, Ctl>, rect: Rect) {
    if let Ok(mut r) = ctl.shared.hit.lock() {
        *r = rect;
    }
}

#[tauri::command]
fn media_cmd(ctl: State<'_, Ctl>, action: MediaAction) {
    ctl.send(Cmd::Media(action));
}

#[tauri::command]
fn volume_set(ctl: State<'_, Ctl>, level: f32) {
    ctl.send(Cmd::VolumeSet(level));
}

#[tauri::command]
fn volume_step(ctl: State<'_, Ctl>, delta: f32) {
    ctl.send(Cmd::VolumeStep(delta));
}

#[tauri::command]
fn volume_mute_toggle(ctl: State<'_, Ctl>) {
    ctl.send(Cmd::MuteToggle);
}

/// Centres the window on the top edge of the primary monitor and remembers
/// where it ended up, so the cursor thread can map screen coordinates.
pub fn place_window(win: &WebviewWindow, shared: &Shared) {
    let monitor = win
        .primary_monitor()
        .ok()
        .flatten()
        .or_else(|| win.current_monitor().ok().flatten());
    let Some(m) = monitor else { return };
    let scale = m.scale_factor();
    let (mx, my) = (m.position().x as f64, m.position().y as f64);
    let mw = m.size().width as f64;
    let w = (WINDOW_W * scale).round();
    let x = (mx + (mw - w) / 2.0).round();
    let y = my;
    let _ = win.set_size(tauri::LogicalSize::new(WINDOW_W, WINDOW_H));
    let _ = win.set_position(PhysicalPosition::new(x as i32, y as i32));
    if let Ok(mut g) = shared.geom.lock() {
        *g = Geometry { x, y, scale };
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let autostart_on = app.autolaunch().is_enabled().unwrap_or(false);
    let autostart = CheckMenuItem::with_id(
        app,
        "autostart",
        "Запускать вместе с Windows",
        true,
        autostart_on,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "Выход", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&autostart, &PredefinedMenuItem::separator(app)?, &quit])?;

    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("Dark Island")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "quit" => app.exit(0),
            "autostart" => {
                let mgr = app.autolaunch();
                let enabled = mgr.is_enabled().unwrap_or(false);
                let _ = if enabled { mgr.disable() } else { mgr.enable() };
                let _ = autostart.set_checked(mgr.is_enabled().unwrap_or(!enabled));
            }
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|_app, _args, _cwd| {}))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .invoke_handler(tauri::generate_handler![
            get_state,
            set_hit_rect,
            media_cmd,
            volume_set,
            volume_step,
            volume_mute_toggle
        ])
        .setup(|app| {
            let shared = Arc::new(Shared::default());
            let win = app
                .get_webview_window("island")
                .expect("window `island` is declared in tauri.conf.json");

            place_window(&win, &shared);
            sys::prepare_window(&win);
            // Clicks pass through until the cursor is over the island itself.
            let _ = win.set_ignore_cursor_events(true);
            let _ = win.show();

            let tx = sys::spawn(app.handle().clone(), shared.clone());
            cursor::spawn(app.handle().clone(), shared.clone());
            sys::spawn_meter(app.handle().clone());
            app.manage(Ctl { shared, tx: Mutex::new(tx) });

            build_tray(app.handle())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Dark Island");
}
