//! OBS Studio status over obs-websocket 5 (built into OBS 28+): whether it is
//! recording or streaming, shown as a pill. Only localhost, only when enabled.

use std::io::ErrorKind;
use std::net::TcpStream;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use tungstenite::Message;

use crate::ai::Keys;
use crate::settings::Settings;

#[derive(Clone, Copy, Default, PartialEq, serde::Serialize)]
pub struct Obs {
    pub connected: bool,
    pub recording: bool,
    pub streaming: bool,
    pub paused: bool,
}

fn b64(d: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(d)
}

fn auth(password: &str, salt: &str, challenge: &str) -> String {
    let secret = b64(&Sha256::digest(format!("{password}{salt}").as_bytes()));
    b64(&Sha256::digest(format!("{secret}{challenge}").as_bytes()))
}

pub fn spawn(app: AppHandle, settings: Arc<Settings>, keys: Arc<Keys>) {
    thread::spawn(move || {
        let mut last = Obs::default();
        let emit = app.clone();
        let mut send = move |s: Obs| {
            if s != last {
                last = s;
                let _ = emit.emit_to("island", "obs", s);
            }
        };
        loop {
            if !settings.bool("obsEnabled", false) {
                send(Obs::default());
                thread::sleep(Duration::from_secs(3));
                continue;
            }
            let port = settings.string("obsPort").parse::<u16>().unwrap_or(4455);
            if let Err(e) = session(port, &settings, &keys, &mut send) {
                crate::diag::log(&app, &format!("obs: {e}"));
            }
            send(Obs::default());
            thread::sleep(Duration::from_secs(8));
        }
    });
}

fn session(port: u16, settings: &Settings, keys: &Keys, send: &mut impl FnMut(Obs)) -> Result<(), String> {
    let stream = TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), Duration::from_secs(2)).map_err(|e| e.to_string())?;
    let (mut ws, _) = tungstenite::client(format!("ws://127.0.0.1:{port}"), stream).map_err(|e| e.to_string())?;
    ws.get_ref().set_read_timeout(Some(Duration::from_secs(2))).ok();
    let mut state = Obs { connected: false, ..Default::default() };
    loop {
        if !settings.bool("obsEnabled", false) {
            let _ = ws.close(None);
            return Ok(());
        }
        let msg = match ws.read() {
            Ok(m) => m,
            Err(tungstenite::Error::Io(e)) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => continue,
            Err(e) => return Err(e.to_string()),
        };
        let Message::Text(t) = msg else { continue };
        let Ok(v) = serde_json::from_str::<Value>(t.as_str()) else { continue };
        let d = &v["d"];
        match v["op"].as_u64() {
            Some(0) => {
                let mut id = json!({ "rpcVersion": 1, "eventSubscriptions": 64 });
                if let (Some(c), Some(s)) = (d["authentication"]["challenge"].as_str(), d["authentication"]["salt"].as_str()) {
                    let pw = keys.get("obs").unwrap_or_default();
                    id["authentication"] = auth(&pw, s, c).into();
                }
                ws.send(Message::text(json!({ "op": 1, "d": id }).to_string())).map_err(|e| e.to_string())?;
            }
            Some(2) => {
                state.connected = true;
                send(state);
                for r in ["GetRecordStatus", "GetStreamStatus"] {
                    let q = json!({ "op": 6, "d": { "requestType": r, "requestId": r } });
                    ws.send(Message::text(q.to_string())).map_err(|e| e.to_string())?;
                }
            }
            Some(5) => {
                let data = &d["eventData"];
                match d["eventType"].as_str().unwrap_or("") {
                    "RecordStateChanged" => {
                        state.recording = data["outputActive"].as_bool().unwrap_or(false);
                        state.paused = data["outputState"].as_str() == Some("OBS_WEBSOCKET_OUTPUT_PAUSED");
                    }
                    "StreamStateChanged" => state.streaming = data["outputActive"].as_bool().unwrap_or(false),
                    "ExitStarted" => return Ok(()),
                    _ => continue,
                }
                send(state);
            }
            Some(7) => {
                let r = &d["responseData"];
                match d["requestId"].as_str().unwrap_or("") {
                    "GetRecordStatus" => {
                        state.recording = r["outputActive"].as_bool().unwrap_or(false);
                        state.paused = r["outputPaused"].as_bool().unwrap_or(false);
                    }
                    "GetStreamStatus" => state.streaming = r["outputActive"].as_bool().unwrap_or(false),
                    _ => {}
                }
                send(state);
            }
            _ => {}
        }
    }
}
