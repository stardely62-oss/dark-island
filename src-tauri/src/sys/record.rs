//! Recording on Windows: the microphone for dictation (WASAPI, 16 kHz mono)
//! and the screen to MP4 (GDI capture + Media Foundation H.264).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use windows::core::HSTRING;
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits, ReleaseDC, SelectObject,
    BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT, DIB_RGB_COLORS, SRCCOPY,
};
use windows::Win32::Media::Audio::{
    eCapture, eConsole, IAudioCaptureClient, IAudioClient, IMMDeviceEnumerator, MMDeviceEnumerator, AUDCLNT_SHAREMODE_SHARED,
    WAVEFORMATEX,
};
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_MULTITHREADED};
use windows::Win32::UI::WindowsAndMessaging::{DrawIconEx, GetCursorInfo, CURSORINFO, CURSOR_SHOWING, DI_NORMAL};

// ------------------------------------------------------------- dictation ----

/// Records the default microphone until `stop` is set. `level` gets the
/// loudness (0..1) about ten times a second. Returns 16 kHz mono samples.
pub fn record_mic(stop: Arc<AtomicBool>, level: impl Fn(f32)) -> Result<Vec<i16>, String> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let e: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(|e| e.to_string())?;
        let chosen = super::windows::AUDIO_PREFS.lock().unwrap().1.clone();
        let dev = match super::devices::device(eCapture, &chosen) {
            Some(d) => d,
            None => e.GetDefaultAudioEndpoint(eCapture, eConsole).map_err(|_| "Нет микрофона".to_string())?,
        };
        let client: IAudioClient = dev.Activate(CLSCTX_ALL, None).map_err(|e| e.to_string())?;
        let wf = client.GetMixFormat().map_err(|e| e.to_string())?;
        let raw: WAVEFORMATEX = std::ptr::read_unaligned(wf);
        let rate = raw.nSamplesPerSec as f32;
        let ch = raw.nChannels.max(1) as usize;
        let float = raw.wFormatTag == 3 || (raw.wFormatTag == 0xFFFE && raw.wBitsPerSample == 32);
        let init = client.Initialize(AUDCLNT_SHAREMODE_SHARED, 0, 2_000_000, 0, wf, None);
        CoTaskMemFree(Some(wf as *const _));
        init.map_err(|e| e.to_string())?;
        let cap: IAudioCaptureClient = client.GetService().map_err(|e| e.to_string())?;
        client.Start().map_err(|e| e.to_string())?;

        let step = rate / 16_000.0;
        let mut out: Vec<i16> = Vec::new();
        let mut acc = 0.0f32;
        let mut acc_n = 0.0f32;
        let mut pos = 0.0f32;
        let mut peak = 0.0f32;
        let mut last_level = Instant::now();
        let started = Instant::now();
        while !stop.load(Ordering::Relaxed) && started.elapsed() < Duration::from_secs(600) {
            thread::sleep(Duration::from_millis(15));
            loop {
                let n = cap.GetNextPacketSize().map_err(|e| e.to_string())?;
                if n == 0 {
                    break;
                }
                let mut data: *mut u8 = std::ptr::null_mut();
                let mut frames = 0u32;
                let mut flags = 0u32;
                cap.GetBuffer(&mut data, &mut frames, &mut flags, None, None).map_err(|e| e.to_string())?;
                for f in 0..frames as usize {
                    let mut s = 0.0f32;
                    if !data.is_null() && flags & 2 == 0 {
                        for c in 0..ch {
                            let i = f * ch + c;
                            s += if float {
                                std::ptr::read_unaligned((data as *const f32).add(i))
                            } else {
                                std::ptr::read_unaligned((data as *const i16).add(i)) as f32 / 32768.0
                            };
                        }
                        s /= ch as f32;
                    }
                    peak = peak.max(s.abs());
                    // Box-filter down to 16 kHz.
                    acc += s;
                    acc_n += 1.0;
                    pos += 1.0;
                    if pos >= step {
                        pos -= step;
                        let v = (acc / acc_n).clamp(-1.0, 1.0);
                        out.push((v * 32767.0) as i16);
                        acc = 0.0;
                        acc_n = 0.0;
                    }
                }
                cap.ReleaseBuffer(frames).map_err(|e| e.to_string())?;
            }
            if last_level.elapsed() > Duration::from_millis(90) {
                level((peak * 3.0).min(1.0));
                peak = 0.0;
                last_level = Instant::now();
            }
        }
        let _ = client.Stop();
        Ok(out)
    }
}

// ----------------------------------------------------------- screen video ----

pub struct Area {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

/// Sound for a recording.
#[derive(Clone, Copy, PartialEq)]
pub enum Sound {
    None,
    /// What the computer plays (loopback of the default output).
    System,
    Mic,
}

/// 16-bit stereo chunks from the computer's sound or the microphone, at the
/// device's rate, kept in step with the clock: silence fills the gaps when
/// nothing plays (a loopback device sends nothing then).
fn capture_sound(sound: Sound, stop: Arc<AtomicBool>, tx: std::sync::mpsc::Sender<Vec<i16>>) -> Result<u32, String> {
    // COM objects stay on the thread that made them: all of it runs there,
    // and only the sample rate comes back.
    let (rtx, rrx) = std::sync::mpsc::channel::<Result<u32, String>>();
    thread::spawn(move || unsafe {
        let setup = (|| -> Result<(IAudioClient, IAudioCaptureClient, u32, usize, bool), String> {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let e: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(|e| e.to_string())?;
            let dev = if sound == Sound::Mic {
                let chosen = super::windows::AUDIO_PREFS.lock().unwrap().1.clone();
                match super::devices::device(eCapture, &chosen) {
                    Some(d) => d,
                    None => e.GetDefaultAudioEndpoint(eCapture, eConsole).map_err(|e| e.to_string())?,
                }
            } else {
                e.GetDefaultAudioEndpoint(windows::Win32::Media::Audio::eRender, eConsole).map_err(|e| e.to_string())?
            };
            let client: IAudioClient = dev.Activate(CLSCTX_ALL, None).map_err(|e| e.to_string())?;
            let wf = client.GetMixFormat().map_err(|e| e.to_string())?;
            let raw: WAVEFORMATEX = std::ptr::read_unaligned(wf);
            let rate = raw.nSamplesPerSec;
            let ch = raw.nChannels.max(1) as usize;
            let float = raw.wFormatTag == 3 || (raw.wFormatTag == 0xFFFE && raw.wBitsPerSample == 32);
            let flags = if sound == Sound::System { windows::Win32::Media::Audio::AUDCLNT_STREAMFLAGS_LOOPBACK } else { 0 };
            let init = client.Initialize(AUDCLNT_SHAREMODE_SHARED, flags, 2_000_000, 0, wf, None);
            CoTaskMemFree(Some(wf as *const _));
            init.map_err(|e| e.to_string())?;
            if !float && raw.wBitsPerSample != 16 {
                return Err("Необычный формат звука".into());
            }
            let cap: IAudioCaptureClient = client.GetService().map_err(|e| e.to_string())?;
            client.Start().map_err(|e| e.to_string())?;
            Ok((client, cap, rate, ch, float))
        })();
        let (client, cap, rate, ch, float) = match setup {
            Ok(v) => v,
            Err(e) => {
                let _ = rtx.send(Err(e));
                return;
            }
        };
        let _ = rtx.send(Ok(rate));
        let started = Instant::now();
        let mut produced: u64 = 0;
        while !stop.load(Ordering::Relaxed) {
            thread::sleep(Duration::from_millis(10));
            let mut chunk: Vec<i16> = Vec::new();
            loop {
                let Ok(n) = cap.GetNextPacketSize() else { break };
                if n == 0 {
                    break;
                }
                let mut data: *mut u8 = std::ptr::null_mut();
                let mut frames = 0u32;
                let mut fl = 0u32;
                if cap.GetBuffer(&mut data, &mut frames, &mut fl, None, None).is_err() {
                    break;
                }
                for f in 0..frames as usize {
                    let sample = |c: usize| -> f32 {
                        if data.is_null() || fl & 2 != 0 {
                            return 0.0;
                        }
                        let i = f * ch + c.min(ch - 1);
                        if float {
                            std::ptr::read_unaligned((data as *const f32).add(i))
                        } else {
                            std::ptr::read_unaligned((data as *const i16).add(i)) as f32 / 32768.0
                        }
                    };
                    let (l, r) = (sample(0), sample(1));
                    chunk.push((l.clamp(-1.0, 1.0) * 32767.0) as i16);
                    chunk.push((r.clamp(-1.0, 1.0) * 32767.0) as i16);
                }
                let _ = cap.ReleaseBuffer(frames);
            }
            produced += (chunk.len() / 2) as u64;
            // Silence for the time nothing came, so sound stays in step with the video.
            let expected = (started.elapsed().as_secs_f64() * rate as f64) as u64;
            if expected > produced + rate as u64 / 20 {
                let missing = (expected - produced) as usize;
                chunk.extend(std::iter::repeat(0i16).take(missing * 2));
                produced = expected;
            }
            if !chunk.is_empty() && tx.send(chunk).is_err() {
                break;
            }
        }
        let _ = client.Stop();
    });
    rrx.recv().map_err(|e| e.to_string())?
}

/// Records `area` of the screen to an MP4 file until `stop` is set.
pub fn record_screen(path: &str, area: Area, fps: u32, high: bool, sound: Sound, stop: Arc<AtomicBool>) -> Result<(), String> {
    // H.264 wants even sizes.
    let w = (area.w & !1).max(2);
    let h = (area.h & !1).max(2);
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        MFStartup(MF_VERSION, MFSTARTUP_FULL).map_err(|e| e.to_string())?;
        let result = (|| -> windows::core::Result<()> {
            let mut attrs: Option<IMFAttributes> = None;
            MFCreateAttributes(&mut attrs, 1)?;
            let attrs = attrs.unwrap();
            attrs.SetUINT32(&MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, 1)?;
            let writer = MFCreateSinkWriterFromURL(&HSTRING::from(path), None, &attrs)?;

            let pack = |a: u32, b: u32| ((a as u64) << 32) | b as u64;
            let out = MFCreateMediaType()?;
            out.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
            out.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_H264)?;
            let pixels = (w * h) as u32;
            let bitrate = pixels * fps / if high { 4 } else { 8 };
            out.SetUINT32(&MF_MT_AVG_BITRATE, bitrate.max(2_000_000))?;
            out.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
            out.SetUINT64(&MF_MT_FRAME_SIZE, pack(w as u32, h as u32))?;
            out.SetUINT64(&MF_MT_FRAME_RATE, pack(fps, 1))?;
            out.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack(1, 1))?;
            let stream = writer.AddStream(&out)?;

            let input = MFCreateMediaType()?;
            input.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
            input.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_RGB32)?;
            input.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
            input.SetUINT64(&MF_MT_FRAME_SIZE, pack(w as u32, h as u32))?;
            input.SetUINT64(&MF_MT_FRAME_RATE, pack(fps, 1))?;
            input.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack(1, 1))?;
            // Positive stride: rows top to bottom, as GetDIBits gives them.
            input.SetUINT32(&MF_MT_DEFAULT_STRIDE, (w * 4) as u32)?;
            writer.SetInputMediaType(stream, &input, None)?;
            // The sound track: AAC from 16-bit stereo PCM.
            let (atx, arx) = std::sync::mpsc::channel::<Vec<i16>>();
            let mut audio: Option<(u32, u32)> = None; // (stream, rate)
            if sound != Sound::None {
                if let Ok(rate) = capture_sound(sound, stop.clone(), atx) {
                    if rate == 44_100 || rate == 48_000 {
                        let aout = MFCreateMediaType()?;
                        aout.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)?;
                        aout.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_AAC)?;
                        aout.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16)?;
                        aout.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, rate)?;
                        aout.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, 2)?;
                        aout.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, 24_000)?;
                        let astream = writer.AddStream(&aout)?;
                        let ain = MFCreateMediaType()?;
                        ain.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)?;
                        ain.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_PCM)?;
                        ain.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16)?;
                        ain.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, rate)?;
                        ain.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, 2)?;
                        ain.SetUINT32(&MF_MT_AUDIO_BLOCK_ALIGNMENT, 4)?;
                        ain.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, rate * 4)?;
                        writer.SetInputMediaType(astream, &ain, None)?;
                        audio = Some((astream, rate));
                    }
                }
            }
            let mut audio_frames: u64 = 0;
            writer.BeginWriting()?;

            let screen = GetDC(None);
            let mem = CreateCompatibleDC(Some(screen));
            let bmp = CreateCompatibleBitmap(screen, w, h);
            let old = SelectObject(mem, bmp.into());
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
            let len = (w * h * 4) as u32;
            let frame_ns = 10_000_000u64 / fps as u64; // 100 ns units
            let start = Instant::now();
            let mut n = 0u64;
            while !stop.load(Ordering::Relaxed) {
                let _ = BitBlt(mem, 0, 0, w, h, Some(screen), area.x, area.y, SRCCOPY | CAPTUREBLT);
                // The cursor is not part of the screen image: draw it in.
                let mut ci = CURSORINFO { cbSize: std::mem::size_of::<CURSORINFO>() as u32, ..Default::default() };
                if GetCursorInfo(&mut ci).is_ok() && ci.flags.0 & CURSOR_SHOWING.0 != 0 {
                    let _ = DrawIconEx(mem, ci.ptScreenPos.x - area.x, ci.ptScreenPos.y - area.y, ci.hCursor.into(), 0, 0, 0, None, DI_NORMAL);
                }
                let buffer = MFCreateMemoryBuffer(len)?;
                let mut ptr: *mut u8 = std::ptr::null_mut();
                buffer.Lock(&mut ptr, None, None)?;
                GetDIBits(mem, bmp, 0, h as u32, Some(ptr as *mut _), &mut info, DIB_RGB_COLORS);
                buffer.Unlock()?;
                buffer.SetCurrentLength(len)?;
                let sample = MFCreateSample()?;
                sample.AddBuffer(&buffer)?;
                // Time stamps follow the real clock, so slow frames don't speed the video up.
                let t = (start.elapsed().as_nanos() / 100) as i64;
                sample.SetSampleTime(t)?;
                sample.SetSampleDuration(frame_ns as i64)?;
                writer.WriteSample(stream, &sample)?;
                // Sound that came in meanwhile.
                if let Some((astream, rate)) = audio {
                    while let Ok(chunk) = arx.try_recv() {
                        let bytes = (chunk.len() * 2) as u32;
                        let buf = MFCreateMemoryBuffer(bytes)?;
                        let mut p: *mut u8 = std::ptr::null_mut();
                        buf.Lock(&mut p, None, None)?;
                        std::ptr::copy_nonoverlapping(chunk.as_ptr() as *const u8, p, bytes as usize);
                        buf.Unlock()?;
                        buf.SetCurrentLength(bytes)?;
                        let s = MFCreateSample()?;
                        s.AddBuffer(&buf)?;
                        let frames = (chunk.len() / 2) as u64;
                        s.SetSampleTime((audio_frames * 10_000_000 / rate as u64) as i64)?;
                        s.SetSampleDuration((frames * 10_000_000 / rate as u64) as i64)?;
                        writer.WriteSample(astream, &s)?;
                        audio_frames += frames;
                    }
                }
                n += 1;
                let next = Duration::from_nanos(n * frame_ns * 100);
                if let Some(wait) = next.checked_sub(start.elapsed()) {
                    thread::sleep(wait);
                }
            }
            SelectObject(mem, old);
            let _ = DeleteObject(bmp.into());
            let _ = DeleteDC(mem);
            ReleaseDC(None, screen);
            writer.Finalize()?;
            Ok(())
        })();
        let _ = MFShutdown();
        result.map_err(|e| e.to_string())
    }
}

// ------------------------------------------------------------------- gif ----

/// Records `area` to an animated GIF (12 frames a second, at most 720 px
/// wide); frames are encoded on another thread so capturing keeps its pace.
pub fn record_gif(path: &str, area: Area, stop: Arc<AtomicBool>) -> Result<(), String> {
    const FPS: u64 = 12;
    let scale = (720.0 / area.w as f32).min(1.0);
    let (tw, th) = (((area.w as f32 * scale) as u16).max(2), ((area.h as f32 * scale) as u16).max(2));
    let file = std::fs::File::create(path).map_err(|e| e.to_string())?;
    let (tx, rx) = std::sync::mpsc::sync_channel::<Vec<u8>>(8);
    let encoder = thread::spawn(move || -> Result<(), String> {
        let mut enc = gif::Encoder::new(std::io::BufWriter::new(file), tw, th, &[]).map_err(|e| e.to_string())?;
        enc.set_repeat(gif::Repeat::Infinite).map_err(|e| e.to_string())?;
        for mut rgba in rx {
            let mut frame = gif::Frame::from_rgba_speed(tw, th, &mut rgba, 10);
            frame.delay = (100 / FPS) as u16;
            enc.write_frame(&frame).map_err(|e| e.to_string())?;
        }
        Ok(())
    });
    unsafe {
        let (w, h) = (area.w, area.h);
        let screen = GetDC(None);
        let mem = CreateCompatibleDC(Some(screen));
        let bmp = CreateCompatibleBitmap(screen, w, h);
        let old = SelectObject(mem, bmp.into());
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
        let start = Instant::now();
        let mut n = 0u64;
        while !stop.load(Ordering::Relaxed) && start.elapsed() < Duration::from_secs(120) {
            let _ = BitBlt(mem, 0, 0, w, h, Some(screen), area.x, area.y, SRCCOPY | CAPTUREBLT);
            let mut ci = CURSORINFO { cbSize: std::mem::size_of::<CURSORINFO>() as u32, ..Default::default() };
            if GetCursorInfo(&mut ci).is_ok() && ci.flags.0 & CURSOR_SHOWING.0 != 0 {
                let _ = DrawIconEx(mem, ci.ptScreenPos.x - area.x, ci.ptScreenPos.y - area.y, ci.hCursor.into(), 0, 0, 0, None, DI_NORMAL);
            }
            GetDIBits(mem, bmp, 0, h as u32, Some(px.as_mut_ptr() as *mut _), &mut info, DIB_RGB_COLORS);
            // Downscale (nearest) and BGRA -> RGBA.
            let mut out = vec![0u8; tw as usize * th as usize * 4];
            for y in 0..th as usize {
                let sy = (y as f32 / scale) as usize;
                for x in 0..tw as usize {
                    let sx = (x as f32 / scale) as usize;
                    let i = (sy.min(h as usize - 1) * w as usize + sx.min(w as usize - 1)) * 4;
                    let o = (y * tw as usize + x) * 4;
                    out[o] = px[i + 2];
                    out[o + 1] = px[i + 1];
                    out[o + 2] = px[i];
                    out[o + 3] = 255;
                }
            }
            if tx.send(out).is_err() {
                break;
            }
            n += 1;
            let next = Duration::from_millis(n * 1000 / FPS);
            if let Some(wait) = next.checked_sub(start.elapsed()) {
                thread::sleep(wait);
            }
        }
        SelectObject(mem, old);
        let _ = DeleteObject(bmp.into());
        let _ = DeleteDC(mem);
        ReleaseDC(None, screen);
    }
    drop(tx);
    encoder.join().map_err(|_| "Не удалось записать GIF".to_string())?
}
