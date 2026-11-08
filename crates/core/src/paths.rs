//! Where the Claude Code config lives.
//!
//! Order of precedence (first match wins):
//! 1. the `--config-dir` flag
//! 2. a folder the user chose in Atlas's Settings (a persisted override)
//! 3. the `CLAUDE_CONFIG_DIR` environment variable
//! 4. `~/.claude`
//!
//! Claude Code puts its global state file (`.claude.json`) *inside* the config
//! dir when `CLAUDE_CONFIG_DIR` is set, and at `~/.claude.json` otherwise.
//! A folder chosen by any non-default tier behaves like `CLAUDE_CONFIG_DIR`.
//! Resolution is pure: it never touches the disk and never reads the
//! environment itself, so tests can run in parallel.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ConfigSource {
    /// `--config-dir`
    Flag,
    /// chosen in Atlas's Settings
    Settings,
    /// `CLAUDE_CONFIG_DIR`
    Env,
    /// `~/.claude`
    Default,
    /// a Sandbox Mode copy
    Sandbox,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigRoot {
    /// The config folder (skills/, agents/, settings.json ...).
    pub dir: PathBuf,
    /// The global state file Claude Code writes constantly.
    pub claude_json: PathBuf,
    /// Where session transcripts are read from. Normally `dir/projects`; a
    /// Sandbox that links the real logs points at them here.
    pub projects_dir: PathBuf,
    /// True when `projects_dir` belongs to somebody else's config (the real
    /// one behind a sandbox): Atlas only ever reads it.
    pub projects_read_only: bool,
    pub source: ConfigSource,
}

impl ConfigRoot {
    fn for_dir(dir: PathBuf, source: ConfigSource) -> Self {
        let claude_json = dir.join(".claude.json");
        let projects_dir = dir.join("projects");
        ConfigRoot { dir, claude_json, projects_dir, projects_read_only: false, source }
    }

    /// A root whose whole tree lives in `dir` (what a sandbox copy is).
    pub fn rooted_at(dir: PathBuf, source: ConfigSource) -> Self {
        Self::for_dir(dir, source)
    }
}

pub struct ConfigInputs<'a> {
    pub flag: Option<&'a Path>,
    pub settings_override: Option<&'a Path>,
    pub env: Option<&'a OsStr>,
    pub home: &'a Path,
    pub cwd: &'a Path,
}

pub fn home_dir() -> Option<PathBuf> {
    dirs::home_dir()
}

/// Resolve the config root. Empty values count as "not set".
pub fn resolve_config_root(i: &ConfigInputs) -> ConfigRoot {
    let non_empty =
        |p: Option<&Path>| p.filter(|p| !p.as_os_str().is_empty()).map(Path::to_path_buf);
    if let Some(p) = non_empty(i.flag) {
        return ConfigRoot::for_dir(absolutize(&p, i.home, i.cwd), ConfigSource::Flag);
    }
    if let Some(p) = non_empty(i.settings_override) {
        return ConfigRoot::for_dir(absolutize(&p, i.home, i.cwd), ConfigSource::Settings);
    }
    if let Some(p) = i.env.filter(|e| !e.is_empty()) {
        return ConfigRoot::for_dir(absolutize(Path::new(p), i.home, i.cwd), ConfigSource::Env);
    }
    ConfigRoot {
        dir: i.home.join(".claude"),
        claude_json: i.home.join(".claude.json"),
        projects_dir: i.home.join(".claude").join("projects"),
        projects_read_only: false,
        source: ConfigSource::Default,
    }
}

/// `~` expansion, then relative paths against `cwd`. The path need not exist.
pub fn absolutize(p: &Path, home: &Path, cwd: &Path) -> PathBuf {
    let expanded = match p.strip_prefix("~") {
        Ok(rest) => home.join(rest),
        Err(_) => p.to_path_buf(),
    };
    let joined = if expanded.is_absolute() { expanded } else { cwd.join(expanded) };
    std::path::absolute(&joined).unwrap_or(joined)
}

/// Atlas's own data folder (settings, cache, backups).
/// `--data-dir`, then `ATLAS_DATA_DIR`, then `<appdata>/atlas`.
pub fn data_dir(
    flag: Option<&Path>,
    env: Option<&OsStr>,
    home: &Path,
    cwd: &Path,
) -> Option<PathBuf> {
    if let Some(p) = flag.filter(|p| !p.as_os_str().is_empty()) {
        return Some(absolutize(p, home, cwd));
    }
    if let Some(p) = env.filter(|e| !e.is_empty()) {
        return Some(absolutize(Path::new(p), home, cwd));
    }
    dirs::data_dir().map(|d| d.join("atlas"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inputs<'a>(
        flag: Option<&'a Path>,
        settings: Option<&'a Path>,
        env: Option<&'a OsStr>,
        home: &'a Path,
        cwd: &'a Path,
    ) -> ConfigInputs<'a> {
        ConfigInputs { flag, settings_override: settings, env, home, cwd }
    }

    fn base() -> (PathBuf, PathBuf) {
        let root = std::env::temp_dir().join("atlas-paths-test");
        (root.join("home"), root.join("cwd"))
    }

    #[test]
    fn default_is_home_claude_with_json_beside_the_folder() {
        let (home, cwd) = base();
        let r = resolve_config_root(&inputs(None, None, None, &home, &cwd));
        assert_eq!(r.source, ConfigSource::Default);
        assert_eq!(r.dir, home.join(".claude"));
        assert_eq!(r.claude_json, home.join(".claude.json"));
        assert_eq!(r.projects_dir, home.join(".claude").join("projects"));
        assert!(!r.projects_read_only);
    }

    #[test]
    fn env_moves_claude_json_inside_the_config_dir() {
        let (home, cwd) = base();
        let envdir = cwd.join("elsewhere");
        let r = resolve_config_root(&inputs(None, None, Some(envdir.as_os_str()), &home, &cwd));
        assert_eq!(r.source, ConfigSource::Env);
        assert_eq!(r.dir, envdir);
        assert_eq!(r.claude_json, envdir.join(".claude.json"));
        assert_eq!(r.projects_dir, envdir.join("projects"));
    }

    #[test]
    fn flag_beats_settings_beats_env_beats_default() {
        let (home, cwd) = base();
        let (f, s, e) = (cwd.join("f"), cwd.join("s"), cwd.join("e"));
        let r = resolve_config_root(&inputs(Some(&f), Some(&s), Some(e.as_os_str()), &home, &cwd));
        assert_eq!((r.source, r.dir.clone()), (ConfigSource::Flag, f.clone()));
        let r = resolve_config_root(&inputs(None, Some(&s), Some(e.as_os_str()), &home, &cwd));
        assert_eq!((r.source, r.dir.clone()), (ConfigSource::Settings, s.clone()));
        let r = resolve_config_root(&inputs(None, None, Some(e.as_os_str()), &home, &cwd));
        assert_eq!((r.source, r.dir), (ConfigSource::Env, e));
    }

    #[test]
    fn flag_also_moves_claude_json_inside() {
        let (home, cwd) = base();
        let f = cwd.join("flagdir");
        let r = resolve_config_root(&inputs(Some(&f), None, None, &home, &cwd));
        assert_eq!(r.claude_json, f.join(".claude.json"));
    }

    #[test]
    fn empty_values_are_unset() {
        let (home, cwd) = base();
        let r = resolve_config_root(&inputs(
            Some(Path::new("")),
            Some(Path::new("")),
            Some(OsStr::new("")),
            &home,
            &cwd,
        ));
        assert_eq!(r.source, ConfigSource::Default);
    }

    #[test]
    fn tilde_and_relative_paths_are_made_absolute() {
        let (home, cwd) = base();
        let r = resolve_config_root(&inputs(Some(Path::new("~/work/cfg")), None, None, &home, &cwd));
        assert_eq!(r.dir, std::path::absolute(home.join("work").join("cfg")).unwrap());
        let r = resolve_config_root(&inputs(Some(Path::new("rel/cfg")), None, None, &home, &cwd));
        assert_eq!(r.dir, std::path::absolute(cwd.join("rel").join("cfg")).unwrap());
        assert!(r.dir.is_absolute());
        // "~name" is not "~"
        let r = resolve_config_root(&inputs(Some(Path::new("~name")), None, None, &home, &cwd));
        assert_eq!(r.dir, std::path::absolute(cwd.join("~name")).unwrap());
    }

    #[test]
    fn paths_with_spaces_and_unicode_survive() {
        let (home, cwd) = base();
        let odd = cwd.join("Claude Konfiguration \u{00fc}ber \u{2603}");
        let r = resolve_config_root(&inputs(Some(&odd), None, None, &home, &cwd));
        assert_eq!(r.dir, odd);
    }

    #[test]
    fn data_dir_precedence() {
        let (home, cwd) = base();
        let d = data_dir(Some(Path::new("dd")), Some(OsStr::new("ee")), &home, &cwd).unwrap();
        assert_eq!(d, std::path::absolute(cwd.join("dd")).unwrap());
        let d = data_dir(None, Some(OsStr::new("ee")), &home, &cwd).unwrap();
        assert_eq!(d, std::path::absolute(cwd.join("ee")).unwrap());
        if let Some(d) = data_dir(None, None, &home, &cwd) {
            assert!(d.ends_with("atlas"));
        }
    }
}
