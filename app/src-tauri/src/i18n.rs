// Tray menu, dialog and notification text.
//
// Every language is one JSON file under app/src-tauri/locales/<code>.json,
// compiled in by build.rs, so adding a language is adding its file. Keys
// missing from a translation fall back to English.
//
// The language is the one chosen in the dashboard: it is saved by the daemon
// in <daemon home>/preferences.json ({"locale": "es"}). With nothing saved,
// the system language (LC_ALL / LC_MESSAGES / LANG, then the macOS setting)
// is used when there is a translation for it, else English.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{OnceLock, RwLock};

include!(concat!(env!("OUT_DIR"), "/locales.rs"));

pub const DEFAULT_LOCALE: &str = "en";

type Catalog = HashMap<String, String>;

fn flatten(prefix: &str, v: &serde_json::Value, out: &mut Catalog) {
    match v {
        serde_json::Value::Object(m) => {
            for (k, v) in m {
                let key = if prefix.is_empty() { k.clone() } else { format!("{prefix}.{k}") };
                flatten(&key, v, out);
            }
        }
        serde_json::Value::String(s) => {
            out.insert(prefix.to_string(), s.clone());
        }
        _ => {}
    }
}

fn catalogs() -> &'static HashMap<&'static str, Catalog> {
    static CATALOGS: OnceLock<HashMap<&'static str, Catalog>> = OnceLock::new();
    CATALOGS.get_or_init(|| {
        LOCALES
            .iter()
            .map(|(code, src)| {
                let mut cat = Catalog::new();
                let v: serde_json::Value = serde_json::from_str(src).unwrap_or_else(|e| panic!("locales/{code}.json: {e}"));
                flatten("", &v, &mut cat);
                (*code, cat)
            })
            .collect()
    })
}

fn current() -> &'static RwLock<String> {
    static CURRENT: OnceLock<RwLock<String>> = OnceLock::new();
    CURRENT.get_or_init(|| RwLock::new(DEFAULT_LOCALE.to_string()))
}

/// The best language there is a translation for ("es-MX", "es_ES.UTF-8" -> "es").
pub fn match_locale(tag: &str) -> Option<&'static str> {
    let tag = tag.split('.').next().unwrap_or("").replace('_', "-");
    if tag.is_empty() || tag == "C" || tag == "POSIX" {
        return None;
    }
    let cats = catalogs();
    if let Some((code, _)) = cats.get_key_value(tag.as_str()) {
        return Some(code);
    }
    let base = tag.split('-').next().unwrap_or("").to_lowercase();
    let mut codes: Vec<&&str> = cats.keys().collect();
    codes.sort();
    codes.into_iter().find(|c| c.eq_ignore_ascii_case(&tag) || c.split('-').next().unwrap_or("").eq_ignore_ascii_case(&base)).copied()
}

/// The locale saved in preferences.json, if any and if there is a translation for it.
pub fn saved_locale(daemon_home: &Path) -> Option<&'static str> {
    let text = std::fs::read_to_string(daemon_home.join("preferences.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    match_locale(v.get("locale")?.as_str()?)
}

fn system_locale() -> Option<&'static str> {
    for var in ["LC_ALL", "LC_MESSAGES", "LANG"] {
        if let Ok(v) = std::env::var(var) {
            if let Some(code) = match_locale(&v) {
                return Some(code);
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        // Apps opened from Finder get no LANG; ask the system.
        let out = std::process::Command::new("defaults").args(["read", "-g", "AppleLanguages"]).output().ok()?;
        let text = String::from_utf8_lossy(&out.stdout);
        for tag in text.split(|c: char| !(c.is_alphanumeric() || c == '-' || c == '_')).filter(|s| !s.is_empty()) {
            if let Some(code) = match_locale(tag) {
                return Some(code);
            }
        }
    }
    None
}

/// The language to use: the saved choice, else the system's, else English.
pub fn resolve(daemon_home: &Path) -> &'static str {
    saved_locale(daemon_home).or_else(system_locale).unwrap_or(DEFAULT_LOCALE)
}

/// Switch language. Returns true when it changed.
pub fn set_locale(code: &str) -> bool {
    let code = if catalogs().contains_key(code) { code } else { DEFAULT_LOCALE };
    let mut cur = current().write().unwrap_or_else(|e| e.into_inner());
    if *cur == code {
        return false;
    }
    *cur = code.to_string();
    true
}

pub fn locale() -> String {
    current().read().unwrap_or_else(|e| e.into_inner()).clone()
}

/// Translate a key. Unknown keys come back as the key.
pub fn tr(key: &str) -> String {
    trf(key, &[])
}

/// Translate a key and fill its {placeholders}.
pub fn trf(key: &str, params: &[(&str, &str)]) -> String {
    let cats = catalogs();
    let cur = locale();
    let msg = cats
        .get(cur.as_str())
        .and_then(|c| c.get(key))
        .or_else(|| cats.get(DEFAULT_LOCALE).and_then(|c| c.get(key)))
        .cloned()
        .unwrap_or_else(|| key.to_string());
    params.iter().fold(msg, |m, (name, value)| m.replace(&format!("{{{name}}}"), value))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn placeholders(s: &str) -> Vec<String> {
        let mut out: Vec<String> = s
            .split('{')
            .skip(1)
            .filter_map(|p| p.split_once('}').map(|(n, _)| n.to_string()))
            .filter(|n| !n.is_empty() && n.chars().all(|c| c.is_alphanumeric()))
            .collect();
        out.sort();
        out
    }

    #[test]
    fn every_language_has_the_english_keys_and_placeholders() {
        let cats = catalogs();
        let en = &cats[DEFAULT_LOCALE];
        for (code, cat) in cats {
            for (k, v) in en {
                let t = cat.get(k).unwrap_or_else(|| panic!("{code}: missing {k}"));
                assert_eq!(placeholders(t), placeholders(v), "{code}: {k} placeholders");
            }
            for k in cat.keys() {
                assert!(en.contains_key(k), "{code}: {k} is not an English key");
            }
        }
    }

    #[test]
    fn matches_system_and_saved_tags() {
        assert_eq!(match_locale("es_ES.UTF-8"), Some("es"));
        assert_eq!(match_locale("es-MX"), Some("es"));
        assert_eq!(match_locale("en-GB"), Some("en"));
        assert_eq!(match_locale("C"), None);
        assert_eq!(match_locale("xx"), None);
        let dir = std::env::temp_dir().join(format!("plughive-i18n-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("preferences.json"), r#"{"locale":"es"}"#).unwrap();
        assert_eq!(saved_locale(&dir), Some("es"));
        std::fs::write(dir.join("preferences.json"), "not json").unwrap();
        assert_eq!(saved_locale(&dir), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn fills_placeholders_and_falls_back() {
        assert_eq!(trf("status.attention", &[("why", "x")]), "Needs attention: x");
        assert_eq!(tr("no.such.key"), "no.such.key");
    }
}
