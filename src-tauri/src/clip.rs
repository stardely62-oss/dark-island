//! Clipboard history, the file shelf and the note: small pieces of state kept
//! in the app's data folder.

use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde::{Deserialize, Serialize};

const MAX_CLIPS: usize = 60;
const MAX_TEXT: usize = 200_000;
const PREVIEW: usize = 400;
const THUMB: u32 = 160;

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn read_json<T: for<'de> Deserialize<'de> + Default>(path: &Path) -> T {
    fs::read(path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn write_json<T: Serialize>(path: &Path, value: &T) {
    if let Ok(bytes) = serde_json::to_vec(value) {
        let tmp = path.with_extension("tmp");
        if fs::write(&tmp, bytes).is_ok() {
            let _ = fs::rename(&tmp, path);
        }
    }
}

// ------------------------------------------------------------ clipboard ----

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Clip {
    pub id: u64,
    pub text: Option<String>,
    /// File name of the full image, in the `clips` folder.
    pub image: Option<String>,
    /// Small PNG preview as a data URL.
    pub thumb: Option<String>,
    pub w: u32,
    pub h: u32,
    pub pinned: bool,
    pub at: u64,
    #[serde(default)]
    pub hash: u64,
}

/// What the UI gets: text is cut to a preview.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipView {
    pub id: u64,
    pub kind: &'static str,
    pub preview: String,
    pub chars: usize,
    pub thumb: Option<String>,
    pub w: u32,
    pub h: u32,
    pub pinned: bool,
    pub at: u64,
}

#[derive(Default, Serialize, Deserialize)]
struct ClipFile {
    next: u64,
    items: Vec<Clip>,
}

pub struct Clips {
    dir: PathBuf,
    data: ClipFile,
}

/// The content of a clip, ready to be put back on the clipboard.
pub enum ClipData {
    Text(String),
    Image { w: u32, h: u32, rgba: Vec<u8> },
}

impl Clips {
    pub fn load(dir: &Path) -> Self {
        let dir = dir.join("clips");
        let _ = fs::create_dir_all(&dir);
        let data = read_json(&dir.join("clips.json"));
        Self { dir, data }
    }

    fn save(&self) {
        write_json(&self.dir.join("clips.json"), &self.data);
    }

    pub fn view(&self) -> Vec<ClipView> {
        let mut items: Vec<&Clip> = self.data.items.iter().collect();
        // Pinned first, then newest first.
        items.sort_by(|a, b| b.pinned.cmp(&a.pinned).then(b.at.cmp(&a.at)));
        items
            .into_iter()
            .map(|c| {
                let text = c.text.as_deref().unwrap_or("");
                ClipView {
                    id: c.id,
                    kind: if c.image.is_some() { "image" } else { "text" },
                    preview: text.chars().take(PREVIEW).collect(),
                    chars: text.chars().count(),
                    thumb: c.thumb.clone(),
                    w: c.w,
                    h: c.h,
                    pinned: c.pinned,
                    at: c.at,
                }
            })
            .collect()
    }

    /// Moves an existing identical entry to the top instead of duplicating it.
    fn bump(&mut self, hash: u64) -> bool {
        if let Some(c) = self.data.items.iter_mut().find(|c| c.hash == hash) {
            c.at = now_ms();
            return true;
        }
        false
    }

    fn push(&mut self, mut clip: Clip) {
        self.data.next += 1;
        clip.id = self.data.next;
        self.data.items.push(clip);
        // Forget the oldest unpinned entries beyond the limit.
        let unpinned = self.data.items.iter().filter(|c| !c.pinned).count();
        if unpinned > MAX_CLIPS {
            let mut old: Vec<(u64, u64)> =
                self.data.items.iter().filter(|c| !c.pinned).map(|c| (c.at, c.id)).collect();
            old.sort();
            for (_, id) in old.into_iter().take(unpinned - MAX_CLIPS) {
                self.remove(id);
            }
        }
        self.save();
    }

    pub fn add_text(&mut self, text: String) -> bool {
        if text.trim().is_empty() || text.len() > MAX_TEXT {
            return false;
        }
        let hash = hash_of(text.as_bytes());
        if self.bump(hash) {
            self.save();
            return true;
        }
        self.push(Clip {
            id: 0,
            text: Some(text),
            image: None,
            thumb: None,
            w: 0,
            h: 0,
            pinned: false,
            at: now_ms(),
            hash,
        });
        true
    }

    pub fn add_image(&mut self, w: u32, h: u32, rgba: &[u8]) -> bool {
        if w == 0 || h == 0 || rgba.len() != (w * h * 4) as usize {
            return false;
        }
        let hash = hash_of(rgba);
        if self.bump(hash) {
            self.save();
            return true;
        }
        let name = format!("{hash:016x}.png");
        let Some(full) = encode_png(w, h, rgba) else { return false };
        if fs::write(self.dir.join(&name), full).is_err() {
            return false;
        }
        let thumb = thumbnail(w, h, rgba).map(|png| format!("data:image/png;base64,{}", B64.encode(png)));
        self.push(Clip {
            id: 0,
            text: None,
            image: Some(name),
            thumb,
            w,
            h,
            pinned: false,
            at: now_ms(),
            hash,
        });
        true
    }

    pub fn data(&self, id: u64) -> Option<ClipData> {
        let c = self.data.items.iter().find(|c| c.id == id)?;
        if let Some(t) = &c.text {
            return Some(ClipData::Text(t.clone()));
        }
        let bytes = fs::read(self.dir.join(c.image.as_ref()?)).ok()?;
        let (w, h, rgba) = decode_png(&bytes)?;
        Some(ClipData::Image { w, h, rgba })
    }

    pub fn remove(&mut self, id: u64) {
        if let Some(i) = self.data.items.iter().position(|c| c.id == id) {
            let c = self.data.items.remove(i);
            if let Some(f) = c.image {
                let _ = fs::remove_file(self.dir.join(f));
            }
            self.save();
        }
    }

    pub fn toggle_pin(&mut self, id: u64) {
        if let Some(c) = self.data.items.iter_mut().find(|c| c.id == id) {
            c.pinned = !c.pinned;
            self.save();
        }
    }

    /// Clears everything except pinned entries.
    pub fn clear(&mut self) {
        let ids: Vec<u64> = self.data.items.iter().filter(|c| !c.pinned).map(|c| c.id).collect();
        for id in ids {
            self.remove(id);
        }
        self.save();
    }
}

fn hash_of(bytes: &[u8]) -> u64 {
    let mut h = DefaultHasher::new();
    bytes.hash(&mut h);
    h.finish()
}

pub fn encode_png(w: u32, h: u32, rgba: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, w, h);
        // Screens are big: favour speed, the ratio is still decent.
        enc.set_compression(png::Compression::Fast);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        let mut writer = enc.write_header().ok()?;
        writer.write_image_data(rgba).ok()?;
    }
    Some(out)
}

pub fn decode_png(bytes: &[u8]) -> Option<(u32, u32, Vec<u8>)> {
    let mut dec = png::Decoder::new(std::io::Cursor::new(bytes));
    dec.set_transformations(png::Transformations::EXPAND | png::Transformations::ALPHA);
    let mut reader = dec.read_info().ok()?;
    let mut buf = vec![0; reader.output_buffer_size()?];
    let info = reader.next_frame(&mut buf).ok()?;
    buf.truncate(info.buffer_size());
    if info.color_type != png::ColorType::Rgba || info.bit_depth != png::BitDepth::Eight {
        return None;
    }
    Some((info.width, info.height, buf))
}

/// Box-filtered downscale to fit `THUMB` px.
pub fn thumbnail(w: u32, h: u32, rgba: &[u8]) -> Option<Vec<u8>> {
    let scale = (THUMB as f32 / w.max(h) as f32).min(1.0);
    let tw = ((w as f32 * scale).round() as u32).max(1);
    let th = ((h as f32 * scale).round() as u32).max(1);
    let mut out = vec![0u8; (tw * th * 4) as usize];
    for ty in 0..th {
        let y0 = ty * h / th;
        let y1 = ((ty + 1) * h / th).max(y0 + 1);
        for tx in 0..tw {
            let x0 = tx * w / tw;
            let x1 = ((tx + 1) * w / tw).max(x0 + 1);
            let mut acc = [0u32; 4];
            let mut n = 0;
            for y in y0..y1 {
                for x in x0..x1 {
                    let i = ((y * w + x) * 4) as usize;
                    for c in 0..4 {
                        acc[c] += rgba[i + c] as u32;
                    }
                    n += 1;
                }
            }
            let o = ((ty * tw + tx) * 4) as usize;
            for c in 0..4 {
                out[o + c] = (acc[c] / n) as u8;
            }
        }
    }
    encode_png(tw, th, &out)
}

// --------------------------------------------------------------- shelf ----

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShelfItem {
    pub path: String,
    pub name: String,
    pub dir: bool,
    pub size: u64,
}

pub struct Shelf {
    file: PathBuf,
    pub items: Vec<ShelfItem>,
}

impl Shelf {
    pub fn load(dir: &Path) -> Self {
        let file = dir.join("shelf.json");
        let items: Vec<ShelfItem> = read_json(&file);
        // Files may have been moved or deleted while the island was closed.
        let items = items.into_iter().filter(|i| Path::new(&i.path).exists()).collect();
        Self { file, items }
    }

    fn save(&self) {
        write_json(&self.file, &self.items);
    }

    pub fn add(&mut self, paths: Vec<String>) {
        for p in paths {
            if self.items.iter().any(|i| i.path == p) {
                continue;
            }
            let path = Path::new(&p);
            let Ok(meta) = fs::metadata(path) else { continue };
            let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| p.clone());
            self.items.push(ShelfItem { path: p, name, dir: meta.is_dir(), size: meta.len() });
        }
        self.save();
    }

    pub fn remove(&mut self, path: &str) {
        self.items.retain(|i| i.path != path);
        self.save();
    }

    pub fn clear(&mut self) {
        self.items.clear();
        self.save();
    }
}

// ---------------------------------------------------------------- note ----

pub struct Note {
    file: PathBuf,
    pub text: String,
}

impl Note {
    pub fn load(dir: &Path) -> Self {
        let file = dir.join("note.txt");
        let text = fs::read_to_string(&file).unwrap_or_default();
        Self { file, text }
    }

    pub fn set(&mut self, text: String) {
        self.text = text;
        let tmp = self.file.with_extension("tmp");
        if fs::write(&tmp, &self.text).is_ok() {
            let _ = fs::rename(&tmp, &self.file);
        }
    }
}
