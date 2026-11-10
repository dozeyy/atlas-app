//! Questions the pages ask (read only). Everything is computed from the small
//! aggregate tables (`usage_hour`, `session_model`); cost is priced at query time
//! through the SQL function `cost_usd`, so editing `pricing.json` reprices every
//! figure with no reindex (D26).

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use chrono::{Datelike, NaiveDate};
use rusqlite::types::Value;
use rusqlite::{params_from_iter, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::pricing::PriceTable;
use super::time::{add_days, Tz};

pub struct QueryCtx {
    pub tz: Tz,
    pub now_ms: i64,
    pub prices: Arc<PriceTable>,
    pub week_starts_sunday: bool,
}

// ---------------------------------------------------------------- shapes

/// `total` is what the pages headline: input + output + cache writes. Cache reads
/// are shown only in the breakdown (Q2).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tokens {
    pub input: u64,
    pub output: u64,
    pub cache_write5m: u64,
    pub cache_write1h: u64,
    pub cache_read: u64,
    pub total: u64,
    pub web_search: u64,
    pub web_fetch: u64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cost {
    /// Estimated dollars of what could be priced; `None` when nothing could be.
    pub usd: Option<f64>,
    /// False when some tokens belong to a model or mode the price list does not cover.
    pub complete: bool,
    pub unpriced_tokens: u64,
}

#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct Group {
    pub(crate) t: Tokens,
    pub(crate) cost: Option<f64>,
}

#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct Acc {
    t: Tokens,
    usd: f64,
    priced: bool,
    unpriced: u64,
}

impl Acc {
    pub(crate) fn add(&mut self, g: &Group) {
        self.t.input += g.t.input;
        self.t.output += g.t.output;
        self.t.cache_write5m += g.t.cache_write5m;
        self.t.cache_write1h += g.t.cache_write1h;
        self.t.cache_read += g.t.cache_read;
        self.t.web_search += g.t.web_search;
        self.t.web_fetch += g.t.web_fetch;
        self.t.total += g.t.total;
        match g.cost {
            Some(c) => {
                self.usd += c;
                self.priced = true;
            }
            None => self.unpriced += g.t.total,
        }
    }
    pub(crate) fn cost(&self) -> Cost {
        let none_priced = !self.priced && self.unpriced > 0;
        Cost { usd: if none_priced { None } else { Some(self.usd) }, complete: self.unpriced == 0, unpriced_tokens: self.unpriced }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Period {
    pub tokens: Tokens,
    pub cost: Cost,
    pub sessions: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelUse {
    pub model: String,
    pub known: bool,
    pub tokens: Tokens,
    pub cost: Cost,
    /// Replies per reasoning effort, most used first (empty where it is not asked for, and for
    /// replies the transcripts give no effort).
    #[serde(default)]
    pub efforts: Vec<EffortUse>,
}

/// How many replies ran at one reasoning effort (`low`, `medium`, `high`, `xhigh`, `max`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EffortUse {
    pub effort: String,
    pub replies: u64,
}

/// Sort order for efforts with equal counts: the known ladder, then anything new by name.
pub fn effort_rank(e: &str) -> (usize, &str) {
    const LADDER: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];
    (LADDER.iter().position(|l| *l == e).unwrap_or(LADDER.len()), e)
}

/// `(key, effort, count)` rows -> each key's effort mix, most used first. Rows with no effort
/// are not listed (absent stays absent).
fn effort_mix<P: rusqlite::Params>(conn: &Connection, sql: &str, p: P) -> rusqlite::Result<HashMap<String, Vec<EffortUse>>> {
    let mut out: HashMap<String, Vec<EffortUse>> = HashMap::new();
    let mut st = conn.prepare_cached(sql)?;
    for r in st.query_map(p, |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?, u(r.get::<_, i64>(2)?))))? {
        let (k, e, n) = r?;
        if let Some(e) = e.filter(|e| !e.is_empty()) {
            out.entry(k).or_default().push(EffortUse { effort: e, replies: n });
        }
    }
    for v in out.values_mut() {
        v.sort_by(|a, b| b.replies.cmp(&a.replies).then_with(|| effort_rank(&a.effort).cmp(&effort_rank(&b.effort))));
    }
    Ok(out)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectUse {
    pub project_key: String,
    pub name: String,
    pub path: String,
    pub tokens: Tokens,
    pub cost: Cost,
    pub sessions: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Warnings {
    pub unknown_models: Vec<String>,
    pub unpriced_tokens: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Dashboard {
    pub today: Period,
    pub week: Period,
    pub month: Period,
    pub by_model: Vec<ModelUse>,
    pub top_projects: Vec<ProjectUse>,
    pub recent: Vec<SessionRow>,
    pub warnings: Warnings,
    /// The local day the periods end on (`YYYY-MM-DD`).
    pub today_date: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelinePoint {
    pub start: String,
    pub tokens: Tokens,
    pub cost: Cost,
    pub sessions: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Series {
    pub key: String,
    pub label: String,
    pub points: Vec<TimelinePoint>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Timeline {
    pub bucket: String,
    pub points: Vec<TimelinePoint>,
    pub series: Option<Vec<Series>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineArgs {
    pub from: String,
    pub to: String,
    pub bucket: String,
    #[serde(default)]
    pub group_by: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionQuery {
    #[serde(default)]
    pub from: Option<String>,
    #[serde(default)]
    pub to: Option<String>,
    #[serde(default)]
    pub projects: Vec<String>,
    #[serde(default)]
    pub models: Vec<String>,
    #[serde(default)]
    pub text: Option<String>,
    /// Sessions to list in addition to the ones `text` finds: the chats whose messages matched
    /// a search. With `text` empty, only these. Every other filter still applies. Capped at
    /// `ALSO_IDS_MAX`.
    #[serde(default)]
    pub also_ids: Vec<String>,
    #[serde(default)]
    pub min_cost_usd: Option<f64>,
    /// Sessions whose transcript files are gone stay listed unless the caller says false
    /// (the same default the UI sends).
    #[serde(default = "yes")]
    pub include_missing: bool,
    #[serde(default)]
    pub sort: String,
    #[serde(default)]
    pub dir: String,
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default)]
    pub limit: usize,
}

fn yes() -> bool {
    true
}

impl Default for SessionQuery {
    fn default() -> Self {
        SessionQuery {
            from: None,
            to: None,
            projects: Vec::new(),
            models: Vec::new(),
            text: None,
            also_ids: Vec::new(),
            min_cost_usd: None,
            include_missing: true,
            sort: String::new(),
            dir: String::new(),
            cursor: None,
            limit: 0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRow {
    pub session_id: String,
    pub title: Option<String>,
    /// What the UI calls the session: the title, else a summary of the first prompt, else None
    /// (the UI then says "Session in <project>"). Never an id.
    pub name: Option<String>,
    /// "title", "agent", "prompt" or "none".
    pub name_source: String,
    /// Subagent transcripts that belong to this session (they are never rows of their own).
    pub agent_count: u64,
    pub project_name: String,
    pub project_path: String,
    pub started_at: i64,
    pub ended_at: i64,
    pub duration_ms: i64,
    pub models: Vec<String>,
    /// The model of the chat itself (most of the main thread's tokens; "" when it has none).
    #[serde(default)]
    pub main_model: String,
    /// The chat's own replies per reasoning effort, most used first (helpers have their own).
    #[serde(default)]
    pub efforts: Vec<EffortUse>,
    pub messages: u64,
    pub subagent_messages: u64,
    pub tokens: Tokens,
    pub cost: Cost,
    pub missing: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPage {
    pub rows: Vec<SessionRow>,
    pub next_cursor: Option<String>,
    pub total: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ByModel {
    pub model: String,
    /// The price list knows this model (a known model can still be unpriced for one reply,
    /// e.g. a speed or tier the list has no rate for).
    #[serde(default)]
    pub known: bool,
    pub tokens: Tokens,
    pub cost: Cost,
    /// Replies per reasoning effort on this model, most used first.
    #[serde(default)]
    pub efforts: Vec<EffortUse>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ByAgent {
    pub agent_id: Option<String>,
    pub messages: u64,
    pub tokens: Tokens,
    pub cost: Cost,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessagePoint {
    pub ts: i64,
    pub model: String,
    pub agent_id: Option<String>,
    pub tokens: Tokens,
    pub cost: Cost,
    pub skill: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRef {
    pub path: String,
    pub is_subagent: bool,
    pub missing: bool,
}

/// One subagent of a session, with what it spent. Counted once, under its session.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSummary {
    pub agent_id: String,
    /// From the Agent/Task description, else the agent type, else the first prompt, else "Helper".
    pub name: String,
    /// "description", "type", "prompt" or "fallback".
    pub name_source: String,
    pub agent_type: Option<String>,
    pub description: Option<String>,
    pub tool_use_id: Option<String>,
    /// The agent that spawned this one (nested subagents).
    pub parent_agent_id: Option<String>,
    pub spawn_depth: i64,
    /// The model that did most of the work ("" when it made no priced call).
    pub model: String,
    pub models: Vec<String>,
    /// The helper's replies per reasoning effort, most used first.
    #[serde(default)]
    pub efforts: Vec<EffortUse>,
    pub messages: u64,
    pub tokens: Tokens,
    pub cost: Cost,
    pub started_at: i64,
    pub ended_at: i64,
    pub duration_ms: i64,
    pub tool_calls: u64,
    /// Its transcript file is gone; the numbers are what was read before.
    pub missing: bool,
}

/// The main conversation alone (without any subagent).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MainThread {
    pub messages: u64,
    pub tokens: Tokens,
    pub cost: Cost,
    pub tool_calls: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDetail {
    pub session_id: String,
    pub session_name: Option<String>,
    pub project_name: String,
    pub agent: AgentSummary,
    pub parent_name: Option<String>,
    pub by_model: Vec<ByModel>,
    pub timeline: Vec<MessagePoint>,
    /// The transcript file, for reading the prompt on demand.
    pub file: Option<FileRef>,
    /// What the agent was asked, read from its transcript on demand (never cached).
    pub prompt: Option<String>,
    pub prompt_truncated: bool,
    /// The session's total, so the page can say "x % of this session".
    pub session_tokens: Tokens,
    pub session_cost: Cost,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDetail {
    pub row: SessionRow,
    pub by_model: Vec<ByModel>,
    pub by_agent: Vec<ByAgent>,
    /// The subagents, in the order they started.
    pub agents: Vec<AgentSummary>,
    /// The main conversation alone; `row.tokens` / `row.cost` are main plus every subagent.
    pub main: MainThread,
    pub timeline: Vec<MessagePoint>,
    pub files: Vec<FileRef>,
    pub claude_code_cost_usd: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRef {
    pub project_key: String,
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRef {
    pub model: String,
    pub known: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterOptions {
    pub projects: Vec<ProjectRef>,
    pub models: Vec<ModelRef>,
}

// ---------------------------------------------------------------- helpers

pub(crate) fn u(v: i64) -> u64 {
    v.max(0) as u64
}

pub(crate) fn group_from(row: &rusqlite::Row, at: usize) -> rusqlite::Result<Group> {
    let g = |i: usize| row.get::<_, i64>(at + i).map(u);
    let (input, output, w5, w1, cr, ws, wf) = (g(0)?, g(1)?, g(2)?, g(3)?, g(4)?, g(5)?, g(6)?);
    Ok(Group {
        t: Tokens {
            input,
            output,
            cache_write5m: w5,
            cache_write1h: w1,
            cache_read: cr,
            total: input + output + w5 + w1,
            web_search: ws,
            web_fetch: wf,
        },
        cost: row.get::<_, Option<f64>>(at + 7)?,
    })
}

pub(crate) const SUMS: &str = "SUM(input), SUM(output), SUM(cw5m), SUM(cw1h), SUM(cr), SUM(web_search), SUM(web_fetch), \
     cost_usd(model, speed, geo, service_tier, price_tier, SUM(input), SUM(output), SUM(cw5m), SUM(cw1h), SUM(cr), SUM(web_search))";

struct GroupRow {
    k: String,
    s: String,
    model: String,
    g: Group,
}

/// `usage_hour` rows between two days (inclusive), grouped by the two key
/// expressions plus everything that changes the price.
fn fetch_hours(
    conn: &Connection,
    key: &str,
    series: &str,
    from_day: &str,
    to_day: &str,
) -> rusqlite::Result<Vec<GroupRow>> {
    let sql = format!(
        "SELECT {key} AS k, {series} AS s, model, {SUMS} FROM usage_hour \
         WHERE hour_local >= ?1 AND hour_local < ?2 \
         GROUP BY k, s, model, speed, geo, service_tier, price_tier"
    );
    let lo = format!("{from_day}T00");
    let hi = format!("{}T00", add_days(to_day, 1));
    let mut st = conn.prepare_cached(&sql)?;
    let rows = st.query_map([lo, hi], |r| {
        Ok(GroupRow { k: r.get(0)?, s: r.get(1)?, model: r.get(2)?, g: group_from(r, 3)? })
    })?;
    rows.collect()
}

/// Local midnight of `day` as epoch milliseconds.
pub fn day_start_ms(tz: Tz, day: &str) -> i64 {
    let Ok(d) = NaiveDate::parse_from_str(day, "%Y-%m-%d") else { return 0 };
    let naive_ms = d.and_hms_opt(0, 0, 0).map(|n| n.and_utc().timestamp_millis()).unwrap_or(0);
    let guess = naive_ms - i64::from(tz.offset_secs(naive_ms)) * 1000;
    naive_ms - i64::from(tz.offset_secs(guess)) * 1000
}

pub fn today_of(ctx: &QueryCtx) -> String {
    ctx.tz.day(ctx.now_ms)
}

/// Today only: the same numbers as `Dashboard.today`, without the 30-day work (the
/// tray asks this every time the cache changes).
pub fn today(conn: &Connection, ctx: &QueryCtx) -> rusqlite::Result<Period> {
    let day = today_of(ctx);
    let rows = fetch_hours(conn, "substr(hour_local,1,10)", "''", &day, &day)?;
    Ok(period(&rows, &day, &day, sessions_active(conn, ctx.tz, &day, &day)?))
}

fn project_index(conn: &Connection) -> rusqlite::Result<HashMap<String, (String, String)>> {
    let mut st = conn.prepare_cached(
        "SELECT project_key, MIN(project_path) FROM sessions WHERE project_key IS NOT NULL GROUP BY project_key",
    )?;
    let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?.unwrap_or_default())))?;
    let mut out = HashMap::new();
    for r in rows {
        let (k, p) = r?;
        out.insert(k, (base_name(&p), p));
    }
    Ok(out)
}

pub fn base_name(path: &str) -> String {
    path.trim_end_matches(['/', '\\']).rsplit(['/', '\\']).next().unwrap_or("").to_string()
}

/// Sessions with at least one message in `[from_day, to_day]`. A conversation that began
/// yesterday and carried on today counts for today: the cards show tokens by when they were
/// used, so the session count must follow the same rule. Candidates come from the indexed
/// `sessions` span; the per-session probe uses `messages_session`, so this stays cheap.
fn sessions_active(conn: &Connection, tz: Tz, from_day: &str, to_day: &str) -> rusqlite::Result<u64> {
    let lo = day_start_ms(tz, from_day);
    let hi = day_start_ms(tz, &add_days(to_day, 1));
    conn.query_row(
        "SELECT COUNT(*) FROM sessions s WHERE s.messages > 0 AND s.last_ts >= ?1 AND s.first_ts < ?2 \
         AND EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.session_id AND m.ts_utc_ms >= ?1 AND m.ts_utc_ms < ?2)",
        [lo, hi],
        |r| r.get::<_, i64>(0),
    )
    .map(u)
}

fn period(rows: &[GroupRow], from_day: &str, to_day: &str, sessions: u64) -> Period {
    let mut a = Acc::default();
    for r in rows.iter().filter(|r| r.k.as_str() >= from_day && r.k.as_str() <= to_day) {
        a.add(&r.g);
    }
    Period { tokens: a.t, cost: a.cost(), sessions }
}

// ---------------------------------------------------------------- dashboard

pub fn dashboard(conn: &Connection, ctx: &QueryCtx) -> rusqlite::Result<Dashboard> {
    let today = today_of(ctx);
    let d7 = add_days(&today, -6);
    let d30 = add_days(&today, -29);
    let by_day = fetch_hours(conn, "substr(hour_local,1,10)", "''", &d30, &today)?;

    let today_p = period(&by_day, &today, &today, sessions_active(conn, ctx.tz, &today, &today)?);
    let week_p = period(&by_day, &d7, &today, sessions_active(conn, ctx.tz, &d7, &today)?);
    let month_p = period(&by_day, &d30, &today, sessions_active(conn, ctx.tz, &d30, &today)?);

    let mut models: BTreeMap<&str, Acc> = BTreeMap::new();
    for r in &by_day {
        models.entry(r.model.as_str()).or_default().add(&r.g);
    }
    let mut by_model: Vec<ModelUse> = models
        .into_iter()
        .map(|(m, a)| ModelUse { model: m.to_string(), known: ctx.prices.is_known(m), tokens: a.t, cost: a.cost(), efforts: Vec::new() })
        .collect();
    by_model.sort_by(|a, b| b.tokens.total.cmp(&a.tokens.total).then_with(|| a.model.cmp(&b.model)));

    let mut unknown: Vec<String> = by_model.iter().filter(|m| !m.known).map(|m| m.model.clone()).collect();
    unknown.sort();
    let mut unpriced = 0;
    for r in &by_day {
        if r.g.cost.is_none() {
            unpriced += r.g.t.total;
        }
    }

    // Top projects over 30 days (+ "other").
    let by_proj = fetch_hours(conn, "''", "project_key", &d30, &today)?;
    let names = project_index(conn)?;
    let mut projs: BTreeMap<&str, Acc> = BTreeMap::new();
    for r in &by_proj {
        projs.entry(r.s.as_str()).or_default().add(&r.g);
    }
    let lo = day_start_ms(ctx.tz, &d30);
    let hi = day_start_ms(ctx.tz, &add_days(&today, 1));
    let mut counts: HashMap<String, u64> = HashMap::new();
    {
        let mut st = conn.prepare_cached(
            "SELECT COALESCE(s.project_key,''), COUNT(*) FROM sessions s \
             WHERE s.messages > 0 AND s.last_ts >= ?1 AND s.first_ts < ?2 \
             AND EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.session_id AND m.ts_utc_ms >= ?1 AND m.ts_utc_ms < ?2) \
             GROUP BY 1",
        )?;
        for r in st.query_map([lo, hi], |r| Ok((r.get::<_, String>(0)?, u(r.get::<_, i64>(1)?))))? {
            let (k, n) = r?;
            counts.insert(k, n);
        }
    }
    let mut list: Vec<(&str, Acc)> = projs.into_iter().collect();
    list.sort_by(|a, b| b.1.t.total.cmp(&a.1.t.total).then_with(|| a.0.cmp(b.0)));
    let mut top_projects = Vec::new();
    let mut other = Acc::default();
    let mut other_sessions = 0;
    let mut other_any = false;
    for (i, (k, a)) in list.into_iter().enumerate() {
        let sessions = counts.get(k).copied().unwrap_or(0);
        if i < 8 {
            let (name, path) = names.get(k).cloned().unwrap_or_else(|| (String::new(), String::new()));
            let name = if name.is_empty() { "Unknown project".to_string() } else { name };
            top_projects.push(ProjectUse {
                project_key: k.to_string(),
                name,
                path,
                tokens: a.t,
                cost: a.cost(),
                sessions,
            });
        } else {
            other_any = true;
            other_sessions += sessions;
            other.t.input += a.t.input;
            other.t.output += a.t.output;
            other.t.cache_write5m += a.t.cache_write5m;
            other.t.cache_write1h += a.t.cache_write1h;
            other.t.cache_read += a.t.cache_read;
            other.t.total += a.t.total;
            other.t.web_search += a.t.web_search;
            other.t.web_fetch += a.t.web_fetch;
            other.usd += a.usd;
            other.priced |= a.priced;
            other.unpriced += a.unpriced;
        }
    }
    if other_any {
        top_projects.push(ProjectUse {
            project_key: String::new(),
            name: "Other".into(),
            path: String::new(),
            tokens: other.t,
            cost: other.cost(),
            sessions: other_sessions,
        });
    }

    let recent = session_rows_for(
        conn,
        ctx,
        &ids_by(conn, "SELECT session_id FROM sessions WHERE messages > 0 ORDER BY last_ts DESC, session_id DESC LIMIT 8")?,
    )?;
    Ok(Dashboard {
        today: today_p,
        week: week_p,
        month: month_p,
        by_model,
        top_projects,
        recent,
        warnings: Warnings { unknown_models: unknown, unpriced_tokens: unpriced },
        today_date: today,
    })
}

fn ids_by(conn: &Connection, sql: &str) -> rusqlite::Result<Vec<String>> {
    let mut st = conn.prepare_cached(sql)?;
    let v = st.query_map([], |r| r.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()?;
    Ok(v)
}

// ---------------------------------------------------------------- timeline

fn bucket_of(day: &str, bucket: &str, sunday: bool) -> String {
    match bucket {
        "week" => match NaiveDate::parse_from_str(day, "%Y-%m-%d") {
            Ok(d) => {
                let back = if sunday {
                    d.weekday().num_days_from_sunday()
                } else {
                    d.weekday().num_days_from_monday()
                };
                add_days(day, -i64::from(back))
            }
            Err(_) => day.to_string(),
        },
        "month" => format!("{}-01", &day[..day.len().min(7)]),
        _ => day.to_string(),
    }
}

/// Every bucket start between two days, in order (zero fill).
fn bucket_starts(from: &str, to: &str, bucket: &str, sunday: bool) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut day = from.to_string();
    let mut guard = 0;
    while day.as_str() <= to && guard < 4000 {
        if bucket == "hour" {
            for h in 0..24 {
                out.push(format!("{day}T{h:02}"));
            }
        } else {
            let b = bucket_of(&day, bucket, sunday);
            if out.last() != Some(&b) {
                out.push(b);
            }
        }
        day = add_days(&day, 1);
        guard += 1;
    }
    out
}

pub fn timeline(conn: &Connection, ctx: &QueryCtx, a: &TimelineArgs) -> rusqlite::Result<Timeline> {
    let bucket = match a.bucket.as_str() {
        "hour" | "day" | "week" | "month" => a.bucket.as_str(),
        _ => "day",
    };
    // The window is clamped so a bad range cannot ask for a million buckets.
    let (from, to) = (a.from.as_str(), a.to.as_str());
    let key = if bucket == "hour" { "hour_local" } else { "substr(hour_local,1,10)" };
    let series_expr = match a.group_by.as_deref() {
        Some("model") => "model",
        Some("project") => "project_key",
        _ => "''",
    };
    let rows = fetch_hours(conn, key, series_expr, from, to)?;
    let starts = bucket_starts(from, to, bucket, ctx.week_starts_sunday);
    let to_bucket = |k: &str| -> String {
        if bucket == "hour" {
            k.to_string()
        } else {
            bucket_of(k, bucket, ctx.week_starts_sunday)
        }
    };

    let mut total: BTreeMap<String, Acc> = starts.iter().map(|s| (s.clone(), Acc::default())).collect();
    let mut per_series: BTreeMap<String, BTreeMap<String, Acc>> = BTreeMap::new();
    for r in &rows {
        let b = to_bucket(&r.k);
        if let Some(acc) = total.get_mut(&b) {
            acc.add(&r.g);
            if series_expr != "''" {
                per_series.entry(r.s.clone()).or_default().entry(b).or_default().add(&r.g);
            }
        }
    }

    // Sessions started per bucket.
    let lo = day_start_ms(ctx.tz, from);
    let hi = day_start_ms(ctx.tz, &add_days(to, 1));
    let mut sess: HashMap<String, u64> = HashMap::new();
    {
        let expr = if bucket == "hour" { "hour_of(first_ts)" } else { "substr(hour_of(first_ts),1,10)" };
        let sql = format!(
            "SELECT {expr}, COUNT(*) FROM sessions WHERE messages > 0 AND first_ts >= ?1 AND first_ts < ?2 GROUP BY 1"
        );
        let mut st = conn.prepare_cached(&sql)?;
        for r in st.query_map([lo, hi], |r| Ok((r.get::<_, String>(0)?, u(r.get::<_, i64>(1)?))))? {
            let (k, n) = r?;
            *sess.entry(to_bucket(&k)).or_default() += n;
        }
    }

    let points: Vec<TimelinePoint> = starts
        .iter()
        .map(|s| {
            let a = total.get(s).copied().unwrap_or_default();
            TimelinePoint { start: s.clone(), tokens: a.t, cost: a.cost(), sessions: sess.get(s).copied().unwrap_or(0) }
        })
        .collect();

    let series = if series_expr == "''" {
        None
    } else {
        let names = if series_expr == "project_key" { project_index(conn)? } else { HashMap::new() };
        let mut list: Vec<(String, BTreeMap<String, Acc>)> = per_series.into_iter().collect();
        list.sort_by_key(|(_, m)| std::cmp::Reverse(m.values().map(|a| a.t.total).sum::<u64>()));
        let mut out: Vec<Series> = Vec::new();
        let mut rest: BTreeMap<String, Acc> = BTreeMap::new();
        for (i, (k, m)) in list.into_iter().enumerate() {
            if i < 8 {
                let label = if series_expr == "model" {
                    k.clone()
                } else {
                    names.get(&k).map(|n| n.0.clone()).filter(|n| !n.is_empty()).unwrap_or_else(|| "Unknown project".into())
                };
                let pts = starts
                    .iter()
                    .map(|s| {
                        let a = m.get(s).copied().unwrap_or_default();
                        TimelinePoint { start: s.clone(), tokens: a.t, cost: a.cost(), sessions: 0 }
                    })
                    .collect();
                out.push(Series { key: k, label, points: pts });
            } else {
                for (s, a) in m {
                    let e = rest.entry(s).or_default();
                    e.t.total += a.t.total;
                    e.t.input += a.t.input;
                    e.t.output += a.t.output;
                    e.t.cache_write5m += a.t.cache_write5m;
                    e.t.cache_write1h += a.t.cache_write1h;
                    e.t.cache_read += a.t.cache_read;
                    e.usd += a.usd;
                    e.priced |= a.priced;
                    e.unpriced += a.unpriced;
                }
            }
        }
        if !rest.is_empty() {
            let pts = starts
                .iter()
                .map(|s| {
                    let a = rest.get(s).copied().unwrap_or_default();
                    TimelinePoint { start: s.clone(), tokens: a.t, cost: a.cost(), sessions: 0 }
                })
                .collect();
            out.push(Series { key: String::new(), label: "Other".into(), points: pts });
        }
        Some(out)
    };
    Ok(Timeline { bucket: bucket.to_string(), points, series })
}

// ---------------------------------------------------------------- scope report

/// Any day range, optionally one project: what the `atlas-usage` CLI (and the skill on
/// top of it) shows. Built from the same `usage_hour` rows, session rule and pricing as
/// the dashboard and timeline, so a day here equals that day's bar in the app.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopeArgs {
    pub from: String,
    pub to: String,
    /// A `sessions.project_key` (see `ingest::project_key`); `None` = every project.
    #[serde(default)]
    pub project_key: Option<String>,
    /// "day" (default), "week" or "month".
    #[serde(default)]
    pub bucket: String,
    /// How many of the biggest chats to list (0 = none).
    #[serde(default)]
    pub top: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopeReport {
    pub from: String,
    pub to: String,
    pub bucket: String,
    /// Tokens and cost in the range; `sessions` = chats with a message in it.
    pub total: Period,
    pub by_model: Vec<ModelUse>,
    /// One point per bucket, zero-filled; `sessions` = chats started in that bucket.
    pub points: Vec<TimelinePoint>,
    /// Every project with usage in the range, biggest first.
    pub projects: Vec<ProjectUse>,
    /// The `top` biggest chats, with `tokens`, `cost` and `models` counted inside the
    /// range only (the other fields describe the whole chat).
    pub chats: Vec<SessionRow>,
}

/// The first local day with any recorded usage (`None` on an empty cache).
pub fn first_day(conn: &Connection) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT MIN(substr(hour_local,1,10)) FROM usage_hour", [], |r| r.get::<_, Option<String>>(0))
}

/// What a typical run of one kind of helper looks like: medians over its finished runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TypicalRun {
    pub agent_type: String,
    /// Median tool calls of a run.
    pub calls: u32,
    /// Median length of a run, ms (first to last recorded message).
    pub ms: i64,
    /// How many finished runs the medians come from.
    pub runs: u32,
}

/// A helper with no message for this long is counted as over (the helper ledger will carry a
/// recorded end status; until then this is the rule).
const TYPICAL_ENDED_AFTER_MS: i64 = 10 * 60_000;

/// A gap this long inside one helper file means it was resumed or abandoned and carried on: longer
/// than the longest quiet build the live tracker still calls working (20 min), so a slow single run
/// is kept and a message hours later is not.
const TYPICAL_RUN_GAP_MS: i64 = 30 * 60_000;

fn median<T: Copy + Ord + Into<i64>>(v: &mut [T]) -> i64 {
    v.sort_unstable();
    let n = v.len();
    if n == 0 {
        return 0;
    }
    if n % 2 == 1 { v[n / 2].into() } else { (v[n / 2 - 1].into() + v[n / 2].into()) / 2 }
}

/// One finished run of a helper: its kind, tool calls and length. The seam the helper ledger will
/// fill from its recorded runs (with their real end status, which this cache does not hold):
/// swap `finished_runs` for a ledger query and `medians` stays as it is.
struct RunSample {
    agent_type: String,
    calls: i64,
    ms: i64,
}

/// Helper runs that ended in `[since, over_by]`, one per helper file, from the cache.
///
/// What counts as one run: a helper whose messages form one continuous stretch (no gap longer
/// than `TYPICAL_RUN_GAP_MS`). A helper that was resumed, or went quiet for longer than that
/// and carried on, spans several lifetimes and the cache keeps one tool-call total per file, so
/// it cannot be cut into honest runs: it is left out rather than counted as one huge run.
/// What this cache cannot say is how a run ended (a killed or failed helper looks like a finished
/// one); the ledger will.
///
/// The time bound is in the `WHERE` of the inner scan (the `messages_ts` index, named in the query:
/// left alone the planner walks every helper file by `messages_file`, 224 ms against 60 ms for a
/// week on a 127k-message cache, EXPLAIN QUERY PLAN 2026-11-09), a day looser than
/// `since` so a run that began just before it is not cut short; the exact bound is on the run's
/// last message in the `HAVING`, where a helper with a message older than the loose bound is left
/// out too: its span is only partly in view, so its lifetime tool-call total would not fit it.
fn finished_runs(conn: &Connection, since: i64, over_by: i64) -> rusqlite::Result<Vec<RunSample>> {
    let mut st = conn.prepare_cached(
        "WITH seen AS ( \
           SELECT m.file_id AS file_id, m.ts_utc_ms AS ts, \
                  m.ts_utc_ms - LAG(m.ts_utc_ms) OVER (PARTITION BY m.file_id ORDER BY m.ts_utc_ms) AS gap \
           FROM messages m INDEXED BY messages_ts \
           WHERE m.ts_utc_ms >= ?1 \
             AND m.file_id IN (SELECT file_id FROM agents WHERE agent_type IS NOT NULL AND agent_type <> '') \
         ) \
         SELECT a.agent_type, f.tool_calls, MIN(s.ts), MAX(s.ts) \
         FROM seen s \
         JOIN agents a ON a.file_id = s.file_id \
         JOIN files f ON f.file_id = s.file_id \
         WHERE f.tool_calls > 0 AND f.missing = 0 \
         GROUP BY a.session_id, a.agent_id \
         HAVING MAX(s.ts) >= ?2 AND MAX(s.ts) <= ?3 AND COALESCE(MAX(s.gap), 0) <= ?4 \
                AND NOT EXISTS (SELECT 1 FROM messages o WHERE o.file_id = a.file_id AND o.ts_utc_ms < ?1)",
    )?;
    let loose = since - 86_400_000;
    let rows = st.query_map([loose, since, over_by, TYPICAL_RUN_GAP_MS], |r| {
        Ok(RunSample {
            agent_type: r.get::<_, String>(0)?,
            calls: r.get::<_, i64>(1)?,
            ms: (r.get::<_, i64>(3)? - r.get::<_, i64>(2)?).max(0),
        })
    })?;
    rows.collect()
}

/// Per kind of helper: the median tool calls and length of its finished runs (see
/// `finished_runs`) that ended in the last `days` days, with the run count. Runs with no tool call
/// are left out, so a median is never zero. The Now tracker compares a live helper with it.
pub fn typical_runs(conn: &Connection, ctx: &QueryCtx, days: u32) -> rusqlite::Result<Vec<TypicalRun>> {
    let since = ctx.now_ms - i64::from(days) * 86_400_000;
    let over_by = ctx.now_ms - TYPICAL_ENDED_AFTER_MS;
    Ok(medians(finished_runs(conn, since, over_by)?))
}

fn medians(runs: Vec<RunSample>) -> Vec<TypicalRun> {
    let mut by_type: BTreeMap<String, (Vec<i64>, Vec<i64>)> = BTreeMap::new();
    for r in runs {
        let e = by_type.entry(r.agent_type).or_default();
        e.0.push(r.calls);
        e.1.push(r.ms);
    }
    by_type
        .into_iter()
        .map(|(agent_type, (mut calls, mut ms))| TypicalRun {
            agent_type,
            runs: calls.len() as u32,
            calls: median(&mut calls).clamp(0, i64::from(u32::MAX)) as u32,
            ms: median(&mut ms),
        })
        .collect()
}

/// Chats with a message in `[from_day, to_day]`, per project key (the dashboard's rule).
fn sessions_by_project(conn: &Connection, tz: Tz, from_day: &str, to_day: &str) -> rusqlite::Result<HashMap<String, u64>> {
    let lo = day_start_ms(tz, from_day);
    let hi = day_start_ms(tz, &add_days(to_day, 1));
    let mut st = conn.prepare_cached(
        "SELECT COALESCE(s.project_key,''), COUNT(*) FROM sessions s \
         WHERE s.messages > 0 AND s.last_ts >= ?1 AND s.first_ts < ?2 \
         AND EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.session_id AND m.ts_utc_ms >= ?1 AND m.ts_utc_ms < ?2) \
         GROUP BY 1",
    )?;
    let mut counts = HashMap::new();
    for r in st.query_map([lo, hi], |r| Ok((r.get::<_, String>(0)?, u(r.get::<_, i64>(1)?))))? {
        let (k, n) = r?;
        counts.insert(k, n);
    }
    Ok(counts)
}

pub fn scope_report(conn: &Connection, ctx: &QueryCtx, a: &ScopeArgs) -> rusqlite::Result<ScopeReport> {
    let bucket = match a.bucket.as_str() {
        "week" | "month" => a.bucket.as_str(),
        _ => "day",
    };
    let (from, to) = (a.from.as_str(), a.to.as_str());
    let project = a.project_key.as_deref();
    let rows: Vec<GroupRow> = fetch_hours(conn, "substr(hour_local,1,10)", "project_key", from, to)?
        .into_iter()
        .filter(|r| project.is_none_or(|k| r.s == k))
        .collect();

    let by_project_sessions = sessions_by_project(conn, ctx.tz, from, to)?;
    let sessions = match project {
        Some(k) => by_project_sessions.get(k).copied().unwrap_or(0),
        None => sessions_active(conn, ctx.tz, from, to)?,
    };
    let total = period(&rows, from, to, sessions);

    let mut models: BTreeMap<&str, Acc> = BTreeMap::new();
    let mut projs: BTreeMap<&str, Acc> = BTreeMap::new();
    let starts = bucket_starts(from, to, bucket, ctx.week_starts_sunday);
    let mut per_bucket: BTreeMap<String, Acc> = starts.iter().map(|s| (s.clone(), Acc::default())).collect();
    for r in &rows {
        models.entry(r.model.as_str()).or_default().add(&r.g);
        projs.entry(r.s.as_str()).or_default().add(&r.g);
        if let Some(acc) = per_bucket.get_mut(&bucket_of(&r.k, bucket, ctx.week_starts_sunday)) {
            acc.add(&r.g);
        }
    }
    let mut by_model: Vec<ModelUse> = models
        .into_iter()
        .map(|(m, a)| ModelUse { model: m.to_string(), known: ctx.prices.is_known(m), tokens: a.t, cost: a.cost(), efforts: Vec::new() })
        .collect();
    by_model.sort_by(|a, b| b.tokens.total.cmp(&a.tokens.total).then_with(|| a.model.cmp(&b.model)));
    {
        // Effort per model over the same hours (and project) the token rows cover.
        let (lo, hi) = (format!("{from}T00"), format!("{}T00", add_days(to, 1)));
        let mut efforts = effort_mix(
            conn,
            "SELECT m.model, m.effort, COUNT(*) FROM messages m LEFT JOIN sessions s ON s.session_id = m.session_id \
             WHERE m.hour_local >= ?1 AND m.hour_local < ?2 AND (?3 IS NULL OR COALESCE(s.project_key,'') = ?3) \
             AND m.effort IS NOT NULL GROUP BY 1, 2",
            rusqlite::params![lo, hi, project],
        )?;
        for m in &mut by_model {
            m.efforts = efforts.remove(&m.model).unwrap_or_default();
        }
    }

    // Chats started per bucket (the timeline's rule), in this project only when one is asked.
    let lo = day_start_ms(ctx.tz, from);
    let hi = day_start_ms(ctx.tz, &add_days(to, 1));
    let mut started: HashMap<String, u64> = HashMap::new();
    {
        let sql = "SELECT substr(hour_of(first_ts),1,10), COALESCE(project_key,''), COUNT(*) FROM sessions \
                   WHERE messages > 0 AND first_ts >= ?1 AND first_ts < ?2 GROUP BY 1, 2";
        let mut st = conn.prepare_cached(sql)?;
        let it = st.query_map([lo, hi], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, u(r.get::<_, i64>(2)?))))?;
        for r in it {
            let (day, key, n) = r?;
            if project.is_none_or(|k| key == k) {
                *started.entry(bucket_of(&day, bucket, ctx.week_starts_sunday)).or_default() += n;
            }
        }
    }
    let points = starts
        .iter()
        .map(|s| {
            let a = per_bucket.get(s).copied().unwrap_or_default();
            TimelinePoint { start: s.clone(), tokens: a.t, cost: a.cost(), sessions: started.get(s).copied().unwrap_or(0) }
        })
        .collect();

    let names = project_index(conn)?;
    let mut list: Vec<(&str, Acc)> = projs.into_iter().collect();
    list.sort_by(|a, b| b.1.t.total.cmp(&a.1.t.total).then_with(|| a.0.cmp(b.0)));
    let projects = list
        .into_iter()
        .map(|(k, a)| {
            let (name, path) = names.get(k).cloned().unwrap_or_default();
            ProjectUse {
                project_key: k.to_string(),
                name: if name.is_empty() { "Unknown project".to_string() } else { name },
                path,
                tokens: a.t,
                cost: a.cost(),
                sessions: by_project_sessions.get(k).copied().unwrap_or(0),
            }
        })
        .collect();

    let chats = chats_in_range(conn, ctx, from, to, project, a.top)?;
    Ok(ScopeReport { from: a.from.clone(), to: a.to.clone(), bucket: bucket.to_string(), total, by_model, points, projects, chats })
}

/// The `limit` biggest chats by tokens used inside `[from_day, to_day]`. A chat that only
/// partly falls in the range counts only that part: the same messages, hours and prices
/// that `usage_hour` sums, so these rows never exceed the range total.
fn chats_in_range(
    conn: &Connection,
    ctx: &QueryCtx,
    from_day: &str,
    to_day: &str,
    project: Option<&str>,
    limit: usize,
) -> rusqlite::Result<Vec<SessionRow>> {
    if limit == 0 {
        return Ok(Vec::new());
    }
    let sql = format!(
        "SELECT m.session_id, m.model, {SUMS} FROM messages m LEFT JOIN sessions s ON s.session_id = m.session_id \
         WHERE m.hour_local >= ?1 AND m.hour_local < ?2 AND (?3 IS NULL OR COALESCE(s.project_key,'') = ?3) \
         GROUP BY m.session_id, m.model, m.speed, m.geo, m.service_tier, m.price_tier"
    );
    let lo = format!("{from_day}T00");
    let hi = format!("{}T00", add_days(to_day, 1));
    let mut aggs: HashMap<String, SessionAgg> = HashMap::new();
    {
        let mut st = conn.prepare_cached(&sql)?;
        let rows = st.query_map(rusqlite::params![lo, hi, project], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, group_from(r, 2)?))
        })?;
        for r in rows {
            let (sid, model, g) = r?;
            let e = aggs.entry(sid).or_default();
            e.acc.add(&g);
            *e.models.entry(model).or_default() += g.t.total;
        }
    }
    let mut order: Vec<(&String, u64)> = aggs.iter().filter(|(_, a)| a.acc.t.total > 0).map(|(k, a)| (k, a.acc.t.total)).collect();
    order.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(b.0)));
    let ids: Vec<String> = order.into_iter().take(limit).map(|(k, _)| k.clone()).collect();
    let mut rows = session_rows_for(conn, ctx, &ids)?;
    for row in &mut rows {
        if let Some(agg) = aggs.remove(&row.session_id) {
            let mut models: Vec<(String, u64)> = agg.models.into_iter().collect();
            models.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
            row.models = models.into_iter().map(|m| m.0).collect();
            row.tokens = agg.acc.t;
            row.cost = agg.acc.cost();
        }
    }
    Ok(rows)
}

// ---------------------------------------------------------------- sessions

#[derive(Default)]
struct SessionAgg {
    acc: Acc,
    models: BTreeMap<String, u64>,
}

fn placeholders(n: usize, from: usize) -> String {
    (0..n).map(|i| format!("?{}", from + i)).collect::<Vec<_>>().join(",")
}

fn row_ids_clause(ids: &[String]) -> (String, Vec<Value>) {
    (placeholders(ids.len(), 1), ids.iter().map(|s| Value::Text(s.clone())).collect())
}

/// Build `SessionRow`s for exactly these ids, in this order.
pub(crate) fn session_rows_for(conn: &Connection, ctx: &QueryCtx, ids: &[String]) -> rusqlite::Result<Vec<SessionRow>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let (ph, vals) = row_ids_clause(ids);
    let mut aggs: HashMap<String, SessionAgg> = HashMap::new();
    {
        let sql = format!(
            "SELECT session_id, model, SUM(input), SUM(output), SUM(cw5m), SUM(cw1h), SUM(cr), SUM(web_search), SUM(web_fetch), \
             cost_usd(model, speed, geo, service_tier, price_tier, SUM(input), SUM(output), SUM(cw5m), SUM(cw1h), SUM(cr), SUM(web_search)) \
             FROM session_model WHERE session_id IN ({ph}) GROUP BY session_id, model, speed, geo, service_tier, price_tier"
        );
        let mut st = conn.prepare(&sql)?;
        let rows = st.query_map(params_from_iter(vals.iter()), |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, group_from(r, 2)?))
        })?;
        for r in rows {
            let (sid, model, g) = r?;
            let e = aggs.entry(sid).or_default();
            e.acc.add(&g);
            *e.models.entry(model).or_default() += g.t.total;
        }
    }
    // The chat itself (no helper): its model by tokens, and its effort mix.
    let mut main_model: HashMap<String, (String, u64)> = HashMap::new();
    let mut efforts: HashMap<String, Vec<EffortUse>> = HashMap::new();
    {
        let sql = format!(
            "SELECT session_id, model, effort, COUNT(*), SUM(input+output+cw5m+cw1h) FROM messages \
             WHERE session_id IN ({ph}) AND agent_id IS NULL GROUP BY 1, 2, 3"
        );
        let mut st = conn.prepare(&sql)?;
        let mut by_model: HashMap<(String, String), u64> = HashMap::new();
        let mut by_effort: HashMap<(String, String), u64> = HashMap::new();
        for r in st.query_map(params_from_iter(vals.iter()), |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?, u(r.get(3)?), u(r.get(4)?)))
        })? {
            let (sid, model, effort, n, tok) = r?;
            *by_model.entry((sid.clone(), model)).or_default() += tok;
            if let Some(e) = effort.filter(|e| !e.is_empty()) {
                *by_effort.entry((sid, e)).or_default() += n;
            }
        }
        for ((sid, model), tok) in by_model {
            let e = main_model.entry(sid).or_insert_with(|| (String::new(), 0));
            if e.0.is_empty() || tok > e.1 || (tok == e.1 && model < e.0) {
                *e = (model, tok);
            }
        }
        for ((sid, effort), n) in by_effort {
            efforts.entry(sid).or_default().push(EffortUse { effort, replies: n });
        }
        for v in efforts.values_mut() {
            v.sort_by(|a, b| b.replies.cmp(&a.replies).then_with(|| effort_rank(&a.effort).cmp(&effort_rank(&b.effort))));
        }
    }
    let mut agent_counts: HashMap<String, u64> = HashMap::new();
    {
        let sql = format!("SELECT session_id, COUNT(*) FROM agents WHERE session_id IN ({ph}) GROUP BY session_id");
        let mut st = conn.prepare(&sql)?;
        for r in st.query_map(params_from_iter(vals.iter()), |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))? {
            let (sid, n) = r?;
            agent_counts.insert(sid, u(n));
        }
    }
    let sql = format!(
        "SELECT session_id, title, COALESCE(project_path,''), COALESCE(first_ts,0), COALESCE(last_ts,0), \
         messages, subagent_messages, missing, prompt_summary, title_source FROM sessions WHERE session_id IN ({ph})"
    );
    let mut st = conn.prepare(&sql)?;
    let mut by_id: HashMap<String, SessionRow> = HashMap::new();
    let rows = st.query_map(params_from_iter(vals.iter()), |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, Option<String>>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, i64>(3)?,
            r.get::<_, i64>(4)?,
            r.get::<_, i64>(5)?,
            r.get::<_, i64>(6)?,
            r.get::<_, i64>(7)?,
            r.get::<_, Option<String>>(8)?,
            r.get::<_, Option<String>>(9)?,
        ))
    })?;
    for r in rows {
        let (sid, title, path, first, last, msgs, sub, missing, prompt, title_source) = r?;
        let title = title.filter(|t| !t.trim().is_empty());
        let prompt = prompt.filter(|t| !t.trim().is_empty());
        let (name, name_source) = match (&title, &prompt) {
            (Some(t), _) => (Some(t.clone()), if title_source.as_deref() == Some("custom") { "title" } else { "agent" }),
            (None, Some(p)) => (Some(p.clone()), "prompt"),
            (None, None) => (None, "none"),
        };
        let agent_count = agent_counts.get(&sid).copied().unwrap_or(0);
        let agg = aggs.remove(&sid).unwrap_or_default();
        let mut models: Vec<(String, u64)> = agg.models.into_iter().collect();
        models.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        let _ = ctx;
        let row_main_model = main_model.remove(&sid).map(|m| m.0).unwrap_or_default();
        let row_efforts = efforts.remove(&sid).unwrap_or_default();
        by_id.insert(
            sid.clone(),
            SessionRow {
                session_id: sid,
                title,
                name,
                name_source: name_source.to_string(),
                agent_count,
                project_name: base_name(&path),
                project_path: path,
                started_at: first,
                ended_at: last,
                duration_ms: (last - first).max(0),
                models: models.into_iter().map(|m| m.0).collect(),
                main_model: row_main_model,
                efforts: row_efforts,
                messages: u(msgs),
                subagent_messages: u(sub),
                tokens: agg.acc.t,
                cost: agg.acc.cost(),
                missing: missing != 0,
            },
        );
    }
    Ok(ids.iter().filter_map(|i| by_id.remove(i)).collect())
}

/// How many `also_ids` one query takes (SQLite binds each id; the UI sends at most ~200).
const ALSO_IDS_MAX: usize = 400;

fn like_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

pub fn sessions_list(conn: &Connection, ctx: &QueryCtx, q: &SessionQuery) -> rusqlite::Result<SessionPage> {
    let limit = if q.limit == 0 { 50 } else { q.limit.min(200) };
    let desc = !q.dir.eq_ignore_ascii_case("asc");
    let sort = match q.sort.as_str() {
        "cost" | "tokens" | "duration" => q.sort.as_str(),
        _ => "start",
    };
    let needs_totals = sort == "cost" || sort == "tokens" || q.min_cost_usd.is_some();

    let mut wh = vec!["s.messages > 0".to_string()];
    let mut vals: Vec<Value> = Vec::new();
    if !q.include_missing {
        wh.push("s.missing = 0".into());
    }
    if let Some(f) = q.from.as_deref().filter(|f| !f.is_empty()) {
        wh.push(format!("s.last_ts >= ?{}", vals.len() + 1));
        vals.push(Value::Integer(day_start_ms(ctx.tz, f)));
    }
    if let Some(t) = q.to.as_deref().filter(|t| !t.is_empty()) {
        wh.push(format!("s.first_ts < ?{}", vals.len() + 1));
        vals.push(Value::Integer(day_start_ms(ctx.tz, &add_days(t, 1))));
    }
    if !q.projects.is_empty() {
        wh.push(format!("s.project_key IN ({})", placeholders(q.projects.len(), vals.len() + 1)));
        vals.extend(q.projects.iter().map(|p| Value::Text(p.clone())));
    }
    if !q.models.is_empty() {
        wh.push(format!(
            "EXISTS (SELECT 1 FROM session_model m WHERE m.session_id = s.session_id AND m.model IN ({}))",
            placeholders(q.models.len(), vals.len() + 1)
        ));
        vals.extend(q.models.iter().map(|p| Value::Text(p.clone())));
    }
    // The title / project text match, OR a session a message search found. One clause, so the
    // filters above and the count below treat both kinds of match alike.
    let mut found_by: Vec<String> = Vec::new();
    if let Some(t) = q.text.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        let n = vals.len() + 1;
        found_by.push(format!(
            "(lower(COALESCE(s.title,'')) LIKE ?{n} ESCAPE '\\' OR lower(COALESCE(s.prompt_summary,'')) LIKE ?{n} ESCAPE '\\' OR lower(COALESCE(s.project_path,'')) LIKE ?{n} ESCAPE '\\')"
        ));
        vals.push(Value::Text(format!("%{}%", like_escape(&t.to_lowercase()))));
    }
    if !q.also_ids.is_empty() {
        let ids = &q.also_ids[..q.also_ids.len().min(ALSO_IDS_MAX)];
        found_by.push(format!("s.session_id IN ({})", placeholders(ids.len(), vals.len() + 1)));
        vals.extend(ids.iter().map(|i| Value::Text(i.clone())));
    }
    if !found_by.is_empty() {
        wh.push(format!("({})", found_by.join(" OR ")));
    }
    if let Some(c) = q.min_cost_usd {
        wh.push(format!("COALESCE(t.cost,0) >= ?{}", vals.len() + 1));
        vals.push(Value::Real(c));
    }

    let totals_cte = "WITH t AS (SELECT session_id, SUM(input+output+cw5m+cw1h) AS tok, SUM(cost) AS cost FROM \
         (SELECT session_id, input, output, cw5m, cw1h, \
           cost_usd(model, speed, geo, service_tier, price_tier, input, output, cw5m, cw1h, cr, web_search) AS cost \
          FROM session_model) GROUP BY session_id) ";
    let (cte, join) = if needs_totals { (totals_cte, " JOIN t ON t.session_id = s.session_id") } else { ("", "") };
    let key_expr = match sort {
        "cost" => "COALESCE(t.cost,0)",
        "tokens" => "COALESCE(t.tok,0)",
        "duration" => "(s.last_ts - s.first_ts)",
        _ => "s.first_ts",
    };
    let where_sql = wh.join(" AND ");

    let total: i64 = {
        let sql = format!("{cte}SELECT COUNT(*) FROM sessions s{join} WHERE {where_sql}");
        conn.query_row(&sql, params_from_iter(vals.iter()), |r| r.get(0))?
    };

    let mut page_vals = vals.clone();
    let mut page_where = where_sql.clone();
    if let Some(cur) = q.cursor.as_deref()
        && let Some((k, id)) = cur.split_once('|') {
            let kv = if let Some(f) = k.strip_prefix("f:") {
                f.parse::<f64>().ok().map(Value::Real)
            } else {
                k.strip_prefix("i:").and_then(|i| i.parse::<i64>().ok()).map(Value::Integer)
            };
            if let Some(kv) = kv {
                let n = page_vals.len();
                let op = if desc { "<" } else { ">" };
                page_where = format!("{page_where} AND ({key_expr}, s.session_id) {op} (?{}, ?{})", n + 1, n + 2);
                page_vals.push(kv);
                page_vals.push(Value::Text(id.to_string()));
            }
        }
    let order = if desc { "DESC" } else { "ASC" };
    let sql = format!(
        "{cte}SELECT s.session_id, {key_expr} FROM sessions s{join} WHERE {page_where} \
         ORDER BY {key_expr} {order}, s.session_id {order} LIMIT {}",
        limit + 1
    );
    let mut st = conn.prepare(&sql)?;
    let found: Vec<(String, Value)> = st
        .query_map(params_from_iter(page_vals.iter()), |r| Ok((r.get::<_, String>(0)?, r.get::<_, Value>(1)?)))?
        .collect::<Result<_, _>>()?;
    let more = found.len() > limit;
    let page: Vec<&(String, Value)> = found.iter().take(limit).collect();
    let next_cursor = if more {
        page.last().map(|(id, k)| {
            let ks = match k {
                Value::Integer(i) => format!("i:{i}"),
                Value::Real(f) => format!("f:{f:?}"),
                _ => "i:0".to_string(),
            };
            format!("{ks}|{id}")
        })
    } else {
        None
    };
    let ids: Vec<String> = page.iter().map(|(id, _)| id.clone()).collect();
    let rows = session_rows_for(conn, ctx, &ids)?;
    Ok(SessionPage { rows, next_cursor, total: u(total) })
}

// ---------------------------------------------------------------- detail

/// Every subagent of a session with its spend, in start order. Agents with a registry row but
/// no priced messages are listed with zeros; messages from an agent with no row (a transcript
/// without a sidecar read through some other path) get a synthesized one.
pub(crate) fn agent_summaries(conn: &Connection, id: &str) -> rusqlite::Result<Vec<AgentSummary>> {
    struct Reg {
        agent_type: Option<String>,
        description: Option<String>,
        tool_use_id: Option<String>,
        parent: Option<String>,
        depth: i64,
        prompt: Option<String>,
        tool_calls: u64,
        missing: bool,
    }
    let mut reg: BTreeMap<String, Reg> = BTreeMap::new();
    {
        let mut st = conn.prepare_cached(
            "SELECT a.agent_id, a.agent_type, a.description, a.tool_use_id, a.parent_agent_id, a.spawn_depth, \
                    a.prompt_summary, COALESCE(f.tool_calls,0), COALESCE(f.missing,0) \
             FROM agents a LEFT JOIN files f ON f.file_id = a.file_id WHERE a.session_id=?1",
        )?;
        for r in st.query_map([id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                Reg {
                    agent_type: r.get(1)?,
                    description: r.get(2)?,
                    tool_use_id: r.get(3)?,
                    parent: r.get(4)?,
                    depth: r.get(5)?,
                    prompt: r.get(6)?,
                    tool_calls: u(r.get::<_, i64>(7)?),
                    missing: r.get::<_, i64>(8)? != 0,
                },
            ))
        })? {
            let (a, g) = r?;
            reg.insert(a, g);
        }
    }
    #[derive(Default)]
    struct Spend {
        acc: Acc,
        messages: u64,
        first: i64,
        last: i64,
        models: BTreeMap<String, u64>,
    }
    let mut spend: BTreeMap<String, Spend> = BTreeMap::new();
    {
        let mut st = conn.prepare_cached(&format!(
            "SELECT agent_id, model, COUNT(*), MIN(ts_utc_ms), MAX(ts_utc_ms), {SUMS} FROM messages \
             WHERE session_id=?1 AND agent_id IS NOT NULL \
             GROUP BY agent_id, model, speed, geo, service_tier, price_tier"
        ))?;
        for r in st.query_map([id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                u(r.get::<_, i64>(2)?),
                r.get::<_, i64>(3)?,
                r.get::<_, i64>(4)?,
                group_from(r, 5)?,
            ))
        })? {
            let (a, model, n, lo, hi, g) = r?;
            let e = spend.entry(a).or_default();
            e.acc.add(&g);
            e.messages += n;
            e.first = if e.first == 0 { lo } else { e.first.min(lo) };
            e.last = e.last.max(hi);
            *e.models.entry(model).or_default() += g.t.total;
        }
    }
    let mut agent_efforts = effort_mix(
        conn,
        "SELECT agent_id, effort, COUNT(*) FROM messages WHERE session_id=?1 AND agent_id IS NOT NULL \
         AND effort IS NOT NULL GROUP BY 1, 2",
        [id],
    )?;
    let mut ids: Vec<String> = reg.keys().cloned().collect();
    for k in spend.keys() {
        if !reg.contains_key(k) {
            ids.push(k.clone());
        }
    }
    let mut out: Vec<AgentSummary> = ids
        .into_iter()
        .map(|aid| {
            let g = reg.remove(&aid);
            let s = spend.remove(&aid).unwrap_or_default();
            let (name, src) = super::naming::agent_name(
                g.as_ref().and_then(|g| g.description.as_deref()),
                g.as_ref().and_then(|g| g.agent_type.as_deref()),
                g.as_ref().and_then(|g| g.prompt.as_deref()),
            );
            let mut models: Vec<(String, u64)> = s.models.into_iter().collect();
            models.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
            let efforts = agent_efforts.remove(&aid).unwrap_or_default();
            AgentSummary {
                efforts,
                agent_id: aid,
                name,
                name_source: src.as_str().to_string(),
                agent_type: g.as_ref().and_then(|g| g.agent_type.clone()),
                description: g.as_ref().and_then(|g| g.description.clone()),
                tool_use_id: g.as_ref().and_then(|g| g.tool_use_id.clone()),
                parent_agent_id: g.as_ref().and_then(|g| g.parent.clone()),
                spawn_depth: g.as_ref().map_or(1, |g| g.depth),
                model: models.first().map(|m| m.0.clone()).unwrap_or_default(),
                models: models.into_iter().map(|m| m.0).collect(),
                messages: s.messages,
                tokens: s.acc.t,
                cost: s.acc.cost(),
                started_at: s.first,
                ended_at: s.last,
                duration_ms: (s.last - s.first).max(0),
                tool_calls: g.as_ref().map_or(0, |g| g.tool_calls),
                missing: g.as_ref().is_some_and(|g| g.missing),
            }
        })
        .collect();
    // Spawn order; agents that never made a call go last.
    out.sort_by(|a, b| {
        let ka = if a.started_at == 0 { i64::MAX } else { a.started_at };
        let kb = if b.started_at == 0 { i64::MAX } else { b.started_at };
        ka.cmp(&kb).then_with(|| a.agent_id.cmp(&b.agent_id))
    });
    Ok(out)
}

/// The main conversation alone: messages with no agent id, and the main files' tool calls.
fn main_thread(conn: &Connection, id: &str) -> rusqlite::Result<MainThread> {
    let mut acc = Acc::default();
    let mut messages = 0u64;
    {
        let mut st = conn.prepare_cached(&format!(
            "SELECT COUNT(*), {SUMS} FROM messages WHERE session_id=?1 AND agent_id IS NULL \
             GROUP BY model, speed, geo, service_tier, price_tier"
        ))?;
        for r in st.query_map([id], |r| Ok((u(r.get::<_, i64>(0)?), group_from(r, 1)?)))? {
            let (n, g) = r?;
            messages += n;
            acc.add(&g);
        }
    }
    let tool_calls: i64 = conn.query_row(
        "SELECT COALESCE(SUM(tool_calls),0) FROM files WHERE session_id=?1 AND is_subagent=0",
        [id],
        |r| r.get(0),
    )?;
    Ok(MainThread { messages, tokens: acc.t, cost: acc.cost(), tool_calls: u(tool_calls) })
}

/// One subagent, for its own page. `prompt` is filled in by the caller from the transcript.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ItemKind {
    Skill,
    Agent,
    Tool,
}

impl ItemKind {
    fn as_str(self) -> &'static str {
        match self {
            ItemKind::Skill => "skill",
            ItemKind::Agent => "agent",
            ItemKind::Tool => "tool",
        }
    }
}

/// Which items to count, in which local days (inclusive, `YYYY-MM-DD`), optionally in one session.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemQuery {
    pub kind: ItemKind,
    #[serde(default)]
    pub from: Option<String>,
    #[serde(default)]
    pub to: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
}

/// One skill, helper type or tool. `uses` and `sessions` count only the period asked for;
/// `lastUsed` (epoch ms) is the last time ever (or in the one session asked for), so an item
/// that was not used in the period still says when it last ran. Never-used items are not here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemUse {
    pub id: String,
    pub kind: ItemKind,
    pub uses: u64,
    pub sessions: u64,
    pub last_used: Option<i64>,
}

pub fn usage_by_item(conn: &Connection, q: &ItemQuery) -> rusqlite::Result<Vec<ItemUse>> {
    let lo = q.from.as_deref().map_or_else(|| "0000".to_string(), |d| format!("{d}T00"));
    let hi = q.to.as_deref().map_or_else(|| "9999".to_string(), |d| format!("{d}T24"));
    let mut st = conn.prepare_cached(
        "SELECT item,
                SUM(CASE WHEN hour_local >= ?2 AND hour_local < ?3 THEN uses ELSE 0 END) AS u,
                COUNT(DISTINCT CASE WHEN hour_local >= ?2 AND hour_local < ?3 THEN session_id END),
                MAX(last_ts) AS last
         FROM item_use
         WHERE kind=?1 AND (?4 IS NULL OR session_id=?4)
         GROUP BY item
         ORDER BY u DESC, last DESC, item
         LIMIT ?5",
    )?;
    let limit = i64::from(q.limit.unwrap_or(500).min(5000));
    let kind = q.kind;
    let rows = st.query_map(params_from_iter([
        Value::Text(kind.as_str().to_string()),
        Value::Text(lo),
        Value::Text(hi),
        q.session_id.clone().map_or(Value::Null, Value::Text),
        Value::Integer(limit),
    ]), |r| {
        Ok(ItemUse {
            id: r.get(0)?,
            kind,
            uses: u(r.get::<_, i64>(1)?),
            sessions: u(r.get::<_, i64>(2)?),
            last_used: r.get(3)?,
        })
    })?;
    rows.collect()
}

pub fn agent_detail(conn: &Connection, ctx: &QueryCtx, session_id: &str, agent_id: &str) -> rusqlite::Result<Option<AgentDetail>> {
    let ids = [session_id.to_string()];
    let Some(row) = session_rows_for(conn, ctx, &ids)?.pop() else { return Ok(None) };
    let all = agent_summaries(conn, session_id)?;
    let Some(agent) = all.iter().find(|a| a.agent_id == agent_id).cloned() else { return Ok(None) };
    let parent_name = agent
        .parent_agent_id
        .as_ref()
        .and_then(|p| all.iter().find(|a| &a.agent_id == p))
        .map(|p| p.name.clone());

    let mut by_model: BTreeMap<String, Acc> = BTreeMap::new();
    {
        let mut st = conn.prepare_cached(&format!(
            "SELECT model, {SUMS} FROM messages WHERE session_id=?1 AND agent_id=?2 \
             GROUP BY model, speed, geo, service_tier, price_tier"
        ))?;
        for r in st.query_map([session_id, agent_id], |r| Ok((r.get::<_, String>(0)?, group_from(r, 1)?)))? {
            let (m, g) = r?;
            by_model.entry(m).or_default().add(&g);
        }
    }
    let mut efforts = effort_mix(
        conn,
        "SELECT model, effort, COUNT(*) FROM messages WHERE session_id=?1 AND agent_id=?2 \
         AND effort IS NOT NULL GROUP BY 1, 2",
        [session_id, agent_id],
    )?;
    let mut by_model: Vec<ByModel> = by_model
        .into_iter()
        .map(|(model, a)| ByModel {
            efforts: efforts.remove(&model).unwrap_or_default(),
            known: ctx.prices.is_known(&model),
            model,
            tokens: a.t,
            cost: a.cost(),
        })
        .collect();
    by_model.sort_by(|a, b| b.tokens.total.cmp(&a.tokens.total).then_with(|| a.model.cmp(&b.model)));

    let mut timeline = Vec::new();
    {
        let mut st = conn.prepare_cached(
            "SELECT ts_utc_ms, model, agent_id, input, output, cw5m, cw1h, cr, web_search, web_fetch, \
             cost_usd(model, speed, geo, service_tier, price_tier, input, output, cw5m, cw1h, cr, web_search), skill \
             FROM messages WHERE session_id=?1 AND agent_id=?2 ORDER BY ts_utc_ms, line_offset LIMIT 5000",
        )?;
        for r in st.query_map([session_id, agent_id], message_point)? {
            timeline.push(r?);
        }
    }
    let file = conn
        .query_row(
            "SELECT f.path, f.is_subagent, f.missing FROM agents a JOIN files f ON f.file_id = a.file_id \
             WHERE a.session_id=?1 AND a.agent_id=?2",
            [session_id, agent_id],
            |r| Ok(FileRef { path: r.get(0)?, is_subagent: r.get::<_, i64>(1)? != 0, missing: r.get::<_, i64>(2)? != 0 }),
        )
        .optional()?;
    Ok(Some(AgentDetail {
        session_id: session_id.to_string(),
        session_name: row.name.clone(),
        project_name: row.project_name.clone(),
        agent,
        parent_name,
        by_model,
        timeline,
        file,
        prompt: None,
        prompt_truncated: false,
        session_tokens: row.tokens,
        session_cost: row.cost,
    }))
}

fn message_point(r: &rusqlite::Row) -> rusqlite::Result<MessagePoint> {
    let g = Group {
        t: {
            let (i, o, w5, w1, cr) = (u(r.get(3)?), u(r.get(4)?), u(r.get(5)?), u(r.get(6)?), u(r.get(7)?));
            Tokens {
                input: i,
                output: o,
                cache_write5m: w5,
                cache_write1h: w1,
                cache_read: cr,
                total: i + o + w5 + w1,
                web_search: u(r.get(8)?),
                web_fetch: u(r.get(9)?),
            }
        },
        cost: r.get::<_, Option<f64>>(10)?,
    };
    let mut a = Acc::default();
    a.add(&g);
    Ok(MessagePoint {
        ts: r.get(0)?,
        model: r.get(1)?,
        agent_id: r.get(2)?,
        tokens: g.t,
        cost: a.cost(),
        skill: r.get(11)?,
    })
}

pub fn session_detail(conn: &Connection, ctx: &QueryCtx, id: &str) -> rusqlite::Result<Option<SessionDetail>> {
    let ids = [id.to_string()];
    let Some(row) = session_rows_for(conn, ctx, &ids)?.pop() else { return Ok(None) };

    let mut by_model: BTreeMap<String, Acc> = BTreeMap::new();
    {
        let mut st = conn.prepare_cached(&format!(
            "SELECT model, {SUMS} FROM session_model WHERE session_id=?1 GROUP BY model, speed, geo, service_tier, price_tier"
        ))?;
        for r in st.query_map([id], |r| Ok((r.get::<_, String>(0)?, group_from(r, 1)?)))? {
            let (m, g) = r?;
            by_model.entry(m).or_default().add(&g);
        }
    }
    let mut efforts = effort_mix(
        conn,
        "SELECT model, effort, COUNT(*) FROM messages WHERE session_id=?1 AND effort IS NOT NULL GROUP BY 1, 2",
        [id],
    )?;
    let mut by_model: Vec<ByModel> = by_model
        .into_iter()
        .map(|(model, a)| ByModel {
            efforts: efforts.remove(&model).unwrap_or_default(),
            known: ctx.prices.is_known(&model),
            model,
            tokens: a.t,
            cost: a.cost(),
        })
        .collect();
    by_model.sort_by(|a, b| b.tokens.total.cmp(&a.tokens.total).then_with(|| a.model.cmp(&b.model)));

    let mut agents: BTreeMap<Option<String>, (u64, Acc)> = BTreeMap::new();
    {
        let mut st = conn.prepare_cached(&format!(
            "SELECT agent_id, COUNT(*), {SUMS} FROM messages WHERE session_id=?1 \
             GROUP BY agent_id, model, speed, geo, service_tier, price_tier"
        ))?;
        for r in st.query_map([id], |r| {
            Ok((r.get::<_, Option<String>>(0)?, u(r.get::<_, i64>(1)?), group_from(r, 2)?))
        })? {
            let (a, n, g) = r?;
            let e = agents.entry(a).or_default();
            e.0 += n;
            e.1.add(&g);
        }
    }
    let by_agent: Vec<ByAgent> = agents
        .into_iter()
        .map(|(agent_id, (messages, a))| ByAgent { agent_id, messages, tokens: a.t, cost: a.cost() })
        .collect();

    let mut timeline = Vec::new();
    {
        let mut st = conn.prepare_cached(
            "SELECT ts_utc_ms, model, agent_id, input, output, cw5m, cw1h, cr, web_search, web_fetch, \
             cost_usd(model, speed, geo, service_tier, price_tier, input, output, cw5m, cw1h, cr, web_search), skill \
             FROM messages WHERE session_id=?1 ORDER BY ts_utc_ms, line_offset LIMIT 20000",
        )?;
        let rows = st.query_map([id], message_point)?;
        for r in rows {
            timeline.push(r?);
        }
    }

    let mut files = Vec::new();
    {
        let mut st = conn.prepare_cached(
            "SELECT DISTINCT f.path, f.is_subagent, f.missing FROM messages m JOIN files f ON f.file_id = m.file_id \
             WHERE m.session_id=?1 ORDER BY f.is_subagent, f.path",
        )?;
        for r in st.query_map([id], |r| {
            Ok(FileRef { path: r.get(0)?, is_subagent: r.get::<_, i64>(1)? != 0, missing: r.get::<_, i64>(2)? != 0 })
        })? {
            files.push(r?);
        }
    }
    let cc: Option<f64> = conn.query_row("SELECT cc_cost_usd FROM sessions WHERE session_id=?1", [id], |r| r.get(0))?;
    let agents = agent_summaries(conn, id)?;
    let main = main_thread(conn, id)?;
    Ok(Some(SessionDetail { row, by_model, by_agent, agents, main, timeline, files, claude_code_cost_usd: cc }))
}

// ---------------------------------------------------------------- filters

pub fn filter_options(conn: &Connection, ctx: &QueryCtx) -> rusqlite::Result<FilterOptions> {
    let names = project_index(conn)?;
    let mut projects: Vec<ProjectRef> = names
        .into_iter()
        .map(|(k, (name, path))| ProjectRef {
            project_key: k,
            name: if name.is_empty() { "Unknown project".into() } else { name },
            path,
        })
        .collect();
    projects.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then_with(|| a.project_key.cmp(&b.project_key)));
    let mut st = conn.prepare_cached("SELECT DISTINCT model FROM session_model ORDER BY model")?;
    let models = st
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .map(|model| {
            let known = ctx.prices.is_known(&model);
            ModelRef { model, known }
        })
        .collect();
    Ok(FilterOptions { projects, models })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn week_and_month_buckets() {
        // 2026-11-08 is a Sunday.
        assert_eq!(bucket_of("2026-11-08", "week", false), "2026-11-02");
        assert_eq!(bucket_of("2026-11-08", "week", true), "2026-11-08");
        assert_eq!(bucket_of("2026-11-08", "month", false), "2026-11-01");
        assert_eq!(bucket_starts("2026-11-01", "2026-11-03", "day", false).len(), 3);
        assert_eq!(bucket_starts("2026-11-01", "2026-11-01", "hour", false).len(), 24);
    }

    #[test]
    fn local_midnight_follows_the_zone() {
        // UTC-7: local midnight is 07:00 UTC.
        let tz = Tz::Fixed(-7 * 3600);
        let ms = day_start_ms(tz, "2026-11-02");
        assert_eq!(tz.hour_bucket(ms), "2026-11-02T00");
        assert_eq!(tz.hour_bucket(ms - 1), "2026-11-01T23");
    }

    #[test]
    fn base_name_handles_both_separators() {
        assert_eq!(base_name("C:\\Users\\Will\\Proj"), "Proj");
        assert_eq!(base_name("/fixture/app/"), "app");
        assert_eq!(base_name(""), "");
    }
}
