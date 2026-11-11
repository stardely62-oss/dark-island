//! Players from before Windows had a media panel: Winamp (and its clones
//! that keep the "Winamp v1.x" window) and AIMP, through their own
//! window-message interfaces.

use windows::core::w;
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, WPARAM};
use windows::Win32::System::Memory::{MapViewOfFile, OpenFileMappingW, UnmapViewOfFile, FILE_MAP_READ};
use windows::Win32::UI::WindowsAndMessaging::{FindWindowW, GetWindowTextW, SendMessageTimeoutW, SMTO_ABORTIFHUNG, WM_COMMAND, WM_USER};

use crate::types::{Media, MediaAction};

#[derive(Clone, Copy)]
pub enum Player {
    Winamp(HWND),
    Aimp(HWND),
}

unsafe fn send(hwnd: HWND, msg: u32, w: usize, l: isize) -> Option<usize> {
    let mut out = 0usize;
    let r = SendMessageTimeoutW(hwnd, msg, WPARAM(w), LPARAM(l), SMTO_ABORTIFHUNG, 300, Some(&mut out));
    (r.0 != 0).then_some(out)
}

const AIMP_COMMAND: u32 = WM_USER + 0x75;
const AIMP_PROPERTY: u32 = WM_USER + 0x77;

pub fn find() -> Option<Player> {
    unsafe {
        if let Ok(h) = FindWindowW(w!("AIMP2_RemoteInfo"), None) {
            if !h.is_invalid() {
                return Some(Player::Aimp(h));
            }
        }
        if let Ok(h) = FindWindowW(w!("Winamp v1.x"), None) {
            if !h.is_invalid() {
                return Some(Player::Winamp(h));
            }
        }
    }
    None
}

pub fn act(p: Player, a: MediaAction) {
    unsafe {
        match p {
            Player::Winamp(h) => {
                let id = match a {
                    MediaAction::Prev => 40044,
                    MediaAction::Next => 40048,
                    // Stopped → play; playing or paused → pause toggles.
                    MediaAction::Toggle => {
                        if send(h, WM_USER, 0, 104).unwrap_or(0) == 0 {
                            40045
                        } else {
                            40046
                        }
                    }
                };
                let _ = send(h, WM_COMMAND, id, 0);
            }
            Player::Aimp(h) => {
                let cmd = match a {
                    MediaAction::Toggle => 14,
                    MediaAction::Next => 17,
                    MediaAction::Prev => 18,
                };
                let _ = send(h, AIMP_COMMAND, cmd, 0);
            }
        }
    }
}

pub fn read(p: Player, now_ms: u64) -> Option<Media> {
    unsafe {
        match p {
            Player::Winamp(h) => {
                let state = send(h, WM_USER, 0, 104)?;
                if state == 0 {
                    return None;
                }
                let mut buf = [0u16; 512];
                let n = GetWindowTextW(h, &mut buf) as usize;
                let (artist, title) = winamp_title(&String::from_utf16_lossy(&buf[..n]))?;
                let pos = send(h, WM_USER, 0, 105).unwrap_or(0) as u64;
                let len = send(h, WM_USER, 1, 105).unwrap_or(0) as u64 * 1000;
                Some(Media {
                    title,
                    artist,
                    app: "Winamp".into(),
                    playing: state == 1,
                    cover: None,
                    position_ms: pos,
                    duration_ms: len,
                    updated_at_ms: now_ms,
                })
            }
            Player::Aimp(h) => {
                let state = send(h, AIMP_PROPERTY, 0x40, 0)?;
                if state == 0 {
                    return None;
                }
                let (artist, title) = aimp_info()?;
                let pos = send(h, AIMP_PROPERTY, 0x20, 0).unwrap_or(0) as u64;
                let len = send(h, AIMP_PROPERTY, 0x30, 0).unwrap_or(0) as u64;
                Some(Media {
                    title,
                    artist,
                    app: "AIMP".into(),
                    playing: state == 2,
                    cover: None,
                    position_ms: pos,
                    duration_ms: len,
                    updated_at_ms: now_ms,
                })
            }
        }
    }
}

/// "12. Artist - Title - Winamp [Paused]" → (artist, title).
fn winamp_title(t: &str) -> Option<(String, String)> {
    let mut s = t.trim();
    for tail in [" [Stopped]", " [Paused]"] {
        s = s.strip_suffix(tail).unwrap_or(s);
    }
    s = s.strip_suffix(" - Winamp").unwrap_or(s);
    if let Some((num, rest)) = s.split_once(". ") {
        if num.chars().all(|c| c.is_ascii_digit()) {
            s = rest;
        }
    }
    if s.is_empty() || s == "Winamp" {
        return None;
    }
    Some(match s.split_once(" - ") {
        Some((a, b)) => (a.trim().to_string(), b.trim().to_string()),
        None => (String::new(), s.to_string()),
    })
}

/// The current track from AIMP's shared memory block: a fixed header, then
/// album, artist, date, file name, genre and title as UTF-16.
unsafe fn aimp_info() -> Option<(String, String)> {
    let map = OpenFileMappingW(FILE_MAP_READ.0, false, w!("AIMP2_RemoteInfo")).ok()?;
    let view = MapViewOfFile(map, FILE_MAP_READ, 0, 0, 2048);
    let out = (|| {
        let base = view.Value as *const u8;
        if base.is_null() {
            return None;
        }
        let dword = |off: usize| std::ptr::read_unaligned(base.add(off) as *const u32) as usize;
        let lens: Vec<usize> = (0..6).map(|i| dword(40 + i * 4)).collect();
        if lens.iter().sum::<usize>() * 2 + 88 > 2048 {
            return None;
        }
        let mut off = 88;
        let mut parts = Vec::new();
        for l in lens {
            let s = std::slice::from_raw_parts(base.add(off) as *const u16, l);
            parts.push(String::from_utf16_lossy(&s.iter().map(|c| *c).collect::<Vec<_>>()));
            off += l * 2;
        }
        let (artist, file, title) = (parts[1].clone(), parts[3].clone(), parts[5].clone());
        let title = if title.trim().is_empty() {
            // No tags: the file name without its folder and extension.
            let name = file.rsplit(['\\', '/']).next().unwrap_or(&file);
            name.rsplit_once('.').map(|(b, _)| b).unwrap_or(name).to_string()
        } else {
            title
        };
        (!title.trim().is_empty()).then_some((artist, title))
    })();
    let _ = UnmapViewOfFile(view);
    let _ = CloseHandle(map);
    out
}
