//! Listens to what the computer plays (WASAPI loopback on the default output)
//! and reports the loudness of a few frequency bands ~30 times a second.
//!
//! The numbers are deliberately coarse: they drive a calm animation, not a
//! spectrum analyser. Smoothing happens on the UI side, per frame.

use std::f32::consts::PI;
use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter};
use windows::Win32::Media::Audio::{
    eConsole, eRender, IAudioCaptureClient, IAudioClient, IMMDevice, IMMDeviceEnumerator, MMDeviceEnumerator,
    AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, WAVEFORMATEX,
};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_MULTITHREADED};

pub const BANDS: usize = 6;
/// Band edges in Hz: sub-bass, bass, low-mid, mid, presence, air.
const EDGES: [f32; BANDS + 1] = [35.0, 110.0, 280.0, 750.0, 2000.0, 5000.0, 12000.0];
const FFT: usize = 1024;
const EMIT_EVERY: Duration = Duration::from_millis(33);
const SILENCE_AFTER: Duration = Duration::from_millis(600);

pub fn spawn(app: AppHandle) {
    thread::Builder::new()
        .name("island-meter".into())
        .spawn(move || {
            unsafe {
                let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            }
            let mut analyser = Analyser::new();
            loop {
                // Runs until the device disappears or changes, then starts over.
                let _ = capture(&app, &mut analyser);
                analyser.reset();
                let _ = app.emit_to("island", "audio", [0.0f32; BANDS]);
                thread::sleep(Duration::from_secs(1));
            }
        })
        .expect("spawn meter thread");
}

struct Format {
    rate: f32,
    channels: usize,
    float: bool,
    bits: u16,
}

unsafe fn default_device() -> windows::core::Result<(IMMDevice, String)> {
    let e: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
    let dev = e.GetDefaultAudioEndpoint(eRender, eConsole)?;
    let id = device_id(&dev);
    Ok((dev, id))
}

unsafe fn device_id(dev: &IMMDevice) -> String {
    match dev.GetId() {
        Ok(p) => {
            let s = p.to_string().unwrap_or_default();
            CoTaskMemFree(Some(p.0 as *const _));
            s
        }
        Err(_) => String::new(),
    }
}

fn capture(app: &AppHandle, an: &mut Analyser) -> windows::core::Result<()> {
    unsafe {
        let (dev, id) = default_device()?;
        let client: IAudioClient = dev.Activate(CLSCTX_ALL, None)?;
        let wf = client.GetMixFormat()?;
        let raw: WAVEFORMATEX = std::ptr::read_unaligned(wf);
        let fmt = Format {
            rate: raw.nSamplesPerSec as f32,
            channels: raw.nChannels.max(1) as usize,
            // 3 = IEEE float; 0xFFFE = extensible, which for the mix format is float at 32 bits.
            float: raw.wFormatTag == 3 || (raw.wFormatTag == 0xFFFE && raw.wBitsPerSample == 32),
            bits: raw.wBitsPerSample,
        };
        let init = client.Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, 2_000_000, 0, wf, None);
        CoTaskMemFree(Some(wf as *const _));
        init?;
        if !fmt.float && fmt.bits != 16 {
            return Ok(()); // unusual format: stay quiet rather than guess
        }
        an.set_rate(fmt.rate);

        let cap: IAudioCaptureClient = client.GetService()?;
        client.Start()?;

        let mut last_emit = Instant::now();
        let mut last_sound = Instant::now() - SILENCE_AFTER;
        let mut quiet_sent = true;
        let mut last_check = Instant::now();
        // When packets stop coming (nothing plays, or Windows paused the
        // stream), the last sound must not be analysed over and over: that
        // froze the bars at one height while the music went on.
        let mut last_packet = Instant::now();
        let mut fed_silence = 0usize;

        loop {
            thread::sleep(Duration::from_millis(10));

            let mut got = false;
            loop {
                let n = cap.GetNextPacketSize()?;
                if n == 0 {
                    break;
                }
                let mut data: *mut u8 = std::ptr::null_mut();
                let mut frames = 0u32;
                let mut flags = 0u32;
                cap.GetBuffer(&mut data, &mut frames, &mut flags, None, None)?;
                let silent = flags & (AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0;
                let frames_n = frames as usize;
                for f in 0..frames_n {
                    let mut s = 0.0f32;
                    if !silent && !data.is_null() {
                        for c in 0..fmt.channels {
                            let i = f * fmt.channels + c;
                            s += if fmt.float {
                                std::ptr::read_unaligned((data as *const f32).add(i))
                            } else {
                                std::ptr::read_unaligned((data as *const i16).add(i)) as f32 / 32768.0
                            };
                        }
                        s /= fmt.channels as f32;
                    }
                    an.push(s);
                }
                cap.ReleaseBuffer(frames)?;
                got = true;
            }
            if got {
                last_packet = Instant::now();
                fed_silence = 0;
            } else if last_packet.elapsed() > Duration::from_millis(120) && fed_silence < FFT {
                // Silence in real time, until the window holds nothing old.
                let n = ((fmt.rate * 0.01) as usize).max(1);
                for _ in 0..n {
                    an.push(0.0);
                }
                fed_silence += n;
            }
            // A stream that has said nothing for a long while may be stuck
            // (another app took the device): open it again.
            if last_packet.elapsed() > Duration::from_secs(8) {
                let _ = client.Stop();
                return Ok(());
            }

            if last_emit.elapsed() >= EMIT_EVERY {
                last_emit = Instant::now();
                let bands = an.bands();
                if an.loud() {
                    last_sound = Instant::now();
                }
                if last_sound.elapsed() < SILENCE_AFTER {
                    let _ = app.emit_to("island", "audio", bands);
                    quiet_sent = false;
                } else if !quiet_sent {
                    let _ = app.emit_to("island", "audio", [0.0f32; BANDS]);
                    quiet_sent = true;
                }
            }

            // Headphones plugged in, another output picked: follow the default device.
            if last_check.elapsed() > Duration::from_secs(2) {
                last_check = Instant::now();
                if default_device().map(|(_, now)| now != id).unwrap_or(true) {
                    let _ = client.Stop();
                    return Ok(());
                }
            }
        }
    }
}

struct Analyser {
    ring: Vec<f32>,
    pos: usize,
    window: Vec<f32>,
    rate: f32,
    re: Vec<f32>,
    im: Vec<f32>,
    /// Slowly decaying loudest level seen, for automatic gain.
    peak_db: f32,
    rms: f32,
}

impl Analyser {
    fn new() -> Self {
        let window = (0..FFT).map(|i| 0.5 - 0.5 * (2.0 * PI * i as f32 / (FFT - 1) as f32).cos()).collect();
        Self {
            ring: vec![0.0; FFT],
            pos: 0,
            window,
            rate: 48_000.0,
            re: vec![0.0; FFT],
            im: vec![0.0; FFT],
            peak_db: -60.0,
            rms: 0.0,
        }
    }

    fn reset(&mut self) {
        self.ring.iter_mut().for_each(|s| *s = 0.0);
        self.peak_db = -60.0;
    }

    fn set_rate(&mut self, rate: f32) {
        self.rate = rate;
    }

    fn push(&mut self, s: f32) {
        self.ring[self.pos] = s;
        self.pos = (self.pos + 1) % FFT;
    }

    fn loud(&self) -> bool {
        self.rms > 0.0015
    }

    /// Band levels in 0..1, already scaled by automatic gain.
    fn bands(&mut self) -> [f32; BANDS] {
        let mut sq = 0.0;
        for i in 0..FFT {
            let s = self.ring[(self.pos + i) % FFT];
            sq += s * s;
            self.re[i] = s * self.window[i];
            self.im[i] = 0.0;
        }
        self.rms = (sq / FFT as f32).sqrt();
        fft(&mut self.re, &mut self.im);

        let hz_per_bin = self.rate / FFT as f32;
        let mut db = [0.0f32; BANDS];
        for b in 0..BANDS {
            let lo = ((EDGES[b] / hz_per_bin) as usize).max(1);
            let hi = ((EDGES[b + 1] / hz_per_bin) as usize).clamp(lo + 1, FFT / 2);
            let mut e = 0.0;
            for k in lo..hi {
                e += self.re[k] * self.re[k] + self.im[k] * self.im[k];
            }
            let mag = (e / (hi - lo) as f32).sqrt() / FFT as f32;
            // Treble is naturally quieter: tilt it up a little.
            db[b] = 20.0 * (mag + 1e-9).log10() + b as f32 * 2.5;
        }

        let loudest = db.iter().cloned().fold(-120.0, f32::max);
        // Fast to rise, ~0.6 dB/s to fall: quiet songs still move, loud ones don't clip.
        self.peak_db = if loudest > self.peak_db { loudest } else { (self.peak_db - 0.02).max(-60.0) };
        let floor = self.peak_db - 32.0;
        let mut out = [0.0f32; BANDS];
        for b in 0..BANDS {
            out[b] = ((db[b] - floor) / 32.0).clamp(0.0, 1.0);
        }
        out
    }
}

/// In-place iterative radix-2 FFT.
fn fft(re: &mut [f32], im: &mut [f32]) {
    let n = re.len();
    let mut j = 0;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j |= bit;
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }
    let mut len = 2;
    while len <= n {
        let ang = -2.0 * PI / len as f32;
        let (wr, wi) = (ang.cos(), ang.sin());
        for start in (0..n).step_by(len) {
            let (mut cr, mut ci) = (1.0f32, 0.0f32);
            for k in 0..len / 2 {
                let a = start + k;
                let b = a + len / 2;
                let tr = re[b] * cr - im[b] * ci;
                let ti = re[b] * ci + im[b] * cr;
                re[b] = re[a] - tr;
                im[b] = im[a] - ti;
                re[a] += tr;
                im[a] += ti;
                let nr = cr * wr - ci * wi;
                ci = cr * wi + ci * wr;
                cr = nr;
            }
        }
        len <<= 1;
    }
}
