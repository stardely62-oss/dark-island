use std::sync::mpsc::{channel, Sender};
use std::sync::Arc;

use tauri::{AppHandle, WebviewWindow};

use crate::types::Cmd;
use crate::Shared;

pub fn spawn(_app: AppHandle, _shared: Arc<Shared>) -> Sender<Cmd> {
    let (tx, rx) = channel::<Cmd>();
    std::thread::spawn(move || while rx.recv().is_ok() {});
    tx
}

pub fn prepare_window(_win: &WebviewWindow) {}

pub fn cursor_pos() -> Option<(f64, f64)> {
    None
}

pub fn spawn_meter(_app: AppHandle) {}

pub fn spawn_clipboard(_app: AppHandle, _clips: Arc<std::sync::Mutex<crate::clip::Clips>>) {}
pub fn send_paste() {}
pub fn take_focus(win: &WebviewWindow) {
    let _ = win.set_focus();
}
pub fn release_focus(_win: &WebviewWindow) {}
pub fn mouse_down() -> bool {
    false
}
