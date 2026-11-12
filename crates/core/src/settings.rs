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
    /// A calm cool grey between Light and Dark. A light window as far as the OS is concerned.
    Silver,
    Dark,
}

/// Settings > Appearance > Text size. Larger adds about 2 px to body and caption text (the whole
/// ramp steps up with it, in `tokens.css`); layout and spacing stay as they are.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TextSize {
    #[default]
    Default,
    Larger,
}

/// The webview zoom steps (percent) Ctrl/Cmd + and - walk through, like a browser's.
pub const ZOOM_LEVELS: [u32; 8] = [80, 90, 100, 110, 125, 150, 175, 200];
pub const DEFAULT_ZOOM: u32 = 100;

/// The nearest step: a hand-edited 137 becomes 125, nonsense becomes 100.
pub fn snap_zoom(n: u32) -> u32 {
    ZOOM_LEVELS.iter().copied().min_by_key(|l| l.abs_diff(n)).unwrap_or(DEFAULT_ZOOM)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum View {
    #[default]
    Dashboard,
    Now,
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
    /// Closing the window hides Atlas to the tray instead of quitting (default off).
    pub close_to_tray: bool,
    /// A desktop notification when a running chat finishes or waits for input (default off).
    pub notify_on_finish: bool,
    /// Show keyboard shortcut hints (tooltips, search badges, menu accelerators). Default off;
    /// the shortcuts work either way and Help > Keyboard shortcuts always lists them.
    pub show_shortcuts: bool,
    /// Let Claude Code use Atlas: Atlas registers its MCP server by itself (default on). Turning
    /// it off in Settings disconnects and is remembered, so it never reconnects on its own.
    pub mcp_auto_connect: bool,
    /// How many versions of each file History keeps (10 to 200, default 50).
    pub history_keep_versions: u32,
    /// "Count cache in token totals": a token total is input + output + cache writes + cache reads
    /// instead of input + output (default off). Only the headline total changes; dollars always
    /// price every kind. See `usage::count`.
    pub count_cache_in_totals: bool,
    /// Text size (default Default). Applied on `<html>` before the first paint.
    pub text_size: TextSize,
    /// Webview zoom in percent, one of `ZOOM_LEVELS` (default 100). Rust applies it to the
    /// window before it is shown.
    pub zoom_percent: u32,
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
            close_to_tray: false,
            notify_on_finish: false,
            show_shortcuts: false,
            mcp_auto_connect: true,
            history_keep_versions: DEFAULT_KEEP_VERSIONS,
            count_cache_in_totals: false,
            text_size: TextSize::Default,
            zoom_percent: DEFAULT_ZOOM,
            extra: Map::new(),
        }
    }
}

pub const DEFAULT_KEEP_VERSIONS: u32 = 50;

/// The range History's "keep this many" stepper allows.
pub fn clamp_keep_versions(n: u32) -> u32 {
    n.clamp(10, 200)
}

const KNOWN: [&str; 14] = [
    "schemaVersion",
    "theme",
    "lastView",
    "configDirOverride",
    "sandbox",
    "launchAnimation",
    "closeToTray",
    "notifyOnFinish",
    "showShortcuts",
    "mcpAutoConnect",
    "historyKeepVersions",
    "countCacheInTotals",
    "textSize",
    "zoomPercent",
];

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
        let close_to_tray = take("closeToTray").and_then(|v| v.as_bool()).unwrap_or(d.close_to_tray);
        let notify_on_finish = take("notifyOnFinish").and_then(|v| v.as_bool()).unwrap_or(d.notify_on_finish);
        let show_shortcuts = take("showShortcuts").and_then(|v| v.as_bool()).unwrap_or(d.show_shortcuts);
        let mcp_auto_connect = take("mcpAutoConnect").and_then(|v| v.as_bool()).unwrap_or(d.mcp_auto_connect);
        let history_keep_versions = take("historyKeepVersions")
            .and_then(|v| v.as_u64())
            .map(|n| clamp_keep_versions(n.min(u32::MAX as u64) as u32))
            .unwrap_or(d.history_keep_versions);
        let count_cache_in_totals =
            take("countCacheInTotals").and_then(|v| v.as_bool()).unwrap_or(d.count_cache_in_totals);
        let text_size = take("textSize").and_then(|v| serde_json::from_value(v).ok()).unwrap_or(d.text_size);
        let zoom_percent = take("zoomPercent")
            .and_then(|v| v.as_u64())
            .map(|n| snap_zoom(n.min(u32::MAX as u64) as u32))
            .unwrap_or(d.zoom_percent);
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
            close_to_tray,
            notify_on_finish,
            show_shortcuts,
            mcp_auto_connect,
            history_keep_versions,
            count_cache_in_totals,
            text_size,
            zoom_percent,
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

/// Whether the saved settings count cache in token totals. Read-only (a damaged file is left
/// where it is), for the processes that are not the app: the MCP server and the CLI.
pub fn count_cache_in(data_dir: &Path) -> bool {
    fs::read(path_in(data_dir))
        .ok()
        .and_then(|b| Settings::from_json(&String::from_utf8_lossy(&b)))
        .is_some_and(|s| s.count_cache_in_totals)
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
    fn silver_is_a_theme_and_survives_a_round_trip() {
        let s = Settings::from_json(r#"{"theme":"silver"}"#).unwrap();
        assert_eq!(s.theme, Theme::Silver);
        let d = tempdir().unwrap();
        save(d.path(), &s).unwrap();
        let text = fs::read_to_string(path_in(d.path())).unwrap();
        assert!(text.contains("\"silver\""), "{text}");
        assert_eq!(load(d.path()).settings.theme, Theme::Silver);
    }

    #[test]
    fn launch_animation_defaults_on_and_persists() {
        assert!(Settings::default().launch_animation);
        assert!(Settings::from_json("{}").unwrap().launch_animation);
        assert!(Settings::from_json(r#"{"launchAnimation":"no"}"#).unwrap().launch_animation);
        let d = tempdir().unwrap();
        let s = Settings { launch_animation: false, ..Settings::default() };
        save(d.path(), &s).unwrap();
        let text = fs::read_to_string(path_in(d.path())).unwrap();
        assert!(text.contains("\"launchAnimation\": false"), "{text}");
        assert!(!load(d.path()).settings.launch_animation);
    }

    #[test]
    fn close_to_tray_defaults_off_and_persists() {
        assert!(!Settings::default().close_to_tray);
        assert!(!Settings::from_json("{}").unwrap().close_to_tray);
        assert!(!Settings::from_json(r#"{"closeToTray":"yes"}"#).unwrap().close_to_tray);
        let d = tempdir().unwrap();
        save(d.path(), &Settings { close_to_tray: true, ..Settings::default() }).unwrap();
        let text = fs::read_to_string(path_in(d.path())).unwrap();
        assert!(text.contains("\"closeToTray\": true"), "{text}");
        assert!(load(d.path()).settings.close_to_tray);
        assert!(!load(d.path()).settings.extra.contains_key("closeToTray"));
    }

    #[test]
    fn notify_on_finish_defaults_off_and_persists() {
        assert!(!Settings::default().notify_on_finish);
        assert!(!Settings::from_json("{}").unwrap().notify_on_finish);
        assert!(!Settings::from_json(r#"{"notifyOnFinish":1}"#).unwrap().notify_on_finish);
        let d = tempdir().unwrap();
        save(d.path(), &Settings { notify_on_finish: true, ..Settings::default() }).unwrap();
        assert!(fs::read_to_string(path_in(d.path())).unwrap().contains("\"notifyOnFinish\": true"));
        assert!(load(d.path()).settings.notify_on_finish);
        assert!(!load(d.path()).settings.extra.contains_key("notifyOnFinish"));
    }

    #[test]
    fn show_shortcuts_defaults_off_and_persists() {
        assert!(!Settings::default().show_shortcuts);
        // A settings file from before this field existed, or a bad value, means off.
        assert!(!Settings::from_json(r#"{"schemaVersion":1,"theme":"dark"}"#).unwrap().show_shortcuts);
        assert!(!Settings::from_json(r#"{"showShortcuts":"yes"}"#).unwrap().show_shortcuts);
        let d = tempdir().unwrap();
        save(d.path(), &Settings { show_shortcuts: true, ..Settings::default() }).unwrap();
        assert!(fs::read_to_string(path_in(d.path())).unwrap().contains("\"showShortcuts\": true"));
        assert!(load(d.path()).settings.show_shortcuts);
        assert!(!load(d.path()).settings.extra.contains_key("showShortcuts"));
    }

    #[test]
    fn letting_claude_code_use_atlas_defaults_on_and_an_off_choice_is_remembered() {
        assert!(Settings::default().mcp_auto_connect);
        // A file from before this field existed, or a bad value, means on (the default).
        assert!(Settings::from_json(r#"{"schemaVersion":1,"theme":"dark"}"#).unwrap().mcp_auto_connect);
        assert!(Settings::from_json(r#"{"mcpAutoConnect":"no"}"#).unwrap().mcp_auto_connect);
        let d = tempdir().unwrap();
        save(d.path(), &Settings { mcp_auto_connect: false, ..Settings::default() }).unwrap();
        assert!(fs::read_to_string(path_in(d.path())).unwrap().contains("\"mcpAutoConnect\": false"));
        assert!(!load(d.path()).settings.mcp_auto_connect, "the off choice survives a relaunch");
        assert!(!load(d.path()).settings.extra.contains_key("mcpAutoConnect"));
    }

    #[test]
    fn counting_cache_in_totals_defaults_off_and_persists() {
        assert!(!Settings::default().count_cache_in_totals);
        assert!(!Settings::from_json(r#"{"schemaVersion":1}"#).unwrap().count_cache_in_totals);
        assert!(!Settings::from_json(r#"{"countCacheInTotals":"yes"}"#).unwrap().count_cache_in_totals);
        assert!(Settings::from_json(r#"{"countCacheInTotals":true}"#).unwrap().count_cache_in_totals);
        let d = tempdir().unwrap();
        save(d.path(), &Settings { count_cache_in_totals: true, ..Settings::default() }).unwrap();
        assert!(load(d.path()).settings.count_cache_in_totals, "the choice survives a relaunch");
        assert!(Settings::default().to_json().contains("\"countCacheInTotals\": false"));
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
    fn text_size_and_zoom_default_and_persist() {
        let d = Settings::default();
        assert_eq!((d.text_size, d.zoom_percent), (TextSize::Default, 100));
        // A file from before these keys existed reads as the defaults (no schema bump needed).
        let old = Settings::from_json(r#"{"schemaVersion":1,"theme":"dark","showShortcuts":true}"#).unwrap();
        assert_eq!((old.text_size, old.zoom_percent, old.theme), (TextSize::Default, 100, Theme::Dark));
        // Bad values keep the other fields and fall back on their own.
        let bad = Settings::from_json(r#"{"textSize":"huge","zoomPercent":"big","theme":"silver"}"#).unwrap();
        assert_eq!((bad.text_size, bad.zoom_percent, bad.theme), (TextSize::Default, 100, Theme::Silver));
        // An off-step zoom snaps to the nearest step.
        assert_eq!(Settings::from_json(r#"{"zoomPercent":137}"#).unwrap().zoom_percent, 125);
        assert_eq!(Settings::from_json(r#"{"zoomPercent":5000}"#).unwrap().zoom_percent, 200);
        assert_eq!(Settings::from_json(r#"{"zoomPercent":0}"#).unwrap().zoom_percent, 80);
        assert_eq!(Settings::from_json(r#"{"zoomPercent":-3}"#).unwrap().zoom_percent, 100);

        let dir = tempfile::tempdir().unwrap();
        save(dir.path(), &Settings { text_size: TextSize::Larger, zoom_percent: 125, ..Settings::default() }).unwrap();
        let back = load(dir.path()).settings;
        assert_eq!((back.text_size, back.zoom_percent), (TextSize::Larger, 125));
        let text = fs::read_to_string(path_in(dir.path())).unwrap();
        assert!(text.contains("\"textSize\": \"larger\"") && text.contains("\"zoomPercent\": 125"), "{text}");
        assert!(back.extra.is_empty(), "known keys must not leak into extra");
    }

    #[test]
    fn newer_schema_version_is_not_downgraded() {
        let s = Settings::from_json(r#"{"schemaVersion":7}"#).unwrap();
        assert_eq!(s.schema_version, 7);
    }
}
