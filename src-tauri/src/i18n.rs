//! The interface language on this side: the island window tells it at
//! start (`ui_lang`), and messages pick Russian or English.

use std::sync::atomic::{AtomicBool, Ordering};

static EN: AtomicBool = AtomicBool::new(false);

pub fn set_en(on: bool) {
    EN.store(on, Ordering::Relaxed);
}

pub fn en() -> bool {
    EN.load(Ordering::Relaxed)
}

/// A fixed text in the interface language.
pub fn tr(ru: &'static str, en: &'static str) -> &'static str {
    if self::en() { en } else { ru }
}

/// `L!("ru {}", "en {}", args…)`: a formatted text in the interface language.
#[macro_export]
macro_rules! L {
    ($ru:literal, $en:literal $(, $a:expr)* $(,)?) => {
        if $crate::i18n::en() { format!($en $(, $a)*) } else { format!($ru $(, $a)*) }
    };
}
