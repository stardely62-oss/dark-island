//! Tracks the cursor so that the transparent window only catches clicks over
//! the island, and feeds the cursor position to the liquid animation.

use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};

use crate::types::CursorEvent;
use crate::{place_window, sys, Shared};

/// How far around the island (logical px) the edge starts reaching for the cursor.
const NEAR: f64 = 140.0;

pub fn spawn(app: AppHandle, shared: Arc<Shared>) {
    thread::Builder::new()
        .name("island-cursor".into())
        .spawn(move || run(app, shared))
        .expect("spawn cursor thread");
}

fn run(app: AppHandle, shared: Arc<Shared>) {
    let Some(win) = app.get_webview_window("island") else { return };
    let mut inside_before = false;
    let mut near_before = false;
    let mut last_place = Instant::now();
    let mut down_before = false;

    loop {
        // Monitors can be plugged in or rescaled: re-centre now and then.
        if last_place.elapsed() > Duration::from_secs(3) {
            place_window(&win, &shared);
            last_place = Instant::now();
        }

        let Some((cx, cy)) = sys::cursor_pos() else {
            thread::sleep(Duration::from_millis(250));
            continue;
        };
        let g = *shared.geom.lock().unwrap();
        let r = *shared.hit.lock().unwrap();
        let x = (cx - g.x) / g.scale;
        let y = (cy - g.y) / g.scale;

        let inside = r.contains(x, y);
        if inside != inside_before {
            let _ = win.set_ignore_cursor_events(!inside);
            inside_before = inside;
        }

        // A click anywhere but the island closes it when it was opened on purpose.
        let down = sys::mouse_down();
        if down && !down_before && !inside {
            let _ = app.emit_to("island", "outside_click", ());
        }
        down_before = down;

        let near = r.w > 0.0 && x > r.x - NEAR && x < r.x + r.w + NEAR && y < r.y + r.h + NEAR;
        if near || near_before {
            let _ = app.emit_to("island", "cursor", CursorEvent { x, y, near, inside });
            near_before = near;
        }

        // Poll fast only while the cursor is close; idle polling is cheap.
        thread::sleep(Duration::from_millis(if near { 16 } else { 40 }));
    }
}
