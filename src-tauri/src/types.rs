use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Media {
    pub title: String,
    pub artist: String,
    pub app: String,
    pub playing: bool,
    /// Album art as a `data:` URL, if the player exposes one.
    pub cover: Option<String>,
    pub position_ms: u64,
    pub duration_ms: u64,
    /// Unix time (ms) at which `position_ms` was valid.
    pub updated_at_ms: u64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Volume {
    pub level: f32,
    pub muted: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Battery {
    pub percent: u8,
    pub charging: bool,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub media: Option<Media>,
    pub volume: Option<Volume>,
    pub battery: Option<Battery>,
}

/// Area of the island inside the window, in logical (CSS) pixels.
#[derive(Clone, Copy, Debug, Default, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Rect {
    pub fn contains(&self, x: f64, y: f64) -> bool {
        self.w > 0.0 && x >= self.x && x <= self.x + self.w && y >= self.y - 2.0 && y <= self.y + self.h
    }
}

/// Where the window sits on screen, in physical pixels.
#[derive(Clone, Copy, Debug)]
pub struct Geometry {
    pub x: f64,
    pub y: f64,
    pub scale: f64,
}

impl Default for Geometry {
    fn default() -> Self {
        Self { x: 0.0, y: 0.0, scale: 1.0 }
    }
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaAction {
    Toggle,
    Next,
    Prev,
}

#[derive(Debug)]
pub enum Cmd {
    Media(MediaAction),
    VolumeSet(f32),
    VolumeStep(f32),
    MuteToggle,
}

#[derive(Clone, Serialize)]
pub struct CursorEvent {
    pub x: f64,
    pub y: f64,
    pub near: bool,
    pub inside: bool,
}
