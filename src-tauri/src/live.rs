//! Live information that comes from the network or the file system:
//! weather (MET Norway), city search (OpenStreetMap Nominatim), song lyrics
//! (LRCLIB), downloads, and the VPN's country.
//!
//! Every request is optional and goes only where it has to: the forecast
//! only for the city the user picked, lyrics only for the song that plays.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use crate::settings::Settings;

const UA: &str = "DarkIsland/0.1 (Windows desktop widget)";

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(12))).build().new_agent()
}

pub fn get_json(url: &str) -> Option<Value> {
    agent().get(url).header("User-Agent", UA).call().ok()?.body_mut().read_json::<Value>().ok()
}

fn enc(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

// -------------------------------------------------------------- weather ----

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Point {
    /// Unix ms.
    pub t: i64,
    pub temp: f64,
    pub wind: f64,
    pub humidity: f64,
    pub pressure: f64,
    pub symbol: String,
    pub precip: f64,
    /// Symbol for the next 6 hours (for the week view).
    pub symbol6: String,
}

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Weather {
    pub city: String,
    pub points: Vec<Point>,
    /// Unix ms of the fetch.
    pub at: i64,
}

pub static WEATHER: Mutex<Option<Weather>> = Mutex::new(None);

fn parse_time(s: &str) -> Option<i64> {
    // "2026-11-11T12:00:00Z"
    let b = s.as_bytes();
    if b.len() < 19 {
        return None;
    }
    let n = |a: usize, l: usize| s.get(a..a + l)?.parse::<i64>().ok();
    let (y, mo, d, h, mi) = (n(0, 4)?, n(5, 2)?, n(8, 2)?, n(11, 2)?, n(14, 2)?);
    // days from civil (Howard Hinnant)
    let y2 = if mo <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 24 + h) * 60 + mi) * 60_000)
}

pub fn fetch_weather(city: &str, lat: f64, lon: f64) -> Option<Weather> {
    let url = format!(
        "https://api.met.no/weatherapi/locationforecast/2.0/compact?lat={:.4}&lon={:.4}",
        lat, lon
    );
    let v = get_json(&url)?;
    let series = v.pointer("/properties/timeseries")?.as_array()?;
    let f = |x: &Value, p: &str| x.pointer(p).and_then(Value::as_f64).unwrap_or(0.0);
    let s = |x: &Value, p: &str| x.pointer(p).and_then(Value::as_str).unwrap_or("").to_string();
    let points = series
        .iter()
        .filter_map(|e| {
            let d = e.get("data")?;
            Some(Point {
                t: parse_time(e.get("time")?.as_str()?)?,
                temp: f(d, "/instant/details/air_temperature"),
                wind: f(d, "/instant/details/wind_speed"),
                humidity: f(d, "/instant/details/relative_humidity"),
                pressure: f(d, "/instant/details/air_pressure_at_sea_level"),
                symbol: {
                    let one = s(d, "/next_1_hours/summary/symbol_code");
                    if one.is_empty() { s(d, "/next_6_hours/summary/symbol_code") } else { one }
                },
                precip: if d.pointer("/next_1_hours").is_some() {
                    f(d, "/next_1_hours/details/precipitation_amount")
                } else {
                    f(d, "/next_6_hours/details/precipitation_amount") / 6.0
                },
                symbol6: s(d, "/next_6_hours/summary/symbol_code"),
            })
        })
        .collect::<Vec<_>>();
    let at = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).ok()?.as_millis() as i64;
    Some(Weather { city: city.to_string(), points, at })
}

fn city_of(settings: &Settings) -> Option<(String, f64, f64)> {
    let c = settings.all().get("weatherCity")?.clone();
    Some((c.get("name")?.as_str()?.to_string(), c.get("lat")?.as_f64()?, c.get("lon")?.as_f64()?))
}

pub fn refresh_weather(app: &AppHandle, settings: &Settings) {
    let Some((name, lat, lon)) = city_of(settings) else {
        *WEATHER.lock().unwrap() = None;
        let _ = app.emit_to("island", "weather", Value::Null);
        return;
    };
    if let Some(w) = fetch_weather(&name, lat, lon) {
        *WEATHER.lock().unwrap() = Some(w.clone());
        let _ = app.emit_to("island", "weather", w);
    }
}

pub fn spawn_weather(app: AppHandle, settings: Arc<Settings>) {
    thread::spawn(move || loop {
        refresh_weather(&app, &settings);
        // MET updates hourly; half an hour keeps the "rain soon" warning fresh.
        thread::sleep(Duration::from_secs(30 * 60));
    });
}

#[derive(Serialize)]
pub struct Place {
    pub name: String,
    pub full: String,
    pub lat: f64,
    pub lon: f64,
}

pub fn search_city(q: &str) -> Vec<Place> {
    let url = format!(
        "https://nominatim.openstreetmap.org/search?q={}&format=jsonv2&limit=6&accept-language=ru&featureType=settlement",
        enc(q)
    );
    let Some(Value::Array(list)) = get_json(&url) else { return Vec::new() };
    list.iter()
        .filter_map(|p| {
            Some(Place {
                name: p.get("name")?.as_str()?.to_string(),
                full: p.get("display_name")?.as_str()?.to_string(),
                lat: p.get("lat")?.as_str()?.parse().ok()?,
                lon: p.get("lon")?.as_str()?.parse().ok()?,
            })
        })
        .collect()
}

// --------------------------------------------------------------- lyrics ----

/// Time-synced lyrics (LRC) for one song, or plain text, or nothing.
pub fn lyrics(artist: &str, title: &str, duration_s: u64) -> Option<String> {
    let get = format!(
        "https://lrclib.net/api/get?artist_name={}&track_name={}{}",
        enc(artist),
        enc(title),
        if duration_s > 0 { format!("&duration={duration_s}") } else { String::new() }
    );
    let pick = |v: &Value| {
        v.get("syncedLyrics")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    if let Some(v) = get_json(&get) {
        if let Some(s) = pick(&v) {
            return Some(s);
        }
    }
    let search = format!("https://lrclib.net/api/search?track_name={}&artist_name={}", enc(title), enc(artist));
    match get_json(&search) {
        Some(Value::Array(list)) => list.iter().find_map(pick),
        _ => None,
    }
}

// ------------------------------------------------------------ downloads ----

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Download {
    pub name: String,
    pub size: u64,
    /// Bytes per second over the last poll.
    pub speed: u64,
}

const PARTIAL: &[&str] = &["crdownload", "part", "partial", "download", "opdownload"];

/// Watches the Downloads folder: files being written show up in the pill,
/// a finished file shows a card.
pub fn spawn_downloads(app: AppHandle) {
    let Ok(dir) = app.path().download_dir() else { return };
    thread::spawn(move || {
        let list = |dir: &PathBuf| -> HashMap<String, u64> {
            std::fs::read_dir(dir)
                .map(|rd| {
                    rd.flatten()
                        .filter_map(|e| {
                            let m = e.metadata().ok()?;
                            m.is_file().then(|| (e.file_name().to_string_lossy().into_owned(), m.len()))
                        })
                        .collect()
                })
                .unwrap_or_default()
        };
        let partial = |n: &str| {
            n.rsplit_once('.').is_some_and(|(_, ext)| PARTIAL.contains(&ext.to_lowercase().as_str()))
        };
        let mut before = list(&dir);
        let mut last = Instant::now();
        let mut active_before = false;
        loop {
            thread::sleep(Duration::from_secs(2));
            let now = list(&dir);
            let secs = last.elapsed().as_secs_f64().max(0.5);
            last = Instant::now();
            let active: Vec<Download> = now
                .iter()
                .filter(|(n, _)| partial(n))
                .map(|(n, &size)| {
                    let prev = before.get(n).copied().unwrap_or(size);
                    let name = n.rsplit_once('.').map(|(b, _)| b).unwrap_or(n).to_string();
                    Download { name, size, speed: ((size.saturating_sub(prev)) as f64 / secs) as u64 }
                })
                .collect();
            if !active.is_empty() || active_before {
                let _ = app.emit_to("island", "downloads", &active);
            }
            active_before = !active.is_empty();
            for (n, &size) in &now {
                if before.contains_key(n) || partial(n) || size == 0 || n.ends_with(".tmp") {
                    continue;
                }
                // A new complete file: from a browser that renamed its partial file, or any other app.
                let path = dir.join(n).to_string_lossy().into_owned();
                let _ = app.emit_to("island", "download_done", serde_json::json!({ "name": n, "path": path, "size": size }));
            }
            before = now;
        }
    });
}

// ------------------------------------------------------------------ vpn ----

/// Public IP and country, asked only when a VPN comes up (and only if allowed).
pub fn vpn_country() -> Option<(String, String)> {
    let v = get_json("https://ipwho.is/?fields=success,ip,country_code")?;
    if !v.get("success").and_then(Value::as_bool).unwrap_or(false) {
        return None;
    }
    Some((v.get("country_code")?.as_str()?.to_string(), v.get("ip")?.as_str()?.to_string()))
}
