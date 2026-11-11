//! Windows integration: media sessions (GSMTC), master volume, battery,
//! full-screen detection and window styles.
//!
//! COM/WinRT objects live on one dedicated thread (`island-sys`) that polls
//! the system and executes commands sent from the UI.

use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession as Session,
    GlobalSystemMediaTransportControlsSessionManager as SessionManager,
    GlobalSystemMediaTransportControlsSessionMediaProperties as MediaProperties,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as PlaybackStatus,
};
use windows::Storage::Streams::DataReader;
use windows::core::PWSTR;
use windows::Win32::Foundation::{CloseHandle, HWND, POINT, RECT};
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromPoint, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONULL, MONITOR_DEFAULTTOPRIMARY,
};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
use windows::Win32::Media::Audio::{eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED};
use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
use windows::Win32::System::SystemInformation::GetTickCount;
use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
use windows::Win32::UI::Shell::{SHQueryUserNotificationState, QUNS_RUNNING_D3D_FULL_SCREEN};
use windows::Win32::UI::WindowsAndMessaging::{
    GetClassNameW, GetCursorPos, GetForegroundWindow, GetWindowLongPtrW, GetWindowRect, GetWindowThreadProcessId,
    IsIconic, IsWindowVisible, IsZoomed, SetWindowLongPtrW, GWL_EXSTYLE, GWL_STYLE, WS_CAPTION, WS_EX_NOACTIVATE,
    WS_EX_TOOLWINDOW,
};

use crate::types::{Battery, Cmd, Media, MediaAction, Presence, Volume};
use crate::Shared;

const TICK: Duration = Duration::from_millis(150);
const MEDIA_EVERY: Duration = Duration::from_millis(900);
const BATTERY_EVERY: Duration = Duration::from_secs(30);
const PRESENCE_EVERY: Duration = Duration::from_millis(400);
const AWAY_EVERY: Duration = Duration::from_secs(2);
/// No keyboard or mouse for this long and the companion falls asleep.
const AWAY_AFTER_MS: u32 = 120_000;
/// Half-width and height (logical px) of the screen area the island needs:
/// a window that reaches under it turns the island into a strip.
const ZONE_HALF_W: f64 = 125.0;
const ZONE_H: f64 = 38.0;

pub fn spawn(app: AppHandle, shared: Arc<Shared>) -> Sender<Cmd> {
    let (tx, rx) = channel();
    thread::Builder::new()
        .name("island-sys".into())
        .spawn(move || run(app, shared, rx))
        .expect("spawn system thread");
    tx
}

/// The island must never steal focus from the window the user is typing in,
/// and must not show up in Alt+Tab.
pub fn prepare_window(win: &WebviewWindow) {
    let Ok(h) = win.hwnd() else { return };
    let hwnd = HWND(h.0 as _);
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex | (WS_EX_NOACTIVATE.0 | WS_EX_TOOLWINDOW.0) as isize);
    }
}

pub fn cursor_pos() -> Option<(f64, f64)> {
    let mut p = POINT::default();
    unsafe { GetCursorPos(&mut p).ok()? };
    Some((p.x as f64, p.y as f64))
}

fn run(app: AppHandle, shared: Arc<Shared>, rx: Receiver<Cmd>) {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    let mut media = MediaWatcher::default();
    let mut audio = Audio::default();
    let mut last_media = Instant::now() - MEDIA_EVERY;
    let mut last_battery = Instant::now() - BATTERY_EVERY;
    let mut last_presence = Instant::now();
    let mut games = GameCache::default();
    let mut last_away = Instant::now();
    let mut away = false;

    loop {
        let mut media_dirty = false;
        match rx.recv_timeout(TICK) {
            Ok(cmd) => match cmd {
                Cmd::Media(a) => {
                    media.act(a);
                    media_dirty = true;
                }
                Cmd::VolumeSet(v) => audio.set(v),
                Cmd::VolumeStep(d) => audio.step(d),
                Cmd::MuteToggle => audio.toggle_mute(),
            },
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }

        // Volume: cheap, polled every tick so hardware keys show up instantly.
        let vol = audio.read();
        let changed = {
            let mut s = shared.snap.lock().unwrap();
            let changed = s.volume != vol;
            s.volume = vol;
            changed
        };
        if changed {
            let _ = app.emit_to("island", "volume", vol);
        }

        if media_dirty || last_media.elapsed() >= MEDIA_EVERY {
            if media_dirty {
                // Give the player a moment to apply the command.
                thread::sleep(Duration::from_millis(120));
            }
            last_media = Instant::now();
            let m = media.read();
            let changed = {
                let mut s = shared.snap.lock().unwrap();
                let changed = s.media != m;
                s.media = m.clone();
                changed
            };
            if changed {
                let _ = app.emit_to("island", "media", m);
            }
        }

        if last_battery.elapsed() >= BATTERY_EVERY {
            last_battery = Instant::now();
            let b = battery();
            let changed = {
                let mut s = shared.snap.lock().unwrap();
                let changed = s.battery != b;
                s.battery = b;
                changed
            };
            if changed {
                let _ = app.emit_to("island", "battery", b);
            }
        }

        if last_away.elapsed() >= AWAY_EVERY {
            last_away = Instant::now();
            let now = idle_ms() >= AWAY_AFTER_MS;
            if now != away {
                away = now;
                let _ = app.emit_to("island", "away", away);
            }
        }

        if last_presence.elapsed() >= PRESENCE_EVERY {
            last_presence = Instant::now();
            let g = *shared.geom.lock().unwrap();
            // The area the collapsed island takes on screen (physical px).
            let mid = g.x + crate::WINDOW_W / 2.0 * g.scale;
            let zone = RECT {
                left: (mid - ZONE_HALF_W * g.scale) as i32,
                top: g.y as i32,
                right: (mid + ZONE_HALF_W * g.scale) as i32,
                bottom: (g.y + ZONE_H * g.scale) as i32,
            };
            let p = presence(zone, &mut games);
            let before = std::mem::replace(&mut shared.snap.lock().unwrap().presence, p);
            if p != before {
                if let Some(w) = app.get_webview_window("island") {
                    if p == Presence::Hidden {
                        let _ = w.hide();
                    } else if before == Presence::Hidden {
                        let _ = w.show();
                    }
                }
                let _ = app.emit_to("island", "presence", p);
            }
        }
    }
}

// ---------------------------------------------------------------- media ----

#[derive(Default)]
struct MediaWatcher {
    manager: Option<SessionManager>,
    key: String,
    cover: Option<String>,
    cover_tries: u8,
}

impl MediaWatcher {
    fn session(&mut self) -> Option<Session> {
        if self.manager.is_none() {
            self.manager = SessionManager::RequestAsync().ok()?.join().ok();
        }
        self.manager.as_ref()?.GetCurrentSession().ok()
    }

    fn act(&mut self, action: MediaAction) {
        let Some(s) = self.session() else { return };
        let op = match action {
            MediaAction::Toggle => s.TryTogglePlayPauseAsync(),
            MediaAction::Next => s.TrySkipNextAsync(),
            MediaAction::Prev => s.TrySkipPreviousAsync(),
        };
        if let Ok(op) = op {
            let _ = op.join();
        }
    }

    fn read(&mut self) -> Option<Media> {
        let s = self.session()?;
        let props = s.TryGetMediaPropertiesAsync().ok()?.join().ok()?;
        let title = props.Title().ok()?.to_string_lossy();
        if title.trim().is_empty() {
            return None;
        }
        let artist = props.Artist().map(|h| h.to_string_lossy()).unwrap_or_default();
        let app = s.SourceAppUserModelId().map(|h| h.to_string_lossy()).unwrap_or_default();
        let playing = s
            .GetPlaybackInfo()
            .and_then(|p| p.PlaybackStatus())
            .map(|st| st == PlaybackStatus::Playing)
            .unwrap_or(false);

        let (mut position_ms, mut duration_ms, mut updated_at_ms) = (0, 0, now_ms());
        if let Ok(tl) = s.GetTimelineProperties() {
            let ms = |d: windows::Foundation::TimeSpan| (d.Duration.max(0) / 10_000) as u64;
            let start = tl.StartTime().map(ms).unwrap_or(0);
            let end = tl.EndTime().map(ms).unwrap_or(0);
            position_ms = tl.Position().map(ms).unwrap_or(0).saturating_sub(start);
            duration_ms = end.saturating_sub(start);
            if let Ok(t) = tl.LastUpdatedTime() {
                // DateTime counts 100 ns ticks since 1601-01-01.
                let unix = (t.UniversalTime - 116_444_736_000_000_000) / 10_000;
                if unix > 0 {
                    updated_at_ms = unix as u64;
                }
            }
        }

        let key = format!("{app}\u{1}{title}\u{1}{artist}");
        if key != self.key {
            self.key = key;
            self.cover = None;
            self.cover_tries = 0;
        }
        // Browsers often publish the artwork a moment after the title.
        if self.cover.is_none() && self.cover_tries < 6 {
            self.cover_tries += 1;
            self.cover = thumbnail(&props);
        }

        Some(Media {
            title,
            artist,
            app,
            playing,
            cover: self.cover.clone(),
            position_ms,
            duration_ms,
            updated_at_ms,
        })
    }
}

fn thumbnail(props: &MediaProperties) -> Option<String> {
    let stream = props.Thumbnail().ok()?.OpenReadAsync().ok()?.join().ok()?;
    let size = stream.Size().ok()?;
    if size == 0 || size > 8 * 1024 * 1024 {
        return None;
    }
    let content_type = stream.ContentType().map(|h| h.to_string_lossy()).unwrap_or_default();
    let reader = DataReader::CreateDataReader(&stream).ok()?;
    reader.LoadAsync(size as u32).ok()?.join().ok()?;
    let mut buf = vec![0u8; size as usize];
    reader.ReadBytes(&mut buf).ok()?;
    let mime = if content_type.starts_with("image/") { content_type } else { sniff(&buf).to_string() };
    Some(format!("data:{mime};base64,{}", B64.encode(&buf)))
}

fn sniff(b: &[u8]) -> &'static str {
    match b {
        [0x89, b'P', b'N', b'G', ..] => "image/png",
        [b'G', b'I', b'F', ..] => "image/gif",
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => "image/webp",
        [b'B', b'M', ..] => "image/bmp",
        _ => "image/jpeg",
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

// ---------------------------------------------------------------- audio ----

#[derive(Default)]
struct Audio {
    endpoint: Option<IAudioEndpointVolume>,
    fetched: Option<Instant>,
}

impl Audio {
    /// The default output device can change (headphones plugged in), so the
    /// endpoint is looked up again every couple of seconds.
    fn endpoint(&mut self) -> Option<&IAudioEndpointVolume> {
        let stale = self.fetched.map_or(true, |t| t.elapsed() > Duration::from_secs(2));
        if self.endpoint.is_none() || stale {
            self.fetched = Some(Instant::now());
            self.endpoint = unsafe {
                CoCreateInstance::<_, IMMDeviceEnumerator>(&MMDeviceEnumerator, None, CLSCTX_ALL)
                    .and_then(|e| e.GetDefaultAudioEndpoint(eRender, eConsole))
                    .and_then(|d| d.Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None))
                    .ok()
            };
        }
        self.endpoint.as_ref()
    }

    fn read(&mut self) -> Option<Volume> {
        let ep = self.endpoint()?;
        unsafe {
            Some(Volume {
                level: ep.GetMasterVolumeLevelScalar().ok()?,
                muted: ep.GetMute().ok()?.as_bool(),
            })
        }
    }

    fn set(&mut self, level: f32) {
        let Some(ep) = self.endpoint() else { return };
        let level = level.clamp(0.0, 1.0);
        unsafe {
            let _ = ep.SetMasterVolumeLevelScalar(level, std::ptr::null());
            if level > 0.0 {
                let _ = ep.SetMute(false, std::ptr::null());
            }
        }
    }

    fn step(&mut self, delta: f32) {
        if let Some(v) = self.read() {
            self.set(v.level + delta);
        }
    }

    fn toggle_mute(&mut self) {
        let Some(ep) = self.endpoint() else { return };
        unsafe {
            if let Ok(m) = ep.GetMute() {
                let _ = ep.SetMute(!m.as_bool(), std::ptr::null());
            }
        }
    }
}

// ------------------------------------------------------ battery, screen ----

fn battery() -> Option<Battery> {
    let mut s = SYSTEM_POWER_STATUS::default();
    unsafe { GetSystemPowerStatus(&mut s).ok()? };
    // 128 = no system battery, 255 = unknown status.
    if s.BatteryFlag & 128 != 0 || s.BatteryFlag == 255 || s.BatteryLifePercent > 100 {
        return None;
    }
    Some(Battery { percent: s.BatteryLifePercent, charging: s.ACLineStatus == 1 })
}

/// What the island should do about the window in front, on the island's monitor.
fn presence(zone: RECT, games: &mut GameCache) -> Presence {
    let island = POINT { x: (zone.left + zone.right) / 2, y: zone.top + 4 };
    unsafe {
        let fg = GetForegroundWindow();
        if fg.is_invalid() || !IsWindowVisible(fg).as_bool() || IsIconic(fg).as_bool() {
            return Presence::Normal;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(fg, Some(&mut pid));
        if pid == std::process::id() {
            return Presence::Normal;
        }
        let class = class_name(fg);
        // The desktop and the taskbar are never "full-screen apps".
        if matches!(class.as_str(), "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd") {
            return Presence::Normal;
        }
        let monitor = MonitorFromPoint(island, MONITOR_DEFAULTTOPRIMARY);
        if MonitorFromWindow(fg, MONITOR_DEFAULTTONULL) != monitor {
            return Presence::Normal;
        }
        let mut mi = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        let mut r = RECT::default();
        if !GetMonitorInfoW(monitor, &mut mi).as_bool() || GetWindowRect(fg, &mut r).is_err() {
            return Presence::Normal;
        }
        let m = mi.rcMonitor;
        let covers = r.left <= m.left && r.top <= m.top && r.right >= m.right && r.bottom >= m.bottom;
        // A maximised window with a title bar can cover the screen too
        // (auto-hiding taskbar); that is an ordinary window, not full-screen.
        let titled = GetWindowLongPtrW(fg, GWL_STYLE) as u32 & WS_CAPTION.0 == WS_CAPTION.0;
        if covers && !(IsZoomed(fg).as_bool() && titled) {
            // Full-screen: games lose the island entirely, the rest get a strip.
            return if games.is_game(fg, pid, &class) { Presence::Hidden } else { Presence::Strip };
        }
        // An ordinary window that reaches under the island (a maximised
        // browser with its tabs and address bar): step aside to a strip.
        let overlaps = r.left < zone.right && r.right > zone.left && r.top < zone.bottom && r.bottom > zone.top;
        if overlaps {
            Presence::Strip
        } else {
            Presence::Normal
        }
    }
}

/// Milliseconds since the last keyboard or mouse input anywhere.
fn idle_ms() -> u32 {
    let mut li = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
    unsafe {
        if !GetLastInputInfo(&mut li).as_bool() {
            return 0;
        }
        GetTickCount().wrapping_sub(li.dwTime)
    }
}

unsafe fn class_name(hwnd: HWND) -> String {
    let mut buf = [0u16; 256];
    let n = GetClassNameW(hwnd, &mut buf);
    String::from_utf16_lossy(&buf[..n.max(0) as usize])
}

/// Window classes of common game engines.
const GAME_CLASSES: &[&str] = &[
    "UnityWndClass",
    "UnrealWindow",
    "LaunchUnrealUWindowsClient",
    "SDL_app",
    "GLFW30",
    "Valve001",
    "CryENGINE",
    "RiotWindowClass",
    "OgreD3D11Wnd",
    "Engine",
];

/// Folders where launchers install games.
const GAME_DIRS: &[&str] = &[
    "\\steamapps\\",
    "\\epic games\\",
    "\\riot games\\",
    "\\gog galaxy\\games\\",
    "\\gog games\\",
    "\\ubisoft game launcher\\games\\",
    "\\ea games\\",
    "\\origin games\\",
    "\\xboxgames\\",
    "\\battle.net\\",
    "\\games\\",
];

/// Remembers the verdict for the last window, so the process path is not
/// looked up several times a second.
#[derive(Default)]
struct GameCache {
    hwnd: isize,
    game: bool,
}

impl GameCache {
    fn is_game(&mut self, hwnd: HWND, pid: u32, class: &str) -> bool {
        // Exclusive full-screen Direct3D is a game for sure, whatever the window.
        if unsafe { SHQueryUserNotificationState() }.is_ok_and(|s| s == QUNS_RUNNING_D3D_FULL_SCREEN) {
            return true;
        }
        if hwnd.0 as isize == self.hwnd {
            return self.game;
        }
        let path = process_path(pid).to_lowercase();
        self.hwnd = hwnd.0 as isize;
        self.game = GAME_CLASSES.contains(&class) || GAME_DIRS.iter().any(|d| path.contains(d));
        self.game
    }
}

fn process_path(pid: u32) -> String {
    unsafe {
        let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return String::new();
        };
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
        let _ = CloseHandle(h);
        if ok {
            String::from_utf16_lossy(&buf[..len as usize])
        } else {
            String::new()
        }
    }
}
