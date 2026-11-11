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
