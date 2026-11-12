mod agents;
mod ai;
mod capture;
mod clip;
mod docs;
mod diag;
mod live;
mod check;
mod obs;
mod settings;
mod cursor;
mod sys;
mod types;

use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State, WebviewWindow};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_plugin_opener::OpenerExt;

use clip::{ClipData, ClipView, Clips, Note, Shelf, ShelfItem};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

use types::{Cmd, Geometry, MediaAction, Rect, Snapshot};

/// Logical size of the transparent window that hosts the island.
pub const WINDOW_W: f64 = 640.0;
pub const WINDOW_H: f64 = 360.0;

pub struct Shared {
    pub snap: Mutex<Snapshot>,
    pub hit: Mutex<Rect>,
    pub geom: Mutex<Geometry>,
    /// Where and how big the island is: (zoom, monitor index or -1 for the
    /// primary one, horizontal offset in logical px).
    pub place: Mutex<(f64, i64, f64)>,
}

impl Default for Shared {
    fn default() -> Self {
        Self {
            snap: Mutex::default(),
            hit: Mutex::default(),
            geom: Mutex::default(),
            place: Mutex::new((1.0, -1, 0.0)),
        }
    }
}

fn read_place(s: &settings::Settings) -> (f64, i64, f64) {
    let all = s.all();
    let zoom = all.get("islandScale").and_then(|v| v.as_f64()).unwrap_or(1.0).clamp(0.8, 2.0);
    let monitor = all.get("islandMonitor").and_then(|v| v.as_i64()).unwrap_or(-1);
    let offset = all.get("islandOffset").and_then(|v| v.as_f64()).unwrap_or(0.0);
    (zoom, monitor, offset)
}

#[derive(serde::Serialize)]
struct MonitorInfo {
    index: usize,
    name: String,
    width: u32,
    height: u32,
    primary: bool,
}

#[tauri::command]
fn monitors_list(app: AppHandle) -> Vec<MonitorInfo> {
    let Some(w) = app.get_webview_window("island") else { return Vec::new() };
    let primary = w.primary_monitor().ok().flatten().map(|m| *m.position());
    w.available_monitors()
        .unwrap_or_default()
        .iter()
        .enumerate()
        .map(|(i, m)| MonitorInfo {
            index: i,
            name: m.name().cloned().unwrap_or_else(|| format!("Монитор {}", i + 1)),
            width: m.size().width,
            height: m.size().height,
            primary: Some(*m.position()) == primary,
        })
        .collect()
}

struct Ctl {
    shared: Arc<Shared>,
    tx: Mutex<Sender<Cmd>>,
    clips: Arc<Mutex<Clips>>,
    shelf: Mutex<Shelf>,
    note: Mutex<Note>,
    settings: Arc<settings::Settings>,
    agents: Arc<agents::Agents>,
    apps: Arc<Mutex<Vec<sys::App>>>,
    keys: Arc<ai::Keys>,
    runs: Arc<ai::Runs>,
    /// Set while dictating / recording the screen; setting it stops them.
    dictation: Mutex<Option<Arc<std::sync::atomic::AtomicBool>>>,
    recording: Mutex<Option<Arc<std::sync::atomic::AtomicBool>>>,
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

/// Files dropped on the island: onto the shelf, and the page is told.
pub fn shelf_dropped(app: &AppHandle, paths: Vec<String>) {
    let ctl = app.state::<Ctl>();
    let items = {
        let mut shelf = ctl.shelf.lock().unwrap();
        shelf.add(paths);
        shelf.items.clone()
    };
    diag::log(app, &format!("shelf: {} item(s) now", items.len()));
    let _ = app.emit_to("island", "shelf", items);
    let _ = app.emit_to("island", "drag", serde_json::json!({ "type": "drop", "paths": [] }));
}

#[tauri::command]
fn diag_open(app: AppHandle) {
    if let Some(p) = diag::path(&app) {
        if !p.exists() {
            diag::log(&app, "log created");
        }
        let _ = app.opener().open_path(p.to_string_lossy().into_owned(), None::<&str>);
    }
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

/// The usual file picker, for putting files on the shelf without dragging.
#[tauri::command]
async fn shelf_pick(app: AppHandle) -> Vec<ShelfItem> {
    use tauri_plugin_dialog::DialogExt;
    let picked = in_dialog(|| app.dialog().file().set_title("Положить на полку").blocking_pick_files()).unwrap_or_default();
    let paths: Vec<String> = picked
        .into_iter()
        .filter_map(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    let ctl = app.state::<Ctl>();
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

// ---- settings ----------------------------------------------------------------

#[tauri::command]
fn settings_get(ctl: State<'_, Ctl>) -> serde_json::Map<String, serde_json::Value> {
    ctl.settings.all()
}

#[tauri::command]
fn settings_set(
    app: AppHandle,
    ctl: State<'_, Ctl>,
    patch: serde_json::Map<String, serde_json::Value>,
) -> serde_json::Map<String, serde_json::Value> {
    let captures = patch.get("showInCaptures").and_then(|v| v.as_bool());
    let city_changed = patch.contains_key("weatherCity");
    let place_changed = ["islandScale", "islandMonitor", "islandOffset"].iter().any(|k| patch.contains_key(*k));
    let all = ctl.settings.merge(patch);
    if let (Some(show), Some(w)) = (captures, app.get_webview_window("island")) {
        sys::exclude_from_capture(&w, !show);
    }
    if place_changed {
        *ctl.shared.place.lock().unwrap() = read_place(&ctl.settings);
        if let Some(w) = app.get_webview_window("island") {
            let s = ctl.shared.clone();
            let w2 = w.clone();
            let _ = w.run_on_main_thread(move || place_window(&w2, &s));
        }
    }
    if city_changed {
        let (app, s) = (app.clone(), ctl.settings.clone());
        std::thread::spawn(move || live::refresh_weather(&app, &s));
    }
    let _ = app.emit_to("island", "settings", all.clone());
    all
}

/// Settings in a window of their own: there are too many for the island.
/// `section` opens a tab by its name (e.g. "ИИ").
/// Async: on Windows a window built from a synchronous command (or on the
/// main thread) waits for the main thread, which waits for it — a hang.
#[tauri::command]
async fn settings_open(app: AppHandle, section: Option<String>) {
    open_settings_window(app, section);
}

fn open_settings_window(app: AppHandle, section: Option<String>) {
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        if let Some(sec) = section {
            let _ = app.emit_to("settings", "settings_section", sec);
        }
        return;
    }
    let mut url = String::from("index.html?view=settings");
    if let Some(sec) = section {
        url.push_str("&section=");
        url.push_str(&sec.bytes().map(|b| format!("%{b:02X}")).collect::<String>());
    }
    let built = tauri::WebviewWindowBuilder::new(&app, "settings", tauri::WebviewUrl::App(url.into()))
        .title("Dark Island — настройки")
        .inner_size(860.0, 640.0)
        .min_inner_size(680.0, 460.0)
        .theme(Some(tauri::Theme::Dark))
        .background_color(tauri::window::Color(20, 20, 22, 255))
        .center()
        .build();
    if let Ok(w) = built {
        let _ = w.set_focus();
    }
}

/// The first-run tour again, on the island.
#[tauri::command]
fn tour_start(app: AppHandle) {
    let _ = app.emit_to("island", "tour", ());
}

/// File dialogs open now: the main thread is busy with them on purpose.
static DIALOGS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// Runs a blocking file dialog; the watchdog leaves the island alone meanwhile.
fn in_dialog<T>(f: impl FnOnce() -> T) -> T {
    DIALOGS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let r = f();
    DIALOGS.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
    r
}

/// Keys that belong to this computer, never exported, imported or reset.
const LOCAL_KEYS: &[&str] = &["agentToken", "agentPort", "vpnProxy"];

/// Saves the settings to a JSON file the user picks; returns its path.
#[tauri::command]
async fn settings_export(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let mut all = app.state::<Ctl>().settings.all();
    for k in LOCAL_KEYS {
        all.remove(*k);
    }
    let Some(path) = in_dialog(|| {
        app.dialog()
            .file()
            .set_title("Сохранить настройки")
            .set_file_name("dark-island-settings.json")
            .add_filter("JSON", &["json"])
            .blocking_save_file()
    })
    .and_then(|p| p.into_path().ok())
    else {
        return Ok(None);
    };
    let text = serde_json::to_string_pretty(&all).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| e.to_string())?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Replaces the settings with `next` (keys missing there go back to defaults).
fn settings_replace(app: &AppHandle, mut next: serde_json::Map<String, serde_json::Value>) -> serde_json::Map<String, serde_json::Value> {
    let ctl = app.state::<Ctl>();
    for k in LOCAL_KEYS {
        next.remove(*k);
    }
    let mut patch = serde_json::Map::new();
    for k in ctl.settings.all().keys() {
        if !LOCAL_KEYS.contains(&k.as_str()) && !next.contains_key(k) {
            patch.insert(k.clone(), serde_json::Value::Null);
        }
    }
    patch.extend(next);
    settings_set(app.clone(), ctl, patch)
}

/// Loads settings from a JSON file the user picks.
#[tauri::command]
async fn settings_import(app: AppHandle) -> Result<Option<serde_json::Map<String, serde_json::Value>>, String> {
    use tauri_plugin_dialog::DialogExt;
    let Some(path) = in_dialog(|| app.dialog().file().set_title("Загрузить настройки").add_filter("JSON", &["json"]).blocking_pick_file())
        .and_then(|p| p.into_path().ok())
    else {
        return Ok(None);
    };
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let map: serde_json::Map<String, serde_json::Value> = serde_json::from_str(&text).map_err(|_| "Это не файл настроек острова".to_string())?;
    Ok(Some(settings_replace(&app, map)))
}

/// Everything back to how it was after installing (keys and hooks stay).
#[tauri::command]
fn settings_reset(app: AppHandle) -> serde_json::Map<String, serde_json::Value> {
    settings_replace(&app, serde_json::Map::new())
}

/// The newest release on GitHub, to compare with this version. Only asked
/// when the user presses the button; nothing is downloaded.
#[tauri::command]
async fn update_check(app: AppHandle) -> Result<serde_json::Value, String> {
    let current = app.package_info().version.to_string();
    let v = live::get_json("https://api.github.com/repos/stardely62-oss/dark-island/releases/latest")
        .ok_or("Не удалось узнать: нет связи с GitHub или релизов ещё нет")?;
    let tag = v.get("tag_name").and_then(|t| t.as_str()).unwrap_or("").trim_start_matches('v').to_string();
    let url = v.get("html_url").and_then(|t| t.as_str()).unwrap_or("https://github.com/stardely62-oss/dark-island/releases").to_string();
    let newer = version_newer(&tag, &current);
    Ok(serde_json::json!({ "current": current, "latest": tag, "url": url, "newer": newer }))
}

/// "0.2.1" > "0.2.0"; anything unparsable is not newer.
fn version_newer(a: &str, b: &str) -> bool {
    let parse = |s: &str| s.split('.').map(|p| p.trim().parse::<u64>().ok()).collect::<Option<Vec<u64>>>();
    match (parse(a), parse(b)) {
        (Some(x), Some(y)) => x > y,
        _ => false,
    }
}

// ---- agents ------------------------------------------------------------------

#[tauri::command]
fn agents_answer(ctl: State<'_, Ctl>, id: u64, allow: bool) {
    ctl.agents.answer(id, allow);
}

#[tauri::command]
fn agents_connections() -> agents::Connections {
    agents::connections()
}

#[tauri::command]
async fn self_check(app: AppHandle) -> Vec<check::Check> {
    check::run(&app)
}

#[tauri::command]
async fn agents_test(app: AppHandle, which: String) -> Result<(), String> {
    let agents = app.state::<Ctl>().agents.clone();
    agents::test(&agents, &which)
}

#[tauri::command]
fn agents_connect(ctl: State<'_, Ctl>, which: String, on: bool, replace: Option<bool>) -> Result<agents::Connections, String> {
    match which.as_str() {
        "claude" => agents::connect_claude(&ctl.agents, on)?,
        "codex" => agents::connect_codex(&ctl.agents, on, replace.unwrap_or(false))?,
        "opencode" => agents::connect_opencode(&ctl.agents, on)?,
        _ => return Err("неизвестный агент".into()),
    }
    Ok(agents::connections())
}

// ---- controls, power, apps -----------------------------------------------------

#[tauri::command]
async fn controls_get() -> sys::Controls {
    sys::controls_get()
}

#[tauri::command]
async fn controls_set(what: String, on: bool) -> sys::Controls {
    match what.as_str() {
        "wifi" | "bluetooth" => {
            sys::radio_set(&what, on);
        }
        "dark" => sys::set_dark(on),
        _ => {}
    }
    sys::controls_get()
}

#[tauri::command]
fn power(action: String) {
    sys::power(&action);
}

#[tauri::command]
async fn apps_list(ctl: State<'_, Ctl>) -> Result<Vec<sys::App>, ()> {
    let cached = ctl.apps.lock().unwrap().clone();
    if !cached.is_empty() {
        return Ok(cached);
    }
    let apps = sys::start_apps();
    *ctl.apps.lock().unwrap() = apps.clone();
    Ok(apps)
}

#[tauri::command]
fn app_launch(id: String) {
    sys::launch_app(&id);
}

#[tauri::command]
fn run_shell(cmd: String, powershell: bool) {
    sys::run_shell(&cmd, powershell);
}

#[tauri::command]
fn open_url(app: AppHandle, url: String) {
    if url.starts_with("https://") || url.starts_with("http://") {
        let _ = app.opener().open_url(url, None::<&str>);
    }
}

// ---- screen tools -------------------------------------------------------------

#[tauri::command]
async fn capture_start(app: AppHandle, mode: String) {
    capture::start(&app, &mode);
}

#[tauri::command]
fn overlay_ready(app: AppHandle) {
    capture::ready(&app);
}

#[tauri::command]
fn overlay_cancel(app: AppHandle) {
    capture::hide(&app);
}

#[tauri::command]
async fn capture_done(app: AppHandle, png: String, action: String) {
    let ctl = app.state::<Ctl>();
    let (settings, keys) = (ctl.settings.clone(), ctl.keys.clone());
    capture::done(&app, &settings, &keys, &png, &action);
}

#[tauri::command]
fn color_done(app: AppHandle, ctl: State<'_, Ctl>, hex: String) {
    capture::color(&app, &ctl.settings, &hex);
}

// ---- live information ------------------------------------------------------------

#[tauri::command]
fn weather_get() -> Option<live::Weather> {
    live::WEATHER.lock().unwrap().clone()
}

#[tauri::command]
async fn weather_refresh(app: AppHandle) {
    let settings = app.state::<Ctl>().settings.clone();
    live::refresh_weather(&app, &settings);
}

#[tauri::command]
async fn city_search(q: String) -> Vec<live::Place> {
    live::search_city(&q)
}

#[tauri::command]
async fn lyrics_get(artist: String, title: String, duration: u64) -> Option<String> {
    live::lyrics(&artist, &title, duration)
}

#[tauri::command]
async fn mic_toggle(app: AppHandle) -> Option<bool> {
    let r = sys::mic_toggle();
    diag::log(&app, &format!("mic toggle -> {r:?}"));
    r
}

#[tauri::command]
async fn notifications_access(ask: bool) -> String {
    sys::notifications_access(ask)
}

// ---- sound devices and Bluetooth --------------------------------------------------

#[tauri::command]
async fn audio_devices() -> serde_json::Value {
    #[cfg(windows)]
    return serde_json::to_value(sys::devices::audio_devices()).unwrap_or_default();
    #[cfg(not(windows))]
    serde_json::json!({ "outputs": [], "inputs": [] })
}

#[tauri::command]
async fn player_volume_get(app_id: String) -> Option<f32> {
    #[cfg(windows)]
    return sys::devices::player_volume(&app_id, &sys::AUDIO_PREFS.lock().unwrap().0.clone());
    #[cfg(not(windows))]
    {
        let _ = app_id;
        None
    }
}

#[tauri::command]
async fn player_volume_set(app_id: String, level: f32) -> bool {
    #[cfg(windows)]
    return sys::devices::set_player_volume(&app_id, &sys::AUDIO_PREFS.lock().unwrap().0.clone(), level);
    #[cfg(not(windows))]
    {
        let _ = (app_id, level);
        false
    }
}

#[tauri::command]
async fn bt_devices() -> serde_json::Value {
    #[cfg(windows)]
    return serde_json::to_value(sys::devices::bt_devices()).unwrap_or_default();
    #[cfg(not(windows))]
    serde_json::json!([])
}

#[tauri::command]
async fn bt_connect(app: AppHandle, container: String, on: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        let r = sys::devices::bt_connect(&container, on);
        diag::log(&app, &format!("bluetooth {} {container}: {r:?}", if on { "connect" } else { "disconnect" }));
        r
    }
    #[cfg(not(windows))]
    {
        let _ = (app, container, on);
        Err("только в Windows".into())
    }
}

// ---- VPN clients -------------------------------------------------------------------

#[tauri::command]
async fn vpn_status() -> Option<String> {
    sys::vpn_now()
}

/// VPN connections Windows itself knows (Settings → VPN).
#[tauri::command]
async fn vpn_names() -> Vec<String> {
    sys::run_hidden("powershell -NoProfile -Command \"Get-VpnConnection | ForEach-Object { $_.Name }\"")
        .map(|o| o.lines().map(str::trim).filter(|l| !l.is_empty()).map(str::to_string).collect())
        .unwrap_or_default()
}

/// Turns the chosen VPN on or off: Windows' own connection (rasdial),
/// Cloudflare WARP (warp-cli), or the user's own commands.
#[tauri::command]
async fn vpn_set(app: AppHandle, on: bool) -> Result<(), String> {
    let s = app.state::<Ctl>().settings.clone();
    let client = s.string("vpnClient");
    let r = match client.as_str() {
        "windows" => {
            let name = s.string("vpnName");
            if name.is_empty() {
                return Err("Выбери подключение в настройках".into());
            }
            let q = name.replace('"', "");
            sys::run_hidden(&if on { format!("rasdial \"{q}\"") } else { format!("rasdial \"{q}\" /disconnect") }).map(|_| ())
        }
        "warp" => {
            let exe = "\"%ProgramFiles%\\Cloudflare\\Cloudflare WARP\\warp-cli.exe\"";
            sys::run_hidden(&format!("{exe} {}", if on { "connect" } else { "disconnect" })).map(|_| ())
        }
        "custom" => {
            let cmd = s.string(if on { "vpnOn" } else { "vpnOff" });
            if cmd.trim().is_empty() {
                return Err("Впиши команды включения и выключения в настройках".into());
            }
            if s.bool("vpnAdmin", false) {
                if sys::run_elevated(&cmd) { Ok(()) } else { Err("Windows не дала прав администратора".into()) }
            } else {
                sys::run_hidden(&cmd).map(|_| ())
            }
        }
        // A VPN program (Happ, Incy, v2rayN…): it has no command line, so the
        // island starts it, and switches the system proxy it set up.
        _ => vpn_app(&app, &s, on),
    };
    diag::log(&app, &format!("vpn {client} {}: {r:?}", if on { "on" } else { "off" }));
    r
}

/// The link scheme of a VPN program that can be switched by link, if it is installed.
fn vpn_scheme(id: &str) -> Option<&'static str> {
    let low = id.to_lowercase();
    ["happ", "incy"].into_iter().find(|s| low.contains(s) && sys::scheme_registered(s))
}

fn vpn_app(app: &AppHandle, s: &settings::Settings, on: bool) -> Result<(), String> {
    let id = s.string("vpnApp");
    if id.is_empty() {
        return Err("Выбери VPN-программу: Настройки → Сеть".into());
    }
    // The exe name, when the Start menu id is a path to it.
    let exe = id
        .rsplit(['\\', '/'])
        .next()
        .filter(|n| n.to_lowercase().ends_with(".exe"))
        .map(|n| n[..n.len() - 4].to_lowercase());
    let name = s.string("vpnAppName").to_lowercase();
    let scheme = vpn_scheme(&format!("{id} {name}"));
    // Running? By the exe in its id, or by its name / link scheme among running programs.
    let running = {
        let exes = sys::running_exes();
        exe.as_ref().is_some_and(|e| exes.contains(e))
            || exes.iter().any(|e| scheme.is_some_and(|sc| e.contains(sc)) || (!name.is_empty() && e.contains(name.split_whitespace().next().unwrap_or("\u{0}"))))
    };
    let remember = |server: &str| {
        let mut m = serde_json::Map::new();
        m.insert("vpnProxy".into(), serde_json::Value::String(server.to_string()));
        s.merge(m);
    };
    // 1. Quietest: the program runs in system-proxy mode, so switching the
    //    Windows proxy is all it takes, and no window shows.
    if on {
        let saved = s.string("vpnProxy");
        if running && !saved.is_empty() && sys::system_proxy().is_none() {
            sys::set_system_proxy(true, &saved);
            diag::log(app, &format!("vpn app: proxy {saved} on"));
            return Ok(());
        }
    } else if let Some(server) = sys::system_proxy() {
        remember(&server);
        sys::set_system_proxy(false, "");
        diag::log(app, &format!("vpn app: proxy {server} off"));
        return Ok(());
    }
    // 2. Happ and Incy take commands by link: happ://connect, incy://disconnect.
    if let Some(scheme) = scheme {
        let url = format!("{scheme}://{}", if on { "connect" } else { "disconnect" });
        if sys::open_scheme_quiet(&url, scheme) {
            diag::log(app, &format!("vpn app: {url} (running: {running})"));
            return Ok(());
        }
        diag::log(app, &format!("vpn app: {url} did not open"));
    } else {
        diag::log(app, &format!("vpn app {id} / {name}: no link scheme"));
    }
    // 3. Not running yet (most connect on start), or a TUN tunnel only the program can stop.
    sys::launch_app(&id);
    Ok(())
}


// ---- documents in the chat ------------------------------------------------------------

#[derive(serde::Serialize)]
struct Doc {
    name: String,
    text: Option<String>,
    error: Option<String>,
}

#[tauri::command]
async fn doc_pick(app: AppHandle) -> Vec<Doc> {
    use tauri_plugin_dialog::DialogExt;
    let picked = in_dialog(|| {
        app.dialog()
            .file()
            .set_title("Приложить документ")
            .add_filter("Документы", &["pdf", "docx", "xlsx", "pptx", "txt", "md", "csv", "json", "log", "xml", "html", "rs", "py", "js", "ts"])
            .blocking_pick_files()
    })
    .unwrap_or_default();
    picked
        .into_iter()
        .filter_map(|p| p.into_path().ok())
        .map(|p| {
            let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            match docs::read(&p.to_string_lossy()) {
                Ok(t) => Doc { name, text: Some(t), error: None },
                Err(e) => Doc { name, text: None, error: Some(e) },
            }
        })
        .collect()
}

// ---- launcher hotkeys --------------------------------------------------------------------

/// Shortcut id → what it opens ("app"/"url"/"path", target).
static LAUNCH_KEYS: std::sync::LazyLock<Mutex<std::collections::HashMap<u32, (String, String, Shortcut)>>> =
    std::sync::LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));

#[derive(serde::Deserialize)]
struct LaunchKey {
    hotkey: String,
    kind: String,
    target: String,
}

fn launch(app: &AppHandle, kind: &str, target: &str) {
    match kind {
        "app" => sys::launch_app(target),
        "url" => {
            let url = if target.starts_with("http") { target.to_string() } else { format!("https://{target}") };
            let _ = app.opener().open_url(url, None::<&str>);
        }
        _ => {
            let _ = app.opener().open_path(target.to_string(), None::<&str>);
        }
    }
}

/// Registers a hotkey per launcher shortcut; returns the ones Windows refused.
#[tauri::command]
fn launcher_hotkeys(app: AppHandle, keys: Vec<LaunchKey>) -> Vec<String> {
    let mut map = LAUNCH_KEYS.lock().unwrap();
    for (_, (_, _, sc)) in map.drain() {
        let _ = app.global_shortcut().unregister(sc);
    }
    let mut failed = Vec::new();
    for k in keys {
        let Ok(sc) = k.hotkey.parse::<Shortcut>() else {
            failed.push(k.hotkey);
            continue;
        };
        if app.global_shortcut().register(sc).is_ok() {
            map.insert(sc.id(), (k.kind, k.target, sc));
        } else {
            failed.push(k.hotkey);
        }
    }
    failed
}

/// Opens a page of Windows Settings (only the few the island needs).
#[tauri::command]
fn open_windows_settings(app: AppHandle, page: String) {
    let uri = match page.as_str() {
        "notifications" => "ms-settings:privacy-notifications",
        "microphone" => "ms-settings:privacy-microphone",
        "speech" => "ms-settings:privacy-speech",
        "vpn" => "ms-settings:network-vpn",
        "bluetooth" => "ms-settings:bluetooth",
        "sound" => "ms-settings:sound",
        _ => return,
    };
    let _ = app.opener().open_url(uri, None::<&str>);
}

// ---- AI ------------------------------------------------------------------------

#[tauri::command]
fn ai_key_set(ctl: State<'_, Ctl>, id: String, key: String) {
    ctl.keys.set(&id, &key);
}

#[tauri::command]
fn ai_key_status(ctl: State<'_, Ctl>, ids: Vec<String>) -> std::collections::HashMap<String, bool> {
    ids.into_iter().map(|id| (id.clone(), ctl.keys.has(&id))).collect()
}

#[tauri::command]
fn ai_chat(app: AppHandle, id: String, provider: ai::Provider, system: String, messages: Vec<ai::Msg>) {
    std::thread::spawn(move || {
        let ctl = app.state::<Ctl>();
        let (keys, runs) = (ctl.keys.clone(), ctl.runs.clone());
        ai::chat(app.clone(), &keys, &runs, id, provider, system, messages);
    });
}

#[tauri::command]
fn ai_cancel(ctl: State<'_, Ctl>, id: String) {
    ctl.runs.cancel(&id);
}

#[tauri::command]
async fn ai_models(app: AppHandle, provider: ai::Provider) -> Result<Vec<String>, String> {
    let keys = app.state::<Ctl>().keys.clone();
    ai::models(&keys, &provider)
}

#[tauri::command]
fn clip_current_text() -> Option<String> {
    arboard::Clipboard::new().ok()?.get_text().ok()
}

/// Puts text on the clipboard and, if asked, pastes it where the user was typing.
#[tauri::command]
async fn paste_text(app: AppHandle, text: String, paste: bool) {
    if let Some(w) = app.get_webview_window("island") {
        sys::release_focus(&w);
    }
    if put_on_clipboard(ClipData::Text(text)) && paste {
        std::thread::sleep(std::time::Duration::from_millis(80));
        sys::send_paste();
    }
}

// ---- dictation -------------------------------------------------------------------

/// Starts or stops dictation. `target` "chat" puts the text in the AI chat
/// box; otherwise it goes to the clipboard and (if allowed) into the window.
#[tauri::command]
fn dictate_toggle(app: AppHandle, target: Option<String>) {
    dictate(&app, target.unwrap_or_default());
}

fn dictate(app: &AppHandle, target: String) {
    let ctl = app.state::<Ctl>();
    if let Some(stop) = ctl.dictation.lock().unwrap().take() {
        stop.store(true, std::sync::atomic::Ordering::Relaxed);
        return;
    }
    #[cfg(windows)]
    {
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        *ctl.dictation.lock().unwrap() = Some(stop.clone());
        let app = app.clone();
        std::thread::spawn(move || {
            let emit = |state: &str, extra: serde_json::Value| {
                let mut v = serde_json::json!({ "state": state, "target": target });
                if let (Some(o), Some(e)) = (v.as_object_mut(), extra.as_object()) {
                    o.extend(e.clone());
                }
                let _ = app.emit_to("island", "dictation", v);
            };
            let ctl = app.state::<Ctl>();
            let s = ctl.settings.all();
            let get = |k: &str, d: &str| s.get(k).and_then(|v| v.as_str()).unwrap_or(d).to_string();
            let service = get("sttService", "windows");
            let lang = get("sttLang", "ru");
            emit("rec", serde_json::json!({ "level": 0 }));
            // The microphone is always recorded: it gives the level, and the
            // sound for Whisper (the chosen service, or the fallback when
            // Windows can't).
            let (stop2, app2) = (stop.clone(), app.clone());
            let target2 = target.clone();
            let mic = std::thread::spawn(move || {
                sys::record::record_mic(stop2, |l| {
                    let _ = app2.emit_to("island", "dictation", serde_json::json!({ "state": "rec", "level": l, "target": target2 }));
                })
            });
            let whisper_key = ["groq", "openai"].into_iter().find(|k| ctl.keys.has(k));
            let whisper = |samples: Vec<i16>, svc: &str| -> Result<String, (String, bool)> {
                if samples.len() <= 16_000 / 3 {
                    return Err(("Слишком коротко".into(), false));
                }
                emit("busy", serde_json::json!({}));
                let (base, model) = match svc {
                    "openai" => ("https://api.openai.com/v1".to_string(), "whisper-1".to_string()),
                    _ => ("https://api.groq.com/openai/v1".to_string(), "whisper-large-v3-turbo".to_string()),
                };
                ai::transcribe(&ctl.keys, svc, &base, &model, ai::wav(&samples, 16_000), &lang).map_err(|e| (e, false))
            };
            let result: Result<String, (String, bool)> = if service == "windows" {
                // Windows listens on its own thread: if it hangs, stopping still works.
                let (tx, rx) = std::sync::mpsc::channel();
                let (stop3, lang3) = (stop.clone(), lang.clone());
                std::thread::spawn(move || {
                    let _ = tx.send(sys::speech::dictate(&lang3, stop3, || {}).map_err(|e| (e.text, e.privacy)));
                });
                // Early failure (before you speak): stop now unless Whisper can take over.
                let mut early = None;
                while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                    if let Ok(r) = rx.recv_timeout(std::time::Duration::from_millis(150)) {
                        early = Some(r);
                        break;
                    }
                }
                let win = match early {
                    Some(Err(e)) if whisper_key.is_none() || e.1 => {
                        stop.store(true, std::sync::atomic::Ordering::Relaxed);
                        Err(e)
                    }
                    Some(r) => {
                        // Failed with a fallback at hand: keep recording until you stop.
                        while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                            std::thread::sleep(std::time::Duration::from_millis(100));
                        }
                        r
                    }
                    None => {
                        emit("busy", serde_json::json!({}));
                        rx.recv_timeout(std::time::Duration::from_secs(6))
                            .unwrap_or_else(|_| Err(("Распознавание Windows не ответило".into(), false)))
                    }
                };
                let samples = mic.join().ok().and_then(|r| r.ok()).unwrap_or_default();
                match (win, whisper_key) {
                    (Ok(t), _) if !t.trim().is_empty() => Ok(t),
                    (Err(e), _) if e.1 => Err(e),
                    (r, Some(k)) => {
                        if let Err(e) = &r {
                            diag::log(&app, &format!("dictation: windows failed ({}), using {k}", e.0));
                        }
                        whisper(samples, k)
                    }
                    (r, None) => {
                        if let Err(e) = &r {
                            diag::log(&app, &format!("dictation: {}", e.0));
                        }
                        r
                    }
                }
            } else {
                let samples = mic.join().map_err(|_| ("Микрофон".to_string(), false)).and_then(|r| r.map_err(|e| (e, false)));
                match samples {
                    Ok(s) => whisper(s, &service),
                    Err(e) => Err(e),
                }
            };
            *ctl.dictation.lock().unwrap() = None;
            match result {
                Ok(text) if !text.trim().is_empty() => {
                    if target != "chat" {
                        let paste = ctl.settings.bool("dictationPaste", true);
                        if put_on_clipboard(ClipData::Text(text.clone())) && paste {
                            std::thread::sleep(std::time::Duration::from_millis(80));
                            sys::send_paste();
                        }
                    }
                    emit("done", serde_json::json!({ "text": text }));
                }
                Ok(_) => emit("error", serde_json::json!({ "text": "Речь не распознана" })),
                Err((e, privacy)) => emit("error", serde_json::json!({ "text": e, "privacy": privacy })),
            }
        });
    }
}

// ---- screen recording --------------------------------------------------------------

fn record_toggle(app: &AppHandle) {
    let ctl = app.state::<Ctl>();
    if let Some(stop) = ctl.recording.lock().unwrap().take() {
        stop.store(true, std::sync::atomic::Ordering::Relaxed);
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || capture::start(&app, "record"));
}

#[tauri::command]
fn record_toggle_cmd(app: AppHandle) {
    record_toggle(&app);
}

/// The overlay picked an area (physical px inside the frozen monitor).
#[tauri::command]
fn record_start(app: AppHandle, x: i32, y: i32, w: i32, h: i32) {
    capture::hide(&app);
    #[cfg(windows)]
    {
        let ctl = app.state::<Ctl>();
        let (ox, oy) = *capture::ORIGIN.lock().unwrap();
        let s = ctl.settings.all();
        let fps = s.get("recordFps").and_then(|v| v.as_u64()).unwrap_or(30).clamp(10, 60) as u32;
        let high = s.get("recordQuality").and_then(|v| v.as_str()) == Some("high");
        let dir = s
            .get("recordDir")
            .and_then(|v| v.as_str())
            .map(std::path::PathBuf::from)
            .or_else(|| app.path().video_dir().ok().map(|p| p.join("Dark Island")));
        let Some(dir) = dir else { return };
        let _ = std::fs::create_dir_all(&dir);
        let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let gif = s.get("recordFormat").and_then(|v| v.as_str()) == Some("gif");
        let sound = match s.get("recordSound").and_then(|v| v.as_str()) {
            Some("system") => sys::record::Sound::System,
            Some("mic") => sys::record::Sound::Mic,
            _ => sys::record::Sound::None,
        };
        let path = dir.join(format!("Запись {secs}.{}", if gif { "gif" } else { "mp4" })).to_string_lossy().into_owned();
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        *ctl.recording.lock().unwrap() = Some(stop.clone());
        let _ = app.emit_to("island", "recording", serde_json::json!({ "on": true }));
        let app2 = app.clone();
        std::thread::spawn(move || {
            let area = sys::record::Area { x: ox + x, y: oy + y, w, h };
            let r = if gif {
                sys::record::record_gif(&path, area, stop)
            } else {
                sys::record::record_screen(&path, area, fps, high, sound, stop)
            };
            *app2.state::<Ctl>().recording.lock().unwrap() = None;
            let _ = app2.emit_to(
                "island",
                "recording",
                match r {
                    Ok(()) => serde_json::json!({ "on": false, "path": path }),
                    Err(e) => serde_json::json!({ "on": false, "error": e }),
                },
            );
        });
    }
    #[cfg(not(windows))]
    let _ = (x, y, w, h);
}

// ---- icons -----------------------------------------------------------------------

static ICONS: std::sync::LazyLock<Mutex<std::collections::HashMap<String, Option<String>>>> =
    std::sync::LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));

/// An icon for a launcher entry, a command-bar app or a shelf file:
/// kind "app" (AppID), "path" (file or folder), or "url" (the site's own favicon).
#[tauri::command]
async fn icon_get(kind: String, target: String) -> Option<String> {
    let key = format!("{kind}\u{1}{target}");
    if let Some(v) = ICONS.lock().unwrap().get(&key) {
        return v.clone();
    }
    let icon = match kind.as_str() {
        "app" => sys::shell_icon(&format!("shell:AppsFolder\\{target}"), 64),
        "path" => sys::shell_icon(&target, 64),
        "url" => live::favicon(&target),
        _ => None,
    };
    ICONS.lock().unwrap().insert(key, icon.clone());
    icon
}

// ---- hotkeys -------------------------------------------------------------------

/// Ctrl+Alt+I opens or closes the island, Ctrl+Alt+V opens the clipboard,
/// Alt+Space opens the command bar.
/// The island's own hotkeys: action → default combination. The user can
/// change each one in the settings ("hotkeys" → { action: "Ctrl+Alt+KeyM" }).
const HOTKEYS: &[(&str, &str, &str)] = &[
    ("toggle", "Ctrl+Alt+KeyI", "Открыть или закрыть остров"),
    ("command", "Alt+Space", "Командная строка"),
    ("clipboard", "Ctrl+Alt+KeyV", "История буфера"),
    ("area", "Ctrl+Alt+KeyS", "Снимок области"),
    ("full", "Ctrl+Alt+Shift+KeyS", "Снимок экрана"),
    ("ocr", "Ctrl+Alt+KeyO", "Текст с экрана"),
    ("qr", "Ctrl+Alt+KeyQ", "QR-код с экрана"),
    ("color", "Ctrl+Alt+KeyC", "Пипетка"),
    ("mic", "Ctrl+Alt+KeyM", "Микрофон: выключить и включить"),
    ("through", "Ctrl+Alt+KeyT", "Сквозной режим"),
    ("chat", "Ctrl+Alt+KeyA", "Чат с ИИ"),
    ("dictation", "Ctrl+Alt+KeyD", "Голос в текст"),
    ("record", "Ctrl+Alt+KeyR", "Запись экрана"),
    ("plain", "Ctrl+Alt+Shift+KeyV", "Вставить без форматирования"),
    ("vpn", "Ctrl+Alt+KeyP", "VPN: включить и выключить"),
];

/// Registered island hotkeys: shortcut id → (action, shortcut).
static ACTION_KEYS: std::sync::LazyLock<Mutex<std::collections::HashMap<u32, (String, Shortcut)>>> =
    std::sync::LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));

/// "Ctrl+Alt+KeyM" → a shortcut ("Ctrl" is spelled the way the parser wants).
fn parse_combo(s: &str) -> Option<Shortcut> {
    s.replace("Ctrl", "Control").replace("Win+", "Super+").parse::<Shortcut>().ok()
}

/// (Re)registers the island's hotkeys from the settings; remembers which
/// ones another program holds.
fn apply_hotkeys(app: &AppHandle) {
    let mut map = ACTION_KEYS.lock().unwrap();
    for (_, (_, sc)) in map.drain() {
        let _ = app.global_shortcut().unregister(sc);
    }
    let custom = app.state::<Ctl>().settings.all().get("hotkeys").cloned().unwrap_or_default();
    let mut taken = Vec::new();
    for (action, default, _) in HOTKEYS {
        let combo = custom.get(*action).and_then(|v| v.as_str()).unwrap_or(default).to_string();
        if combo.is_empty() {
            continue; // turned off
        }
        let Some(sc) = parse_combo(&combo) else {
            taken.push(format!("{combo} (не понял)"));
            continue;
        };
        if app.global_shortcut().register(sc).is_ok() {
            map.insert(sc.id(), (action.to_string(), sc));
        } else {
            taken.push(combo.replace("Key", "").replace("Digit", ""));
        }
    }
    *check::HOTKEYS_TAKEN.lock().unwrap() = taken;
}

#[derive(serde::Serialize)]
struct HotkeyInfo {
    action: &'static str,
    title: &'static str,
    default: &'static str,
    combo: String,
    taken: bool,
}

/// The island's hotkeys with their current combinations, for the settings.
#[tauri::command]
fn hotkeys_list(app: AppHandle) -> Vec<HotkeyInfo> {
    let custom = app.state::<Ctl>().settings.all().get("hotkeys").cloned().unwrap_or_default();
    let live = ACTION_KEYS.lock().unwrap();
    HOTKEYS
        .iter()
        .map(|(action, default, title)| {
            let combo = custom.get(*action).and_then(|v| v.as_str()).unwrap_or(default).to_string();
            let taken = !combo.is_empty() && !live.values().any(|(a, _)| a == action);
            HotkeyInfo { action, title, default, combo, taken }
        })
        .collect()
}

/// Saves one combination ("" turns it off, null restores the default) and
/// registers everything again.
#[tauri::command]
fn hotkey_set(app: AppHandle, action: String, combo: Option<String>) -> Vec<HotkeyInfo> {
    let ctl = app.state::<Ctl>();
    let mut all = ctl.settings.all().get("hotkeys").and_then(|v| v.as_object().cloned()).unwrap_or_default();
    match combo {
        Some(c) => {
            all.insert(action, serde_json::Value::String(c));
        }
        None => {
            all.remove(&action);
        }
    }
    let mut patch = serde_json::Map::new();
    patch.insert("hotkeys".into(), serde_json::Value::Object(all));
    ctl.settings.merge(patch);
    apply_hotkeys(&app);
    hotkeys_list(app)
}

/// An important card while a game hides the island: shows the window for
/// the card (`on`), and hides it again afterwards if the game is still on.
#[tauri::command]
fn island_peek(app: AppHandle, ctl: State<'_, Ctl>, on: bool) {
    let Some(w) = app.get_webview_window("island") else { return };
    let hidden = ctl.shared.snap.lock().unwrap().presence == types::Presence::Hidden;
    if on {
        let _ = w.show();
    } else if hidden {
        let _ = w.hide();
    }
}

/// While a new combination is being typed in the settings, the island's own
/// hotkeys step aside (else they would catch the keys first).
#[tauri::command]
fn hotkeys_pause(app: AppHandle, on: bool) {
    if on {
        let mut map = ACTION_KEYS.lock().unwrap();
        for (_, (_, sc)) in map.drain() {
            let _ = app.global_shortcut().unregister(sc);
        }
    } else {
        apply_hotkeys(&app);
    }
}

fn on_hotkey(app: &AppHandle, action: &str) {
    match action {
        "area" | "full" | "ocr" | "qr" | "color" => {
            let (app, mode) = (app.clone(), action.to_string());
            std::thread::spawn(move || capture::start(&app, &mode));
        }
        "vpn" => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let on = sys::vpn_now().is_none();
                if let Err(e) = vpn_set(app.clone(), on).await {
                    let _ = app.emit_to("island", "vpn_error", e);
                }
            });
        }
        "dictation" => dictate(app, String::new()),
        "record" => record_toggle(app),
        "plain" => {
            // Paste without formatting: the clipboard's text only.
            std::thread::spawn(move || {
                let text = arboard::Clipboard::new().ok().and_then(|mut c| c.get_text().ok());
                if let Some(t) = text {
                    if put_on_clipboard(ClipData::Text(t)) {
                        std::thread::sleep(std::time::Duration::from_millis(120));
                        sys::send_paste();
                    }
                }
            });
        }
        "mic" => {
            let app = app.clone();
            std::thread::spawn(move || {
                let r = sys::mic_toggle();
                diag::log(&app, &format!("mic hotkey -> {r:?}"));
                if let Some(muted) = r {
                    let _ = app.emit_to("island", "mic_muted", muted);
                }
            });
        }
        // toggle, command, clipboard, through, chat: the page handles them.
        other => {
            let _ = app.emit_to("island", "hotkey", other);
        }
    }
}

fn register_hotkeys(app: &AppHandle) -> tauri::Result<()> {
    app.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(move |app, sc, ev| {
                if ev.state() != ShortcutState::Pressed {
                    return;
                }
                let action = ACTION_KEYS.lock().unwrap().get(&sc.id()).map(|(a, _)| a.clone());
                if let Some(a) = action {
                    return on_hotkey(app, &a);
                }
                if let Some((kind, target, _)) = LAUNCH_KEYS.lock().unwrap().get(&sc.id()).cloned() {
                    launch(app, &kind, &target);
                }
            })
            .build(),
    )?;
    apply_hotkeys(app);
    Ok(())
}

/// Centres the window on the top edge of the primary monitor and remembers
/// where it ended up, so the cursor thread can map screen coordinates.
pub fn place_window(win: &WebviewWindow, shared: &Shared) {
    let (zoom, index, offset) = *shared.place.lock().unwrap();
    let chosen = (index >= 0)
        .then(|| win.available_monitors().ok().and_then(|list| list.into_iter().nth(index as usize)))
        .flatten();
    let monitor = chosen
        .or_else(|| win.primary_monitor().ok().flatten())
        .or_else(|| win.current_monitor().ok().flatten());
    let Some(m) = monitor else { return };
    let scale = m.scale_factor() * zoom;
    let (mx, my) = (m.position().x as f64, m.position().y as f64);
    let mw = m.size().width as f64;
    let w = (WINDOW_W * scale).round();
    let shift = (offset * m.scale_factor()).clamp(-(mw - w) / 2.0, (mw - w) / 2.0);
    let x = (mx + (mw - w) / 2.0 + shift).round();
    // With the taskbar at the top of the screen the island stands under it.
    let y = (m.work_area().position.y as f64).max(my);
    let size = PhysicalSize::new(w as u32, (WINDOW_H * scale).round() as u32);
    if win.outer_size().ok() != Some(size) {
        let _ = win.set_size(size);
        let _ = win.set_zoom(zoom);
    }
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
    let settings = MenuItem::with_id(app, "settings", "Настройки", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Выход", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&settings, &autostart, &PredefinedMenuItem::separator(app)?, &quit])?;

    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("Dark Island")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "quit" => app.exit(0),
            "settings" => {
                // Off the main thread (see settings_open).
                let app = app.clone();
                std::thread::spawn(move || open_settings_window(app, None));
            }
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

/// The agent-hook mode of the executable (see main.rs).
pub fn agent_hook(agent: &str) -> i32 {
    agents::hook_main(agent)
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|_app, _args, _cwd| {}))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_drag::init())
        .register_uri_scheme_protocol("frame", |_ctx, _req| capture::protocol())
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
            shelf_pick,
            shelf_clear,
            open_path,
            reveal_path,
            note_get,
            note_set,
            take_focus,
            release_focus,
            settings_get,
            settings_set,
            agents_answer,
            agents_connections,
            agents_connect,
            controls_get,
            controls_set,
            power,
            apps_list,
            app_launch,
            run_shell,
            open_url,
            capture_start,
            overlay_ready,
            overlay_cancel,
            capture_done,
            color_done,
            weather_get,
            weather_refresh,
            city_search,
            lyrics_get,
            mic_toggle,
            notifications_access,
            open_windows_settings,
            ai_key_set,
            settings_open,
            tour_start,
            agents_test,
            hotkeys_list,
            hotkey_set,
            hotkeys_pause,
            island_peek,
            self_check,
            settings_export,
            settings_import,
            settings_reset,
            update_check,
            ai_key_status,
            ai_chat,
            ai_cancel,
            ai_models,
            clip_current_text,
            paste_text,
            dictate_toggle,
            record_toggle_cmd,
            record_start,
            monitors_list,
            icon_get,
            diag_open,
            audio_devices,
            player_volume_get,
            player_volume_set,
            bt_devices,
            bt_connect,
            vpn_status,
            vpn_names,
            vpn_set,
            doc_pick,
            launcher_hotkeys
        ])
        .setup(|app| {
            let shared = Arc::new(Shared::default());
            let win = app
                .get_webview_window("island")
                .expect("window `island` is declared in tauri.conf.json");

            let data_dir = app.path().app_data_dir()?;
            let _ = std::fs::create_dir_all(&data_dir);
            let settings = Arc::new(settings::Settings::load(&data_dir));
            *shared.place.lock().unwrap() = read_place(&settings);
            place_window(&win, &shared);
            let _ = win.set_zoom(shared.place.lock().unwrap().0);
            sys::prepare_window(&win);
            // Clicks pass through until the cursor is over the island itself.
            let _ = win.set_ignore_cursor_events(true);
            let _ = win.show();

            let tx = sys::spawn(app.handle().clone(), shared.clone(), settings.clone());
            cursor::spawn(app.handle().clone(), shared.clone());
            sys::spawn_meter(app.handle().clone());
            let clips = Arc::new(Mutex::new(Clips::load(&data_dir)));
            sys::spawn_clipboard(app.handle().clone(), clips.clone(), settings.clone());
            let agents = agents::start(app.handle().clone(), settings.clone());
            live::spawn_weather(app.handle().clone(), settings.clone());
            live::spawn_downloads(app.handle().clone());
            let keys = Arc::new(ai::Keys::load(&data_dir));
            obs::spawn(app.handle().clone(), settings.clone(), keys.clone());
            sys::spawn_notifications(app.handle().clone(), settings.clone());
            // The Start menu is read once in the background for the command bar.
            let apps = Arc::new(Mutex::new(Vec::new()));
            {
                let apps = apps.clone();
                std::thread::spawn(move || {
                    let list = sys::start_apps();
                    *apps.lock().unwrap() = list;
                });
            }
            app.manage(Ctl {
                shared,
                tx: Mutex::new(tx),
                clips,
                shelf: Mutex::new(Shelf::load(&data_dir)),
                note: Mutex::new(Note::load(&data_dir)),
                settings,
                agents,
                apps,
                keys,
                runs: Arc::new(ai::Runs::new()),
                dictation: Mutex::new(None),
                recording: Mutex::new(None),
            });
            register_hotkeys(app.handle())?;
            // Files dropped on the island go straight to the shelf (sys::drop).
            #[cfg(windows)]
            {
                let app2 = app.handle().clone();
                if let Ok(h) = win.hwnd() {
                    let hwnd = h.0 as isize;
                    // WebView2 creates its child windows over time: register now
                    // and again a few times as they appear.
                    std::thread::spawn(move || {
                        for i in 0u64.. {
                            let a = app2.clone();
                            let _ = app2.run_on_main_thread(move || sys::drop::register(&a, hwnd));
                            std::thread::sleep(std::time::Duration::from_millis(if i < 10 { 500 } else { 5000 }));
                        }
                    });
                }
            }
            capture::create_overlay(app.handle())?;
            // By default the island stays out of screenshots, recordings and streams.
            let show_in_captures = app.state::<Ctl>().settings.bool("showInCaptures", false);
            if let Some(w) = app.get_webview_window("island") {
                sys::exclude_from_capture(&w, !show_in_captures);
            }

            build_tray(app.handle())?;
            // A watchdog: if the main thread stops answering, the island quits
            // rather than sit on top of the desktop blocking clicks.
            {
                let app = app.handle().clone();
                std::thread::spawn(move || {
                    // Counts the main thread's answers; missed checks in a row
                    // (not wall time) decide, so sleep and hibernation don't count.
                    let beat = Arc::new(std::sync::atomic::AtomicU64::new(0));
                    let mut seen = 0u64;
                    let mut missed = 0u32;
                    loop {
                        let b = beat.clone();
                        let _ = app.run_on_main_thread(move || {
                            b.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        });
                        std::thread::sleep(std::time::Duration::from_secs(2));
                        let now = beat.load(std::sync::atomic::Ordering::Relaxed);
                        if now == seen && DIALOGS.load(std::sync::atomic::Ordering::Relaxed) == 0 {
                            missed += 1;
                        } else {
                            missed = 0;
                            seen = now;
                        }
                        if missed >= 10 {
                            diag::log(&app, "main thread silent for 20s: quitting so the desktop is not blocked");
                            std::process::exit(1);
                        }
                    }
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Dark Island");
}

#[cfg(test)]
mod tests {
    use super::version_newer;

    #[test]
    fn versions() {
        assert!(version_newer("0.2.0", "0.1.9"));
        assert!(version_newer("0.10.0", "0.9.0"));
        assert!(!version_newer("0.1.0", "0.1.0"));
        assert!(!version_newer("beta", "0.1.0"));
    }
}
