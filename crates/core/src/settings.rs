//! Atlas's own settings: `<data dir>/settings.json`.
//!
//! Never confuse this with Claude Code's `settings.json`. Rules:
//! - loading never fails: a missing file gives defaults, a damaged file is moved
//!   aside (`settings.json.corrupt-<time>`) and defaults are used, so a bad write
//!   can never stop the app from starting;
//! - each field is read on its own, so one bad value keeps the others;
//! - keys this version does not know are kept and written back (a newer Atlas
//!   may have added them);
//! - writes are atomic (`fsutil::atomic_write`).

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::fsutil::atomic_write;

pub const SCHEMA_VERSION: u32 = 1;
pub const FILE_NAME: &str = "settings.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    #[default]
    System,
    Light,
    Dark,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum View {
    #[default]
    Dashboard,
    Sessions,
    Setup,
    History,
    Wrapped,
    Settings,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub schema_version: u32,
    pub theme: Theme,
    pub last_view: View,
    /// A Claude config folder chosen in Settings (below `--config-dir`, above
    /// `CLAUDE_CONFIG_DIR`).
    pub config_dir_override: Option<String>,
    /// Start in Sandbox Mode.
    pub sandbox: bool,
    /// Play the launch animation on a cold start (default on).
    pub launch_animation: bool,
    /// Keys this version does not know, kept as they were.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            schema_version: SCHEMA_VERSION,
            theme: Theme::System,
            last_view: View::Dashboard,
            config_dir_override: None,
            sandbox: false,
            launch_animation: true,
            extra: Map::new(),
        }
    }
}

const KNOWN: [&str; 6] =
    ["schemaVersion", "theme", "lastView", "configDirOverride", "sandbox", "launchAnimation"];

impl Settings {
    /// Read settings from JSON text. `None` when the text is not a JSON object.
    pub fn from_json(text: &str) -> Option<Settings> {
        let text = text.strip_prefix('\u{feff}').unwrap_or(text);
        let Value::Object(mut map) = serde_json::from_str::<Value>(text).ok()? else {
            return None;
        };
        let mut take = |k: &str| map.remove(k);
        let d = Settings::default();
        let schema_version = take("schemaVersion")
            .and_then(|v| v.as_u64())
            .map(|v| v.max(SCHEMA_VERSION as u64) as u32)
            .unwrap_or(d.schema_version);
        let theme = take("theme").and_then(|v| serde_json::from_value(v).ok()).unwrap_or(d.theme);
        let last_view =
            take("lastView").and_then(|v| serde_json::from_value(v).ok()).unwrap_or(d.last_view);
        let config_dir_override = take("configDirOverride")
            .and_then(|v| v.as_str().map(str::to_owned))
            .filter(|s| !s.trim().is_empty());
        let sandbox = take("sandbox").and_then(|v| v.as_bool()).unwrap_or(false);
        let launch_animation =
            take("launchAnimation").and_then(|v| v.as_bool()).unwrap_or(d.launch_animation);
        for k in KNOWN {
            map.remove(k);
        }
        Some(Settings {
            schema_version,
            theme,
            last_view,
            config_dir_override,
            sandbox,
            launch_animation,
            extra: map,
        })
    }

    pub fn to_json(&self) -> String {
        let mut s = serde_json::to_string_pretty(self).expect("settings serialize");
        s.push('\n');
        s
    }
}

#[derive(Debug)]
pub struct Loaded {
    pub settings: Settings,
    /// Where a damaged file was moved to, if there was one.
    pub recovered_from: Option<PathBuf>,
}

pub fn path_in(data_dir: &Path) -> PathBuf {
    data_dir.join(FILE_NAME)
}

/// Load `<data_dir>/settings.json`. Never fails.
pub fn load(data_dir: &Path) -> Loaded {
    let path = path_in(data_dir);
    let text = match fs::read(&path) {
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        Err(_) => return Loaded { settings: Settings::default(), recovered_from: None },
    };
    match Settings::from_json(&text) {
        Some(settings) => Loaded { settings, recovered_from: None },
        None => {
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            let aside = data_dir.join(format!("{FILE_NAME}.corrupt-{stamp}"));
            let moved = fs::rename(&path, &aside).ok().map(|_| aside);
            Loaded { settings: Settings::default(), recovered_from: moved }
        }
    }
}

pub fn save(data_dir: &Path, settings: &Settings) -> io::Result<()> {
    atomic_write(&path_in(data_dir), settings.to_json().as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn missing_file_gives_defaults() {
        let d = tempdir().unwrap();
        let l = load(d.path());
        assert_eq!(l.settings, Settings::default());
        assert!(l.recovered_from.is_none());
    }

    #[test]
    fn round_trips_and_keeps_unknown_keys() {
        let d = tempdir().unwrap();
        fs::write(
            path_in(d.path()),
            r#"{"schemaVersion":1,"theme":"dark","lastView":"setup","futureThing":{"a":[1,2]}}"#,
        )
        .unwrap();
        let mut l = load(d.path());
        assert_eq!(l.settings.theme, Theme::Dark);
        assert_eq!(l.settings.last_view, View::Setup);
        l.settings.last_view = View::History;
        save(d.path(), &l.settings).unwrap();
        let text = fs::read_to_string(path_in(d.path())).unwrap();
        assert!(text.contains("\"futureThing\""), "unknown key lost: {text}");
        assert!(text.contains("\"history\""));
        let again = load(d.path());
        assert_eq!(again.settings, l.settings);
    }

    #[test]
    fn one_bad_value_keeps_the_rest() {
        let s = Settings::from_json(r#"{"theme":"purple","lastView":"wrapped","sandbox":"yes"}"#).unwrap();
        assert_eq!(s.theme, Theme::System);
        assert_eq!(s.last_view, View::Wrapped);
        assert!(!s.sandbox);
    }

    #[test]
    fn launch_animation_defaults_on_and_persists() {
        assert!(Settings::default().launch_animation);
        assert!(Settings::from_json("{}").unwrap().launch_animation);
        assert!(Settings::from_json(r#"{"launchAnimation":"no"}"#).unwrap().launch_animation);
        let d = tempdir().unwrap();
        let mut s = Settings::default();
        s.launch_animation = false;
        save(d.path(), &s).unwrap();
        let text = fs::read_to_string(path_in(d.path())).unwrap();
        assert!(text.contains("\"launchAnimation\": false"), "{text}");
        assert!(!load(d.path()).settings.launch_animation);
    }

    #[test]
    fn corrupt_file_is_moved_aside_and_defaults_used() {
        let d = tempdir().unwrap();
        fs::write(path_in(d.path()), b"{ this is not json").unwrap();
        let l = load(d.path());
        assert_eq!(l.settings, Settings::default());
        let aside = l.recovered_from.expect("moved aside");
        assert_eq!(fs::read(&aside).unwrap(), b"{ this is not json");
        assert!(!path_in(d.path()).exists());
    }

    #[test]
    fn a_json_array_is_not_settings() {
        assert!(Settings::from_json("[1,2,3]").is_none());
    }

    #[test]
    fn bom_and_blank_override_are_tolerated() {
        let s = Settings::from_json("\u{feff}{\"configDirOverride\":\"  \"}").unwrap();
        assert_eq!(s.config_dir_override, None);
    }

    #[test]
    fn newer_schema_version_is_not_downgraded() {
        let s = Settings::from_json(r#"{"schemaVersion":7}"#).unwrap();
        assert_eq!(s.schema_version, 7);
    }
}
