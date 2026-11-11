//! Operating-system integration. The real work happens in `windows.rs`;
//! other platforms get a stub so the UI can be developed anywhere.

#[cfg(windows)]
mod classic;
#[cfg(windows)]
pub mod devices;
#[cfg(windows)]
pub mod drop;
#[cfg(windows)]
mod meter;
#[cfg(windows)]
pub mod record;
#[cfg(windows)]
pub mod speech;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use self::meter::spawn as spawn_meter;
#[cfg(windows)]
pub use self::windows::{
    AUDIO_PREFS, steam_path, system_proxy, set_system_proxy, vpn_now, running_exes, run_elevated, run_hidden, bring_to_front, capture_monitor, shell_icon, protect, unprotect, mic_toggle, notifications_access, spawn_notifications, controls_get, cursor_pos, exclude_from_capture, launch_app, ocr, utc_offset_secs, mouse_down, power, prepare_window, radio_set, release_focus, run_shell,
    send_paste, set_dark, spawn, spawn_clipboard, start_apps, take_focus, App, Controls,
};

#[cfg(not(windows))]
mod stub;
#[cfg(not(windows))]
pub use self::stub::{
    steam_path, cursor_pos, mouse_down, prepare_window, release_focus, send_paste, spawn, spawn_clipboard, spawn_meter,
    take_focus,
};
