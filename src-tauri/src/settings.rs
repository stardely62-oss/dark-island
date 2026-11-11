//! User settings: a flat JSON object in the app's data folder. The UI owns
//! the defaults; Rust reads the few keys it needs with a fallback.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::{Map, Value};

pub struct Settings {
    file: PathBuf,
    values: Mutex<Map<String, Value>>,
}

impl Settings {
    pub fn load(dir: &Path) -> Self {
        let file = dir.join("settings.json");
        let values = fs::read(&file)
            .ok()
            .and_then(|b| serde_json::from_slice::<Map<String, Value>>(&b).ok())
            .unwrap_or_default();
        Self { file, values: Mutex::new(values) }
    }

    pub fn all(&self) -> Map<String, Value> {
        self.values.lock().unwrap().clone()
    }

    /// Merges `patch` in (a `null` removes a key) and saves.
    pub fn merge(&self, patch: Map<String, Value>) -> Map<String, Value> {
        let mut v = self.values.lock().unwrap();
        for (k, val) in patch {
            if val.is_null() {
                v.remove(&k);
            } else {
                v.insert(k, val);
            }
        }
        if let Ok(bytes) = serde_json::to_vec_pretty(&*v) {
            let tmp = self.file.with_extension("tmp");
            if fs::write(&tmp, bytes).is_ok() {
                let _ = fs::rename(&tmp, &self.file);
            }
        }
        v.clone()
    }

    pub fn bool(&self, key: &str, default: bool) -> bool {
        self.values.lock().unwrap().get(key).and_then(Value::as_bool).unwrap_or(default)
    }

    pub fn string(&self, key: &str) -> String {
        self.values.lock().unwrap().get(key).and_then(Value::as_str).unwrap_or("").to_string()
    }

    pub fn strings(&self, key: &str) -> Vec<String> {
        self.values
            .lock()
            .unwrap()
            .get(key)
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|s| s.as_str().map(str::to_lowercase)).collect())
            .unwrap_or_default()
    }
}
