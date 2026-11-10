//! The agent scorecard, the review themes and the run debrief, read from the helper-run ledger
//! (`docs/specs/agent-scorecard.md`; the ledger is written by `ingest::apply_ledger`).
//!
//! The query surface, in the spec's terms:
//!
//! * [`agent_scorecard`]: one [`TypeCard`] per agent type with a run in range: runs, how they ended
//!   (D3), finish rate, median tool calls and time running (D4), tokens and an estimated cost (D5),
//!   12 rolling weeks of runs, the projects it ran in, the Interactive/Headless split (D13), and
//!   either its review counts as a worker (D10, D11) or its verdict counts as a reviewer (D6, D7).
//!   Every run, and so every card, carries the exact model id (named by [`model_name`]: "Opus 5.5",
//!   an unknown new id such as `claude-fable-5-2` becomes "Fable 5.2", an unreadable id stays as
//!   written) and the effort level the transcript recorded (`perTurnEffort`, else `effort`; none
//!   recorded = `None`, never guessed): `TypeCard::top_model` is the most used pair and `mix`
//!   the whole spread.
//! * [`review_themes`]: the findings reviewers raised (D8), grouped by `textgroup` (D14), kept when
//!   at least `Thresholds::THEME_MIN_FINDINGS` findings from `THEME_MIN_RUNS` runs agree (D24, D25).
//! * [`run_debrief`]: the facts of one chat and its helpers since a time (spec D60, D61); Unit 4
//!   renders them, Atlas supplies facts and never a format.
//!
//! Honesty limits (spec 1.3), kept in the numbers rather than papered over:
//! * A verdict is what the report says: a `Verdict:` or `Overall:` line, else its `STATUS:` line
//!   (`partial`, or one pass/fail word on a `done` line). A bare `STATUS: done` states none; every
//!   run without one counts as "no verdict", never as a pass.
//! * A median needs `Thresholds::MEDIAN_MIN_RUNS` runs; below that the card says "too few runs" and
//!   shows counts only (`TypeCard::too_few_runs`).
//! * A helper that was messaged after it finished works in several stretches: its duration is the
//!   time it spent in them (`RunRow::duration_ms`), not the idle gap between, and `resumes` counts
//!   the wake-ups. It stays one run (one id): its ties, verdict and models are per helper.
//! * A review is tied to a worker only by the rules of D10; otherwise it is "not tied". A review
//!   that names no worker and follows two or more finished workers stays not tied.
//! * "Sent back" means a message or dispatch naming the worker followed a `findings` review; it is
//!   a sign, not a measurement of what the worker did next.
//! * A run's end is `None` when no source (notice, sidecar, the thread's last line) says it ended.
//! * Cost is an estimate at API prices, priced at query time; tokens are the headline figure.

use std::collections::{BTreeMap, HashMap, HashSet};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use super::naming::humanize_type;
use super::query::{group_from, u, Acc, Cost, Group, QueryCtx, Tokens};
use super::reviews::{self, ReviewTie, RunFacts, LinkFacts, Thresholds, Verdict, WorkerReviews};
use crate::textgroup;

const DAY_MS: i64 = 86_400_000;
const WEEKS: usize = 12;
const RECENT_RUNS: usize = 20;
const LABEL_CHARS: usize = 140;
const EXAMPLE_CHARS: usize = 200;
const EXAMPLES: usize = 3;
const DEFAULT_THEMES: usize = 12;

// ---------------------------------------------------------------- shapes

/// D13: where a chat was started from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StartedFrom {
    #[default]
    All,
    Interactive,
    Headless,
}

/// `entrypoint` starting `sdk-` (`claude -p` writes `sdk-cli`) is Headless; anything else, or none,
/// is Interactive.
pub fn is_headless(entrypoint: Option<&str>) -> bool {
    entrypoint.is_some_and(|e| e.starts_with("sdk-"))
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ScorecardArgs {
    /// Runs that started in the last N days; `None` = all history.
    pub days: Option<u32>,
    /// One type only (the raw name, e.g. `code-reviewer`).
    pub agent_type: Option<String>,
    pub started_from: StartedFrom,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EndCounts {
    pub finished: u32,
    pub errored: u32,
    pub stopped: u32,
    /// No source says the run ended (still going, or it just stopped writing).
    pub unknown: u32,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartedSplit {
    pub interactive: u32,
    pub headless: u32,
}

/// A reviewer type's own verdicts (D6): "no verdict" is every run whose report states none.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerdictCounts {
    pub pass: u32,
    /// The reports that asked for changes (FIX-REQUIRED, FAIL, BLOCKED, ...).
    pub findings: u32,
    /// The reports that said `STATUS: partial` (they did not get all the way).
    pub partial: u32,
    /// Any other verdict word.
    pub other: u32,
    /// No verdict stated (a bare `STATUS: done` is none: it says the helper finished, not how it went).
    pub none: u32,
}

/// A worker type's reviews (D10, D11). `tied` and the splits count (review, worker) pairs; `not_tied`
/// counts runs.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewCounts {
    pub tied: u32,
    pub passed: u32,
    pub sent_back: u32,
    /// Tied reviews whose verdict was another word, or none.
    pub other: u32,
    /// Runs with no tied review and never sent back.
    pub not_tied: u32,
    /// A rate sentence ("Passed 9 of 12 reviews") is honest only from `Thresholds::RATE_MIN_REVIEWS`
    /// tied reviews; below that, show counts only.
    pub rate_ok: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRuns {
    pub project_key: String,
    pub name: String,
    pub runs: u32,
    pub tokens: u64,
}

/// One model-and-effort combination a helper type (or one run) used. `model` is the exact id as
/// the transcript wrote it; `model_name` is built from it ("Opus 5.5", a new id such as
/// `claude-fable-5-2` -> "Fable 5.2", an id of no known shape stays as written). `effort` is the
/// recorded level, None when the transcript recorded none (never guessed).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelUse {
    pub model: String,
    pub model_name: String,
    pub effort: Option<String>,
    /// Assistant messages written with this combination.
    pub messages: u32,
    /// Runs that used it at all.
    pub runs: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRow {
    pub session_id: String,
    /// Empty: the chat itself ran as this agent ("ran as the main chat").
    pub agent_id: String,
    pub started: i64,
    /// Time the helper spent working: first to last line, minus the idle gaps before each resume.
    pub duration_ms: i64,
    /// How many times a message woke the helper after it had finished.
    pub resumes: u32,
    pub tool_calls: u64,
    /// `finished` | `errored` | `stopped`, or None.
    pub end_status: Option<String>,
    /// `notice` | `sidecar` | `thread`.
    pub end_source: Option<String>,
    /// `pass` | `findings` | `partial` | `other`, or None (the report states no verdict).
    pub verdict: Option<String>,
    pub verdict_word: Option<String>,
    pub tokens: u64,
    /// Estimated dollars (hover only).
    pub cost: Cost,
    pub entrypoint: Option<String>,
    pub headless: bool,
    pub project_key: String,
    pub project: String,
    pub worktree_branch: Option<String>,
    /// The run's most used model and effort (None: no assistant message was read for it).
    pub model: Option<ModelUse>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TypeCard {
    pub agent_type: String,
    pub display_name: String,
    /// D7: a reviewer type (by name, or a verdict on at least half its runs).
    pub reviewer: bool,
    pub runs: u32,
    pub ends: EndCounts,
    /// Finished out of the runs whose end is known; None when none is.
    pub finish_rate: Option<f64>,
    /// Fewer than `Thresholds::MEDIAN_MIN_RUNS` runs: the medians are hidden ("Too few runs yet").
    pub too_few_runs: bool,
    /// None when `too_few_runs`.
    pub tool_calls_median: Option<u64>,
    /// Median of the helpers' own working time (D4, `RunRow::duration_ms`), over the runs that are
    /// not still running; never summed across parallel helpers. None when `too_few_runs`.
    pub duration_ms_median: Option<i64>,
    /// Runs a message woke after they had finished.
    pub resumed_runs: u32,
    pub tokens: Tokens,
    pub cost: Cost,
    /// Runs started per rolling week, oldest first, the last one ending today (always 12).
    pub weekly: Vec<u32>,
    pub started: StartedSplit,
    pub verdicts: Option<VerdictCounts>,
    pub reviews: Option<ReviewCounts>,
    pub projects: Vec<ProjectRuns>,
    /// The most used model and effort across the type's runs (the first of `mix`).
    pub top_model: Option<ModelUse>,
    /// Every model and effort combination the type's runs used, most messages first.
    pub mix: Vec<ModelUse>,
    /// The newest runs, newest first.
    pub recent: Vec<RunRow>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scorecard {
    pub from_ts: Option<i64>,
    pub to_ts: i64,
    /// "History covers the last N days": the age of the oldest chat in the cache.
    pub history_days: Option<u32>,
    pub total_runs: u32,
    /// Ordered by runs, then tokens.
    pub types: Vec<TypeCard>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ThemeArgs {
    pub days: Option<u32>,
    /// How many themes to return (default 12, at most 50).
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeverityCount {
    pub severity: String,
    pub count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TypeCount {
    pub agent_type: String,
    pub count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Example {
    pub text: String,
    pub session_id: String,
    pub agent_id: String,
    pub ts: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Theme {
    /// The `textgroup` group id (stable while the same leader wins).
    pub id: String,
    /// The most frequent original finding text (tie: newest), cut to 140 characters.
    pub label: String,
    pub count: u32,
    pub runs: u32,
    /// Most severe first, then a `none` bucket for findings without a severity.
    pub severities: Vec<SeverityCount>,
    /// Worker types the reviews were tied to (D10), by findings.
    pub found_in_work_by: Vec<TypeCount>,
    /// Findings whose review is not tied to one helper.
    pub not_tied: u32,
    /// Reviewer types that raised it.
    pub reviewers: Vec<TypeCount>,
    pub projects: Vec<String>,
    pub last_seen: i64,
    pub examples: Vec<Example>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Themes {
    pub from_ts: Option<i64>,
    /// Findings read in range (before grouping).
    pub findings: u32,
    /// Themes that pass the thresholds (before `limit`).
    pub total: u32,
    pub themes: Vec<Theme>,
}

// ---------------------------------------------------------------- loading

#[derive(Debug, Clone)]
struct RunRec {
    session_id: String,
    agent_id: String,
    agent_type: String,
    first_ts: i64,
    last_ts: i64,
    /// Time spent working (see `RunRow::duration_ms`).
    duration_ms: i64,
    resumes: u32,
    tool_calls: u64,
    end_status: Option<String>,
    end_source: Option<String>,
    verdict: Option<Verdict>,
    verdict_word: Option<String>,
    /// The verdict came from the `STATUS:` line (stored as `STATUS:<WORD>`), not a Verdict line.
    verdict_from_status: bool,
    worktree_branch: Option<String>,
    tool_use_id: Option<String>,
    project_key: String,
    project_path: String,
    entrypoint: Option<String>,
}

impl RunRec {
    fn headless(&self) -> bool {
        is_headless(self.entrypoint.as_deref())
    }
    /// Still going: no source says it ended and its last line is recent.
    fn running(&self, now_ms: i64) -> bool {
        self.end_status.is_none() && now_ms - self.last_ts < Thresholds::RUNNING_MS
    }
    fn facts(&self) -> RunFacts {
        RunFacts {
            agent_id: self.agent_id.clone(),
            agent_type: self.agent_type.clone(),
            first_ts: self.first_ts,
            last_ts: self.last_ts,
            tool_use_id: self.tool_use_id.clone(),
            verdict: self.verdict,
        }
    }
}

/// `(model id, effort or "", messages)` per (chat, helper id).
type ModelMix = HashMap<(String, String), Vec<(String, String, u32)>>;

/// Every run, the reviewer types (D7) and every chat's review ties (D10), computed once per query.
struct Ledger {
    runs: Vec<RunRec>,
    reviewers: HashSet<String>,
    /// Ties per chat.
    ties: HashMap<String, Vec<ReviewTie>>,
    /// `per_worker` per (chat, helper id).
    worker: HashMap<(String, String), WorkerReviews>,
    /// `(model id, effort or "", messages)` per (chat, helper id).
    models: ModelMix,
}

fn load_ledger(conn: &Connection) -> rusqlite::Result<Ledger> {
    let mut st = conn.prepare_cached(
        "SELECT r.session_id, r.agent_id, r.agent_type, COALESCE(r.first_ts, 0), COALESCE(r.last_ts, r.first_ts, 0),
                r.tool_calls, r.end_status, r.end_source, r.verdict, r.verdict_word, r.worktree_branch, a.tool_use_id,
                COALESCE(s.project_key, ''), COALESCE(s.project_path, ''), s.entrypoint,
                r.active_ms, r.resumes, COALESCE(r.seg_start, r.first_ts, 0)
         FROM agent_runs r
         LEFT JOIN agents a ON a.session_id = r.session_id AND a.agent_id = r.agent_id
         LEFT JOIN sessions s ON s.session_id = r.session_id",
    )?;
    let runs: Vec<RunRec> = st
        .query_map([], |r| {
            let word: Option<String> = r.get(9)?;
            let (first, last): (i64, i64) = (r.get(3)?, r.get(4)?);
            let (active, resumes, seg_start): (i64, i64, i64) = (r.get(15)?, r.get(16)?, r.get(17)?);
            let from_status = word.as_deref().is_some_and(|w| w.starts_with(reviews::STATUS_PREFIX));
            Ok(RunRec {
                session_id: r.get(0)?,
                agent_id: r.get(1)?,
                agent_type: r.get(2)?,
                first_ts: first,
                last_ts: last,
                duration_ms: if first > 0 { (active + (last - seg_start).max(0)).max(0) } else { 0 },
                resumes: resumes.max(0) as u32,
                tool_calls: u(r.get::<_, i64>(5)?),
                end_status: r.get(6)?,
                end_source: r.get(7)?,
                verdict: r.get::<_, Option<String>>(8)?.as_deref().and_then(Verdict::parse),
                verdict_word: word.map(|w| w.strip_prefix(reviews::STATUS_PREFIX).map_or(w.clone(), str::to_string)),
                verdict_from_status: from_status,
                worktree_branch: r.get(10)?,
                tool_use_id: r.get(11)?,
                project_key: r.get(12)?,
                project_path: r.get(13)?,
                entrypoint: r.get(14)?,
            })
        })?
        .collect::<Result<_, _>>()?;

    // D7 over all history, so a type's class does not flip with the range.
    let mut stats: BTreeMap<&str, (u64, u64)> = BTreeMap::new();
    for r in &runs {
        let e = stats.entry(r.agent_type.as_str()).or_default();
        e.0 += 1;
        // Only a Verdict line makes a type a reviewer; a worker's `STATUS: partial` does not.
        if r.verdict.is_some() && !r.verdict_from_status {
            e.1 += 1;
        }
    }
    let reviewers = reviews::reviewer_types(stats.iter().map(|(t, (n, v))| (*t, *n, *v)));

    // D10 for every chat that has a reviewer run (helper runs only: a chat's own run is not a helper).
    let mut by_chat: HashMap<&str, Vec<&RunRec>> = HashMap::new();
    for r in runs.iter().filter(|r| !r.agent_id.is_empty()) {
        by_chat.entry(r.session_id.as_str()).or_default().push(r);
    }
    by_chat.retain(|_, v| v.iter().any(|r| reviewers.contains(&r.agent_type)));
    let mut links: HashMap<String, Vec<LinkFacts>> = HashMap::new();
    {
        let mut st = conn.prepare_cached("SELECT session_id, kind, tool_use_id, COALESCE(ts, 0), subagent_type, target FROM agent_links")?;
        for row in st.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                LinkFacts {
                    send: r.get::<_, String>(1)? == "send",
                    tool_use_id: r.get(2)?,
                    ts: r.get(3)?,
                    subagent_type: r.get(4)?,
                    target: r.get(5)?,
                },
            ))
        })? {
            let (sid, l) = row?;
            if by_chat.contains_key(sid.as_str()) {
                links.entry(sid).or_default().push(l);
            }
        }
    }
    let is_rev = |t: &str| reviewers.contains(t);
    let mut ties: HashMap<String, Vec<ReviewTie>> = HashMap::new();
    let mut worker: HashMap<(String, String), WorkerReviews> = HashMap::new();
    for (sid, rs) in &by_chat {
        let facts: Vec<RunFacts> = rs.iter().map(|r| r.facts()).collect();
        let t = reviews::tie_reviews(&facts, links.get(*sid).map_or(&[][..], Vec::as_slice), &is_rev);
        for (w, c) in reviews::per_worker(&t) {
            worker.insert((sid.to_string(), w), c);
        }
        ties.insert(sid.to_string(), t);
    }
    let mut models: ModelMix = HashMap::new();
    {
        let mut st = conn.prepare_cached("SELECT session_id, agent_id, model, effort, n FROM agent_run_models")?;
        for row in st.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?, r.get::<_, i64>(4)?))
        })? {
            let (s, a, m, e, n) = row?;
            models.entry((s, a)).or_default().push((m, e, n.max(0) as u32));
        }
    }
    Ok(Ledger { runs, reviewers, ties, worker, models })
}

/// Tokens and priced groups per run (session id, agent id), for runs that started at or after `from_ms`.
fn run_usage(conn: &Connection, from_ms: i64) -> rusqlite::Result<HashMap<(String, String), Vec<Group>>> {
    let sql = format!(
        "SELECT m.session_id, COALESCE(m.agent_id, ''), m.model, {SUMS_QUALIFIED}
         FROM messages m JOIN agent_runs r ON r.session_id = m.session_id AND r.agent_id = COALESCE(m.agent_id, '')
         WHERE COALESCE(r.first_ts, 0) >= ?1
         GROUP BY m.session_id, COALESCE(m.agent_id, ''), m.model, m.speed, m.geo, m.service_tier, m.price_tier",
        SUMS_QUALIFIED = super::query::SUMS
    );
    let mut st = conn.prepare_cached(&sql)?;
    let mut out: HashMap<(String, String), Vec<Group>> = HashMap::new();
    for row in st.query_map([from_ms], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, group_from(r, 3)?)))? {
        let (s, a, g) = row?;
        out.entry((s, a)).or_default().push(g);
    }
    Ok(out)
}

fn add_tokens(to: &mut Tokens, t: &Tokens) {
    to.input += t.input;
    to.output += t.output;
    to.cache_write5m += t.cache_write5m;
    to.cache_write1h += t.cache_write1h;
    to.cache_read += t.cache_read;
    to.total += t.total;
    to.web_search += t.web_search;
    to.web_fetch += t.web_fetch;
}

fn sum_groups(gs: &[Group]) -> (Tokens, Cost) {
    let mut t = Tokens::default();
    let mut acc = Acc::default();
    for g in gs {
        add_tokens(&mut t, &g.t);
        acc.add(g);
    }
    (t, acc.cost())
}

fn median<T: Copy + Ord>(v: &mut [T]) -> Option<T> {
    if v.is_empty() {
        return None;
    }
    v.sort_unstable();
    Some(v[v.len() / 2])
}

/// A readable name built from a model id: `claude-opus-5-5` -> "Opus 5.5", `claude-fable-5-2` ->
/// "Fable 5.2", `claude-sonnet-4-5-20250929` -> "Sonnet 4.5", `claude-3-5-sonnet-20241022` ->
/// "Sonnet 3.5". An id of any other shape (one word of letters plus one or two version numbers is
/// the only shape read) is returned as written, so a new model is still named and counted.
pub fn model_name(id: &str) -> String {
    let raw = id.trim();
    let base = raw.split('[').next().unwrap_or(raw);
    let Some(rest) = base.strip_prefix("claude-") else { return raw.to_string() };
    let (mut family, mut nums): (Option<&str>, Vec<&str>) = (None, Vec::new());
    for part in rest.split('-') {
        if part.is_empty() {
            return raw.to_string();
        }
        if part.bytes().all(|b| b.is_ascii_digit()) {
            // 8 digits is a snapshot date, not a version.
            if part.len() <= 2 {
                nums.push(part);
            } else if part.len() != 8 {
                return raw.to_string();
            }
        } else if part.bytes().all(|b| b.is_ascii_alphabetic()) && part != "latest" {
            if family.replace(part).is_some() {
                return raw.to_string();
            }
        } else if part != "latest" {
            return raw.to_string();
        }
    }
    let Some(family) = family else { return raw.to_string() };
    if nums.len() > 2 {
        return raw.to_string();
    }
    let mut name: String = family[..1].to_ascii_uppercase();
    name.push_str(&family[1..].to_ascii_lowercase());
    if !nums.is_empty() {
        name.push(' ');
        name.push_str(&nums.join("."));
    }
    name
}

fn model_use(model: &str, effort: &str, messages: u32, runs: u32) -> ModelUse {
    ModelUse {
        model: model.to_string(),
        model_name: model_name(model),
        effort: (!effort.is_empty()).then(|| effort.to_string()),
        messages,
        runs,
    }
}

/// The most used combination of one run (ties: the lexically smaller model id, then effort).
fn top_of(rows: &[(String, String, u32)]) -> Option<ModelUse> {
    rows.iter()
        .max_by(|a, b| a.2.cmp(&b.2).then_with(|| b.0.cmp(&a.0)).then_with(|| b.1.cmp(&a.1)))
        .map(|(m, e, n)| model_use(m, e, *n, 1))
}

fn cut(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        return s.to_string();
    }
    let mut out: String = s.chars().take(n.saturating_sub(3)).collect();
    out.push_str("...");
    out
}

fn range_from(ctx: &QueryCtx, days: Option<u32>) -> Option<i64> {
    days.map(|d| ctx.now_ms - i64::from(d) * DAY_MS)
}

fn history_days(conn: &Connection, ctx: &QueryCtx) -> rusqlite::Result<Option<u32>> {
    let first: Option<i64> = conn.query_row("SELECT MIN(first_ts) FROM sessions WHERE first_ts > 0", [], |r| r.get(0))?;
    Ok(first.map(|f| ((ctx.now_ms - f).max(0) / DAY_MS) as u32 + 1))
}

fn in_scope(r: &RunRec, from: Option<i64>, started: StartedFrom) -> bool {
    from.is_none_or(|f| r.first_ts >= f)
        && match started {
            StartedFrom::All => true,
            StartedFrom::Interactive => !r.headless(),
            StartedFrom::Headless => r.headless(),
        }
}

// ---------------------------------------------------------------- the scorecard

pub fn agent_scorecard(conn: &Connection, ctx: &QueryCtx, a: &ScorecardArgs) -> rusqlite::Result<Scorecard> {
    let ledger = load_ledger(conn)?;
    let from = range_from(ctx, a.days);
    let usage = run_usage(conn, from.unwrap_or(0))?;

    let wanted: Vec<&RunRec> = ledger
        .runs
        .iter()
        .filter(|r| in_scope(r, from, a.started_from))
        .filter(|r| a.agent_type.as_deref().is_none_or(|t| t == r.agent_type))
        .collect();

    // Rolling weeks ending tonight: [today + 1 day - (12 - k) weeks, + 1 week).
    let today_start = super::query::day_start_ms(ctx.tz, &super::query::today_of(ctx));
    let week_end = today_start + DAY_MS;
    let week_of = |ts: i64| -> Option<usize> {
        let back = week_end - ts;
        if back <= 0 || back > WEEKS as i64 * 7 * DAY_MS {
            return None;
        }
        Some(WEEKS - 1 - ((back - 1) / (7 * DAY_MS)) as usize)
    };

    let mut by_type: BTreeMap<&str, Vec<&RunRec>> = BTreeMap::new();
    for r in &wanted {
        by_type.entry(r.agent_type.as_str()).or_default().push(r);
    }

    let mut types: Vec<TypeCard> = Vec::new();
    for (ty, runs) in by_type {
        let reviewer = ledger.reviewers.contains(ty);
        let mut ends = EndCounts::default();
        let mut started = StartedSplit::default();
        let mut tools: Vec<u64> = Vec::new();
        let mut durs: Vec<i64> = Vec::new();
        let mut resumed_runs = 0u32;
        let mut weekly = vec![0u32; WEEKS];
        let mut groups: Vec<Group> = Vec::new();
        let mut verdicts = VerdictCounts::default();
        let mut rc = ReviewCounts::default();
        let mut projects: BTreeMap<&str, ProjectRuns> = BTreeMap::new();
        // (model id, effort) -> (messages, runs)
        let mut mix: BTreeMap<(&str, &str), (u32, u32)> = BTreeMap::new();
        for r in &runs {
            match r.end_status.as_deref() {
                Some("finished") => ends.finished += 1,
                Some("errored") => ends.errored += 1,
                Some("stopped") => ends.stopped += 1,
                _ => ends.unknown += 1,
            }
            if r.headless() {
                started.headless += 1;
            } else {
                started.interactive += 1;
            }
            tools.push(r.tool_calls);
            if let Some(ms) = ledger.models.get(&(r.session_id.clone(), r.agent_id.clone())) {
                for (m, e, n) in ms {
                    let c = mix.entry((m.as_str(), e.as_str())).or_default();
                    c.0 += n;
                    c.1 += 1;
                }
            }
            // A run that is still going has no duration yet; every other run with times has one.
            if r.first_ts > 0 && !r.running(ctx.now_ms) {
                durs.push(r.duration_ms);
                if r.resumes > 0 {
                    resumed_runs += 1;
                }
            }
            if let Some(w) = week_of(r.first_ts) {
                weekly[w] += 1;
            }
            let g = usage.get(&(r.session_id.clone(), r.agent_id.clone()));
            if let Some(g) = g {
                groups.extend(g.iter().copied());
            }
            let tokens = g.map_or(0, |g| sum_groups(g).0.total);
            let p = projects.entry(r.project_key.as_str()).or_insert_with(|| ProjectRuns {
                project_key: r.project_key.clone(),
                name: super::query::base_name(&r.project_path),
                runs: 0,
                tokens: 0,
            });
            p.runs += 1;
            p.tokens += tokens;
            if reviewer {
                match r.verdict {
                    Some(Verdict::Pass) => verdicts.pass += 1,
                    Some(Verdict::Findings) => verdicts.findings += 1,
                    Some(Verdict::Partial) => verdicts.partial += 1,
                    Some(Verdict::Other) => verdicts.other += 1,
                    None => verdicts.none += 1,
                }
            } else if !r.agent_id.is_empty() {
                let w = ledger.worker.get(&(r.session_id.clone(), r.agent_id.clone())).copied().unwrap_or_default();
                rc.tied += w.tied;
                rc.passed += w.passed;
                rc.sent_back += w.sent_back;
                rc.other += w.other;
                if w.tied == 0 && w.sent_back == 0 {
                    rc.not_tied += 1;
                }
            }
        }
        rc.rate_ok = rc.tied >= Thresholds::RATE_MIN_REVIEWS;
        let known = ends.finished + ends.errored + ends.stopped;
        let (tokens, cost) = sum_groups(&groups);

        let mut newest = runs.clone();
        newest.sort_by(|a, b| b.first_ts.cmp(&a.first_ts).then_with(|| a.agent_id.cmp(&b.agent_id)));
        let recent = newest
            .iter()
            .take(RECENT_RUNS)
            .map(|r| {
                let (t, c) = usage.get(&(r.session_id.clone(), r.agent_id.clone())).map_or((Tokens::default(), Cost::default()), |g| sum_groups(g));
                RunRow {
                    session_id: r.session_id.clone(),
                    agent_id: r.agent_id.clone(),
                    started: r.first_ts,
                    duration_ms: r.duration_ms,
                    resumes: r.resumes,
                    tool_calls: r.tool_calls,
                    end_status: r.end_status.clone(),
                    end_source: r.end_source.clone(),
                    verdict: r.verdict.map(|v| v.as_str().to_string()),
                    verdict_word: r.verdict_word.clone(),
                    tokens: t.total,
                    cost: c,
                    entrypoint: r.entrypoint.clone(),
                    headless: r.headless(),
                    project_key: r.project_key.clone(),
                    project: super::query::base_name(&r.project_path),
                    worktree_branch: r.worktree_branch.clone(),
                    model: ledger.models.get(&(r.session_id.clone(), r.agent_id.clone())).and_then(|m| top_of(m)),
                }
            })
            .collect();

        let mut mix_rows: Vec<ModelUse> = mix.iter().map(|((m, e), (n, r))| model_use(m, e, *n, *r)).collect();
        mix_rows.sort_by(|a, b| b.messages.cmp(&a.messages).then_with(|| a.model.cmp(&b.model)).then_with(|| a.effort.cmp(&b.effort)));
        let mut projects: Vec<ProjectRuns> = projects.into_values().collect();
        projects.sort_by(|a, b| b.runs.cmp(&a.runs).then(b.tokens.cmp(&a.tokens)).then_with(|| a.name.cmp(&b.name)));

        types.push(TypeCard {
            agent_type: ty.to_string(),
            display_name: humanize_type(ty),
            reviewer,
            runs: runs.len() as u32,
            ends,
            finish_rate: (known > 0).then(|| f64::from(ends.finished) / f64::from(known)),
            too_few_runs: runs.len() < Thresholds::MEDIAN_MIN_RUNS,
            tool_calls_median: if runs.len() < Thresholds::MEDIAN_MIN_RUNS { None } else { median(&mut tools) },
            duration_ms_median: if durs.len() < Thresholds::MEDIAN_MIN_RUNS { None } else { median(&mut durs) },
            resumed_runs,
            tokens,
            cost,
            weekly,
            started,
            verdicts: reviewer.then_some(verdicts),
            reviews: (!reviewer).then_some(rc),
            projects,
            top_model: mix_rows.first().cloned(),
            mix: mix_rows,
            recent,
        });
    }
    types.sort_by(|a, b| b.runs.cmp(&a.runs).then(b.tokens.total.cmp(&a.tokens.total)).then_with(|| a.agent_type.cmp(&b.agent_type)));

    Ok(Scorecard {
        from_ts: from,
        to_ts: ctx.now_ms,
        history_days: history_days(conn, ctx)?,
        total_runs: wanted.len() as u32,
        types,
    })
}

// ---------------------------------------------------------------- themes

struct FindingRec {
    session_id: String,
    agent_id: String,
    severity: Option<String>,
    text: String,
    ts: i64,
    reviewer_type: String,
    project: String,
}

/// The findings of reviewer-type helpers only: a coder's "Issues fixed:" bullets or a quoted JSON
/// sample in its report are not review findings.
fn load_findings(conn: &Connection, ledger: &Ledger, from: Option<i64>, session: Option<&str>) -> rusqlite::Result<Vec<FindingRec>> {
    let mut st = conn.prepare_cached(
        "SELECT f.session_id, f.agent_id, f.severity, f.text, COALESCE(f.ts, r.last_ts, 0), r.agent_type,
                COALESCE(s.project_path, '')
         FROM review_findings f
         JOIN agent_runs r ON r.session_id = f.session_id AND r.agent_id = f.agent_id
         LEFT JOIN sessions s ON s.session_id = f.session_id
         WHERE COALESCE(f.ts, r.last_ts, 0) >= ?1 AND (?2 IS NULL OR f.session_id = ?2)
         ORDER BY f.session_id, f.agent_id, f.ord",
    )?;
    let rows = st.query_map(params![from.unwrap_or(0), session], |r| {
        Ok(FindingRec {
            session_id: r.get(0)?,
            agent_id: r.get(1)?,
            severity: r.get(2)?,
            text: r.get(3)?,
            ts: r.get(4)?,
            reviewer_type: r.get(5)?,
            project: super::query::base_name(&r.get::<_, String>(6)?),
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        let r = r?;
        if ledger.reviewers.contains(&r.reviewer_type) {
            out.push(r);
        }
    }
    Ok(out)
}

/// Group findings (D14) and keep the groups of at least `min_findings` findings from at least
/// `min_runs` runs. `tie` says which worker types a finding's review was tied to.
fn build_themes(
    rows: &[FindingRec],
    min_findings: usize,
    min_runs: usize,
    ledger: &Ledger,
) -> Vec<Theme> {
    let types: HashMap<(&str, &str), &str> =
        ledger.runs.iter().map(|r| ((r.session_id.as_str(), r.agent_id.as_str()), r.agent_type.as_str())).collect();
    // (session, reviewer id) -> worker ids it was tied to.
    let mut tied: HashMap<(&str, &str), Vec<&str>> = HashMap::new();
    for (sid, ts) in &ledger.ties {
        for t in ts {
            tied.insert((sid.as_str(), t.reviewer.as_str()), t.workers.iter().map(|(w, _)| w.as_str()).collect());
        }
    }

    let entries: Vec<(String, i64)> = rows.iter().map(|f| (textgroup::normalize_finding(&f.text), f.ts)).collect();
    let clusters = textgroup::cluster(&entries);
    let mut out: Vec<Theme> = Vec::new();
    for c in clusters {
        let members: Vec<&FindingRec> = c.members.iter().filter(|&&i| !entries[i].0.is_empty()).map(|&i| &rows[i]).collect();
        let runs: HashSet<(&str, &str)> = members.iter().map(|f| (f.session_id.as_str(), f.agent_id.as_str())).collect();
        if members.len() < min_findings || runs.len() < min_runs {
            continue;
        }
        // Label: the most frequent original text, ties to the newest.
        let mut freq: HashMap<&str, (u32, i64)> = HashMap::new();
        for f in &members {
            let e = freq.entry(f.text.as_str()).or_insert((0, i64::MIN));
            e.0 += 1;
            e.1 = e.1.max(f.ts);
        }
        let mut texts: Vec<(&str, (u32, i64))> = freq.into_iter().collect();
        texts.sort_by(|a, b| b.1 .0.cmp(&a.1 .0).then(b.1 .1.cmp(&a.1 .1)).then(a.0.cmp(b.0)));
        let label_text = texts[0].0;

        let mut sev: BTreeMap<usize, (String, u32)> = BTreeMap::new();
        let mut work: BTreeMap<&str, u32> = BTreeMap::new();
        let mut revs: BTreeMap<&str, u32> = BTreeMap::new();
        let mut projects: BTreeMap<&str, u32> = BTreeMap::new();
        let mut not_tied = 0u32;
        let mut last_seen = i64::MIN;
        for f in &members {
            let (rank, name) = match f.severity.as_deref() {
                Some(s) => (reviews::severity_rank(s), s.to_string()),
                None => (usize::MAX, "none".to_string()),
            };
            sev.entry(rank).or_insert((name, 0)).1 += 1;
            *revs.entry(f.reviewer_type.as_str()).or_default() += 1;
            if !f.project.is_empty() {
                *projects.entry(f.project.as_str()).or_default() += 1;
            }
            last_seen = last_seen.max(f.ts);
            match tied.get(&(f.session_id.as_str(), f.agent_id.as_str())) {
                Some(ws) if !ws.is_empty() => {
                    for w in ws {
                        if let Some(t) = types.get(&(f.session_id.as_str(), *w)) {
                            *work.entry(t).or_default() += 1;
                        }
                    }
                }
                _ => not_tied += 1,
            }
        }
        let mut examples: Vec<Example> = Vec::new();
        let mut seen_text: HashSet<&str> = HashSet::from([label_text]);
        let mut newest: Vec<&&FindingRec> = members.iter().collect();
        newest.sort_by(|a, b| b.ts.cmp(&a.ts).then_with(|| a.text.cmp(&b.text)));
        for f in newest {
            if examples.len() >= EXAMPLES {
                break;
            }
            if seen_text.insert(f.text.as_str()) {
                examples.push(Example { text: cut(&f.text, EXAMPLE_CHARS), session_id: f.session_id.clone(), agent_id: f.agent_id.clone(), ts: f.ts });
            }
        }
        let counted = |m: BTreeMap<&str, u32>| -> Vec<TypeCount> {
            let mut v: Vec<TypeCount> = m.into_iter().map(|(t, n)| TypeCount { agent_type: t.to_string(), count: n }).collect();
            v.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.agent_type.cmp(&b.agent_type)));
            v
        };
        let mut project_names: Vec<(&str, u32)> = projects.into_iter().collect();
        project_names.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));
        out.push(Theme {
            id: c.id,
            label: cut(label_text, LABEL_CHARS),
            count: members.len() as u32,
            runs: runs.len() as u32,
            severities: sev.into_values().map(|(severity, count)| SeverityCount { severity, count }).collect(),
            found_in_work_by: counted(work),
            not_tied,
            reviewers: counted(revs),
            projects: project_names.into_iter().map(|(p, _)| p.to_string()).collect(),
            last_seen,
            examples,
        });
    }
    out.sort_by(|a, b| b.count.cmp(&a.count).then(b.last_seen.cmp(&a.last_seen)).then_with(|| a.id.cmp(&b.id)));
    out
}

pub fn review_themes(conn: &Connection, ctx: &QueryCtx, a: &ThemeArgs) -> rusqlite::Result<Themes> {
    let ledger = load_ledger(conn)?;
    let from = range_from(ctx, a.days);
    let rows = load_findings(conn, &ledger, from, None)?;
    let all = build_themes(&rows, Thresholds::THEME_MIN_FINDINGS, Thresholds::THEME_MIN_RUNS, &ledger);
    let limit = a.limit.map_or(DEFAULT_THEMES, |l| l.clamp(1, 50) as usize);
    Ok(Themes { from_ts: from, findings: rows.len() as u32, total: all.len() as u32, themes: all.into_iter().take(limit).collect() })
}

// ---------------------------------------------------------------- the run debrief

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DebriefArgs {
    pub session_id: String,
    /// Epoch milliseconds; default the chat's first line.
    pub since: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebriefHelper {
    pub agent_id: String,
    pub agent_type: String,
    pub started: i64,
    pub duration_ms: i64,
    pub tool_calls: u64,
    pub end_status: Option<String>,
    pub verdict: Option<String>,
    pub verdict_word: Option<String>,
    pub tokens: u64,
    pub model: Option<ModelUse>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebriefReviews {
    pub passed: u32,
    /// Reviews that asked for changes.
    pub findings: u32,
    /// Workers a `findings` review sent back (D10).
    pub sent_back: u32,
    pub other: u32,
    pub no_verdict: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Biggest {
    /// Empty: the chat's own thread.
    pub agent_id: String,
    pub agent_type: Option<String>,
    pub tokens: u64,
    /// Share of all the tokens in the window, 0..=1.
    pub share: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunDebrief {
    pub session_id: String,
    pub from_ts: i64,
    /// The last line of the chat or any helper in the window.
    pub to_ts: i64,
    pub wall_ms: i64,
    pub helpers: Vec<DebriefHelper>,
    pub ends: EndCounts,
    pub reviews: DebriefReviews,
    pub tokens: Tokens,
    pub cost: Cost,
    pub biggest: Option<Biggest>,
    /// Helpers with no end seen (still running, or stuck): the caller applies its own stuck rule.
    pub open: Vec<DebriefHelper>,
    /// The themes of this chat's own findings, at least 2 findings from 2 runs.
    pub caught: Vec<Theme>,
}

pub fn run_debrief(conn: &Connection, ctx: &QueryCtx, a: &DebriefArgs) -> rusqlite::Result<Option<RunDebrief>> {
    let sid = a.session_id.as_str();
    let chat: Option<(i64, i64)> = conn
        .query_row("SELECT COALESCE(first_ts, 0), COALESCE(last_ts, 0) FROM sessions WHERE session_id = ?1", [sid], |r| Ok((r.get(0)?, r.get(1)?)))
        .ok();
    let Some((chat_first, chat_last)) = chat else { return Ok(None) };
    let from = a.since.unwrap_or(chat_first);

    // Per-thread tokens in the window (messages since `from`).
    let sql = format!(
        "SELECT COALESCE(agent_id, ''), model, {sums} FROM messages
         WHERE session_id = ?1 AND ts_utc_ms >= ?2
         GROUP BY COALESCE(agent_id, ''), model, speed, geo, service_tier, price_tier",
        sums = super::query::SUMS
    );
    let mut usage: HashMap<String, Vec<Group>> = HashMap::new();
    {
        let mut st = conn.prepare(&sql)?;
        for row in st.query_map(params![sid, from], |r| Ok((r.get::<_, String>(0)?, group_from(r, 2)?)))? {
            let (agent, g) = row?;
            usage.entry(agent).or_default().push(g);
        }
    }
    let all: Vec<Group> = usage.values().flatten().copied().collect();
    let (tokens, cost) = sum_groups(&all);

    let ledger = load_ledger(conn)?;
    let runs: Vec<&RunRec> = ledger.runs.iter().filter(|r| r.session_id == sid && !r.agent_id.is_empty() && r.first_ts >= from).collect();
    let helper_of = |r: &RunRec| DebriefHelper {
        agent_id: r.agent_id.clone(),
        agent_type: r.agent_type.clone(),
        started: r.first_ts,
        duration_ms: (r.last_ts - r.first_ts).max(0),
        tool_calls: r.tool_calls,
        end_status: r.end_status.clone(),
        verdict: r.verdict.map(|v| v.as_str().to_string()),
        verdict_word: r.verdict_word.clone(),
        tokens: usage.get(&r.agent_id).map_or(0, |g| sum_groups(g).0.total),
        model: ledger.models.get(&(r.session_id.clone(), r.agent_id.clone())).and_then(|m| top_of(m)),
    };
    let helpers: Vec<DebriefHelper> = {
        let mut v: Vec<DebriefHelper> = runs.iter().map(|r| helper_of(r)).collect();
        v.sort_by(|a, b| a.started.cmp(&b.started).then_with(|| a.agent_id.cmp(&b.agent_id)));
        v
    };
    let mut ends = EndCounts::default();
    for h in &helpers {
        match h.end_status.as_deref() {
            Some("finished") => ends.finished += 1,
            Some("errored") => ends.errored += 1,
            Some("stopped") => ends.stopped += 1,
            _ => ends.unknown += 1,
        }
    }
    let mut rv = DebriefReviews::default();
    for t in ledger.ties.get(sid).into_iter().flatten() {
        // Only reviews that ran in the window.
        if !runs.iter().any(|r| r.agent_id == t.reviewer) {
            continue;
        }
        match t.verdict {
            Some(Verdict::Pass) => rv.passed += 1,
            Some(Verdict::Findings) => rv.findings += 1,
            // A report that only got part of the way is not a pass; the debrief counts it with "other".
            Some(Verdict::Partial | Verdict::Other) => rv.other += 1,
            None => rv.no_verdict += 1,
        }
        rv.sent_back += t.sent_back.len() as u32;
    }

    let total = tokens.total.max(1);
    let biggest = usage
        .iter()
        .map(|(agent, g)| (agent.as_str(), sum_groups(g).0.total))
        .max_by(|a, b| a.1.cmp(&b.1).then_with(|| b.0.cmp(a.0)))
        .filter(|(_, t)| *t > 0)
        .map(|(agent, t)| Biggest {
            agent_id: agent.to_string(),
            agent_type: runs.iter().find(|r| r.agent_id == agent).map(|r| r.agent_type.clone()),
            tokens: t,
            share: t as f64 / total as f64,
        });
    let open: Vec<DebriefHelper> = helpers.iter().filter(|h| h.end_status.is_none()).cloned().collect();

    let to_ts = runs.iter().map(|r| r.last_ts).max().unwrap_or(0).max(chat_last);
    let findings = load_findings(conn, &ledger, Some(from), Some(sid))?;
    let caught: Vec<Theme> = build_themes(&findings, 2, 2, &ledger).into_iter().take(2).collect();
    let _ = ctx;
    Ok(Some(RunDebrief {
        session_id: sid.to_string(),
        from_ts: from,
        to_ts,
        wall_ms: (to_ts - from).max(0),
        helpers,
        ends,
        reviews: rv,
        tokens,
        cost,
        biggest,
        open,
        caught,
    }))
}
