//! Operating-system integration. The real work happens in `windows.rs`;
//! other platforms get a stub so the UI can be developed anywhere.

#[cfg(windows)]
mod meter;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use self::meter::spawn as spawn_meter;
#[cfg(windows)]
pub use self::windows::{cursor_pos, prepare_window, spawn};

#[cfg(not(windows))]
mod stub;
#[cfg(not(windows))]
pub use self::stub::{cursor_pos, prepare_window, spawn, spawn_meter};
