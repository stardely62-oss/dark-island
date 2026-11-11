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
    AttachThreadInput, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
use windows::Win32::Media::Audio::{eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED};
use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
use windows::Win32::System::SystemInformation::GetTickCount;
use windows::core::{w, HSTRING, PCWSTR, PWSTR as PWSTR2};
use windows::Win32::Foundation::SIZE;
use windows::Win32::Graphics::Gdi::{GetObjectW, BITMAP};
use windows::Win32::System::Com::COINIT_APARTMENTTHREADED;
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::UI::Shell::{IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF_BIGGERSIZEOK, SIIGBF_ICONONLY};
use windows::UI::Notifications::Management::{UserNotificationListener, UserNotificationListenerAccessStatus};
use windows::UI::Notifications::{KnownNotificationBindings, NotificationKinds};
use windows::Win32::Foundation::{ERROR_BUFFER_OVERFLOW, HLOCAL, LocalFree};
use windows::Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB};
use windows::Win32::Media::Audio::{eCapture, eCommunications};
use windows::Win32::System::Com::CoTaskMemFree;
use windows::Win32::NetworkManagement::IpHelper::{
    GetAdaptersAddresses, GAA_FLAG_SKIP_ANYCAST, GAA_FLAG_SKIP_DNS_SERVER, GAA_FLAG_SKIP_MULTICAST, IP_ADAPTER_ADDRESSES_LH,
};
use windows::Win32::NetworkManagement::Ndis::IfOperStatusUp;
use windows::Win32::System::Registry::{RegCloseKey, RegEnumKeyExW, RegOpenKeyExW, HKEY, KEY_READ, RRF_RT_REG_QWORD};
use windows::Globalization::Language;
use windows::Graphics::Imaging::{BitmapDecoder, BitmapPixelFormat, SoftwareBitmap};
use windows::Media::Ocr::OcrEngine;
use windows::Storage::Streams::{DataWriter, InMemoryRandomAccessStream};
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits, ReleaseDC, SelectObject,
    BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT, DIB_RGB_COLORS, SRCCOPY,
};
use windows::Win32::UI::WindowsAndMessaging::{SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE, WDA_NONE};
use windows::Devices::Radios::{Radio, RadioAccessStatus, RadioKind, RadioState};
use windows::Win32::Foundation::{FILETIME, LPARAM, WPARAM};
use windows::Win32::Storage::FileSystem::FileTimeToLocalFileTime;
use windows::Win32::System::SystemInformation::GetSystemTimeAsFileTime;
use windows::Win32::System::Registry::{RegGetValueW, RegSetKeyValueW, HKEY_CURRENT_USER, REG_DWORD, RRF_RT_REG_DWORD};
use windows::Win32::System::Power::SetSuspendState;
use windows::Win32::System::Shutdown::LockWorkStation;
use windows::Win32::UI::WindowsAndMessaging::{SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE};
use windows::Win32::System::DataExchange::{GetClipboardOwner, GetClipboardSequenceNumber, IsClipboardFormatAvailable, RegisterClipboardFormatW};
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, GetKeyState, GetKeyboardLayout, GetLastInputInfo, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD,
    KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, LASTINPUTINFO, VIRTUAL_KEY, VK_CAPITAL, VK_CONTROL, VK_LBUTTON,
    VK_MENU, VK_RBUTTON, VK_SHIFT, VK_V,
};
use windows::Win32::UI::Shell::{SHQueryUserNotificationState, QUNS_RUNNING_D3D_FULL_SCREEN};
use windows::Win32::UI::WindowsAndMessaging::{
    GetClassNameW, GetCursorPos, GetForegroundWindow, GetWindowLongPtrW, GetWindowRect, GetWindowThreadProcessId,
    IsIconic, IsWindowVisible, IsZoomed, SetForegroundWindow, SetWindowLongPtrW, GWL_EXSTYLE, GWL_STYLE, WS_CAPTION, WS_EX_NOACTIVATE,
    WS_EX_TOOLWINDOW,
};

use crate::types::{Battery, Cmd, Media, MediaAction, Presence, Volume};
use crate::settings::Settings;
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

pub fn spawn(app: AppHandle, shared: Arc<Shared>, settings: Arc<Settings>) -> Sender<Cmd> {
    let (tx, rx) = channel();
    thread::Builder::new()
        .name("island-sys".into())
        .spawn(move || run(app, shared, settings, rx))
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

fn run(app: AppHandle, shared: Arc<Shared>, settings: Arc<Settings>, rx: Receiver<Cmd>) {
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
    let mut last_keys = keys();
    let mut last_privacy = Instant::now();
    let mut privacy_before = String::new();
    let mut last_vpn = Instant::now() - Duration::from_secs(60);
    let mut vpn_before: Option<String> = None;
    let mut fg_before = String::new();

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

        // Caps Lock and keyboard layout: shown as a short card when they change.
        let k = keys();
        if k != last_keys {
            let what = if k.0 != last_keys.0 { "caps" } else { "layout" };
            // A layout change while switching windows is not news.
            let _ = app.emit_to("island", "keys", KeysEvent { caps: k.0, layout: k.1.clone(), what });
            last_keys = k;
        }

        // Microphone and camera in use, and whether the mic is muted.
        if last_privacy.elapsed() >= Duration::from_millis(1500) {
            last_privacy = Instant::now();
            let mic = in_use("microphone");
            let cam = in_use("webcam");
            let muted = mic_muted().unwrap_or(false);
            let key = format!("{mic:?}{cam:?}{muted}");
            if key != privacy_before {
                privacy_before = key;
                let _ = app.emit_to("island", "privacy", serde_json::json!({ "mic": mic, "cam": cam, "micMuted": muted }));
            }
        }

        if last_vpn.elapsed() >= Duration::from_secs(4) {
            last_vpn = Instant::now();
            let now = vpn_adapter();
            if now != vpn_before {
                vpn_before = now.clone();
                let _ = app.emit_to("island", "vpn", serde_json::json!({ "on": now.is_some(), "name": now }));
                if let (Some(name), true) = (now, settings.bool("vpnCountry", true)) {
                    let app = app.clone();
                    thread::spawn(move || {
                        // Give the tunnel a moment to carry traffic.
                        thread::sleep(Duration::from_secs(2));
                        if let Some((country, ip)) = crate::live::vpn_country() {
                            let _ = app.emit_to("island", "vpn", serde_json::json!({ "on": true, "name": name, "country": country, "ip": ip }));
                        }
                    });
                }
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
            let p = presence(zone, &mut games, &settings);
            let fg = foreground_exe();
            if fg != fg_before && !fg.is_empty() {
                fg_before = fg.clone();
                let _ = app.emit_to("island", "foreground", fg);
            }
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

#[derive(Clone, serde::Serialize)]
struct KeysEvent {
    caps: bool,
    layout: String,
    what: &'static str,
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
fn presence(zone: RECT, games: &mut GameCache, settings: &Settings) -> Presence {
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
            let game = games.is_game(fg, pid, &class);
            return if game && settings.bool("hideInGames", true) { Presence::Hidden } else { Presence::Strip };
        }
        // An ordinary window that reaches under the island (a maximised
        // browser with its tabs and address bar): step aside to a strip.
        let overlaps = r.left < zone.right && r.right > zone.left && r.top < zone.bottom && r.bottom > zone.top;
        if overlaps && settings.bool("stripOverWindows", true) {
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

// ------------------------------------------------------------ clipboard ----

/// Watches the clipboard and records what is copied. Content marked private
/// (password managers set "ExcludeClipboardContentFromMonitorProcessing") is
/// never recorded.
pub fn spawn_clipboard(app: AppHandle, clips: Arc<std::sync::Mutex<crate::clip::Clips>>, settings: Arc<Settings>) {
    thread::Builder::new()
        .name("island-clipboard".into())
        .spawn(move || {
            let private = [
                w!("ExcludeClipboardContentFromMonitorProcessing"),
                w!("Clipboard Viewer Ignore"),
            ]
            .map(|f| unsafe { RegisterClipboardFormatW(f) });
            let mut seq = unsafe { GetClipboardSequenceNumber() };
            loop {
                thread::sleep(Duration::from_millis(300));
                let now = unsafe { GetClipboardSequenceNumber() };
                if now == seq {
                    continue;
                }
                seq = now;
                if !settings.bool("clipboardHistory", true)
                    || private.iter().any(|&f| f != 0 && unsafe { IsClipboardFormatAvailable(f) }.is_ok())
                {
                    continue;
                }
                // Apps the user asked to skip (e.g. a password manager without the private mark).
                let skip = settings.strings("clipSkipApps");
                if !skip.is_empty() {
                    let owner = unsafe { GetClipboardOwner() }.unwrap_or_default();
                    let mut pid = 0u32;
                    unsafe { GetWindowThreadProcessId(owner, Some(&mut pid)) };
                    let exe = process_path(pid).to_lowercase();
                    let name = exe.rsplit('\\').next().unwrap_or("").trim_end_matches(".exe").to_string();
                    if !name.is_empty() && skip.iter().any(|s| s.trim_end_matches(".exe") == name) {
                        continue;
                    }
                }
                // The owner may still be writing: give it a moment.
                thread::sleep(Duration::from_millis(60));
                let Ok(mut cb) = arboard::Clipboard::new() else { continue };
                let changed = if let Ok(text) = cb.get_text() {
                    clips.lock().unwrap().add_text(text)
                } else if let Ok(img) = cb.get_image() {
                    clips.lock().unwrap().add_image(img.width as u32, img.height as u32, &img.bytes)
                } else {
                    false
                };
                if changed {
                    let view = clips.lock().unwrap().view();
                    let _ = app.emit_to("island", "clips", view);
                }
            }
        })
        .expect("spawn clipboard thread");
}

/// Presses Ctrl+V in whatever window has the keyboard focus.
pub fn send_paste() {
    let key = |vk: VIRTUAL_KEY, up: bool| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: 0,
                dwFlags: if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) },
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    // Release modifiers the user may still hold from a hotkey first.
    let inputs = [
        key(VK_MENU, true),
        key(VK_SHIFT, true),
        key(VK_CONTROL, false),
        key(VK_V, false),
        key(VK_V, true),
        key(VK_CONTROL, true),
    ];
    unsafe {
        SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
    }
}

// ---------------------------------------------------------------- focus ----

static PREVIOUS: std::sync::atomic::AtomicIsize = std::sync::atomic::AtomicIsize::new(0);

/// Brings a window to the front even from the background, by briefly
/// attaching to the input of the window that is in front now.
unsafe fn force_foreground(hwnd: HWND) {
    let fg = GetForegroundWindow();
    let fg_thread = GetWindowThreadProcessId(fg, None);
    let me = GetCurrentThreadId();
    let attached = fg_thread != 0 && fg_thread != me && AttachThreadInput(me, fg_thread, true).as_bool();
    let _ = SetForegroundWindow(hwnd);
    if attached {
        let _ = AttachThreadInput(me, fg_thread, false);
    }
}

/// The island takes the keyboard (to type a note); the window that had it is
/// remembered and gets it back in `release_focus`.
pub fn take_focus(win: &WebviewWindow) {
    let Ok(h) = win.hwnd() else { return };
    let hwnd = HWND(h.0 as _);
    unsafe {
        let fg = GetForegroundWindow();
        if fg != hwnd {
            PREVIOUS.store(fg.0 as isize, std::sync::atomic::Ordering::Relaxed);
        }
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex & !(WS_EX_NOACTIVATE.0 as isize));
        force_foreground(hwnd);
    }
    let _ = win.set_focus();
}

pub fn release_focus(win: &WebviewWindow) {
    let Ok(h) = win.hwnd() else { return };
    let hwnd = HWND(h.0 as _);
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex | WS_EX_NOACTIVATE.0 as isize);
        let prev = PREVIOUS.swap(0, std::sync::atomic::Ordering::Relaxed);
        if prev != 0 && GetForegroundWindow() == hwnd {
            force_foreground(HWND(prev as _));
        }
    }
}

// ------------------------------------------------------------- keyboard ----

/// Caps Lock state and the keyboard layout of the window in front.
pub fn keys() -> (bool, String) {
    unsafe {
        let fg = GetForegroundWindow();
        let fg_thread = GetWindowThreadProcessId(fg, None);
        let me = GetCurrentThreadId();
        // Toggle state is per input queue: read it from the one in front.
        let attached = fg_thread != 0 && fg_thread != me && AttachThreadInput(me, fg_thread, true).as_bool();
        let caps = GetKeyState(VK_CAPITAL.0 as i32) & 1 == 1;
        if attached {
            let _ = AttachThreadInput(me, fg_thread, false);
        }
        let hkl = GetKeyboardLayout(fg_thread);
        let lang = (hkl.0 as usize & 0xffff) as u16;
        (caps, layout_name(lang))
    }
}

fn layout_name(langid: u16) -> String {
    let code = match langid & 0x3ff {
        0x19 => "RU",
        0x09 => "EN",
        0x22 => "UK",
        0x23 => "BE",
        0x3f => "KK",
        0x07 => "DE",
        0x0c => "FR",
        0x0a => "ES",
        0x10 => "IT",
        0x15 => "PL",
        0x05 => "CS",
        0x1f => "TR",
        0x16 => "PT",
        0x11 => "JA",
        0x04 => "ZH",
        0x12 => "KO",
        0x37 => "KA",
        0x2b => "HY",
        0x2c => "AZ",
        0x43 => "UZ",
        _ => "",
    };
    if code.is_empty() {
        format!("{:04X}", langid)
    } else {
        code.to_string()
    }
}

pub fn mouse_down() -> bool {
    unsafe { (GetAsyncKeyState(VK_LBUTTON.0 as i32) as u16 & 0x8000) != 0 || (GetAsyncKeyState(VK_RBUTTON.0 as i32) as u16 & 0x8000) != 0 }
}

// ------------------------------------------------------------- controls ----

#[derive(Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Controls {
    pub wifi: Option<bool>,
    pub ssid: Option<String>,
    pub bluetooth: Option<bool>,
    pub dark: bool,
}

fn radios() -> Vec<Radio> {
    let _ = Radio::RequestAccessAsync().and_then(|op| op.join());
    match Radio::GetRadiosAsync().and_then(|op| op.join()) {
        Ok(list) => list.into_iter().collect(),
        Err(_) => Vec::new(),
    }
}

fn radio_state(kind: RadioKind) -> Option<bool> {
    radios()
        .into_iter()
        .find(|r| r.Kind().ok() == Some(kind))
        .and_then(|r| r.State().ok())
        .map(|s| s == RadioState::On)
}

pub fn controls_get() -> Controls {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    let wifi = radio_state(RadioKind::WiFi);
    Controls {
        wifi,
        ssid: if wifi == Some(true) { current_ssid() } else { None },
        bluetooth: radio_state(RadioKind::Bluetooth),
        dark: !read_theme_light(),
    }
}

/// Turns the Wi-Fi or Bluetooth radio on or off.
pub fn radio_set(kind: &str, on: bool) -> bool {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    let kind = match kind {
        "wifi" => RadioKind::WiFi,
        "bluetooth" => RadioKind::Bluetooth,
        _ => return false,
    };
    let state = if on { RadioState::On } else { RadioState::Off };
    radios()
        .into_iter()
        .filter(|r| r.Kind().ok() == Some(kind))
        .map(|r| r.SetStateAsync(state).and_then(|op| op.join()).map(|a| a == RadioAccessStatus::Allowed).unwrap_or(false))
        .fold(false, |a, b| a || b)
}

/// Runs a console program without flashing a window and returns its output.
pub fn quiet_output(program: &str, args: &[&str]) -> Option<String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let out = std::process::Command::new(program).args(args).creation_flags(CREATE_NO_WINDOW).output().ok()?;
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn current_ssid() -> Option<String> {
    let out = quiet_output("netsh", &["wlan", "show", "interfaces"])?;
    out.lines().find_map(|l| {
        let (k, v) = l.split_once(':')?;
        (k.trim() == "SSID").then(|| v.trim().to_string()).filter(|s| !s.is_empty())
    })
}

const PERSONALIZE: PCWSTR = w!("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize");

fn read_theme_light() -> bool {
    let mut data = 1u32;
    let mut size = 4u32;
    unsafe {
        let _ = RegGetValueW(
            HKEY_CURRENT_USER,
            PERSONALIZE,
            w!("AppsUseLightTheme"),
            RRF_RT_REG_DWORD,
            None,
            Some(&mut data as *mut u32 as *mut _),
            Some(&mut size),
        );
    }
    data != 0
}

/// Switches Windows (apps and system) between the dark and the light theme.
pub fn set_dark(dark: bool) {
    let v: u32 = if dark { 0 } else { 1 };
    unsafe {
        for name in [w!("AppsUseLightTheme"), w!("SystemUsesLightTheme")] {
            let _ = RegSetKeyValueW(
                HKEY_CURRENT_USER,
                PERSONALIZE,
                name,
                REG_DWORD.0,
                Some(&v as *const u32 as *const _),
                4,
            );
        }
        let mut res = 0usize;
        let _ = SendMessageTimeoutW(
            HWND_BROADCAST,
            WM_SETTINGCHANGE,
            WPARAM(0),
            LPARAM(w!("ImmersiveColorSet").as_ptr() as isize),
            SMTO_ABORTIFHUNG,
            200,
            Some(&mut res),
        );
    }
}

pub fn power(action: &str) {
    match action {
        "lock" => unsafe {
            let _ = LockWorkStation();
        },
        "sleep" => unsafe {
            let _ = SetSuspendState(false, false, false);
        },
        "restart" => {
            let _ = quiet_output("shutdown", &["/r", "/t", "0"]);
        }
        "shutdown" => {
            let _ = quiet_output("shutdown", &["/s", "/t", "0"]);
        }
        _ => {}
    }
}

// ----------------------------------------------------------------- apps ----

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct App {
    #[serde(rename = "Name")]
    pub name: String,
    #[serde(rename = "AppID")]
    pub id: String,
}

/// Every app of the Start menu, Store apps included (via Get-StartApps).
pub fn start_apps() -> Vec<App> {
    let Some(out) = quiet_output(
        "powershell",
        &["-NoProfile", "-NonInteractive", "-Command", "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-StartApps | ConvertTo-Json -Compress"],
    ) else {
        return Vec::new();
    };
    let out = out.trim_start_matches('\u{feff}');
    serde_json::from_str::<Vec<App>>(out)
        .or_else(|_| serde_json::from_str::<App>(out).map(|a| vec![a]))
        .unwrap_or_default()
        .into_iter()
        .filter(|a| !a.name.is_empty())
        .collect()
}

pub fn launch_app(id: &str) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let _ = std::process::Command::new("explorer.exe")
        .arg(format!("shell:AppsFolder\\{id}"))
        .creation_flags(CREATE_NO_WINDOW)
        .spawn();
}

/// Runs a command line in a new console window that stays open.
pub fn run_shell(cmd: &str, powershell: bool) {
    use std::os::windows::process::CommandExt;
    const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
    let mut c = if powershell {
        let mut c = std::process::Command::new("powershell.exe");
        c.args(["-NoLogo", "-NoExit", "-Command", cmd]);
        c
    } else {
        let mut c = std::process::Command::new("cmd.exe");
        c.raw_arg(format!("/k {cmd}"));
        c
    };
    let _ = c.creation_flags(CREATE_NEW_CONSOLE).spawn();
}

// --------------------------------------------------------------- screen ----

/// A frozen picture of one monitor, in physical pixels.
pub struct Frame {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
    pub rgba: Vec<u8>,
}

/// Captures the monitor under the cursor. Windows marked as excluded from
/// capture (the island, unless the user asked otherwise) are left out.
pub fn capture_monitor() -> Option<Frame> {
    unsafe {
        let mut p = POINT::default();
        GetCursorPos(&mut p).ok()?;
        let mon = MonitorFromPoint(p, MONITOR_DEFAULTTOPRIMARY);
        let mut mi = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        if !GetMonitorInfoW(mon, &mut mi).as_bool() {
            return None;
        }
        let r = mi.rcMonitor;
        let (w, h) = ((r.right - r.left) as i32, (r.bottom - r.top) as i32);
        let screen = GetDC(None);
        let mem = CreateCompatibleDC(Some(screen));
        let bmp = CreateCompatibleBitmap(screen, w, h);
        let old = SelectObject(mem, bmp.into());
        let ok = BitBlt(mem, 0, 0, w, h, Some(screen), r.left, r.top, SRCCOPY | CAPTUREBLT).is_ok();
        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: -h, // top-down
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut px = vec![0u8; (w * h * 4) as usize];
        let lines = GetDIBits(mem, bmp, 0, h as u32, Some(px.as_mut_ptr() as *mut _), &mut info, DIB_RGB_COLORS);
        SelectObject(mem, old);
        let _ = DeleteObject(bmp.into());
        let _ = DeleteDC(mem);
        ReleaseDC(None, screen);
        if !ok || lines == 0 {
            return None;
        }
        for c in px.chunks_exact_mut(4) {
            c.swap(0, 2); // BGRA -> RGBA
            c[3] = 255;
        }
        Some(Frame { x: r.left, y: r.top, w: w as u32, h: h as u32, rgba: px })
    }
}

/// Keeps a window out of screenshots, recordings and screen sharing.
pub fn exclude_from_capture(win: &WebviewWindow, exclude: bool) {
    let Ok(h) = win.hwnd() else { return };
    unsafe {
        let _ = SetWindowDisplayAffinity(HWND(h.0 as _), if exclude { WDA_EXCLUDEFROMCAPTURE } else { WDA_NONE });
    }
}

pub fn bring_to_front(win: &WebviewWindow) {
    let Ok(h) = win.hwnd() else { return };
    unsafe { force_foreground(HWND(h.0 as _)) };
}

fn ocr_with(engine: &OcrEngine, bmp: &SoftwareBitmap) -> Vec<String> {
    engine
        .RecognizeAsync(bmp)
        .and_then(|op| op.join())
        .and_then(|r| r.Lines())
        .map(|lines| lines.into_iter().filter_map(|l| l.Text().ok()).map(|t| t.to_string_lossy()).collect())
        .unwrap_or_default()
}

/// Text from a picture (PNG) with Windows' own recognisers. When both Russian
/// and English are installed, each line is taken from the recogniser whose
/// alphabet dominates it.
pub fn ocr(png: &[u8]) -> Option<String> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    let stream = InMemoryRandomAccessStream::new().ok()?;
    let writer = DataWriter::CreateDataWriter(&stream).ok()?;
    writer.WriteBytes(png).ok()?;
    writer.StoreAsync().ok()?.join().ok()?;
    writer.FlushAsync().ok()?.join().ok()?;
    let _ = writer.DetachStream();
    stream.Seek(0).ok()?;
    let decoder = BitmapDecoder::CreateAsync(&stream).ok()?.join().ok()?;
    let bmp = decoder.GetSoftwareBitmapAsync().ok()?.join().ok()?;
    let bmp = SoftwareBitmap::Convert(&bmp, BitmapPixelFormat::Bgra8).ok()?;

    let lang = |tag: &str| Language::CreateLanguage(&HSTRING::from(tag)).ok().and_then(|l| OcrEngine::TryCreateFromLanguage(&l).ok());
    let ru = lang("ru");
    let en = lang("en-US").or_else(|| lang("en"));
    let lines = match (&ru, &en) {
        (Some(ru), Some(en)) => {
            let a = ocr_with(ru, &bmp);
            let b = ocr_with(en, &bmp);
            if a.len() == b.len() {
                a.into_iter()
                    .zip(b)
                    .map(|(r, e)| {
                        let cyr = r.chars().filter(|c| ('а'..='я').contains(&c.to_lowercase().next().unwrap_or(' ')) || *c == 'ё' || *c == 'Ё').count();
                        let letters = r.chars().filter(|c| c.is_alphabetic()).count().max(1);
                        if cyr * 2 >= letters { r } else { e }
                    })
                    .collect()
            } else if a.iter().map(|l| l.len()).sum::<usize>() >= b.iter().map(|l| l.len()).sum::<usize>() {
                a
            } else {
                b
            }
        }
        _ => {
            let engine = OcrEngine::TryCreateFromUserProfileLanguages().ok()?;
            ocr_with(&engine, &bmp)
        }
    };
    let text = lines.join("\n");
    (!text.trim().is_empty()).then_some(text)
}

/// Local time offset from UTC, in seconds.
pub fn utc_offset_secs() -> i64 {
    unsafe {
        let utc = GetSystemTimeAsFileTime();
        let mut local = FILETIME::default();
        if FileTimeToLocalFileTime(&utc, &mut local).is_err() {
            return 0;
        }
        let v = |f: FILETIME| ((f.dwHighDateTime as i64) << 32) | f.dwLowDateTime as i64;
        (v(local) - v(utc)) / 10_000_000
    }
}

// -------------------------------------------------- microphone, camera ----

unsafe fn reg_subkeys(root: HKEY, path: &str) -> Vec<String> {
    let mut key = HKEY::default();
    if RegOpenKeyExW(root, &HSTRING::from(path), Some(0), KEY_READ, &mut key).is_err() {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut i = 0;
    loop {
        let mut buf = [0u16; 512];
        let mut len = buf.len() as u32;
        if RegEnumKeyExW(key, i, Some(PWSTR2(buf.as_mut_ptr())), &mut len, None, None, None, None).is_err() {
            break;
        }
        out.push(String::from_utf16_lossy(&buf[..len as usize]));
        i += 1;
    }
    let _ = RegCloseKey(key);
    out
}

unsafe fn reg_qword(root: HKEY, path: &str, name: &str) -> Option<u64> {
    let mut v = 0u64;
    let mut size = 8u32;
    RegGetValueW(
        root,
        &HSTRING::from(path),
        &HSTRING::from(name),
        RRF_RT_REG_QWORD,
        None,
        Some(&mut v as *mut u64 as *mut _),
        Some(&mut size),
    )
    .ok()
    .ok()?;
    Some(v)
}

/// Apps using the microphone or the camera right now, from Windows' own
/// privacy records (the same source as the mic icon in the taskbar).
pub fn in_use(device: &str) -> Vec<String> {
    let running = running_exes();
    let base = format!("Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\{device}");
    let mut apps = Vec::new();
    unsafe {
        let mut check = |path: String, name: String| {
            let start = reg_qword(HKEY_CURRENT_USER, &path, "LastUsedTimeStart").unwrap_or(0);
            let stop = reg_qword(HKEY_CURRENT_USER, &path, "LastUsedTimeStop").unwrap_or(1);
            if start != 0 && stop == 0 {
                apps.push(name);
            }
        };
        for k in reg_subkeys(HKEY_CURRENT_USER, &base) {
            if k == "NonPackaged" {
                let np = format!("{base}\\NonPackaged");
                for e in reg_subkeys(HKEY_CURRENT_USER, &np) {
                    // "C:#Program Files#App#app.exe"
                    let name = e.rsplit('#').next().unwrap_or(&e).to_lowercase().trim_end_matches(".exe").to_string();
                    // Windows can leave a stale "in use" record after a crash: trust it
                    // only while that program is actually running.
                    if running.contains(&name) {
                        check(format!("{np}\\{e}"), name);
                    }
                }
            } else {
                let name = k.split('_').next().unwrap_or(&k).rsplit('.').next().unwrap_or(&k).to_string();
                check(format!("{base}\\{k}"), name);
            }
        }
    }
    apps
}

/// The default microphone, and the default one for calls if it is another
/// device (Windows keeps the two separately).
fn capture_endpoints() -> Vec<IAudioEndpointVolume> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let Ok(e) = CoCreateInstance::<_, IMMDeviceEnumerator>(&MMDeviceEnumerator, None, CLSCTX_ALL) else {
            return Vec::new();
        };
        let mut ids: Vec<String> = Vec::new();
        let mut out = Vec::new();
        for role in [eConsole, eCommunications] {
            let Ok(dev) = e.GetDefaultAudioEndpoint(eCapture, role) else { continue };
            let id = dev.GetId().map(|p| {
                let s = p.to_string().unwrap_or_default();
                CoTaskMemFree(Some(p.0 as *const _));
                s
            });
            let id = id.unwrap_or_default();
            if ids.contains(&id) {
                continue;
            }
            ids.push(id);
            if let Ok(v) = dev.Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None) {
                out.push(v);
            }
        }
        out
    }
}

pub fn mic_muted() -> Option<bool> {
    let eps = capture_endpoints();
    unsafe { eps.first()?.GetMute().ok().map(|b| b.as_bool()) }
}

/// Mutes or unmutes the microphone (both defaults); returns the new state.
pub fn mic_toggle() -> Option<bool> {
    let eps = capture_endpoints();
    let first = eps.first()?;
    unsafe {
        let now = !first.GetMute().ok()?.as_bool();
        let mut ok = false;
        for ep in &eps {
            ok |= ep.SetMute(now, std::ptr::null()).is_ok();
        }
        ok.then_some(now)
    }
}

// ------------------------------------------------------------------ vpn ----

const VPN_WORDS: &[&str] = &[
    "wintun", "wireguard", "tap-windows", "openvpn", "vpn", "warp", "cloudflare", "nordlynx", "mullvad", "proton",
    "amnezia", "outline", "hiddify", "v2ray", "sing-box", "happ", "karing", "windscribe", "tunnel", "tun ",
];

/// The name of an active VPN adapter, if any.
pub fn vpn_adapter() -> Option<String> {
    unsafe {
        let mut size = 16 * 1024u32;
        let mut buf = vec![0u8; size as usize];
        let mut rc = GetAdaptersAddresses(0, GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER, None, Some(buf.as_mut_ptr() as *mut _), &mut size);
        if rc == ERROR_BUFFER_OVERFLOW.0 {
            buf = vec![0u8; size as usize];
            rc = GetAdaptersAddresses(0, GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER, None, Some(buf.as_mut_ptr() as *mut _), &mut size);
        }
        if rc != 0 {
            return None;
        }
        let mut p = buf.as_ptr() as *const IP_ADAPTER_ADDRESSES_LH;
        while !p.is_null() {
            let a = &*p;
            if a.OperStatus == IfOperStatusUp {
                let name = a.FriendlyName.to_string().unwrap_or_default();
                let desc = a.Description.to_string().unwrap_or_default();
                let all = format!("{} {} ", name, desc).to_lowercase();
                let ppp = a.IfType == 23; // IF_TYPE_PPP: Windows' own VPN connections
                if ppp || VPN_WORDS.iter().any(|w| all.contains(w)) {
                    return Some(if name.is_empty() { desc } else { name });
                }
            }
            p = a.Next;
        }
        None
    }
}

// -------------------------------------------------------- notifications ----

pub fn notifications_access(ask: bool) -> String {
    let Ok(l) = UserNotificationListener::Current() else { return "unsupported".into() };
    let status = if ask {
        l.RequestAccessAsync().and_then(|op| op.join())
    } else {
        l.GetAccessStatus()
    };
    match status {
        Ok(s) if s == UserNotificationListenerAccessStatus::Allowed => "allowed",
        Ok(s) if s == UserNotificationListenerAccessStatus::Denied => "denied",
        Ok(_) => "unspecified",
        Err(_) => "unsupported",
    }
    .into()
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Toast {
    pub app: String,
    pub aumid: String,
    pub title: String,
    pub body: String,
}

/// Shows other programs' notifications on the island while enabled.
pub fn spawn_notifications(app: AppHandle, settings: Arc<Settings>) {
    thread::spawn(move || {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        let mut seen: std::collections::HashSet<u32> = std::collections::HashSet::new();
        let mut primed = false;
        loop {
            thread::sleep(Duration::from_secs(2));
            if !settings.bool("showNotifications", false) {
                primed = false;
                continue;
            }
            let Ok(l) = UserNotificationListener::Current() else { continue };
            if l.GetAccessStatus().ok() != Some(UserNotificationListenerAccessStatus::Allowed) {
                continue;
            }
            let Ok(list) = l.GetNotificationsAsync(NotificationKinds::Toast).and_then(|op| op.join()) else { continue };
            let muted = settings.strings("notifyMuted");
            for n in list {
                let Ok(id) = n.Id() else { continue };
                if !seen.insert(id) || !primed {
                    continue;
                }
                let info = n.AppInfo().ok();
                let name = info
                    .as_ref()
                    .and_then(|i| i.DisplayInfo().ok())
                    .and_then(|d| d.DisplayName().ok())
                    .map(|h| h.to_string_lossy())
                    .unwrap_or_default();
                if muted.iter().any(|m| name.to_lowercase().contains(m)) {
                    continue;
                }
                let aumid = info.and_then(|i| i.AppUserModelId().ok()).map(|h| h.to_string_lossy()).unwrap_or_default();
                let texts: Vec<String> = n
                    .Notification()
                    .and_then(|t| t.Visual())
                    .and_then(|v| v.GetBinding(&KnownNotificationBindings::ToastGeneric()?))
                    .and_then(|b| b.GetTextElements())
                    .map(|els| els.into_iter().filter_map(|e| e.Text().ok()).map(|h| h.to_string_lossy()).collect())
                    .unwrap_or_default();
                let title = texts.first().cloned().unwrap_or_default();
                let body = texts.iter().skip(1).cloned().collect::<Vec<_>>().join(" ");
                let _ = app.emit_to("island", "notification", Toast { app: name, aumid, title, body });
            }
            primed = true;
        }
    });
}

/// Name of the program in front (without .exe), for "hide for these apps".
pub fn foreground_exe() -> String {
    unsafe {
        let fg = GetForegroundWindow();
        let mut pid = 0u32;
        GetWindowThreadProcessId(fg, Some(&mut pid));
        if pid == std::process::id() {
            return String::new();
        }
        let path = process_path(pid).to_lowercase();
        path.rsplit('\\').next().unwrap_or("").trim_end_matches(".exe").to_string()
    }
}

// ------------------------------------------------------------- secrets ----

/// Encrypts with DPAPI for the current Windows user.
pub fn protect(data: &[u8]) -> Option<Vec<u8>> {
    unsafe {
        let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
        let mut out = CRYPT_INTEGER_BLOB::default();
        CryptProtectData(&input, w!("Dark Island key"), None, None, None, 0, &mut out).ok()?;
        let v = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(out.pbData as *mut _)));
        Some(v)
    }
}

pub fn unprotect(data: &[u8]) -> Option<Vec<u8>> {
    unsafe {
        let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
        let mut out = CRYPT_INTEGER_BLOB::default();
        CryptUnprotectData(&input, None, None, None, None, 0, &mut out).ok()?;
        let v = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(out.pbData as *mut _)));
        Some(v)
    }
}

// ---------------------------------------------------------------- icons ----

/// The icon Windows shows for a program, file or folder, as a PNG data URL.
/// `name` is a path, or "shell:AppsFolder\<AppID>" for an installed app.
pub fn shell_icon(name: &str, size: i32) -> Option<String> {
    let name = name.to_string();
    // The shell's image factory wants a single-threaded apartment.
    thread::spawn(move || unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let f: IShellItemImageFactory = SHCreateItemFromParsingName(&HSTRING::from(name.as_str()), None).ok()?;
        let hbmp = f.GetImage(SIZE { cx: size, cy: size }, SIIGBF_BIGGERSIZEOK | SIIGBF_ICONONLY).ok()?;
        let mut bm = BITMAP::default();
        GetObjectW(hbmp.into(), std::mem::size_of::<BITMAP>() as i32, Some(&mut bm as *mut _ as *mut _));
        let (w, h) = (bm.bmWidth, bm.bmHeight.abs());
        if w <= 0 || h <= 0 {
            let _ = DeleteObject(hbmp.into());
            return None;
        }
        let dc = CreateCompatibleDC(None);
        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: -h,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut px = vec![0u8; (w * h * 4) as usize];
        let lines = GetDIBits(dc, hbmp, 0, h as u32, Some(px.as_mut_ptr() as *mut _), &mut info, DIB_RGB_COLORS);
        let _ = DeleteDC(dc);
        let _ = DeleteObject(hbmp.into());
        if lines == 0 {
            return None;
        }
        // Old-style icons carry no alpha at all: treat them as opaque.
        let any_alpha = px.chunks_exact(4).any(|c| c[3] != 0);
        for c in px.chunks_exact_mut(4) {
            c.swap(0, 2);
            if !any_alpha {
                c[3] = 255;
            } else if c[3] > 0 && c[3] < 255 {
                // premultiplied -> straight
                for i in 0..3 {
                    c[i] = ((c[i] as u32 * 255) / c[3] as u32).min(255) as u8;
                }
            }
        }
        let png = crate::clip::encode_png(w as u32, h as u32, &px)?;
        Some(format!("data:image/png;base64,{}", B64.encode(png)))
    })
    .join()
    .ok()
    .flatten()
}

/// Names (lower case, without .exe) of running programs.
pub fn running_exes() -> std::collections::HashSet<String> {
    let mut out = std::collections::HashSet::new();
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return out };
        let mut e = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        if Process32FirstW(snap, &mut e).is_ok() {
            loop {
                let len = e.szExeFile.iter().position(|&c| c == 0).unwrap_or(e.szExeFile.len());
                let name = String::from_utf16_lossy(&e.szExeFile[..len]).to_lowercase();
                out.insert(name.trim_end_matches(".exe").to_string());
                if Process32NextW(snap, &mut e).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
    }
    out
}
