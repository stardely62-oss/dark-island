//! Operating-system integration. The real work happens in `windows.rs`;
//! other platforms get a stub so the UI can be developed anywhere.

#[cfg(windows)]
mod meter;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use self::meter::spawn as spawn_meter;
#[cfg(windows)]
pub use self::windows::{
    cursor_pos, mouse_down, prepare_window, release_focus, send_paste, spawn, spawn_clipboard, take_focus,
};

#[cfg(not(windows))]
mod stub;
#[cfg(not(windows))]
pub use self::stub::{
    cursor_pos, mouse_down, prepare_window, release_focus, send_paste, spawn, spawn_clipboard, spawn_meter,
    take_focus,
};
