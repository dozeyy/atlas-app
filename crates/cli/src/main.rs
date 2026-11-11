//! `atlas-usage`: Claude Code token usage for this chat, a day range or a project, in
//! chat-ready markdown (default) or JSON. Same engine, session rule and prices as the
//! Atlas app, so the numbers match its charts.
//!
//! Read-only on `~/.claude`: transcripts are only read. The cache lives in Atlas's own
//! data folder (`<local app data>/atlas/cli`, or `--cache-dir`).

mod debrief;
mod fmt;
mod render;
mod repeats;
mod scope;

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use atlas_core::usage::query::{ScopeArgs, SessionQuery};
use atlas_core::usage::{Event, EventSink, UsageConfig, UsageEngine, ingest, time};
use chrono::NaiveDate;
use serde_json::json;

const HELP: &str = "atlas-usage - Claude Code token usage, same numbers as the Atlas app

USAGE
  atlas-usage [SCOPE...] [--vs SCOPE] [options]
  atlas-usage repeats | offer-note ...   what you keep asking Claude for (run: atlas-usage repeats --help)
  atlas-usage debrief ...                what this chat's helpers did (run: atlas-usage debrief --help)

SCOPE (words may be combined: \"project last-week\")
  chat                this chat (default when nothing else is given)
  today, yesterday, week, last-week, month, last-month, 7d, 30d, <N>d, all
  YYYY-MM-DD          one day;   YYYY-MM-DD..YYYY-MM-DD   a range
  project             only the project of the current folder (all time unless a range is given)

OPTIONS
  --vs SCOPE          compare with another range (e.g. last-week --vs week)
  --session ID        the chat to show (default: $CLAUDE_CODE_SESSION_ID, else the newest
                      chat in this folder's project, which the output says)
  --project=NAME|PATH a project by folder name or path instead of the current folder
  --cwd DIR           folder that decides \"this project\" (default: $CLAUDE_PROJECT_DIR, else .)
  --top N             how many models and projects a reply names (at most 3; --json lists N)
  --json              JSON instead of markdown
  --ascii             plain ASCII bars (# and .) for a terminal that draws boxes for blocks
                      (also: ATLAS_ASCII=1)
  --week-start mon|sun  default: the operating system's setting, like the app
  --config-dir DIR    Claude config folder (default: $CLAUDE_CONFIG_DIR, else ~/.claude)
  --cache-dir DIR     where the index lives (default: $ATLAS_USAGE_CACHE, else
                      <local app data>/atlas/cli)

Tokens = input + output; the Settings option Count cache in token totals adds cache writes and reads.
The one dollar figure is an estimate at API prices. Transcripts are only read, never written.";

struct Quiet;
impl EventSink for Quiet {
    fn emit(&self, _: Event) {}
    fn log(&self, _: &str) {}
}

#[derive(Default)]
struct Opts {
    chat: bool,
    project: bool,
    project_name: Option<String>,
    span: Option<String>,
    vs: Option<String>,
    session: Option<String>,
    json: bool,
    ascii: bool,
    top: usize,
    cwd: Option<PathBuf>,
    week_start: Option<bool>,
    config_dir: Option<PathBuf>,
    cache_dir: Option<PathBuf>,
}

const FILLER: &[&str] = &[
    "my", "the", "for", "of", "in", "on", "at", "usage", "tokens", "token", "stats", "how", "much", "many", "what", "whats", "s", "was",
    "is", "were", "did", "do", "i", "me", "use", "used", "show", "give", "so", "far", "been", "have", "has", "looking", "like", "it",
    "atlas", "spend", "spent", "cost", "costs",
];

/// Positional words to (chat?, project?, span words, vs words). "vs" splits the two.
fn words(opts: &mut Opts, raw: &[String]) {
    let mut main: Vec<String> = Vec::new();
    let mut other: Vec<String> = Vec::new();
    let mut after_vs = false;
    let mut joining = false; // "2026-11-01 to 2026-11-07" is one range, not a comparison
    let is_date = |s: &str| chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").is_ok();
    for w in raw.iter().flat_map(|a| a.split_whitespace()).map(|w| w.to_lowercase()) {
        let w = w.trim_matches(|c: char| !c.is_alphanumeric() && c != '-' && c != '.').to_string();
        let list = if after_vs { &mut other } else { &mut main };
        if joining && is_date(&w) {
            let last = list.pop().unwrap_or_default();
            list.push(format!("{last}..{w}"));
            joining = false;
            continue;
        }
        joining = false;
        match w.as_str() {
            "" => {}
            "to" | "through" | "until" | "thru" if list.last().is_some_and(|l| is_date(l)) => joining = true,
            "to" => {}
            "vs" | "versus" | "compared" | "compare" | "against" | "and" if !main.is_empty() => after_vs = true,
            "chat" | "session" | "conversation" | "thread" => opts.chat = true,
            "project" | "repo" | "folder" | "workspace" => opts.project = true,
            "this" if !after_vs => {}
            _ if FILLER.contains(&w.as_str()) => {}
            _ => {
                if after_vs { other.push(w) } else { main.push(w) }
            }
        }
    }
    if !main.is_empty() {
        opts.span = Some(main.join("-"));
    }
    if !other.is_empty() {
        let joined = other.join("-");
        opts.vs = Some(if joined == "this" { "week".into() } else { joined.trim_start_matches("this-").to_string() });
    }
}

fn parse_args(args: Vec<String>) -> Result<Opts, String> {
    let mut o = Opts { top: 5, ..Opts::default() };
    let mut positional = Vec::new();
    let mut it = args.into_iter();
    let need = |it: &mut std::vec::IntoIter<String>, flag: &str| it.next().ok_or_else(|| format!("{flag} needs a value"));
    while let Some(a) = it.next() {
        match a.as_str() {
            "-h" | "--help" => return Err(String::new()),
            "--json" => o.json = true,
            "--ascii" => o.ascii = true,
            "--vs" => o.vs = Some(need(&mut it, "--vs")?),
            "--session" => o.session = Some(need(&mut it, "--session")?),
            "--project" => o.project = true,
            "--cwd" => o.cwd = Some(PathBuf::from(need(&mut it, "--cwd")?)),
            "--top" => o.top = need(&mut it, "--top")?.parse().map_err(|_| "--top needs a number".to_string())?,
            "--config-dir" => o.config_dir = Some(PathBuf::from(need(&mut it, "--config-dir")?)),
            "--cache-dir" => o.cache_dir = Some(PathBuf::from(need(&mut it, "--cache-dir")?)),
            "--week-start" => {
                o.week_start = Some(match need(&mut it, "--week-start")?.to_lowercase().as_str() {
                    "sun" | "sunday" => true,
                    "mon" | "monday" => false,
                    v => return Err(format!("--week-start {v}: use mon or sun")),
                })
            }
            _ if a.starts_with("--project=") => {
                o.project = true;
                o.project_name = Some(a["--project=".len()..].to_string()).filter(|s| !s.is_empty());
            }
            _ if a.starts_with("--") => return Err(format!("unknown option {a}")),
            _ => positional.push(a),
        }
    }
    words(&mut o, &positional);
    o.top = o.top.clamp(1, 50);
    Ok(o)
}

/// A session id that was really substituted (not an empty or literal `${...}` placeholder).
fn real_id(s: Option<String>) -> Option<String> {
    s.map(|s| s.trim().to_string()).filter(|s| !s.is_empty() && !s.contains('$') && !s.contains('{'))
}

/// An on/off environment value: only 1, true or yes (any case) switch it on, so `false`,
/// `no`, `off`, `0` and an empty value leave it off.
fn truthy(v: &str) -> bool {
    matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes")
}

fn env_path(k: &str) -> Option<PathBuf> {
    std::env::var_os(k).filter(|v| !v.is_empty()).map(PathBuf::from)
}

/// Copy the app's price file (and its seed marker) so estimates match edits made in the app.
/// Only Atlas's own folders are touched.
fn copy_pricing(app_dir: &Path, cache_dir: &Path) {
    for name in ["pricing.json", "pricing.seed-hash"] {
        let src = app_dir.join(name);
        if src.is_file() {
            let _ = std::fs::copy(&src, cache_dir.join(name));
        }
    }
}

struct Ctx {
    engine: Arc<UsageEngine>,
    today: NaiveDate,
    sunday: bool,
    cwd: PathBuf,
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    // `repeats` and `offer-note` are the plugin skill's no-app path (src/repeats.rs).
    if let Some(cmd) = args.first().filter(|a| matches!(a.as_str(), "repeats" | "offer-note")).cloned() {
        match repeats::run(&cmd, args[1..].to_vec()) {
            Ok(Some(out)) => println!("{out}"),
            Ok(None) => println!("{}", repeats::HELP),
            Err(e) => {
                eprintln!("atlas-usage: {}", fmt::plain(&e));
                std::process::exit(1);
            }
        }
        return;
    }
    // `debrief`: the helpers of one chat as short facts (src/debrief.rs).
    if args.first().is_some_and(|a| a == "debrief") {
        match debrief::run(args[1..].to_vec()) {
            Ok(Some(out)) => println!("{out}"),
            Ok(None) => println!("{}", debrief::HELP),
            Err(debrief::Failure { message, code }) => {
                eprintln!("atlas-usage: {}", fmt::plain(&message));
                std::process::exit(code);
            }
        }
        return;
    }
    let opts = match parse_args(args) {
        Ok(o) => o,
        Err(e) if e.is_empty() => {
            println!("{HELP}");
            return;
        }
        Err(e) => {
            eprintln!("atlas-usage: {e}\n(run atlas-usage --help)");
            std::process::exit(2);
        }
    };
    fmt::set_ascii(opts.ascii || std::env::var("ATLAS_ASCII").is_ok_and(|v| truthy(&v)));
    match run(&opts) {
        Ok(out) => println!("{out}"),
        Err(e) => {
            eprintln!("atlas-usage: {}", fmt::plain(&e));
            std::process::exit(1);
        }
    }
}

/// What every command needs to open the engine: where things are.
struct Common {
    cwd: Option<PathBuf>,
    week_start: Option<bool>,
    config_dir: Option<PathBuf>,
    cache_dir: Option<PathBuf>,
}

/// Open the usage engine on the Claude folder (read-only) and wait for its first pass.
/// The caller stops the engine when done.
fn open(c: &Common) -> Result<Ctx, String> {
    let home = atlas_core::paths::home_dir().ok_or("no home folder")?;
    let here = std::env::current_dir().map_err(|e| e.to_string())?;
    let cwd = c.cwd.clone().or_else(|| env_path("CLAUDE_PROJECT_DIR")).unwrap_or_else(|| here.clone());
    let cwd = atlas_core::paths::absolutize(&cwd, &home, &here);

    let env_cfg: Option<OsString> = std::env::var_os("CLAUDE_CONFIG_DIR");
    let root = atlas_core::paths::resolve_config_root(&atlas_core::paths::ConfigInputs {
        flag: c.config_dir.as_deref(),
        settings_override: None,
        env: env_cfg.as_deref(),
        home: &home,
        cwd: &here,
    });
    if !root.projects_dir.is_dir() {
        return Err(format!("no Claude Code transcripts at {} (set --config-dir or CLAUDE_CONFIG_DIR)", root.projects_dir.display()));
    }
    let atlas_env = std::env::var_os("ATLAS_DATA_DIR");
    let app_dir = atlas_core::paths::local_data_dir(None, atlas_env.as_deref(), &home, &here).ok_or("no local app data folder")?;
    let cache_dir = match c.cache_dir.clone().or_else(|| env_path("ATLAS_USAGE_CACHE")) {
        Some(d) => atlas_core::paths::absolutize(&d, &home, &here),
        None => app_dir.join("cli"),
    };
    if atlas_core::usage::is_inside(&cache_dir, &root.projects_dir) || atlas_core::usage::is_inside(&cache_dir, &root.dir) {
        return Err("the cache folder must not be inside the Claude config folder (it is read-only here)".into());
    }
    std::fs::create_dir_all(&cache_dir).map_err(|e| format!("cannot create {}: {e}", cache_dir.display()))?;
    copy_pricing(&app_dir, &cache_dir);

    let cache_db = cache_dir.join("cache.sqlite");
    let first_run = !cache_db.exists();
    if first_run {
        eprintln!("atlas-usage: first run, indexing Claude Code transcripts (read-only). This can take a minute.");
    }
    let sunday = c.week_start.unwrap_or_else(time::week_starts_sunday);
    let mut cfg = UsageConfig::new(root.projects_dir.clone(), root.dir.clone(), cache_dir.clone(), cache_db);
    cfg.watch = false;
    cfg.week_starts_sunday = sunday;
    cfg.count_cache = atlas_core::paths::data_dir(None, atlas_env.as_deref(), &home, &here)
        .is_some_and(|d| atlas_core::settings::count_cache_in(&d));
    let started = Instant::now();
    let engine = UsageEngine::start(cfg, Arc::new(Quiet));
    if !engine.wait_pass(0, Duration::from_secs(1800)) {
        engine.stop();
        return Err("indexing did not finish in 30 minutes".into());
    }
    if first_run {
        eprintln!("atlas-usage: indexed in {:.0}s", started.elapsed().as_secs_f64());
    }
    let today = scope::day(&engine.today_date()).ok_or("bad today date")?;
    Ok(Ctx { engine, today, sunday, cwd })
}

fn run(o: &Opts) -> Result<String, String> {
    let ctx = open(&Common { cwd: o.cwd.clone(), week_start: o.week_start, config_dir: o.config_dir.clone(), cache_dir: o.cache_dir.clone() })?;
    let out = if o.chat || (o.span.is_none() && !o.project && o.vs.is_none()) { chat(&ctx, o) } else { range(&ctx, o) };
    ctx.engine.stop();
    out
}

/// "This project": the cwd's project key, else the longest recorded project that holds
/// the cwd, else (with `--project=NAME`) a project whose folder name matches.
fn resolve_project(ctx: &Ctx, name: Option<&str>) -> Result<(String, String, String), String> {
    let opts = ctx.engine.filter_options()?;
    let pick = |p: &atlas_core::usage::query::ProjectRef| Ok((p.project_key.clone(), p.name.clone(), p.path.clone()));
    let path_key = |p: &Path| ingest::project_key(&p.to_string_lossy());
    let target = match name {
        Some(n) if n.contains('/') || n.contains('\\') || Path::new(n).is_dir() => {
            let home = atlas_core::paths::home_dir().unwrap_or_default();
            Some(path_key(&atlas_core::paths::absolutize(Path::new(n), &home, &ctx.cwd)))
        }
        Some(_) => None,
        None => Some(path_key(&ctx.cwd)),
    };
    if let Some(key) = target {
        if let Some(p) = opts.projects.iter().find(|p| p.project_key == key) {
            return pick(p);
        }
        let inside = opts
            .projects
            .iter()
            .filter(|p| key.starts_with(&format!("{}/", p.project_key.trim_end_matches('/'))))
            .max_by_key(|p| p.project_key.len());
        if let Some(p) = inside {
            return pick(p);
        }
        if name.is_none() {
            return Err(format!("no Claude Code usage recorded for this folder ({})", ctx.cwd.display()));
        }
    }
    let n = name.unwrap_or_default().to_lowercase();
    let exact = opts.projects.iter().find(|p| p.name.to_lowercase() == n);
    let loose = || opts.projects.iter().find(|p| p.name.to_lowercase().contains(&n));
    match exact.or_else(loose) {
        Some(p) => pick(p),
        None => Err(format!("no project named \"{}\" has recorded usage", name.unwrap_or_default())),
    }
}

fn chat(ctx: &Ctx, o: &Opts) -> Result<String, String> {
    let env_id = std::env::var("CLAUDE_CODE_SESSION_ID").ok();
    let (id, note) = match real_id(o.session.clone()).or_else(|| real_id(env_id)) {
        Some(id) => (id, None),
        None => {
            let (key, name, _) = resolve_project(ctx, None)?;
            let q: SessionQuery = serde_json::from_value(json!({ "projects": [key], "sort": "start", "dir": "desc", "limit": 1 }))
                .map_err(|e| e.to_string())?;
            let page = ctx.engine.sessions_list(&q)?;
            let row = page.rows.into_iter().next().ok_or_else(|| format!("no chats recorded for {name}"))?;
            (row.session_id, Some(format!("No session id was given, so this is the newest chat in {name}.")))
        }
    };
    let detail = ctx
        .engine
        .session_detail(&id)?
        .ok_or_else(|| "this chat has no recorded usage yet (its transcript has no assistant messages)".to_string())?;
    if o.json {
        let mut v = json!({
            "kind": "chat",
            "sessionId": detail.row.session_id,
            "note": note,
            "chat": detail.row,
            "byModel": detail.by_model,
            "main": detail.main,
            "helpers": detail.agents,
        });
        if let Some(obj) = v.as_object_mut() {
            obj.insert("costIsEstimate".into(), json!(true));
        }
        return serde_json::to_string_pretty(&v).map_err(|e| e.to_string());
    }
    Ok(render::chat(&detail, note.as_deref(), o.top))
}

fn range(ctx: &Ctx, o: &Opts) -> Result<String, String> {
    let first = ctx.engine.first_day()?.as_deref().and_then(scope::day);
    let span_word = o.span.clone().unwrap_or_else(|| if o.project { "all".into() } else { "week".into() });
    let span = scope::parse(&span_word, ctx.today, ctx.sunday, first)?;
    let project = if o.project { Some(resolve_project(ctx, o.project_name.as_deref())?) } else { None };
    let key = project.as_ref().map(|p| p.0.clone());

    let report_for = |s: &scope::Span, top: usize| {
        ctx.engine.scope_report(&ScopeArgs {
            from: scope::ymd(s.from),
            to: scope::ymd(s.to),
            project_key: key.clone(),
            bucket: scope::bucket_for(s.days()).to_string(),
            top,
        })
    };
    let report = report_for(&span, o.top)?;
    let compare = match &o.vs {
        Some(w) => {
            let s = scope::parse(w, ctx.today, ctx.sunday, first)?;
            let r = report_for(&s, 0)?;
            Some((s, r))
        }
        None => None,
    };
    // Each chat's usage inside the range only (a chat that spills over counts its part).
    let top_chats = &report.chats;

    if o.json {
        let v = json!({
            "kind": "range",
            "label": span.label,
            "from": report.from,
            "to": report.to,
            "project": project.as_ref().map(|p| json!({ "name": p.1, "path": p.2 })),
            "report": report,
            "topChats": top_chats,
            "compare": compare.as_ref().map(|(s, r)| json!({ "label": s.label, "report": r })),
            "costIsEstimate": true,
        });
        return serde_json::to_string_pretty(&v).map_err(|e| e.to_string());
    }
    let proj_name = project.as_ref().map(|p| p.1.as_str());
    Ok(render::range(&render::RangeView {
        span: &span,
        today: ctx.today,
        report: &report,
        project: proj_name,
        top_chats,
        compare: compare.as_ref().map(|(s, r)| (s, r)),
        top: o.top,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(a: &[&str]) -> Opts {
        parse_args(a.iter().map(|s| s.to_string()).collect()).unwrap()
    }

    #[test]
    fn plain_words_become_scopes() {
        let o = opts(&["what", "was", "my", "usage", "last", "week"]);
        assert_eq!(o.span.as_deref(), Some("last-week"));
        let o = opts(&["last week"]);
        assert_eq!(o.span.as_deref(), Some("last-week"));
        let o = opts(&["this", "chat"]);
        assert!(o.chat && o.span.is_none());
        let o = opts(&["project", "last-week"]);
        assert!(o.project);
        assert_eq!(o.span.as_deref(), Some("last-week"));
        let o = opts(&["last", "week", "vs", "this", "week"]);
        assert_eq!((o.span.as_deref(), o.vs.as_deref()), (Some("last-week"), Some("week")));
        let o = opts(&["week", "--vs", "last-week", "--project=atlas", "--top", "3"]);
        assert_eq!((o.vs.as_deref(), o.project_name.as_deref(), o.top), (Some("last-week"), Some("atlas"), 3));
    }

    #[test]
    fn date_to_date_is_one_range_not_a_comparison() {
        let o = opts(&["usage", "2026-11-01", "to", "2026-11-07"]);
        assert_eq!(o.span.as_deref(), Some("2026-11-01..2026-11-07"));
        assert_eq!(o.vs, None);
        let o = opts(&["this week compared to last week"]);
        assert_eq!(o.span.as_deref(), Some("week"));
        assert_eq!(o.vs.as_deref(), Some("last-week"));
        let o = opts(&["today and yesterday"]);
        assert_eq!(o.span.as_deref(), Some("today"));
        assert_eq!(o.vs.as_deref(), Some("yesterday"));
    }

    #[test]
    fn ascii_is_a_flag_not_a_scope() {
        let o = opts(&["30d", "--ascii"]);
        assert!(o.ascii);
        assert_eq!(o.span.as_deref(), Some("30d"));
        assert!(!opts(&["30d"]).ascii);
    }

    #[test]
    fn only_a_yes_turns_the_ascii_env_on() {
        for on in ["1", "true", "TRUE", "yes", " Yes "] {
            assert!(truthy(on), "{on}");
        }
        for off in ["0", "false", "False", "no", "off", "", "2", "ascii"] {
            assert!(!truthy(off), "{off}");
        }
    }

    #[test]
    fn placeholder_ids_are_ignored() {
        assert_eq!(real_id(Some("${CLAUDE_SESSION_ID}".into())), None);
        assert_eq!(real_id(Some("  ".into())), None);
        assert_eq!(real_id(Some("abc-123".into())).as_deref(), Some("abc-123"));
    }
}
