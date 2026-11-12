//! `atlas-usage repeats` and `atlas-usage offer-note`: the same two things the Atlas MCP tools
//! `find_repeated_requests` and `note_skill_offer` do, for the plugin skill when the Atlas app
//! and its MCP server are not installed. Same core code (`atlas_core::habits`), same
//! `habits.json`, same grouping rules and thresholds; JSON on stdout.
//!
//! Chat index: the Atlas app's own index is read when it exists and is current (no transcript
//! newer than its last pass). Otherwise this program reads the transcripts itself into its own
//! index under `<cache dir>/search.sqlite`, newest chats first and for at most `READ_SECS`
//! seconds per run: a run that cannot finish answers from what it has read and says
//! `"reading": true`, and the next run carries on where it stopped. Transcripts are only
//! read; the one file written outside the cache folder is `habits.json` in Atlas's data folder.

use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use atlas_core::habits::{self, FindArgs, Habits, NoteArgs};
use atlas_core::search::db::get_meta;
use atlas_core::search::{NullSearchSink, SearchConfig, SearchEngine, db};
use serde_json::Value;

pub const HELP: &str = "atlas-usage repeats - what you keep asking Claude for (JSON)

USAGE
  atlas-usage repeats [--like TEXT] [--days N] [--project NAME] [--limit N] [--all-projects-text] [--json]
  atlas-usage offer-note <id|-> <made|declined|off> [--skill NAME] [--like TEXT]

repeats       groups the requests you typed in past chats (no AI, computed on this computer).
              The wordings it prints are shown to Claude, so by default only wordings typed in
              the current project are printed (counts include every project);
              --all-projects-text also prints wordings from other projects.
              --like TEXT adds the group the request in front of you belongs to.
offer-note    remembers your answer to an offer to make a skill: made (a skill was saved),
              declined (do not offer this again) or off (stop offering at all; the id may be -).
              The answer is stored in Atlas's data folder as habits.json, ids only, never text.

Options for both: --config-dir DIR (default: $CLAUDE_CONFIG_DIR, else ~/.claude),
--cache-dir DIR (default: $ATLAS_USAGE_CACHE, else <local app data>/atlas/cli, or cli/roots/<id> for a --config-dir that is not your own),
--data-dir DIR (Atlas's data folder; default like the app: $ATLAS_DATA_DIR, else the OS folder).";

#[derive(Default)]
struct Opts {
    like: Option<String>,
    days: Option<i64>,
    project: Option<String>,
    limit: Option<usize>,
    all_projects_text: bool,
    current_project: Option<String>,
    skill: Option<String>,
    config_dir: Option<PathBuf>,
    cache_dir: Option<PathBuf>,
    data_dir: Option<PathBuf>,
    positional: Vec<String>,
}

fn parse(args: Vec<String>) -> Result<Opts, String> {
    let mut o = Opts::default();
    let mut it = args.into_iter();
    let need = |it: &mut std::vec::IntoIter<String>, flag: &str| it.next().ok_or_else(|| format!("{flag} needs a value"));
    while let Some(a) = it.next() {
        match a.as_str() {
            "-h" | "--help" => return Err(String::new()),
            "--json" => {}
            "--all-projects-text" => o.all_projects_text = true,
            "--current-project" => o.current_project = Some(need(&mut it, "--current-project")?),
            "--like" => o.like = Some(need(&mut it, "--like")?),
            "--days" => o.days = Some(need(&mut it, "--days")?.parse().map_err(|_| "--days needs a number".to_string())?),
            "--limit" => o.limit = Some(need(&mut it, "--limit")?.parse().map_err(|_| "--limit needs a number".to_string())?),
            "--project" => o.project = Some(need(&mut it, "--project")?),
            "--skill" => o.skill = Some(need(&mut it, "--skill")?),
            "--config-dir" => o.config_dir = Some(PathBuf::from(need(&mut it, "--config-dir")?)),
            "--cache-dir" => o.cache_dir = Some(PathBuf::from(need(&mut it, "--cache-dir")?)),
            "--data-dir" => o.data_dir = Some(PathBuf::from(need(&mut it, "--data-dir")?)),
            // "-" is a real value (offer-note's "no id"); anything else starting with - is a typo.
            _ if a.starts_with('-') && a != "-" => return Err(format!("unknown option {a}")),
            _ => o.positional.push(a),
        }
    }
    Ok(o)
}

fn env_path(k: &str) -> Option<PathBuf> {
    std::env::var_os(k).filter(|v| !v.is_empty()).map(PathBuf::from)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// `Ok(None)` means "print the help".
pub fn run(cmd: &str, args: Vec<String>) -> Result<Option<String>, String> {
    let o = match parse(args) {
        Ok(o) => o,
        Err(e) if e.is_empty() => return Ok(None),
        Err(e) => return Err(format!("{e}\n(run atlas-usage repeats --help)")),
    };
    let ctx = Ctx::resolve(&o)?;
    let out = match cmd {
        "repeats" => find(&ctx, &o)?,
        _ => note(&ctx, &o)?,
    };
    serde_json::to_string(&out).map(Some).map_err(|e| e.to_string())
}

/// Longest one run spends reading chats itself, in seconds (`ATLAS_USAGE_READ_SECS` overrides).
const READ_SECS: u64 = 20;
/// The app's index is "current" when no transcript is newer than its last pass by more than this.
const FRESH_SLACK_SECS: i64 = 90;

fn read_budget() -> Duration {
    Duration::from_secs(std::env::var("ATLAS_USAGE_READ_SECS").ok().and_then(|v| v.trim().parse().ok()).unwrap_or(READ_SECS))
}

/// Newest modification time (Unix seconds) of any chat file: `projects/<folder>/*.jsonl`.
fn newest_chat_secs(projects: &std::path::Path) -> Option<i64> {
    let mut newest: Option<i64> = None;
    for folder in std::fs::read_dir(projects).ok()?.flatten() {
        let Ok(files) = std::fs::read_dir(folder.path()) else { continue };
        for f in files.flatten() {
            if f.path().extension().is_none_or(|e| e != "jsonl") {
                continue;
            }
            let t = f.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs() as i64);
            newest = newest.max(t);
        }
    }
    newest
}

/// True when the index at `path` opens and covers every chat file as of its last pass.
fn index_is_current(path: &std::path::Path, projects: &std::path::Path) -> bool {
    let Ok(conn) = habits::open_index(path) else { return false };
    let Some(at) = get_meta(&conn, "last_indexed_at").and_then(|v| v.parse::<i64>().ok()) else { return false };
    newest_chat_secs(projects).is_none_or(|m| m <= at + FRESH_SLACK_SECS)
}

struct Ctx {
    here: PathBuf,
    data_dir: PathBuf,
    index: PathBuf,
    projects_dir: PathBuf,
    config_dir: PathBuf,
    cache_dir: PathBuf,
}

impl Ctx {
    fn resolve(o: &Opts) -> Result<Ctx, String> {
        use atlas_core::paths::{self, ConfigInputs, ConfigSource};
        let home = paths::home_dir().ok_or("no home folder")?;
        let here = std::env::current_dir().map_err(|e| e.to_string())?;
        let env_cfg: Option<OsString> = std::env::var_os("CLAUDE_CONFIG_DIR");
        let root = paths::resolve_config_root(&ConfigInputs { flag: o.config_dir.as_deref(), settings_override: None, env: env_cfg.as_deref(), home: &home, cwd: &here });
        let atlas_env = std::env::var_os("ATLAS_DATA_DIR");
        let data_dir = paths::data_dir(o.data_dir.as_deref(), atlas_env.as_deref(), &home, &here).ok_or("no Atlas data folder")?;
        let local = paths::local_data_dir(o.data_dir.as_deref(), atlas_env.as_deref(), &home, &here).ok_or("no local app data folder")?;
        let cache_dir = match o.cache_dir.clone().or_else(|| env_path("ATLAS_USAGE_CACHE")) {
            Some(d) => paths::absolutize(&d, &home, &here),
            None => paths::cli_cache_dir(&local, &root, env_cfg.as_deref(), &home, &here),
        };
        if atlas_core::usage::is_inside(&cache_dir, &root.projects_dir) || atlas_core::usage::is_inside(&cache_dir, &root.dir) || atlas_core::usage::is_inside(&data_dir, &root.dir) {
            return Err("the cache and data folders must not be inside the Claude config folder (it is read-only here)".into());
        }
        let index = db::search_file(&local, &root.projects_dir, root.source != ConfigSource::Flag);
        Ok(Ctx { here, data_dir, index, projects_dir: root.projects_dir, config_dir: root.dir, cache_dir })
    }

    /// The index to read and whether it is still being read (`true`): the app's when it is there
    /// and current, else this program's own, brought up to date from the transcripts for at
    /// most `read_budget()`.
    fn index(&self) -> Result<(PathBuf, bool), String> {
        if index_is_current(&self.index, &self.projects_dir) {
            return Ok((self.index.clone(), false));
        }
        if !self.projects_dir.is_dir() {
            return Err(format!("no Claude Code transcripts at {} (set --config-dir or CLAUDE_CONFIG_DIR)", self.projects_dir.display()));
        }
        std::fs::create_dir_all(&self.cache_dir).map_err(|e| format!("cannot create {}: {e}", self.cache_dir.display()))?;
        let own = self.cache_dir.join("search.sqlite");
        if !own.exists() {
            eprintln!("atlas-usage: reading your Claude Code chats for the first time (read-only, newest first).");
        }
        let mut cfg = SearchConfig::new(self.projects_dir.clone(), self.config_dir.clone(), own.clone());
        cfg.debounce = Duration::from_millis(20);
        let engine = SearchEngine::start(cfg, Arc::new(NullSearchSink));
        let n = engine.passes();
        engine.poke();
        let done = engine.wait_pass(n, read_budget());
        engine.stop();
        Ok((own, !done))
    }

    /// An index that already exists, for a note: never starts a read.
    fn existing_index(&self) -> PathBuf {
        if habits::open_index(&self.index).is_ok() {
            return self.index.clone();
        }
        let own = self.cache_dir.join("search.sqlite");
        if habits::open_index(&own).is_ok() { own } else { self.index.clone() }
    }
}

fn find(ctx: &Ctx, o: &Opts) -> Result<Value, String> {
    let (index, reading) = ctx.index()?;
    let h = Habits::new(index, ctx.data_dir.clone());
    let here = o.current_project.clone().unwrap_or_else(|| ctx.here.to_string_lossy().into_owned());
    let args = FindArgs { like: o.like.clone(), days: o.days, project: o.project.clone(), limit: o.limit, current_project: Some(here), all_projects_text: o.all_projects_text };
    let mut out = h.find(&args, now_ms())?;
    if reading {
        // Partial: the run ran out of time. What is here is the newest chats; the next run carries on.
        out["reading"] = Value::Bool(true);
    }
    Ok(out)
}

fn note(ctx: &Ctx, o: &Opts) -> Result<Value, String> {
    let (id, answer) = match o.positional.as_slice() {
        [a] if is_answer(a) => (None, a.as_str()),
        [id, a] if is_answer(a) => (Some(id.as_str()).filter(|i| *i != "-"), a.as_str()),
        _ => return Err("usage: atlas-usage offer-note <id|-> <made|declined|off>".into()),
    };
    let answer = if answer.eq_ignore_ascii_case("off") { "never" } else { answer };
    // The index only helps to find a request's sibling wordings; a note never starts a read and
    // never needs an index to exist.
    let h = Habits::new(ctx.existing_index(), ctx.data_dir.clone());
    h.note(&NoteArgs { group_id: id.map(str::to_string), like: o.like.clone(), answer: answer.to_string(), skill_name: o.skill.clone() }, now_ms())
}

fn is_answer(s: &str) -> bool {
    matches!(s.to_ascii_lowercase().as_str(), "made" | "declined" | "off" | "offered")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn options_parse_and_a_lone_dash_is_a_value() {
        let o = parse(v(&["--like", "read the readme", "--days", "30", "--json", "-", "declined", "--skill", "readme-summary"])).unwrap();
        assert_eq!((o.like.as_deref(), o.days, o.skill.as_deref()), (Some("read the readme"), Some(30), Some("readme-summary")));
        assert_eq!(o.positional, ["-", "declined"]);
        assert!(parse(v(&["--nope"])).is_err());
        assert!(parse(v(&["--days", "x"])).is_err());
        assert!(parse(v(&["--like"])).is_err());
        assert_eq!(parse(v(&["--help"])).err().as_deref(), Some(""));
    }

    #[test]
    fn only_the_four_answers_count() {
        for a in ["made", "declined", "off", "OFF", "offered"] {
            assert!(is_answer(a), "{a}");
        }
        for a in ["never", "yes", "", "no"] {
            assert!(!is_answer(a), "{a}");
        }
    }
}
