//! `atlas-usage debrief`: what one chat's helpers did, as a few plain lines (spec
//! `docs/specs/agent-scorecard.md` D60-D62): how long the run took, which helpers ran and how
//! they ended, their models and reasoning effort, what the reviewers said, the tokens, what is
//! still open, and what reviewers keep catching. Facts only: Claude folds them into the report
//! it is already writing, in the user's own style.
//!
//! The text comes from `atlas_core::usage::debrief_text::render`, the same function the MCP tool
//! `get_run_debrief` calls, so both print the same bytes. Transcripts are only read.

use std::path::PathBuf;

use atlas_core::usage::debrief_text::{self, Options};
use atlas_core::usage::query::SessionQuery;
use atlas_core::usage::scorecard::DebriefArgs;
use serde_json::json;

use super::{Common, Ctx, open, real_id, resolve_project};

pub const HELP: &str = "atlas-usage debrief - what a chat's helpers did, in a few plain lines

USAGE
  atlas-usage debrief [--session ID | --last] [--since TIME] [--detail low|high] [--cost] [--json]

  --session ID     the chat to debrief (default: $CLAUDE_CODE_SESSION_ID, else the newest chat in
                   this folder's project that used helpers, named in a first line of the output)
  --last           the newest chat in this folder's project that used helpers (else the newest chat)
  --since TIME     only what happened at or after TIME: an ISO time (2026-11-09T14:00:00Z), a day
                   (2026-11-09) or epoch milliseconds. Default: the start of the chat.
  --detail low     at most 10 lines and 900 characters (default)
  --detail high    at most 40 lines and 3000 characters, with one line per helper
  --cost           add an estimate in dollars at API prices to the Tokens line (never a bill)
  --json           the facts as JSON (with the same text) instead of the text alone
  --project NAME   with --last: a project by name or folder instead of this folder's
  --cwd DIR        the folder that decides \"this project\" (default: $CLAUDE_PROJECT_DIR, else .)
  --config-dir DIR Claude config folder (default: $CLAUDE_CONFIG_DIR, else ~/.claude)
  --cache-dir DIR  where the index lives (default: $ATLAS_USAGE_CACHE, else <local app data>/atlas/cli, or cli/roots/<id> for a --config-dir that is not your own)

Exit codes: 0 done; 1 a problem reading; 2 a wrong option or no chat with that id.";

pub struct Failure {
    pub message: String,
    pub code: i32,
}

fn fail(message: impl Into<String>, code: i32) -> Failure {
    Failure { message: message.into(), code }
}

#[derive(Default)]
struct Opts {
    session: Option<String>,
    last: bool,
    project: Option<String>,
    since: Option<i64>,
    high: bool,
    cost: bool,
    json: bool,
    cwd: Option<PathBuf>,
    config_dir: Option<PathBuf>,
    cache_dir: Option<PathBuf>,
}

fn parse(args: Vec<String>) -> Result<Opts, String> {
    let mut o = Opts::default();
    let mut it = args.into_iter();
    let need = |it: &mut std::vec::IntoIter<String>, flag: &str| it.next().ok_or_else(|| format!("{flag} needs a value"));
    while let Some(a) = it.next() {
        match a.as_str() {
            "-h" | "--help" => return Err(String::new()),
            "--json" => o.json = true,
            "--cost" => o.cost = true,
            "--last" => o.last = true,
            "--project" => o.project = Some(need(&mut it, "--project")?),
            "--session" => o.session = Some(need(&mut it, "--session")?),
            "--since" => o.since = Some(debrief_text::parse_since(&need(&mut it, "--since")?)?),
            "--detail" => {
                o.high = match need(&mut it, "--detail")?.to_lowercase().as_str() {
                    "low" => false,
                    "high" => true,
                    v => return Err(format!("--detail {v}: use low or high")),
                }
            }
            "--cwd" => o.cwd = Some(PathBuf::from(need(&mut it, "--cwd")?)),
            "--config-dir" => o.config_dir = Some(PathBuf::from(need(&mut it, "--config-dir")?)),
            "--cache-dir" => o.cache_dir = Some(PathBuf::from(need(&mut it, "--cache-dir")?)),
            _ if a.starts_with("--") => return Err(format!("unknown option {a}")),
            _ => return Err(format!("unexpected word {a}")),
        }
    }
    Ok(o)
}

/// `Ok(None)` means "print the help".
pub fn run(args: Vec<String>) -> Result<Option<String>, Failure> {
    let o = match parse(args) {
        Ok(o) => o,
        Err(e) if e.is_empty() => return Ok(None),
        Err(e) => return Err(fail(format!("{e}\n(run atlas-usage debrief --help)"), 2)),
    };
    let ctx = open(&Common { cwd: o.cwd.clone(), week_start: None, config_dir: o.config_dir.clone(), cache_dir: o.cache_dir.clone() }).map_err(|e| fail(e, 1))?;
    let out = debrief(&ctx, &o);
    ctx.engine.stop();
    out.map(Some)
}

/// The newest chat of this folder's project that used helpers, else the newest chat there, with
/// the plain line that says which chat it is.
fn newest(ctx: &Ctx, project: Option<&str>) -> Result<(String, String), String> {
    let (key, name, _) = resolve_project(ctx, project)?;
    let q: SessionQuery = serde_json::from_value(json!({ "projects": [key], "sort": "start", "dir": "desc", "limit": 40 })).map_err(|e| e.to_string())?;
    let rows = ctx.engine.sessions_list(&q)?.rows;
    let (row, has_helpers) = debrief_text::pick_newest(&rows).ok_or_else(|| format!("no chats recorded for {name}"))?;
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64);
    Ok((row.session_id.clone(), debrief_text::fallback_line(row, has_helpers, now)))
}

fn debrief(ctx: &Ctx, o: &Opts) -> Result<String, Failure> {
    let given = if o.last { None } else { real_id(o.session.clone()).or_else(|| real_id(std::env::var("CLAUDE_CODE_SESSION_ID").ok())) };
    // When the chat was picked, not given, the answer starts with one plain line that says which
    // chat it is (on stdout: that is what the caller reads). `--last` asked for the newest, so no line.
    let mut note: Option<String> = None;
    let id = match given {
        Some(id) => id,
        None => {
            let (id, line) = newest(ctx, o.project.as_deref()).map_err(|e| fail(e, 1))?;
            if !o.last {
                note = Some(line);
            }
            id
        }
    };
    let d = ctx
        .engine
        .run_debrief(&DebriefArgs { session_id: id, since: o.since })
        .map_err(|e| fail(e, 1))?
        .ok_or_else(|| fail("No chat with that id.", 2))?;
    let text = debrief_text::render(&d, &Options { high: o.high, cost: o.cost });
    if !o.json {
        return Ok(match note {
            Some(n) => format!("{n}\n{text}"),
            None => text,
        });
    }
    let v = json!({ "kind": "debrief", "detail": if o.high { "high" } else { "low" }, "text": text, "note": note, "debrief": d, "costIsEstimate": true });
    serde_json::to_string_pretty(&v).map_err(|e| fail(e.to_string(), 1))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(a: &[&str]) -> Result<Opts, String> {
        parse(a.iter().map(|s| s.to_string()).collect())
    }

    #[test]
    fn options_parse() {
        let o = p(&["--session", "abc", "--detail", "high", "--since", "2026-11-06T09:00:00Z", "--cost", "--json"]).unwrap();
        assert_eq!((o.session.as_deref(), o.high, o.since, o.cost, o.json), (Some("abc"), true, Some(1_793_955_600_000), true, true));
        assert!(p(&["--last"]).unwrap().last);
        assert!(p(&["--detail", "medium"]).is_err());
        assert!(p(&["--since", "yesterday"]).is_err());
        assert!(p(&["--nope"]).is_err());
        assert!(p(&["words"]).is_err());
        assert_eq!(p(&["--help"]).err().as_deref(), Some(""));
    }
}
