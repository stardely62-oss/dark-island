//! Screen tools: area / full-screen screenshots with markup, text from the
//! screen (OCR), QR codes and the colour picker.
//!
//! The monitor under the cursor is frozen into a picture, which a hidden
//! full-screen window (`overlay`) shows; the user selects and marks up there,
//! and the result comes back here to be copied, saved or read.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::http::Response;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};

use crate::clip::{decode_png, encode_png, thumbnail};
use crate::sys;

/// The frozen screen, as PNG, served to the overlay at `frame://`.
static FRAME: Mutex<Option<Vec<u8>>> = Mutex::new(None);
static SHOT: AtomicU64 = AtomicU64::new(0);
/// Top-left corner of the frozen monitor, to place a recording area.
pub static ORIGIN: Mutex<(i32, i32)> = Mutex::new((0, 0));

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Start {
    mode: String,
    id: u64,
    w: u32,
    h: u32,
}

/// Result shown on the island as a card.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureResult {
    /// shot | text | qr | link | color | error
    pub kind: &'static str,
    pub text: String,
    pub thumb: Option<String>,
    pub path: Option<String>,
}

pub fn create_overlay(app: &AppHandle) -> tauri::Result<()> {
    let w = WebviewWindowBuilder::new(app, "overlay", WebviewUrl::App("index.html?view=overlay".into()))
        .title("Dark Island")
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .visible(false)
        .focused(false)
        .build()?;
    sys::exclude_from_capture(&w, true);
    Ok(())
}

/// Serves the frozen frame to the overlay (with CORS, so its canvas stays exportable).
pub fn protocol() -> Response<Vec<u8>> {
    let body = FRAME.lock().unwrap().clone().unwrap_or_default();
    Response::builder()
        .header("Content-Type", "image/png")
        .header("Access-Control-Allow-Origin", "*")
        .header("Cache-Control", "no-store")
        .body(body)
        .unwrap()
}

/// mode: area | full | ocr | qr | color
pub fn start(app: &AppHandle, mode: &str) {
    let Some(overlay) = app.get_webview_window("overlay") else { return };
    if overlay.is_visible().unwrap_or(false) {
        return;
    }
    // Let the hotkey's own key-up and any menu close before freezing the screen.
    std::thread::sleep(std::time::Duration::from_millis(80));
    let Some(frame) = sys::capture_monitor() else { return };
    let Some(png) = encode_png(frame.w, frame.h, &frame.rgba) else { return };
    *FRAME.lock().unwrap() = Some(png);
    *ORIGIN.lock().unwrap() = (frame.x, frame.y);
    let id = SHOT.fetch_add(1, Ordering::Relaxed) + 1;
    let _ = overlay.set_position(PhysicalPosition::new(frame.x, frame.y));
    let _ = overlay.set_size(PhysicalSize::new(frame.w, frame.h));
    let _ = app.emit_to("overlay", "overlay_start", Start { mode: mode.to_string(), id, w: frame.w, h: frame.h });
}

pub fn ready(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("overlay") {
        let _ = w.show();
        sys::bring_to_front(&w);
        let _ = w.set_focus();
    }
}

pub fn hide(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("overlay") {
        let _ = w.hide();
    }
    *FRAME.lock().unwrap() = None;
}

fn report(app: &AppHandle, r: CaptureResult) {
    let _ = app.emit_to("island", "capture", r);
}

fn put_text(text: &str) {
    if let Ok(mut cb) = arboard::Clipboard::new() {
        let _ = cb.set_text(text.to_string());
    }
}

fn save_dir(app: &AppHandle, settings: &crate::settings::Settings) -> Option<std::path::PathBuf> {
    let custom = settings.all().get("screenshotDir").and_then(Value::as_str).map(std::path::PathBuf::from);
    let dir = custom.or_else(|| app.path().picture_dir().ok().map(|p| p.join("Screenshots").join("Dark Island")))?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

fn stamp() -> String {
    // Local time without extra crates: let Windows format it through the file name.
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let offset = sys::utc_offset_secs();
    let t = secs as i64 + offset;
    let (days, rem) = (t.div_euclid(86_400), t.rem_euclid(86_400));
    let (y, m, d) = civil(days);
    format!("{y:04}-{m:02}-{d:02} {:02}-{:02}-{:02}", rem / 3600, rem % 3600 / 60, rem % 60)
}

/// Days since 1970-01-01 to (year, month, day).
fn civil(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + if m <= 2 { 1 } else { 0 }, m, d)
}

/// The overlay finished: `png` is the marked-up selection.
pub fn done(app: &AppHandle, settings: &crate::settings::Settings, keys: &crate::ai::Keys, png_b64: &str, action: &str) {
    hide(app);
    let Ok(png) = B64.decode(png_b64.trim_start_matches("data:image/png;base64,")) else { return };
    match action {
        "ocr" => {
            let text = sys::ocr(&png);
            match text {
                Some(t) => {
                    put_text(&t);
                    report(app, CaptureResult { kind: "text", text: t, thumb: None, path: None });
                }
                None => report(app, CaptureResult { kind: "error", text: crate::i18n::tr("Текст не найден", "No text found").into(), thumb: None, path: None }),
            }
        }
        "upload" => {
            let service = settings.all().get("uploadService").and_then(Value::as_str).unwrap_or("imgbb").to_string();
            match crate::ai::upload(keys, &service, &png) {
                Ok(url) => {
                    put_text(&url);
                    report(app, CaptureResult { kind: "link", text: url, thumb: None, path: None });
                }
                Err(e) => report(app, CaptureResult { kind: "error", text: e, thumb: None, path: None }),
            }
        }
        "qr" => match decode_qr(&png) {
            Some(t) => {
                put_text(&t);
                report(app, CaptureResult { kind: "qr", text: t, thumb: None, path: None });
            }
            None => report(app, CaptureResult { kind: "error", text: crate::i18n::tr("QR-код не найден", "No QR code found").into(), thumb: None, path: None }),
        },
        _ => {
            let Some((w, h, rgba)) = decode_png(&png) else { return };
            let copied = arboard::Clipboard::new()
                .and_then(|mut cb| {
                    cb.set_image(arboard::ImageData { width: w as usize, height: h as usize, bytes: rgba.clone().into() })
                })
                .is_ok();
            let mut path = None;
            if action == "save" || settings.bool("screenshotSave", true) {
                if let Some(dir) = save_dir(app, settings) {
                    let p = dir.join(crate::L!("Снимок {}.png", "Screenshot {}.png", stamp()));
                    if std::fs::write(&p, &png).is_ok() {
                        path = Some(p.to_string_lossy().into_owned());
                    }
                }
            }
            let thumb = thumbnail(w, h, &rgba).map(|t| format!("data:image/png;base64,{}", B64.encode(t)));
            let text = match (copied, &path) {
                (true, Some(_)) => crate::i18n::tr("В буфере и в папке", "In the clipboard and the folder"),
                (true, None) => crate::i18n::tr("В буфере обмена", "In the clipboard"),
                (false, Some(_)) => crate::i18n::tr("Сохранён в папку", "Saved to the folder"),
                _ => crate::i18n::tr("Не удалось сохранить", "Couldn't save"),
            };
            report(app, CaptureResult { kind: "shot", text: text.into(), thumb, path });
        }
    }
}

pub fn color(app: &AppHandle, settings: &crate::settings::Settings, hex: &str) {
    hide(app);
    put_text(hex);
    let mut history: Vec<Value> = settings
        .all()
        .get("colorHistory")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    history.retain(|v| v.as_str() != Some(hex));
    history.insert(0, Value::String(hex.to_string()));
    history.truncate(12);
    let mut patch = serde_json::Map::new();
    patch.insert("colorHistory".into(), json!(history));
    let all = settings.merge(patch);
    let _ = app.emit_to("island", "settings", all.clone());
    let _ = app.emit_to("overlay", "settings", all);
    report(app, CaptureResult { kind: "color", text: hex.to_string(), thumb: None, path: None });
}

pub fn decode_qr(png: &[u8]) -> Option<String> {
    let (w, h, rgba) = decode_png(png)?;
    let luma: Vec<u8> = rgba
        .chunks_exact(4)
        .map(|p| ((p[0] as u32 * 299 + p[1] as u32 * 587 + p[2] as u32 * 114) / 1000) as u8)
        .collect();
    let mut img = rqrr::PreparedImage::prepare_from_greyscale(w as usize, h as usize, |x, y| luma[y * w as usize + x]);
    img.detect_grids().into_iter().find_map(|g| g.decode().ok().map(|(_, text)| text))
}
