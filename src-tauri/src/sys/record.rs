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
        let dev = e.GetDefaultAudioEndpoint(eCapture, eConsole).map_err(|_| "Нет микрофона".to_string())?;
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

/// Records `area` of the screen to an MP4 file until `stop` is set.
pub fn record_screen(path: &str, area: Area, fps: u32, high: bool, stop: Arc<AtomicBool>) -> Result<(), String> {
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
