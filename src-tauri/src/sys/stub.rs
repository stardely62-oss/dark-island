use std::sync::mpsc::{channel, Sender};
use std::sync::Arc;

use tauri::{AppHandle, WebviewWindow};

use crate::types::Cmd;
use crate::Shared;

pub fn spawn(_app: AppHandle, _shared: Arc<Shared>, _settings: Arc<crate::settings::Settings>) -> Sender<Cmd> {
    let (tx, rx) = channel::<Cmd>();
    std::thread::spawn(move || while rx.recv().is_ok() {});
    tx
}

pub fn prepare_window(_win: &WebviewWindow) {}

pub fn cursor_pos() -> Option<(f64, f64)> {
    None
}

pub fn spawn_meter(_app: AppHandle) {}

pub fn spawn_clipboard(
    _app: AppHandle,
    _clips: Arc<std::sync::Mutex<crate::clip::Clips>>,
    _settings: Arc<crate::settings::Settings>,
) {
}
pub fn send_paste() {}
pub fn take_focus(win: &WebviewWindow) {
    let _ = win.set_focus();
}
pub fn release_focus(_win: &WebviewWindow) {}
pub fn mouse_down() -> bool {
    false
}

#[derive(Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Controls {
    pub wifi: Option<bool>,
    pub ssid: Option<String>,
    pub bluetooth: Option<bool>,
    pub dark: bool,
}
pub fn controls_get() -> Controls {
    Controls::default()
}
pub fn radio_set(_kind: &str, _on: bool) -> bool {
    false
}
pub fn set_dark(_dark: bool) {}
pub fn power(_action: &str) {}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct App {
    #[serde(rename = "Name")]
    pub name: String,
    #[serde(rename = "AppID")]
    pub id: String,
}
pub fn start_apps() -> Vec<App> {
    Vec::new()
}
pub fn launch_app(_id: &str) {}
pub fn run_shell(_cmd: &str, _powershell: bool) {}
