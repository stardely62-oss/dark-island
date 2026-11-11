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
use windows::Win32::Foundation::{HWND, POINT};
use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
use windows::Win32::Media::Audio::{eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED};
use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
use windows::Win32::UI::Shell::{
    SHQueryUserNotificationState, QUNS_BUSY, QUNS_PRESENTATION_MODE, QUNS_RUNNING_D3D_FULL_SCREEN,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetCursorPos, GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
};

use crate::types::{Battery, Cmd, Media, MediaAction, Volume};
use crate::Shared;

const TICK: Duration = Duration::from_millis(150);
const MEDIA_EVERY: Duration = Duration::from_millis(900);
const BATTERY_EVERY: Duration = Duration::from_secs(30);
const FULLSCREEN_EVERY: Duration = Duration::from_millis(700);

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
    let mut last_fullscreen = Instant::now();
    let mut hidden = false;

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

        if last_fullscreen.elapsed() >= FULLSCREEN_EVERY {
            last_fullscreen = Instant::now();
            let busy = fullscreen_app_in_front();
            if busy != hidden {
                hidden = busy;
                if let Some(w) = app.get_webview_window("island") {
                    let _ = if busy { w.hide() } else { w.show() };
                }
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

/// True while a game, a full-screen video or a presentation is in front.
fn fullscreen_app_in_front() -> bool {
    match unsafe { SHQueryUserNotificationState() } {
        Ok(state) => state == QUNS_BUSY || state == QUNS_RUNNING_D3D_FULL_SCREEN || state == QUNS_PRESENTATION_MODE,
        Err(_) => false,
    }
}
