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
        c("Остров", "Горячие клавиши", "ok", crate::i18n::tr("все сочетания заняты островом", "all shortcuts belong to the island"))
    } else {
        c("Остров", "Горячие клавиши", "warn", L!("заняты другой программой: {}", "taken by another app: {}", taken.join(", ")))
    });
    out.push(match tauri::webview_version() {
        Ok(v) => c("Остров", "WebView2", "ok", L!("версия {v}", "version {v}")),
        Err(e) => c("Остров", "WebView2", "fail", L!("не найден: {e}", "not found: {e}")),
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
        c("Остров", "Папка настроек", "fail", crate::i18n::tr("нельзя записать — настройки и заметки не сохранятся", "can't write — settings and notes won't be saved"))
    });

    // ---- sound ----
    #[cfg(windows)]
    {
        let dev = crate::sys::devices::audio_devices();
        out.push(if dev.outputs.is_empty() {
            c("Звук", "Динамики", "fail", crate::i18n::tr("Windows не видит ни одного устройства вывода", "Windows sees no output device"))
        } else {
            c("Звук", "Динамики", "ok", L!("{} шт.", "{} found", dev.outputs.len()))
        });
        out.push(if dev.inputs.is_empty() {
            c("Звук", "Микрофон", "warn", crate::i18n::tr("микрофонов нет — диктовка и запись голоса не заработают", "no microphones — dictation and voice recording won't work"))
        } else {
            c("Звук", "Микрофон", "ok", L!("{} шт.", "{} found", dev.inputs.len()))
        });
        let base = "Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone";
        let all = crate::sys::reg_hkcu(base, "Value").unwrap_or_default();
        let desktop = crate::sys::reg_hkcu(&format!("{base}\\NonPackaged"), "Value").unwrap_or_default();
        out.push(if all == "Deny" || desktop == "Deny" {
            c("Звук", "Доступ к микрофону", "fail", crate::i18n::tr("запрещён в Параметрах → Конфиденциальность → Микрофон (для классических приложений)", "blocked in Settings → Privacy → Microphone (for desktop apps)"))
        } else {
            c("Звук", "Доступ к микрофону", "ok", crate::i18n::tr("разрешён", "allowed"))
        });
        let busy = crate::sys::in_use("microphone");
        out.push(if busy.is_empty() {
            c("Звук", "Микрофон сейчас", "ok", crate::i18n::tr("никто не слушает", "nobody is listening"))
        } else {
            c("Звук", "Микрофон сейчас", "warn", L!("слушает: {} (это и есть оранжевая точка)", "listening: {} (that's the orange dot)", busy.join(", ")))
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
            c("Распознавание", "Текст с экрана", "fail", crate::i18n::tr("нет языков распознавания: Параметры → Время и язык → Язык → добавить пакет", "no recognition languages: Settings → Time & language → Language → add a pack"))
        } else if !ocr.iter().any(|l| l.starts_with("ru")) {
            c("Распознавание", "Текст с экрана", "warn", L!("есть: {}; русского нет — добавь русский языковой пакет", "available: {}; no Russian — add the Russian language pack", ocr.join(", ")))
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
            c("Распознавание", "Диктовка Windows", if windows_stt { "fail" } else { "warn" }, crate::i18n::tr("нет языков диктовки: Параметры → Время и язык → Речь", "no dictation languages: Settings → Time & language → Speech"))
        } else if !speech.iter().any(|l| l.starts_with(want)) {
            c("Распознавание", "Диктовка Windows", if windows_stt { "fail" } else { "warn" }, L!("есть: {}; нужного языка нет — поставь пакет речи", "available: {}; the needed language is missing — install a speech pack", speech.join(", ")))
        } else {
            c("Распознавание", "Диктовка Windows", "ok", speech.join(", "))
        });
        let online = crate::sys::reg_hkcu("Software\\Microsoft\\Speech_OneCore\\Settings\\OnlineSpeechPrivacy", "HasAccepted").unwrap_or_default();
        out.push(if online == "1" {
            c("Распознавание", "Речь в сети", "ok", crate::i18n::tr("включено", "on"))
        } else {
            c("Распознавание", "Речь в сети", if windows_stt { "fail" } else { "warn" }, crate::i18n::tr("выключено — диктовка Windows не запустится. Параметры → Конфиденциальность → Речь", "off — Windows dictation won't start. Settings → Privacy → Speech"))
        });
        if !windows_stt {
            out.push(if ctl.keys.has(&service) {
                c("Распознавание", "Ключ Whisper", "ok", service)
            } else {
                c("Распознавание", "Ключ Whisper", "fail", L!("нет ключа {service} — диктовка не заработает", "no {service} key — dictation won't work"))
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
        c("ИИ", "Ключ ИИ", "warn", L!("нет ключа для {provider} — чат и кнопки ИИ не ответят", "no key for {provider} — chat and AI buttons won't answer"))
    });

    // ---- system ----
    #[cfg(windows)]
    {
        let r = crate::sys::controls_get();
        out.push(match r.wifi {
            Some(_) => c("Система", "Wi-Fi", "ok", crate::i18n::tr("переключается с острова", "switchable from the island")),
            None => c("Система", "Wi-Fi", "warn", crate::i18n::tr("адаптера нет (или Windows не даёт им управлять)", "no adapter (or Windows doesn't allow controlling it)")),
        });
        out.push(match r.bluetooth {
            Some(_) => c("Система", "Bluetooth", "ok", crate::i18n::tr("переключается с острова", "switchable from the island")),
            None => c("Система", "Bluetooth", "warn", crate::i18n::tr("адаптера нет (или Windows не даёт им управлять)", "no adapter (or Windows doesn't allow controlling it)")),
        });
        let n = crate::sys::notifications_access(false);
        let want = s.bool("showNotifications", false);
        out.push(match (n.as_str(), want) {
            ("allowed", _) => c("Система", "Уведомления Windows", "ok", crate::i18n::tr("доступ есть", "access granted")),
            (_, false) => c("Система", "Уведомления Windows", "ok", crate::i18n::tr("показ на острове выключен", "showing on the island is off")),
            _ => c("Система", "Уведомления Windows", "fail", crate::i18n::tr("нет доступа — разреши в настройках острова («Разное»)", "no access — allow it in the island settings (Misc)")),
        });
    }
    out.push(match crate::sys::vpn_now() {
        Some(v) => c("Система", "VPN", "ok", L!("включён: {v}", "on: {v}")),
        None => c("Система", "VPN", "ok", crate::i18n::tr("сейчас выключен", "off now")),
    });

    // ---- network ----
    let net = crate::live::get_json("https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=55.75&lon=37.62").is_some();
    out.push(if net {
        c("Сеть", "Погода", "ok", crate::i18n::tr("MET Norway отвечает", "MET Norway responds"))
    } else {
        c("Сеть", "Погода", "fail", crate::i18n::tr("нет связи с api.met.no — погода не обновится", "no connection to api.met.no — the weather won't update"))
    });

    // ---- agents, OBS, Steam ----
    let a = &ctl.agents;
    let alive = a.port != 0 && std::net::TcpStream::connect_timeout(&([127, 0, 0, 1], a.port).into(), Duration::from_secs(1)).is_ok();
    out.push(if alive {
        c("Агенты", "Приёмник сигналов", "ok", L!("порт {}", "port {}", a.port))
    } else {
        c("Агенты", "Приёмник сигналов", "fail", crate::i18n::tr("не запущен — Claude Code, Codex и opencode не смогут сообщать", "not running — Claude Code, Codex and opencode can't report"))
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
            Some(sec) => c("Агенты", title, "ok", L!("подключён, последний сигнал {} мин назад", "connected, last signal {} min ago", sec / 60)),
            None => c("Агенты", title, "warn", L!("подключён, но с запуска острова {name} ещё ничего не присылал — перезапусти его", "connected, but {name} hasn't sent anything since the island started — restart it")),
        });
    }
    if conn.codex && !conn.codex_hooks {
        out.push(c("Агенты", "Codex: вопросы", "warn", crate::i18n::tr("хук для вопросов о разрешении не установлен — в настройках, раздел «Агенты», нажми «Починить» у Codex и перезапусти Codex", "the permission-question hook isn't installed — in the settings, Agents section, press “Repair” for Codex and restart Codex")));
    } else if conn.codex {
        out.push(c("Агенты", "Codex: вопросы", "ok", crate::i18n::tr("хук установлен и одобрен; перезапусти Codex, если он был открыт", "hook installed and approved; restart Codex if it was open")));
    }
    if s.bool("obsEnabled", false) {
        let port = s.string("obsPort").parse::<u16>().unwrap_or(4455);
        let ok = std::net::TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), Duration::from_secs(1)).is_ok();
        out.push(if ok {
            c("Программы", "OBS", "ok", L!("WebSocket на порту {port} отвечает", "WebSocket on port {port} responds"))
        } else {
            c("Программы", "OBS", "warn", L!("на порту {port} никого — OBS закрыт или в нём выключен WebSocket-сервер", "nothing on port {port} — OBS is closed or its WebSocket server is off"))
        });
    }
    out.push(match crate::sys::steam_path() {
        Some(p) => c("Программы", "Steam", "ok", p),
        None => c("Программы", "Steam", "ok", crate::i18n::tr("не установлен — загрузки Steam показываться не будут", "not installed — Steam downloads won't be shown")),
    });
    out
}
