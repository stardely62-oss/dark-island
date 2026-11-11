//! A small log file for things that can only be checked on the user's
//! Windows: drops on the shelf, the microphone. Settings → "Журнал" opens it.

use std::io::Write;

use tauri::{AppHandle, Manager};

pub fn path(app: &AppHandle) -> Option<std::path::PathBuf> {
    let dir = app.path().app_log_dir().ok()?;
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.join("island.log"))
}

pub fn log(app: &AppHandle, msg: &str) {
    let Some(p) = path(app) else { return };
    // Keep it small: start over past 256 KB.
    if std::fs::metadata(&p).map(|m| m.len() > 256 * 1024).unwrap_or(false) {
        let _ = std::fs::remove_file(&p);
    }
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(p) {
        let _ = writeln!(f, "{secs} {msg}");
    }
}
