//! AI agents in a terminal (Claude Code, Codex) tell the island what they do.
//!
//! A tiny HTTP server on 127.0.0.1 receives Claude Code's HTTP hooks and
//! Codex's `notify` calls. Every request must carry the island's token.
//! A permission request is held for a short while so it can be answered on
//! the island; if nobody answers, Claude Code shows its usual prompt.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter};

use crate::settings::Settings;

const FIRST_PORT: u16 = 47326;
const MARK: &str = "/dark-island/";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEvent {
    pub agent: &'static str,
    pub session: String,
    /// working | ask | waiting | done | end | info
    pub state: &'static str,
    /// Project folder name.
    pub project: String,
    pub detail: String,
    /// For `ask`: answer with `agents_answer(id, …)` within `seconds`.
    pub ask_id: u64,
    pub seconds: u64,
}

pub struct Agents {
    pub port: u16,
    pub token: String,
    pending: Mutex<HashMap<u64, Sender<bool>>>,
    next: AtomicU64,
}

impl Agents {
    pub fn answer(&self, id: u64, allow: bool) {
        if let Some(tx) = self.pending.lock().unwrap().remove(&id) {
            let _ = tx.send(allow);
        }
    }

    fn url(&self, agent: &str) -> String {
        format!("http://127.0.0.1:{}{MARK}{agent}?t={}", self.port, self.token)
    }
}

pub fn start(app: AppHandle, settings: Arc<Settings>) -> Arc<Agents> {
    let token = settings
        .all()
        .get("agentToken")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| {
            let t = new_token();
            let mut m = Map::new();
            m.insert("agentToken".into(), Value::String(t.clone()));
            settings.merge(m);
            t
        });
    // The port the hooks were installed with is preferred, so they keep working.
    let saved = settings.all().get("agentPort").and_then(Value::as_u64).map(|p| p as u16);
    let mut listener = None;
    for port in saved.into_iter().chain(FIRST_PORT..FIRST_PORT + 20) {
        if let Ok(l) = TcpListener::bind(("127.0.0.1", port)) {
            listener = Some((l, port));
            break;
        }
    }
    let port = listener.as_ref().map(|(_, p)| *p).unwrap_or(0);
    if port != 0 && saved != Some(port) {
        let mut m = Map::new();
        m.insert("agentPort".into(), Value::from(port));
        settings.merge(m);
    }
    let agents = Arc::new(Agents { port, token, pending: Mutex::new(HashMap::new()), next: AtomicU64::new(1) });
    if let Some((l, _)) = listener {
        let a = agents.clone();
        thread::Builder::new()
            .name("island-agents".into())
            .spawn(move || {
                for stream in l.incoming().flatten() {
                    let (app, a, s) = (app.clone(), a.clone(), settings.clone());
                    thread::spawn(move || {
                        let _ = handle(stream, &app, &a, &s);
                    });
                }
            })
            .expect("spawn agents thread");
    }
    agents
}

fn new_token() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let mut out = String::new();
    for _ in 0..2 {
        let mut h = RandomState::new().build_hasher();
        h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos());
        h.write_u32(std::process::id());
        out.push_str(&format!("{:016x}", h.finish()));
    }
    out
}

fn handle(stream: TcpStream, app: &AppHandle, agents: &Agents, settings: &Settings) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let target = line.split_whitespace().nth(1).unwrap_or("").to_string();
    let mut len = 0usize;
    loop {
        let mut h = String::new();
        if reader.read_line(&mut h)? == 0 || h == "\r\n" || h == "\n" {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            if k.trim().eq_ignore_ascii_case("content-length") {
                len = v.trim().parse().unwrap_or(0);
            }
        }
    }
    let mut body = vec![0u8; len.min(4 * 1024 * 1024)];
    reader.read_exact(&mut body)?;

    let (path, query) = target.split_once('?').unwrap_or((&target, ""));
    let token_ok = query.split('&').any(|kv| kv == format!("t={}", agents.token));
    let agent = path.strip_prefix(MARK).unwrap_or("");
    if !token_ok || !matches!(agent, "claude" | "codex") {
        return reply(stream, 403, "{}");
    }
    let input: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let out = if !settings.bool("agents", true) {
        "{}".to_string()
    } else if agent == "claude" {
        claude(app, agents, settings, &input)
    } else {
        codex(app, &input);
        "{}".to_string()
    };
    reply(stream, 200, &out)
}

fn reply(mut stream: TcpStream, code: u16, body: &str) -> std::io::Result<()> {
    let status = if code == 200 { "OK" } else { "Forbidden" };
    write!(
        stream,
        "HTTP/1.1 {code} {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )?;
    stream.flush()
}

fn project(input: &Value) -> String {
    let cwd = input.get("cwd").and_then(Value::as_str).unwrap_or("");
    cwd.rsplit(['/', '\\']).find(|s| !s.is_empty()).unwrap_or("").to_string()
}

fn short(s: &str, n: usize) -> String {
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if s.chars().count() > n {
        format!("{}…", s.chars().take(n).collect::<String>())
    } else {
        s
    }
}

/// What a tool is about to do, in one line.
fn describe(tool: &str, input: &Value) -> String {
    let field = |k: &str| input.get(k).and_then(Value::as_str).unwrap_or("");
    let what = match tool {
        "Bash" | "PowerShell" => field("command").to_string(),
        "Edit" | "Write" | "Read" | "NotebookEdit" | "MultiEdit" => field("file_path").to_string(),
        "WebFetch" => field("url").to_string(),
        "WebSearch" => field("query").to_string(),
        _ => {
            let d = field("description");
            if d.is_empty() {
                input.to_string()
            } else {
                d.to_string()
            }
        }
    };
    short(&format!("{tool}: {what}"), 140)
}

fn emit(app: &AppHandle, e: AgentEvent) {
    let _ = app.emit_to("island", "agent", e);
}

fn claude(app: &AppHandle, agents: &Agents, settings: &Settings, input: &Value) -> String {
    let event = input.get("hook_event_name").and_then(Value::as_str).unwrap_or("");
    let session = input.get("session_id").and_then(Value::as_str).unwrap_or("").to_string();
    let base = |state: &'static str, detail: String| AgentEvent {
        agent: "claude",
        session: session.clone(),
        state,
        project: project(input),
        detail,
        ask_id: 0,
        seconds: 0,
    };
    match event {
        "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "SubagentStart" => {
            let tool = input.get("tool_name").and_then(Value::as_str).unwrap_or("");
            emit(app, base("working", tool.to_string()));
            "{}".into()
        }
        "PermissionRequest" => {
            if !settings.bool("agentsAnswer", true) {
                emit(app, base("waiting", "Нужно разрешение".into()));
                return "{}".into();
            }
            let tool = input.get("tool_name").and_then(Value::as_str).unwrap_or("");
            let detail = describe(tool, input.get("tool_input").unwrap_or(&Value::Null));
            let seconds = 30;
            let id = agents.next.fetch_add(1, Ordering::Relaxed);
            let (tx, rx) = channel();
            agents.pending.lock().unwrap().insert(id, tx);
            emit(app, AgentEvent { ask_id: id, seconds, ..base("ask", detail) });
            let answer = rx.recv_timeout(Duration::from_secs(seconds));
            agents.pending.lock().unwrap().remove(&id);
            match answer {
                Ok(allow) => {
                    emit(app, base("working", String::new()));
                    let decision = if allow {
                        json!({ "behavior": "allow" })
                    } else {
                        json!({ "behavior": "deny", "message": "Отклонено на острове" })
                    };
                    json!({ "hookSpecificOutput": { "hookEventName": "PermissionRequest", "decision": decision } })
                        .to_string()
                }
                // Nobody answered: Claude Code asks in the terminal as usual.
                Err(_) => {
                    emit(app, base("waiting", "Ответь в терминале".into()));
                    "{}".into()
                }
            }
        }
        "Notification" => {
            let kind = input.get("notification_type").and_then(Value::as_str).unwrap_or("");
            let msg = input.get("message").and_then(Value::as_str).unwrap_or("");
            match kind {
                // Already shown through PermissionRequest.
                "permission_prompt" => {}
                "idle_prompt" => emit(app, base("waiting", "Ждёт тебя".into())),
                _ => emit(app, base("info", short(msg, 140))),
            }
            "{}".into()
        }
        "Stop" => {
            let last = input.get("last_assistant_message").and_then(Value::as_str).unwrap_or("");
            emit(app, base("done", short(last, 160)));
            "{}".into()
        }
        "SessionEnd" => {
            emit(app, base("end", String::new()));
            "{}".into()
        }
        _ => "{}".into(),
    }
}

/// Codex calls its `notify` program with one JSON argument per event.
fn codex(app: &AppHandle, input: &Value) {
    let kind = input.get("type").and_then(Value::as_str).unwrap_or("");
    if kind == "agent-turn-complete" {
        let last = input.get("last-assistant-message").and_then(Value::as_str).unwrap_or("");
        emit(
            app,
            AgentEvent {
                agent: "codex",
                session: input.get("thread-id").and_then(Value::as_str).unwrap_or("codex").to_string(),
                state: "done",
                project: project(input),
                detail: short(last, 160),
                ask_id: 0,
                seconds: 0,
            },
        );
    }
}

// --------------------------------------------------- connect / disconnect ----

fn home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from)
}

fn claude_settings() -> Option<PathBuf> {
    let dir = std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from).or_else(|| home().map(|h| h.join(".claude")))?;
    Some(dir.join("settings.json"))
}

fn codex_config() -> Option<PathBuf> {
    let dir = std::env::var_os("CODEX_HOME").map(PathBuf::from).or_else(|| home().map(|h| h.join(".codex")))?;
    Some(dir.join("config.toml"))
}

const CLAUDE_EVENTS: &[(&str, u32)] = &[
    ("SessionStart", 5),
    ("UserPromptSubmit", 5),
    ("PreToolUse", 5),
    ("PostToolUse", 5),
    ("PermissionRequest", 40),
    ("Notification", 5),
    ("Stop", 5),
    ("SessionEnd", 5),
];

#[derive(Serialize)]
pub struct Connections {
    pub claude: bool,
    pub codex: bool,
    /// Codex already has a `notify` program of its own.
    pub codex_busy: bool,
}

pub fn connections() -> Connections {
    let claude = claude_settings()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .is_some_and(|s| s.contains(MARK));
    let toml = codex_config().and_then(|p| std::fs::read_to_string(p).ok()).unwrap_or_default();
    let codex = toml.contains(MARK);
    let codex_busy = !codex && toml.lines().any(|l| l.trim_start().starts_with("notify"));
    Connections { claude, codex, codex_busy }
}

fn backup(path: &PathBuf) {
    let b = path.with_extension(format!(
        "{}.dark-island.bak",
        path.extension().and_then(|e| e.to_str()).unwrap_or("")
    ));
    if path.exists() && !b.exists() {
        let _ = std::fs::copy(path, b);
    }
}

/// Adds (or, with `on == false`, removes) the island's hooks in Claude Code's
/// user settings, leaving everything else as it was. A copy of the original
/// file is kept next to it.
pub fn connect_claude(agents: &Agents, on: bool) -> Result<(), String> {
    let path = claude_settings().ok_or("нет папки пользователя")?;
    let text = std::fs::read_to_string(&path).unwrap_or_else(|_| "{}".into());
    let mut root: Value = serde_json::from_str(&text).map_err(|_| "settings.json Claude Code не читается как JSON")?;
    let obj = root.as_object_mut().ok_or("settings.json — не объект")?;
    let hooks = obj.entry("hooks").or_insert_with(|| json!({}));
    let hooks = hooks.as_object_mut().ok_or("hooks — не объект")?;
    let ours = |g: &Value| g.to_string().contains(MARK);
    for (event, _) in CLAUDE_EVENTS {
        if let Some(Value::Array(groups)) = hooks.get_mut(*event) {
            groups.retain(|g| !ours(g));
        }
    }
    if on {
        let url = agents.url("claude");
        for (event, timeout) in CLAUDE_EVENTS {
            let groups = hooks.entry(*event).or_insert_with(|| json!([]));
            if let Value::Array(g) = groups {
                g.push(json!({ "hooks": [{ "type": "http", "url": url, "timeout": timeout }] }));
            }
        }
    }
    hooks.retain(|_, v| !matches!(v, Value::Array(a) if a.is_empty()));
    if hooks.is_empty() {
        obj.remove("hooks");
    }
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    backup(&path);
    let out = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    std::fs::write(&path, out).map_err(|e| e.to_string())
}

/// Adds or removes the island's `notify` line in Codex's config.toml.
pub fn connect_codex(agents: &Agents, on: bool) -> Result<(), String> {
    let path = codex_config().ok_or("нет папки пользователя")?;
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    let mut lines: Vec<String> = text.lines().filter(|l| !l.contains(MARK)).map(str::to_string).collect();
    if on {
        if lines.iter().any(|l| l.trim_start().starts_with("notify")) {
            return Err("у Codex уже есть свой notify".into());
        }
        // Codex appends the event JSON as the last argument: it becomes curl's body.
        let line = format!(
            "notify = [\"curl\", \"-s\", \"-m\", \"3\", \"-H\", \"Content-Type: application/json\", \"{}\", \"--data-binary\"]",
            agents.url("codex")
        );
        // Top-level keys must come before the first [table].
        let at = lines.iter().position(|l| l.trim_start().starts_with('[')).unwrap_or(lines.len());
        lines.insert(at, line);
    }
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    backup(&path);
    let mut out = lines.join("\n");
    out.push('\n');
    std::fs::write(&path, out).map_err(|e| e.to_string())
}
