//! The self-check: the island tries each thing it relies on, on this very
//! computer, and says plainly what works, what does not and what to do.

use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::Ctl;

/// Global hotkeys another program already owns (filled at start-up).
pub static HOTKEYS_TAKEN: Mutex<Vec<String>> = Mutex::new(Vec::new());

#[derive(Serialize)]
pub struct Check {
    pub group: &'static str,
    pub title: &'static str,
    /// "ok", "warn" (works, but…) or "fail".
    pub status: &'static str,
    pub detail: String,
}

fn c(group: &'static str, title: &'static str, status: &'static str, detail: impl Into<String>) -> Check {
    Check { group, title, status, detail: detail.into() }
}

pub fn run(app: &AppHandle) -> Vec<Check> {
    let ctl = app.state::<Ctl>();
    let s = &ctl.settings;
    let mut out = Vec::new();

    // ---- the island itself ----
    let taken = HOTKEYS_TAKEN.lock().unwrap().clone();
    out.push(if taken.is_empty() {
        c("Остров", "Горячие клавиши", "ok", "все сочетания заняты островом")
    } else {
        c("Остров", "Горячие клавиши", "warn", format!("заняты другой программой: {}", taken.join(", ")))
    });
    out.push(match tauri::webview_version() {
        Ok(v) => c("Остров", "WebView2", "ok", format!("версия {v}")),
        Err(e) => c("Остров", "WebView2", "fail", format!("не найден: {e}")),
    });
    let dir = app.path().app_data_dir().ok();
    let writable = dir.as_ref().is_some_and(|d| {
        let f = d.join(".check");
        let ok = std::fs::write(&f, b"ok").is_ok();
        let _ = std::fs::remove_file(&f);
        ok
    });
    out.push(if writable {
        c("Остров", "Папка настроек", "ok", dir.map(|d| d.to_string_lossy().into_owned()).unwrap_or_default())
    } else {
        c("Остров", "Папка настроек", "fail", "нельзя записать — настройки и заметки не сохранятся")
    });

    // ---- sound ----
    #[cfg(windows)]
    {
        let dev = crate::sys::devices::audio_devices();
        out.push(if dev.outputs.is_empty() {
            c("Звук", "Динамики", "fail", "Windows не видит ни одного устройства вывода")
        } else {
            c("Звук", "Динамики", "ok", format!("{} шт.", dev.outputs.len()))
        });
        out.push(if dev.inputs.is_empty() {
            c("Звук", "Микрофон", "warn", "микрофонов нет — диктовка и запись голоса не заработают")
        } else {
            c("Звук", "Микрофон", "ok", format!("{} шт.", dev.inputs.len()))
        });
        let base = "Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone";
        let all = crate::sys::reg_hkcu(base, "Value").unwrap_or_default();
        let desktop = crate::sys::reg_hkcu(&format!("{base}\\NonPackaged"), "Value").unwrap_or_default();
        out.push(if all == "Deny" || desktop == "Deny" {
            c("Звук", "Доступ к микрофону", "fail", "запрещён в Параметрах → Конфиденциальность → Микрофон (для классических приложений)")
        } else {
            c("Звук", "Доступ к микрофону", "ok", "разрешён")
        });
        let busy = crate::sys::in_use("microphone");
        out.push(if busy.is_empty() {
            c("Звук", "Микрофон сейчас", "ok", "никто не слушает")
        } else {
            c("Звук", "Микрофон сейчас", "warn", format!("слушает: {} (это и есть оранжевая точка)", busy.join(", ")))
        });
    }

    // ---- voice and text recognition ----
    #[cfg(windows)]
    {
        use windows::Media::Ocr::OcrEngine;
        use windows::Media::SpeechRecognition::SpeechRecognizer;
        let ocr: Vec<String> = OcrEngine::AvailableRecognizerLanguages()
            .map(|v| v.into_iter().filter_map(|l| l.LanguageTag().ok().map(|t| t.to_string_lossy())).collect())
            .unwrap_or_default();
        out.push(if ocr.is_empty() {
            c("Распознавание", "Текст с экрана", "fail", "нет языков распознавания: Параметры → Время и язык → Язык → добавить пакет")
        } else if !ocr.iter().any(|l| l.starts_with("ru")) {
            c("Распознавание", "Текст с экрана", "warn", format!("есть: {}; русского нет — добавь русский языковой пакет", ocr.join(", ")))
        } else {
            c("Распознавание", "Текст с экрана", "ok", ocr.join(", "))
        });
        let speech: Vec<String> = SpeechRecognizer::SupportedTopicLanguages()
            .map(|v| v.into_iter().filter_map(|l| l.LanguageTag().ok().map(|t| t.to_string_lossy())).collect())
            .unwrap_or_default();
        let service = s.string("sttService");
        let windows_stt = service.is_empty() || service == "windows";
        let lang = s.string("sttLang");
        let want = if lang.is_empty() || lang == "ru" { "ru" } else { "en" };
        out.push(if speech.is_empty() {
            c("Распознавание", "Диктовка Windows", if windows_stt { "fail" } else { "warn" }, "нет языков диктовки: Параметры → Время и язык → Речь")
        } else if !speech.iter().any(|l| l.starts_with(want)) {
            c("Распознавание", "Диктовка Windows", if windows_stt { "fail" } else { "warn" }, format!("есть: {}; нужного языка нет — поставь пакет речи", speech.join(", ")))
        } else {
            c("Распознавание", "Диктовка Windows", "ok", speech.join(", "))
        });
        let online = crate::sys::reg_hkcu("Software\\Microsoft\\Speech_OneCore\\Settings\\OnlineSpeechPrivacy", "HasAccepted").unwrap_or_default();
        out.push(if online == "1" {
            c("Распознавание", "Речь в сети", "ok", "включено")
        } else {
            c("Распознавание", "Речь в сети", if windows_stt { "fail" } else { "warn" }, "выключено — диктовка Windows не запустится. Параметры → Конфиденциальность → Речь")
        });
        if !windows_stt {
            out.push(if ctl.keys.has(&service) {
                c("Распознавание", "Ключ Whisper", "ok", service)
            } else {
                c("Распознавание", "Ключ Whisper", "fail", format!("нет ключа {service} — диктовка не заработает"))
            });
        }
    }

    // ---- AI ----
    let provider = {
        let p = s.string("aiProvider");
        if p.is_empty() { "anthropic".to_string() } else { p }
    };
    out.push(if provider == "custom" || ctl.keys.has(&provider) {
        c("ИИ", "Ключ ИИ", "ok", provider)
    } else {
        c("ИИ", "Ключ ИИ", "warn", format!("нет ключа для {provider} — чат и кнопки ИИ не ответят"))
    });

    // ---- system ----
    #[cfg(windows)]
    {
        let r = crate::sys::controls_get();
        out.push(match r.wifi {
            Some(_) => c("Система", "Wi-Fi", "ok", "переключается с острова"),
            None => c("Система", "Wi-Fi", "warn", "адаптера нет (или Windows не даёт им управлять)"),
        });
        out.push(match r.bluetooth {
            Some(_) => c("Система", "Bluetooth", "ok", "переключается с острова"),
            None => c("Система", "Bluetooth", "warn", "адаптера нет (или Windows не даёт им управлять)"),
        });
        let n = crate::sys::notifications_access(false);
        let want = s.bool("showNotifications", false);
        out.push(match (n.as_str(), want) {
            ("allowed", _) => c("Система", "Уведомления Windows", "ok", "доступ есть"),
            (_, false) => c("Система", "Уведомления Windows", "ok", "показ на острове выключен"),
            _ => c("Система", "Уведомления Windows", "fail", "нет доступа — разреши в настройках острова («Разное»)"),
        });
    }
    out.push(match crate::sys::vpn_now() {
        Some(v) => c("Система", "VPN", "ok", format!("включён: {v}")),
        None => c("Система", "VPN", "ok", "сейчас выключен"),
    });

    // ---- network ----
    let net = crate::live::get_json("https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=55.75&lon=37.62").is_some();
    out.push(if net {
        c("Сеть", "Погода", "ok", "MET Norway отвечает")
    } else {
        c("Сеть", "Погода", "fail", "нет связи с api.met.no — погода не обновится")
    });

    // ---- agents, OBS, Steam ----
    let a = &ctl.agents;
    let alive = a.port != 0 && std::net::TcpStream::connect_timeout(&([127, 0, 0, 1], a.port).into(), Duration::from_secs(1)).is_ok();
    out.push(if alive {
        c("Агенты", "Приёмник сигналов", "ok", format!("порт {}", a.port))
    } else {
        c("Агенты", "Приёмник сигналов", "fail", "не запущен — Claude Code, Codex и opencode не смогут сообщать")
    });
    let conn = crate::agents::connections();
    for (id, name, on) in [("claude", "Claude Code", conn.claude), ("codex", "Codex", conn.codex), ("opencode", "opencode", conn.opencode)] {
        if !on {
            continue;
        }
        let title: &'static str = match id {
            "claude" => "Claude Code",
            "codex" => "Codex",
            _ => "opencode",
        };
        out.push(match conn.seen.get(id) {
            Some(sec) => c("Агенты", title, "ok", format!("подключён, последний сигнал {} мин назад", sec / 60)),
            None => c("Агенты", title, "warn", format!("подключён, но с запуска острова {name} ещё ничего не присылал — перезапусти его")),
        });
    }
    if conn.codex && !conn.codex_hooks {
        out.push(c("Агенты", "Codex: вопросы", "warn", "хук для вопросов о разрешении не установлен — нажми «Отключить» и «Подключить» у Codex"));
    } else if conn.codex {
        out.push(c("Агенты", "Codex: вопросы", "ok", "хук установлен; если вопросы не приходят — в Codex набери /hooks и одобри хук с dark-island в команде"));
    }
    if s.bool("obsEnabled", false) {
        let port = s.string("obsPort").parse::<u16>().unwrap_or(4455);
        let ok = std::net::TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), Duration::from_secs(1)).is_ok();
        out.push(if ok {
            c("Программы", "OBS", "ok", format!("WebSocket на порту {port} отвечает"))
        } else {
            c("Программы", "OBS", "warn", format!("на порту {port} никого — OBS закрыт или в нём выключен WebSocket-сервер"))
        });
    }
    out.push(match crate::sys::steam_path() {
        Some(p) => c("Программы", "Steam", "ok", p),
        None => c("Программы", "Steam", "ok", "не установлен — загрузки Steam показываться не будут"),
    });
    out
}
