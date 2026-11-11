//! Dictation with Windows' own speech recognition: no key, no account.
//! Windows may send the sound to its online service for the dictation
//! topic; if that is off in the privacy settings, the user is told how to
//! turn it on.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use windows::core::HSTRING;
use windows::Foundation::TypedEventHandler;
use windows::Globalization::Language;
use windows::Media::SpeechRecognition::{
    SpeechContinuousRecognitionResultGeneratedEventArgs, SpeechContinuousRecognitionSession, SpeechRecognitionResultStatus,
    SpeechRecognitionScenario, SpeechRecognitionTopicConstraint, SpeechRecognizer,
};

/// What went wrong, in words for the island. `privacy` marks the one the
/// user can fix in Windows' privacy settings.
pub struct SpeechError {
    pub text: String,
    pub privacy: bool,
}

fn err(text: &str) -> SpeechError {
    SpeechError { text: text.into(), privacy: false }
}

fn from_hr(e: windows::core::Error) -> SpeechError {
    // 0x80045509: the speech privacy policy was not accepted.
    if e.code().0 as u32 == 0x8004_5509 {
        return SpeechError { text: "Включи «Распознавание речи в сети» в Параметрах Windows".into(), privacy: true };
    }
    SpeechError { text: format!("Распознавание Windows: {}", e.message()), privacy: false }
}

/// Listens until `stop` is set, then returns everything that was said.
/// `lang` is "ru", "en" or "" (the language of Windows).
pub fn dictate(lang: &str, stop: Arc<AtomicBool>, mut on_hint: impl FnMut()) -> Result<String, SpeechError> {
    let rec = match lang {
        "ru" => SpeechRecognizer::Create(&Language::CreateLanguage(&HSTRING::from("ru-RU")).map_err(from_hr)?),
        "en" => SpeechRecognizer::Create(&Language::CreateLanguage(&HSTRING::from("en-US")).map_err(from_hr)?),
        _ => SpeechRecognizer::new(),
    }
    .map_err(|_| err("Нет распознавания речи для этого языка: Параметры → Время и язык → Речь"))?;
    let topic = SpeechRecognitionTopicConstraint::Create(SpeechRecognitionScenario::Dictation, &HSTRING::from("dictation")).map_err(from_hr)?;
    rec.Constraints().map_err(from_hr)?.Append(&topic).map_err(from_hr)?;
    let compiled = rec.CompileConstraintsAsync().map_err(from_hr)?.join().map_err(from_hr)?;
    match compiled.Status().map_err(from_hr)? {
        s if s == SpeechRecognitionResultStatus::Success => {}
        s if s == SpeechRecognitionResultStatus::TopicLanguageNotSupported => {
            return Err(err("Windows не умеет диктовку на этом языке: поставь языковой пакет речи"));
        }
        s if s == SpeechRecognitionResultStatus::NetworkFailure => return Err(err("Распознаванию Windows нужен интернет")),
        _ => return Err(err("Распознавание Windows не запустилось")),
    }
    let session: SpeechContinuousRecognitionSession = rec.ContinuousRecognitionSession().map_err(from_hr)?;
    let _ = session.SetAutoStopSilenceTimeout(windows::Foundation::TimeSpan { Duration: 600_000_000 });
    let said = Arc::new(Mutex::new(Vec::<String>::new()));
    let sink = said.clone();
    session
        .ResultGenerated(&TypedEventHandler::<SpeechContinuousRecognitionSession, SpeechContinuousRecognitionResultGeneratedEventArgs>::new(
            move |_, args| {
                if let Some(a) = args.as_ref() {
                    if let Ok(t) = a.Result().and_then(|r| r.Text()) {
                        let t = t.to_string_lossy();
                        if !t.trim().is_empty() {
                            sink.lock().unwrap().push(t.trim().to_string());
                        }
                    }
                }
                Ok(())
            },
        ))
        .map_err(from_hr)?;
    session.StartAsync().map_err(from_hr)?.join().map_err(from_hr)?;
    while !stop.load(Ordering::Relaxed) {
        std::thread::sleep(Duration::from_millis(100));
        on_hint();
    }
    // Stopping lets the last phrase finish and arrive.
    let _ = session.StopAsync().and_then(|op| op.join());
    std::thread::sleep(Duration::from_millis(150));
    let text = said.lock().unwrap().join(" ");
    Ok(text)
}
