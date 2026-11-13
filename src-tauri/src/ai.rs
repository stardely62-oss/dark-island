//! AI with the user's own key: chat and text actions (streamed), model lists,
//! speech to text (Whisper-compatible), and image hosting for screenshots.
//!
//! Two protocols: Anthropic's Messages API for Claude, and the OpenAI-style
//! chat completions that Groq, Gemini, OpenRouter, DeepSeek and others speak.
//! Keys are encrypted with Windows DPAPI for the current user and leave the
//! computer only in requests to the service they were issued for.

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::sys;

pub const ANTHROPIC: &str = "https://api.anthropic.com/v1";

// ------------------------------------------------------------------ keys ----

pub struct Keys {
    file: PathBuf,
    map: Mutex<HashMap<String, String>>,
}

impl Keys {
    pub fn load(dir: &Path) -> Self {
        let file = dir.join("keys.json");
        let map = std::fs::read(&file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        Self { file, map: Mutex::new(map) }
    }

    pub fn set(&self, id: &str, key: &str) {
        let mut m = self.map.lock().unwrap();
        if key.trim().is_empty() {
            m.remove(id);
        } else if let Some(enc) = sys::protect(key.trim().as_bytes()) {
            m.insert(id.to_string(), B64.encode(enc));
        }
        if let Ok(b) = serde_json::to_vec(&*m) {
            let _ = std::fs::write(&self.file, b);
        }
    }

    pub fn get(&self, id: &str) -> Option<String> {
        let enc = B64.decode(self.map.lock().unwrap().get(id)?).ok()?;
        String::from_utf8(sys::unprotect(&enc)?).ok()
    }

    pub fn has(&self, id: &str) -> bool {
        self.map.lock().unwrap().contains_key(id)
    }
}

// -------------------------------------------------------------- requests ----

fn stream_agent(url: &str) -> ureq::Agent {
    ureq::Agent::config_builder()
        .proxy(crate::live::proxy_for(url))
        .timeout_connect(Some(Duration::from_secs(15)))
        .timeout_recv_response(Some(Duration::from_secs(120)))
        .timeout_recv_body(Some(Duration::from_secs(600)))
        .http_status_as_error(false)
        .build()
        .new_agent()
}

/// Provider settings sent by the UI with each request.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Provider {
    /// Key id in the key store (groq, gemini, anthropic, …).
    pub id: String,
    /// "anthropic" or "openai"
    pub protocol: String,
    pub base: String,
    pub model: String,
}

/// A chat message: text plus optional images as data URLs.
#[derive(Clone, Deserialize)]
pub struct Msg {
    pub role: String,
    pub text: String,
    #[serde(default)]
    pub images: Vec<String>,
}

fn split_data_url(u: &str) -> Option<(&str, &str)> {
    let rest = u.strip_prefix("data:")?;
    let (mime, data) = rest.split_once(";base64,")?;
    Some((mime, data))
}

fn error_text(code: u16, body: &str) -> String {
    let v: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let msg = v
        .pointer("/error/message")
        .or_else(|| v.pointer("/message"))
        .or_else(|| v.get(0).and_then(|e| e.pointer("/error/message")))
        .and_then(Value::as_str)
        .unwrap_or(body);
    let hint = match code {
        401 | 403 => crate::i18n::tr("Ключ не подошёл. ", "The key didn't work. "),
        404 => crate::i18n::tr("Нет такой модели или адреса. ", "No such model or address. "),
        429 => crate::i18n::tr("Слишком много запросов или кончился лимит. ", "Too many requests or the limit ran out. "),
        500 | 502 | 503 | 529 => crate::i18n::tr("Сервис сейчас перегружен (это на их стороне). Остров уже пробовал повторить и взять модель полегче — подожди минуту или выбери другую модель. ", "The service is overloaded right now (on their side). The island already retried and tried a lighter model — wait a minute or pick another model. "),
        _ => "",
    };
    let low = msg.to_lowercase();
    let blocked = ["location is not supported", "unsupported_country", "unsupported country", "not available in your country", "not available in your region", "request not allowed", "country, region, or territory"];
    let hint = if blocked.iter().any(|b| low.contains(b)) {
        crate::i18n::tr("Сервис недоступен из вашей страны — нужен VPN. Остров ходит через системный прокси Windows: включите в VPN режим «системный прокси» или TUN и повторите. ", "The service isn't available in your country — a VPN is needed. The island goes through the Windows system proxy: switch the VPN to “system proxy” or TUN mode and try again. ")
    } else {
        hint
    };
    format!("{hint}{} ({code})", msg.chars().take(300).collect::<String>())
}

#[derive(Clone, Serialize)]
pub struct Delta {
    pub id: String,
    pub text: String,
}

#[derive(Clone, Serialize)]
pub struct Done {
    pub id: String,
    pub error: Option<String>,
}

pub struct Runs {
    cancel: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl Runs {
    pub fn new() -> Self {
        Self { cancel: Mutex::new(HashMap::new()) }
    }
    pub fn cancel(&self, id: &str) {
        if let Some(f) = self.cancel.lock().unwrap().get(id) {
            f.store(true, Ordering::Relaxed);
        }
    }
}

/// Streams a reply: "ai_delta" events with text, then one "ai_done".
pub fn chat(app: AppHandle, keys: &Keys, runs: &Runs, id: String, p: Provider, system: String, msgs: Vec<Msg>) {
    let Some(key) = keys.get(&p.id) else {
        let _ = app.emit_to("island", "ai_done", Done { id, error: Some(crate::i18n::tr("Нет ключа: добавь его в настройках ИИ", "No key: add it in the AI settings").into()) });
        return;
    };
    let stop = Arc::new(AtomicBool::new(false));
    runs.cancel.lock().unwrap().insert(id.clone(), stop.clone());
    let emit = |text: String| {
        let _ = app.emit_to("island", "ai_delta", Delta { id: id.clone(), text });
    };
    let result = if p.protocol == "anthropic" {
        claude_stream(&key, &p, &system, &msgs, &stop, emit)
    } else {
        openai_stream(&key, &p, &system, &msgs, &stop, emit)
    };
    runs.cancel.lock().unwrap().remove(&id);
    let _ = app.emit_to("island", "ai_done", Done { id, error: result.err() });
}

/// Claude through the Anthropic Messages API (raw HTTP: Rust has no official SDK).
fn claude_stream(
    key: &str,
    p: &Provider,
    system: &str,
    msgs: &[Msg],
    stop: &AtomicBool,
    emit: impl Fn(String),
) -> Result<(), String> {
    let messages: Vec<Value> = msgs
        .iter()
        .map(|m| {
            let mut content: Vec<Value> = m
                .images
                .iter()
                .filter_map(|u| split_data_url(u))
                .map(|(mime, data)| json!({ "type": "image", "source": { "type": "base64", "media_type": mime, "data": data } }))
                .collect();
            content.push(json!({ "type": "text", "text": m.text }));
            json!({ "role": if m.role == "assistant" { "assistant" } else { "user" }, "content": content })
        })
        .collect();
    let mut body = json!({
        "model": p.model,
        "max_tokens": 16000,
        "stream": true,
        "messages": messages,
        // If the model declines, the API re-runs the request on a fallback model.
        "fallbacks": "default",
    });
    if !system.is_empty() {
        body["system"] = json!(system);
    }
    let base = if p.base.is_empty() { ANTHROPIC } else { p.base.trim_end_matches('/') };
    let mut resp = stream_agent(base)
        .post(format!("{base}/messages"))
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .header("anthropic-beta", "server-side-fallback-2026-07-01")
        .header("content-type", "application/json")
        .send_json(&body)
        .map_err(|e| L!("Нет связи с Anthropic: {e}", "No connection to Anthropic: {e}"))?;
    let code = resp.status().as_u16();
    if code != 200 {
        let text = resp.body_mut().read_to_string().unwrap_or_default();
        return Err(error_text(code, &text));
    }
    let reader = BufReader::new(resp.body_mut().as_reader());
    for line in reader.lines() {
        if stop.load(Ordering::Relaxed) {
            return Ok(());
        }
        let line = line.map_err(|e| e.to_string())?;
        let Some(data) = line.strip_prefix("data:") else { continue };
        let Ok(v) = serde_json::from_str::<Value>(data.trim()) else { continue };
        match v.get("type").and_then(Value::as_str) {
            Some("content_block_delta") => {
                // Only the visible answer; thinking deltas are not shown.
                if v.pointer("/delta/type").and_then(Value::as_str) == Some("text_delta") {
                    if let Some(t) = v.pointer("/delta/text").and_then(Value::as_str) {
                        emit(t.to_string());
                    }
                }
            }
            Some("message_delta") => {
                if v.pointer("/delta/stop_reason").and_then(Value::as_str) == Some("refusal") {
                    return Err(crate::i18n::tr("Модель отказалась отвечать на этот запрос", "The model declined to answer this request").into());
                }
            }
            Some("error") => {
                return Err(v.pointer("/error/message").and_then(Value::as_str).unwrap_or(crate::i18n::tr("Ошибка", "Error")).to_string());
            }
            Some("message_stop") => break,
            _ => {}
        }
    }
    Ok(())
}

fn openai_stream(
    key: &str,
    p: &Provider,
    system: &str,
    msgs: &[Msg],
    stop: &AtomicBool,
    emit: impl Fn(String),
) -> Result<(), String> {
    let mut messages: Vec<Value> = Vec::new();
    if !system.is_empty() {
        messages.push(json!({ "role": "system", "content": system }));
    }
    for m in msgs {
        if m.images.is_empty() {
            messages.push(json!({ "role": m.role, "content": m.text }));
        } else {
            let mut parts: Vec<Value> = vec![json!({ "type": "text", "text": m.text })];
            for u in &m.images {
                parts.push(json!({ "type": "image_url", "image_url": { "url": u } }));
            }
            messages.push(json!({ "role": m.role, "content": parts }));
        }
    }
    let body = json!({ "model": p.model, "stream": true, "messages": messages });
    let mut resp = stream_agent(&p.base)
        .post(format!("{}/chat/completions", p.base.trim_end_matches('/')))
        .header("Authorization", format!("Bearer {key}"))
        .header("content-type", "application/json")
        .send_json(&body)
        .map_err(|e| L!("Нет связи с сервисом: {e}", "No connection to the service: {e}"))?;
    let code = resp.status().as_u16();
    if code != 200 {
        let text = resp.body_mut().read_to_string().unwrap_or_default();
        return Err(error_text(code, &text));
    }
    let reader = BufReader::new(resp.body_mut().as_reader());
    for line in reader.lines() {
        if stop.load(Ordering::Relaxed) {
            return Ok(());
        }
        let line = line.map_err(|e| e.to_string())?;
        let Some(data) = line.strip_prefix("data:") else { continue };
        let data = data.trim();
        if data == "[DONE]" {
            break;
        }
        let Ok(v) = serde_json::from_str::<Value>(data) else { continue };
        if let Some(t) = v.pointer("/choices/0/delta/content").and_then(Value::as_str) {
            emit(t.to_string());
        }
        if let Some(e) = v.pointer("/error/message").and_then(Value::as_str) {
            return Err(e.to_string());
        }
    }
    Ok(())
}

/// Model ids the key can use.
pub fn models(keys: &Keys, p: &Provider) -> Result<Vec<String>, String> {
    let key = keys.get(&p.id).ok_or(crate::i18n::tr("Нет ключа", "No key"))?;
    let agent = stream_agent(&p.base);
    let mut resp = if p.protocol == "anthropic" {
        agent
            .get(format!("{}/models?limit=100", if p.base.is_empty() { ANTHROPIC } else { p.base.trim_end_matches('/') }))
            .header("x-api-key", &key)
            .header("anthropic-version", "2023-06-01")
            .call()
    } else {
        agent
            .get(format!("{}/models", p.base.trim_end_matches('/')))
            .header("Authorization", format!("Bearer {key}"))
            .call()
    }
    .map_err(|e| e.to_string())?;
    let code = resp.status().as_u16();
    let text = resp.body_mut().read_to_string().unwrap_or_default();
    if code != 200 {
        return Err(error_text(code, &text));
    }
    let v: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let mut ids: Vec<String> = v
        .get("data")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|m| m.get("id").and_then(Value::as_str)).map(|s| s.trim_start_matches("models/").to_string()).collect())
        .unwrap_or_default();
    ids.sort();
    Ok(ids)
}

// --------------------------------------------------------- speech to text ----

/// Sends a WAV recording to a Whisper-compatible endpoint and returns the text.
pub fn transcribe(keys: &Keys, key_id: &str, base: &str, model: &str, wav: Vec<u8>, lang: &str) -> Result<String, String> {
    let key = keys.get(key_id).ok_or(crate::i18n::tr("Нет ключа для распознавания речи", "No key for speech recognition"))?;
    let boundary = format!("----dark-island-{}", wav.len());
    let mut body = Vec::new();
    let mut field = |name: &str, value: &str| {
        body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n").as_bytes());
    };
    field("model", model);
    field("response_format", "json");
    if !lang.is_empty() {
        field("language", lang);
    }
    body.extend_from_slice(
        format!("--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"speech.wav\"\r\nContent-Type: audio/wav\r\n\r\n")
            .as_bytes(),
    );
    body.extend_from_slice(&wav);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    let mut resp = stream_agent(base)
        .post(format!("{}/audio/transcriptions", base.trim_end_matches('/')))
        .header("Authorization", format!("Bearer {key}"))
        .header("content-type", format!("multipart/form-data; boundary={boundary}"))
        .send(&body[..])
        .map_err(|e| L!("Нет связи с сервисом: {e}", "No connection to the service: {e}"))?;
    let code = resp.status().as_u16();
    let text = resp.body_mut().read_to_string().unwrap_or_default();
    if code != 200 {
        return Err(error_text(code, &text));
    }
    let v: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    Ok(v.get("text").and_then(Value::as_str).unwrap_or("").trim().to_string())
}

/// 16-bit mono WAV.
pub fn wav(samples: &[i16], rate: u32) -> Vec<u8> {
    let data_len = (samples.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&rate.to_le_bytes());
    out.extend_from_slice(&(rate * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for s in samples {
        out.extend_from_slice(&s.to_le_bytes());
    }
    out
}

// ---------------------------------------------------------- image hosting ----

/// Uploads a PNG to ImgBB or Imgur with the user's key and returns its link.
pub fn upload(keys: &Keys, service: &str, png: &[u8]) -> Result<String, String> {
    let key = keys.get(service).ok_or(crate::i18n::tr("Нет ключа сервиса картинок: добавь его в настройках", "No image service key: add it in the settings"))?;
    let b64 = B64.encode(png);
    let agent = stream_agent("https://api.imgbb.com");
    let (mut resp, path) = match service {
        "imgbb" => (
            agent
                .post(format!("https://api.imgbb.com/1/upload?key={key}"))
                .send_form([("image", b64.as_str())])
                .map_err(|e| e.to_string())?,
            "/data/url",
        ),
        "imgur" => (
            agent
                .post("https://api.imgur.com/3/image")
                .header("Authorization", format!("Client-ID {key}"))
                .send_form([("image", b64.as_str()), ("type", "base64")])
                .map_err(|e| e.to_string())?,
            "/data/link",
        ),
        _ => return Err(crate::i18n::tr("Сервис не выбран", "No service chosen").into()),
    };
    let code = resp.status().as_u16();
    let text = resp.body_mut().read_to_string().unwrap_or_default();
    if code != 200 {
        return Err(error_text(code, &text));
    }
    let v: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    v.pointer(path).and_then(Value::as_str).map(str::to_string).ok_or_else(|| crate::i18n::tr("Сервис не вернул ссылку", "The service returned no link").into())
}
