mod clip;
mod cursor;
mod sys;
mod types;

use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, State, WebviewWindow};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_opener::OpenerExt;

use clip::{ClipData, ClipView, Clips, Note, Shelf, ShelfItem};
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
    clips: Arc<Mutex<Clips>>,
    shelf: Mutex<Shelf>,
    note: Mutex<Note>,
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

// ---- clipboard history ----------------------------------------------------

#[tauri::command]
fn clip_list(ctl: State<'_, Ctl>) -> Vec<ClipView> {
    ctl.clips.lock().unwrap().view()
}

fn put_on_clipboard(data: ClipData) -> bool {
    let Ok(mut cb) = arboard::Clipboard::new() else { return false };
    match data {
        ClipData::Text(t) => cb.set_text(t).is_ok(),
        ClipData::Image { w, h, rgba } => cb
            .set_image(arboard::ImageData { width: w as usize, height: h as usize, bytes: rgba.into() })
            .is_ok(),
    }
}

/// Puts an entry back on the clipboard and, if `paste`, presses Ctrl+V in
/// the window the user was typing in (the island never took its focus).
#[tauri::command]
async fn clip_use(app: AppHandle, id: u64, paste: bool) -> bool {
    let ctl = app.state::<Ctl>();
    let Some(data) = ctl.clips.lock().unwrap().data(id) else { return false };
    if let Some(w) = app.get_webview_window("island") {
        sys::release_focus(&w);
    }
    if !put_on_clipboard(data) {
        return false;
    }
    if paste {
        std::thread::sleep(std::time::Duration::from_millis(60));
        sys::send_paste();
    }
    true
}

#[tauri::command]
fn clip_delete(app: AppHandle, ctl: State<'_, Ctl>, id: u64) {
    ctl.clips.lock().unwrap().remove(id);
    let _ = app.emit_to("island", "clips", ctl.clips.lock().unwrap().view());
}

#[tauri::command]
fn clip_pin(app: AppHandle, ctl: State<'_, Ctl>, id: u64) {
    ctl.clips.lock().unwrap().toggle_pin(id);
    let _ = app.emit_to("island", "clips", ctl.clips.lock().unwrap().view());
}

#[tauri::command]
fn clip_clear(app: AppHandle, ctl: State<'_, Ctl>) {
    ctl.clips.lock().unwrap().clear();
    let _ = app.emit_to("island", "clips", ctl.clips.lock().unwrap().view());
}

// ---- shelf -------------------------------------------------------------------

#[tauri::command]
fn shelf_list(ctl: State<'_, Ctl>) -> Vec<ShelfItem> {
    ctl.shelf.lock().unwrap().items.clone()
}

#[tauri::command]
fn shelf_add(ctl: State<'_, Ctl>, paths: Vec<String>) -> Vec<ShelfItem> {
    let mut shelf = ctl.shelf.lock().unwrap();
    shelf.add(paths);
    shelf.items.clone()
}

#[tauri::command]
fn shelf_remove(ctl: State<'_, Ctl>, path: String) -> Vec<ShelfItem> {
    let mut shelf = ctl.shelf.lock().unwrap();
    shelf.remove(&path);
    shelf.items.clone()
}

#[tauri::command]
fn shelf_clear(ctl: State<'_, Ctl>) -> Vec<ShelfItem> {
    let mut shelf = ctl.shelf.lock().unwrap();
    shelf.clear();
    shelf.items.clone()
}

#[tauri::command]
fn open_path(app: AppHandle, path: String) {
    let _ = app.opener().open_path(path, None::<&str>);
}

#[tauri::command]
fn reveal_path(app: AppHandle, path: String) {
    let _ = app.opener().reveal_item_in_dir(path);
}

// ---- note and keyboard focus ---------------------------------------------------

#[tauri::command]
fn note_get(ctl: State<'_, Ctl>) -> String {
    ctl.note.lock().unwrap().text.clone()
}

#[tauri::command]
fn note_set(ctl: State<'_, Ctl>, text: String) {
    ctl.note.lock().unwrap().set(text);
}

#[tauri::command]
fn take_focus(app: AppHandle) {
    let a = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(w) = a.get_webview_window("island") {
            sys::take_focus(&w);
        }
    });
}

#[tauri::command]
fn release_focus(app: AppHandle) {
    let a = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(w) = a.get_webview_window("island") {
            sys::release_focus(&w);
        }
    });
}

// ---- hotkeys -------------------------------------------------------------------

/// Ctrl+Alt+I opens or closes the island, Ctrl+Alt+V opens the clipboard.
fn register_hotkeys(app: &AppHandle) -> tauri::Result<()> {
    let toggle = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyI);
    let clipboard = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyV);
    app.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(move |app, sc, ev| {
                if ev.state() != ShortcutState::Pressed {
                    return;
                }
                let name = if *sc == toggle {
                    "toggle"
                } else if *sc == clipboard {
                    "clipboard"
                } else {
                    return;
                };
                let _ = app.emit_to("island", "hotkey", name);
            })
            .build(),
    )?;
    // Another program may already own a combination: the rest still work.
    for sc in [toggle, clipboard] {
        let _ = app.global_shortcut().register(sc);
    }
    Ok(())
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
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_drag::init())
        .invoke_handler(tauri::generate_handler![
            get_state,
            set_hit_rect,
            media_cmd,
            volume_set,
            volume_step,
            volume_mute_toggle,
            clip_list,
            clip_use,
            clip_delete,
            clip_pin,
            clip_clear,
            shelf_list,
            shelf_add,
            shelf_remove,
            shelf_clear,
            open_path,
            reveal_path,
            note_get,
            note_set,
            take_focus,
            release_focus
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
            let data_dir = app.path().app_data_dir()?;
            let _ = std::fs::create_dir_all(&data_dir);
            let clips = Arc::new(Mutex::new(Clips::load(&data_dir)));
            sys::spawn_clipboard(app.handle().clone(), clips.clone());
            app.manage(Ctl {
                shared,
                tx: Mutex::new(tx),
                clips,
                shelf: Mutex::new(Shelf::load(&data_dir)),
                note: Mutex::new(Note::load(&data_dir)),
            });
            register_hotkeys(app.handle())?;

            build_tray(app.handle())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Dark Island");
}
