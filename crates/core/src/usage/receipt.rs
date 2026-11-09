//! "Where the money went": a receipt for one chat, and the helper tree's numbers.
//!
//! Every figure comes from the ledger (exact tokens, priced at query time) except the parts that
//! need the transcript's tool results, which are estimates and are labelled that way in the app.
//! The receipt sums to the chat's existing cost figure: each view lists its lines and an
//! "everything else" remainder, so `lines + remainder == total` always holds.
//!
//! Nothing here carries message text: only tool names, file paths, helper names and numbers.

use std::collections::{BTreeMap, HashMap};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use super::pricing::{Basis, Counts, PriceTable};
use super::query::{agent_summaries, session_rows_for, u, QueryCtx};
use super::receipt_scan::{ResultScan, Scan, ThreadScan};

// ---------------------------------------------------------------- thresholds (all estimates)

/// A file read this many times in one place is worth a look...
const REPEAT_READS: u32 = 6;
/// ...when the reads put at least this much into the conversation.
const REPEAT_MIN_TOKENS: u64 = 30_000;
/// One tool result this big is "a huge output".
const HUGE_TOKENS: u64 = 40_000;
/// A non-file result at least this big gets its own line; smaller ones are summed per tool.
const SINGLE_MIN_TOKENS: u64 = 5_000;
/// A helper on a model whose output price is at least this many dollars per million...
const HEAVY_OUT_PER_M: f64 = 15.0;
/// ...that spent at least this much, only read things, and wrote this little, is flagged.
const HEAVY_MIN_USD: f64 = 0.50;
const HEAVY_MAX_OUTPUT: u64 = 10_000;
/// Cache expiry: five minutes, an hour when the earlier write was the long kind.
const TTL_SHORT_MS: i64 = 300_000;
const TTL_LONG_MS: i64 = 3_600_000;
/// A request after a pause that wrote this many tokens back into the cache counts as a miss...
const MISS_MIN_TOKENS: u64 = 10_000;
/// ...if the extra money it cost (writes instead of reads) was at least this much...
const MISS_MIN_EXTRA: f64 = 0.02;
/// ...and the flag shows when they add up to this much.
const MISS_FLAG_MIN: f64 = 0.10;
const TOP_ITEMS: usize = 8;
const TOP_THREAD_ITEMS: usize = 5;
const TOP_FLAGS: usize = 6;
const TOP_THREAD_FLAGS: usize = 4;

/// Tools that only look. A helper whose every call is one of these is read-only.
const READ_ONLY_TOOLS: [&str; 8] = ["Read", "Grep", "Glob", "LS", "WebSearch", "WebFetch", "NotebookRead", "ToolSearch"];

// ---------------------------------------------------------------- shapes

/// Dollars by what was bought. `input` is the fresh (uncached) input.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Kinds {
    pub output: f64,
    pub cache_write: f64,
    pub cache_read: f64,
    pub input: f64,
    pub web: f64,
}

impl Kinds {
    pub fn sum(&self) -> f64 {
        self.output + self.cache_write + self.cache_read + self.input + self.web
    }
    fn add(&mut self, o: &Kinds) {
        self.output += o.output;
        self.cache_write += o.cache_write;
        self.cache_read += o.cache_read;
        self.input += o.input;
        self.web += o.web;
    }
}

/// Tokens by what they were. The first three are the headline (input + output + cache writes);
/// cache reads are listed apart, as everywhere else in the app.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenKinds {
    pub output: u64,
    pub cache_write: u64,
    pub input: u64,
    pub cache_read: u64,
}

impl TokenKinds {
    fn add_counts(&mut self, c: &Counts) {
        self.output += c.output;
        self.cache_write += c.cw5m + c.cw1h;
        self.input += c.input;
        self.cache_read += c.cr;
    }
    fn add(&mut self, o: &TokenKinds) {
        self.output += o.output;
        self.cache_write += o.cache_write;
        self.input += o.input;
        self.cache_read += o.cache_read;
    }
    /// input + output + cache writes: the figure the app headlines.
    pub fn headline(&self) -> u64 {
        self.output + self.cache_write + self.input
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelLine {
    pub model: String,
    pub usd: f64,
    /// input + output + cache writes (the figure the pages headline).
    pub tokens: u64,
}

/// One line of "biggest things that went into the conversation". `usd` is an estimate.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemLine {
    /// `read` (one file, however often), `output` (one big result) or `outputs` (many small ones of one tool).
    pub kind: String,
    pub tool: String,
    pub path: Option<String>,
    pub count: u32,
    pub tokens: u64,
    pub usd: Option<f64>,
    /// The thread's name when exactly one thread produced it.
    pub thread: Option<String>,
}

/// Something worth a second look. Text is composed by the app from these fields.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Flag {
    /// `repeat_read`, `huge_output`, `heavy_helper` or `cache_miss`.
    pub kind: String,
    /// The file, the tool, or the helper's name.
    pub label: String,
    pub agent_id: Option<String>,
    pub count: u32,
    pub tokens: u64,
    pub usd: Option<f64>,
    /// `cache_miss`: the longest pause, in minutes.
    pub minutes: Option<u32>,
    pub model: Option<String>,
    /// `heavy_helper`: what it did, most used first.
    pub tools: Vec<String>,
}

/// The main chat or one helper: its spend and its slice of the receipt.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    /// `None` for the main chat.
    pub agent_id: Option<String>,
    pub name: String,
    pub parent_agent_id: Option<String>,
    pub spawn_depth: i64,
    pub model: String,
    pub usd: f64,
    pub tokens: u64,
    pub cache_read_tokens: u64,
    pub messages: u64,
    pub duration_ms: i64,
    pub tool_calls: u64,
    pub kinds: Kinds,
    pub token_kinds: TokenKinds,
    pub models: Vec<ModelLine>,
    /// `finished`, `errored` or `stopped`, only where the transcript says. Never set for the main chat.
    pub outcome: Option<String>,
    pub items: Vec<ItemLine>,
    pub items_other_usd: f64,
    pub flags: Vec<Flag>,
    /// Some of its tokens belong to a model the price list does not cover.
    pub unpriced_tokens: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub session_id: String,
    /// The chat's existing cost figure (what the Sessions list shows).
    pub total_usd: Option<f64>,
    /// False when some tokens could not be priced.
    pub complete: bool,
    /// The transcripts could be read, so big items and most flags are present.
    pub scanned: bool,
    /// Main chat first, then the helpers in the order they started.
    pub threads: Vec<Thread>,
    pub threads_other_usd: f64,
    pub models: Vec<ModelLine>,
    pub models_other_usd: f64,
    pub kinds: Kinds,
    pub kinds_other_usd: f64,
    /// The chat's headline tokens (input + output + cache writes) and its tokens by kind.
    pub total_tokens: u64,
    pub token_kinds: TokenKinds,
    pub items: Vec<ItemLine>,
    pub items_other_usd: f64,
    pub flags: Vec<Flag>,
}

// ---------------------------------------------------------------- pricing the buckets

struct Bucket {
    agent: Option<String>,
    model: String,
    speed: String,
    geo: String,
    tier: String,
    price_tier: i64,
    c: Counts,
    messages: u64,
}

fn buckets(conn: &Connection, id: &str) -> rusqlite::Result<Vec<Bucket>> {
    let mut st = conn.prepare_cached(
        "SELECT agent_id, model, speed, geo, service_tier, price_tier, SUM(input), SUM(output), SUM(cw5m), SUM(cw1h), \
                SUM(cr), SUM(web_search), COUNT(*) FROM messages WHERE session_id=?1 \
         GROUP BY agent_id, model, speed, geo, service_tier, price_tier",
    )?;
    let rows = st.query_map([id], |r| {
        Ok(Bucket {
            agent: r.get(0)?,
            model: r.get(1)?,
            speed: r.get(2)?,
            geo: r.get(3)?,
            tier: r.get(4)?,
            price_tier: r.get(5)?,
            c: Counts {
                input: u(r.get(6)?),
                output: u(r.get(7)?),
                cw5m: u(r.get(8)?),
                cw1h: u(r.get(9)?),
                cr: u(r.get(10)?),
                web_search: u(r.get(11)?),
            },
            messages: u(r.get(12)?),
        })
    })?;
    rows.collect()
}

/// Each kind priced alone. The price is linear per kind, so the parts add up to the whole.
fn kinds_for(p: &PriceTable, b: &Basis, c: &Counts) -> Option<Kinds> {
    let one = |x: Counts| p.cost(b, &x);
    Some(Kinds {
        input: one(Counts { input: c.input, ..Default::default() })?,
        output: one(Counts { output: c.output, ..Default::default() })?,
        cache_write: one(Counts { cw5m: c.cw5m, cw1h: c.cw1h, ..Default::default() })?,
        cache_read: one(Counts { cr: c.cr, ..Default::default() })?,
        web: one(Counts { web_search: c.web_search, ..Default::default() })?,
    })
}

#[derive(Default)]
struct Acc {
    kinds: Kinds,
    token_kinds: TokenKinds,
    models: BTreeMap<String, (f64, u64)>,
    tokens: u64,
    cache_read: u64,
    output: u64,
    messages: u64,
    unpriced: u64,
}

fn model_lines(m: &BTreeMap<String, (f64, u64)>) -> Vec<ModelLine> {
    let mut v: Vec<ModelLine> =
        m.iter().map(|(model, (usd, tokens))| ModelLine { model: model.clone(), usd: *usd, tokens: *tokens }).collect();
    v.sort_by(|a, b| b.usd.total_cmp(&a.usd).then_with(|| b.tokens.cmp(&a.tokens)).then_with(|| a.model.cmp(&b.model)));
    v
}

// ---------------------------------------------------------------- big items

/// Dollars per million tokens of cache writes and reads on a model (global rates).
fn context_rates(p: &PriceTable, model: &str) -> Option<(f64, f64)> {
    let m = p.model(model)?;
    Some((m.cache_write5m, m.cache_read))
}

struct RawItem {
    key: String,
    kind: &'static str,
    tool: String,
    path: Option<String>,
    count: u32,
    tokens: u64,
    est: Option<f64>,
}

struct ThreadInsight {
    items: Vec<RawItem>,
    /// Every result at least `HUGE_TOKENS` big, with its estimate.
    huge: Vec<(ResultScan, Option<f64>)>,
}

/// What one result costs the chat: written into the cache once, then read on every later turn.
fn result_cost(r: &ResultScan, turns: u32, rates: Option<(f64, f64)>) -> Option<f64> {
    let (w, rd) = rates?;
    let later = turns.saturating_sub(r.turn).saturating_sub(1) as f64;
    Some(r.tokens as f64 * (w + later * rd) / 1_000_000.0)
}

/// Group a thread's results into lines, and scale the estimates so they never exceed what the
/// thread actually spent on context (cache writes plus reads).
fn analyze(ts: &ThreadScan, rates: Option<(f64, f64)>, context_usd: f64) -> ThreadInsight {
    let ests: Vec<Option<f64>> = ts.results.iter().map(|r| result_cost(r, ts.turns, rates)).collect();
    let raw_sum: f64 = ests.iter().flatten().sum();
    let scale = if raw_sum > context_usd && raw_sum > 0.0 { (context_usd / raw_sum).max(0.0) } else { 1.0 };
    let mut by_key: HashMap<String, usize> = HashMap::new();
    let mut items: Vec<RawItem> = Vec::new();
    let mut huge = Vec::new();
    for (i, r) in ts.results.iter().enumerate() {
        let est = ests[i].map(|e| e * scale);
        if r.tokens >= HUGE_TOKENS {
            huge.push((r.clone(), est));
        }
        let (key, kind) = match (&r.path, r.tool.as_str()) {
            (Some(p), "Read" | "NotebookRead") => (format!("read:{p}"), "read"),
            _ if r.tokens >= SINGLE_MIN_TOKENS => (format!("one:{i}"), "output"),
            (_, t) => (format!("many:{t}"), "outputs"),
        };
        match by_key.get(&key) {
            Some(&ix) => {
                let it = &mut items[ix];
                it.count += 1;
                it.tokens += r.tokens;
                it.est = match (it.est, est) {
                    (Some(a), Some(b)) => Some(a + b),
                    (a, b) => a.or(b),
                };
            }
            None => {
                by_key.insert(key.clone(), items.len());
                items.push(RawItem { key, kind, tool: r.tool.clone(), path: r.path.clone(), count: 1, tokens: r.tokens, est });
            }
        }
    }
    ThreadInsight { items, huge }
}

fn item_line(it: &RawItem, thread: Option<String>) -> ItemLine {
    ItemLine {
        kind: it.kind.to_string(),
        tool: it.tool.clone(),
        path: it.path.clone(),
        count: it.count,
        tokens: it.tokens,
        usd: it.est,
        thread,
    }
}

fn by_size(a: &RawItem, b: &RawItem) -> std::cmp::Ordering {
    b.est.unwrap_or(0.0).total_cmp(&a.est.unwrap_or(0.0)).then_with(|| b.tokens.cmp(&a.tokens)).then_with(|| a.key.cmp(&b.key))
}

fn repeat_flag(it: &RawItem, agent_id: Option<String>) -> Option<Flag> {
    if it.kind != "read" || it.count < REPEAT_READS || it.tokens < REPEAT_MIN_TOKENS {
        return None;
    }
    Some(Flag {
        kind: "repeat_read".into(),
        label: it.path.clone().unwrap_or_else(|| it.tool.clone()),
        agent_id,
        count: it.count,
        tokens: it.tokens,
        usd: it.est,
        minutes: None,
        model: None,
        tools: Vec::new(),
    })
}

fn huge_flag(r: &ResultScan, est: Option<f64>, agent_id: Option<String>) -> Flag {
    Flag {
        kind: "huge_output".into(),
        label: r.path.clone().unwrap_or_else(|| r.tool.clone()),
        agent_id,
        count: 1,
        tokens: r.tokens,
        usd: est,
        minutes: None,
        model: None,
        tools: Vec::new(),
    }
}

fn rank_flags(flags: &mut Vec<Flag>, keep: usize) {
    flags.sort_by(|a, b| {
        b.usd.unwrap_or(0.0).total_cmp(&a.usd.unwrap_or(0.0)).then_with(|| b.tokens.cmp(&a.tokens)).then_with(|| a.label.cmp(&b.label))
    });
    flags.truncate(keep);
}

// ---------------------------------------------------------------- cache misses

#[derive(Default)]
struct Misses {
    count: u32,
    tokens: u64,
    extra: f64,
    max_gap_ms: i64,
    model: String,
}

/// Requests that came after a pause longer than the cache lives and wrote the conversation back
/// into the cache. The extra cost is what those writes cost over reading the same tokens.
fn cache_misses(conn: &Connection, id: &str, prices: &PriceTable) -> rusqlite::Result<HashMap<Option<String>, Misses>> {
    let mut st = conn.prepare_cached(
        "SELECT agent_id, ts_utc_ms, model, cw5m, cw1h, cr FROM messages WHERE session_id=?1 \
         ORDER BY agent_id, ts_utc_ms, line_offset LIMIT 60000",
    )?;
    let mut out: HashMap<Option<String>, Misses> = HashMap::new();
    // (thread, time of its previous request, whether it has ever written the hour-long cache)
    let mut prev: Option<(Option<String>, i64, bool)> = None;
    let rows = st.query_map([id], |r| {
        Ok((r.get::<_, Option<String>>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?, u(r.get(3)?), u(r.get(4)?), u(r.get(5)?)))
    })?;
    for r in rows {
        let (agent, ts, model, cw5, cw1, cr) = r?;
        let mut long_now = cw1 > 0 && cw1 >= cw5;
        if let Some((pa, pts, long)) = &prev
            && *pa == agent
        {
            long_now |= *long;
            let gap = ts - *pts;
            let ttl = if *long { TTL_LONG_MS } else { TTL_SHORT_MS };
            let cw = cw5 + cw1;
            if gap > ttl
                && cw >= MISS_MIN_TOKENS
                && cw >= cr
                && let Some(m) = prices.model(&model)
            {
                let extra = (cw5 as f64 * (m.cache_write5m - m.cache_read) + cw1 as f64 * (m.cache_write1h - m.cache_read))
                    / 1_000_000.0;
                if extra >= MISS_MIN_EXTRA {
                    let e = out.entry(agent.clone()).or_default();
                    e.count += 1;
                    e.tokens += cw;
                    e.extra += extra;
                    if gap > e.max_gap_ms {
                        e.max_gap_ms = gap;
                        e.model = model.clone();
                    }
                }
            }
        }
        prev = Some((agent, ts, long_now));
    }
    Ok(out)
}

fn miss_flag(m: &Misses, agent_id: Option<String>, label: String) -> Option<Flag> {
    if m.extra < MISS_FLAG_MIN {
        return None;
    }
    Some(Flag {
        kind: "cache_miss".into(),
        label,
        agent_id,
        count: m.count,
        tokens: m.tokens,
        usd: Some(m.extra),
        minutes: Some((m.max_gap_ms / 60_000) as u32),
        model: Some(m.model.clone()),
        tools: Vec::new(),
    })
}

// ---------------------------------------------------------------- tool mix of helpers

fn tool_mix(conn: &Connection, id: &str) -> rusqlite::Result<HashMap<String, Vec<(String, u64)>>> {
    let mut st = conn.prepare_cached(
        "SELECT a.agent_id, iu.item, SUM(iu.uses) FROM item_use iu JOIN agents a ON a.file_id = iu.file_id \
         WHERE a.session_id=?1 AND iu.kind='tool' GROUP BY a.agent_id, iu.item",
    )?;
    let mut out: HashMap<String, Vec<(String, u64)>> = HashMap::new();
    for r in st.query_map([id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, u(r.get(2)?))))? {
        let (a, item, n) = r?;
        out.entry(a).or_default().push((item, n));
    }
    for v in out.values_mut() {
        v.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    }
    Ok(out)
}

// ---------------------------------------------------------------- outcome

fn outcome_of(agent_id: &str, notices: &HashMap<&str, &str>, ts: Option<&ThreadScan>) -> Option<String> {
    if let Some(s) = notices.get(agent_id) {
        return match *s {
            "completed" => Some("finished".into()),
            "failed" => Some("errored".into()),
            "killed" | "stopped" | "cancelled" => Some("stopped".into()),
            _ => None,
        };
    }
    let t = ts?;
    if t.last_api_error {
        return Some("errored".into());
    }
    if t.last_stop.as_deref() == Some("end_turn") {
        return Some("finished".into());
    }
    if t.interrupted {
        return Some("stopped".into());
    }
    None
}

// ---------------------------------------------------------------- the receipt

/// Build the receipt from the ledger and (when there is one) the transcript scan.
pub fn build(conn: &Connection, ctx: &QueryCtx, id: &str, scan: Option<&Scan>) -> rusqlite::Result<Option<Receipt>> {
    let ids = [id.to_string()];
    let Some(row) = session_rows_for(conn, ctx, &ids)?.pop() else { return Ok(None) };
    let prices: &PriceTable = &ctx.prices;
    let agents = agent_summaries(conn, id)?;

    // Spend, by thread and kind and model.
    let mut accs: BTreeMap<Option<String>, Acc> = BTreeMap::new();
    for b in buckets(conn, id)? {
        let a = accs.entry(b.agent.clone()).or_default();
        let total = b.c.input + b.c.output + b.c.cw5m + b.c.cw1h;
        a.tokens += total;
        a.cache_read += b.c.cr;
        a.token_kinds.add_counts(&b.c);
        a.output += b.c.output;
        a.messages += b.messages;
        let basis = Basis { model: &b.model, speed: &b.speed, geo: &b.geo, service_tier: &b.tier, price_tier: b.price_tier };
        match kinds_for(prices, &basis, &b.c) {
            Some(k) => {
                a.kinds.add(&k);
                let m = a.models.entry(b.model.clone()).or_default();
                m.0 += k.sum();
                m.1 += total;
            }
            None => {
                a.unpriced += total;
                a.models.entry(b.model.clone()).or_default().1 += total;
            }
        }
    }

    let scan = scan.filter(|s| s.readable);
    let mut scan_threads: HashMap<Option<&str>, &ThreadScan> = HashMap::new();
    let mut notices: HashMap<&str, &str> = HashMap::new();
    if let Some(s) = scan {
        for t in &s.threads {
            scan_threads.insert(t.agent_id.as_deref(), t);
        }
        for n in &s.notices {
            notices.insert(n.agent_id.as_str(), n.status.as_str());
        }
    }
    let misses = cache_misses(conn, id, prices)?;
    let mix = tool_mix(conn, id)?;

    // Threads: the main chat, then each helper in start order.
    // agent id, name, started by, spawn depth, duration ms, tool calls, model
    type Row = (Option<String>, String, Option<String>, i64, i64, u64, String);
    let mut roster: Vec<Row> = Vec::new();
    roster.push((None, "Main chat".into(), None, 0, 0, 0, String::new()));
    for a in &agents {
        roster.push((
            Some(a.agent_id.clone()),
            a.name.clone(),
            a.parent_agent_id.clone(),
            a.spawn_depth,
            a.duration_ms,
            a.tool_calls,
            a.model.clone(),
        ));
    }
    let main_tool_calls: i64 = conn.query_row(
        "SELECT COALESCE(SUM(tool_calls),0) FROM files WHERE session_id=?1 AND is_subagent=0",
        [id],
        |r| r.get(0),
    )?;
    let names: HashMap<Option<String>, String> = roster.iter().map(|r| (r.0.clone(), r.1.clone())).collect();

    let mut threads: Vec<Thread> = Vec::new();
    let mut all_items: Vec<(Option<String>, RawItem)> = Vec::new();
    let mut huge_all: Vec<(Option<String>, ResultScan, Option<f64>)> = Vec::new();
    let mut kinds_total = Kinds::default();
    let mut token_kinds_total = TokenKinds::default();
    let mut models_total: BTreeMap<String, (f64, u64)> = BTreeMap::new();

    for (agent, name, parent, depth, duration, tool_calls, summary_model) in roster {
        let acc = accs.remove(&agent).unwrap_or_default();
        let models = model_lines(&acc.models);
        let model = models.first().map(|m| m.model.clone()).filter(|m| !m.is_empty()).unwrap_or(summary_model);
        let usd = acc.kinds.sum();
        kinds_total.add(&acc.kinds);
        token_kinds_total.add(&acc.token_kinds);
        for (m, (c, t)) in &acc.models {
            let e = models_total.entry(m.clone()).or_default();
            e.0 += c;
            e.1 += t;
        }

        let ts = scan_threads.get(&agent.as_deref()).copied();
        let mut items = Vec::new();
        let mut flags: Vec<Flag> = Vec::new();
        let mut items_other = 0.0;
        if let Some(ts) = ts {
            let ins = analyze(ts, context_rates(prices, &model), acc.kinds.cache_write + acc.kinds.cache_read);
            let mut raw = ins.items;
            raw.sort_by(by_size);
            for it in &raw {
                if let Some(f) = repeat_flag(it, agent.clone()) {
                    flags.push(f);
                }
            }
            for (r, est) in &ins.huge {
                flags.push(huge_flag(r, *est, agent.clone()));
            }
            let shown: Vec<&RawItem> = raw.iter().take(TOP_THREAD_ITEMS).collect();
            items_other = usd - shown.iter().filter_map(|i| i.est).sum::<f64>();
            items = shown.iter().map(|i| item_line(i, Some(name.clone()))).collect();
            for (r, est) in ins.huge {
                huge_all.push((agent.clone(), r, est));
            }
            for it in raw {
                all_items.push((agent.clone(), it));
            }
        }
        if let Some(m) = misses.get(&agent)
            && let Some(f) = miss_flag(m, agent.clone(), name.clone())
        {
            flags.push(f);
        }
        // An expensive model doing small read-only work.
        if let Some(aid) = &agent {
            let tools = mix.get(aid).cloned().unwrap_or_default();
            let heavy = prices.model(&model).is_some_and(|m| m.output >= HEAVY_OUT_PER_M);
            if heavy
                && usd >= HEAVY_MIN_USD
                && acc.output <= HEAVY_MAX_OUTPUT
                && !tools.is_empty()
                && tools.iter().all(|(t, _)| READ_ONLY_TOOLS.contains(&t.as_str()))
            {
                flags.push(Flag {
                    kind: "heavy_helper".into(),
                    label: name.clone(),
                    agent_id: agent.clone(),
                    count: tools.iter().map(|t| t.1).sum::<u64>() as u32,
                    tokens: acc.tokens,
                    usd: Some(usd),
                    minutes: None,
                    model: Some(model.clone()),
                    tools: tools.iter().take(3).map(|t| t.0.clone()).collect(),
                });
            }
        }
        rank_flags(&mut flags, TOP_THREAD_FLAGS);
        let outcome = agent.as_deref().and_then(|a| outcome_of(a, &notices, ts));
        threads.push(Thread {
            tool_calls: if agent.is_none() { u(main_tool_calls) } else { tool_calls },
            agent_id: agent,
            name,
            parent_agent_id: parent,
            spawn_depth: depth,
            model,
            usd,
            tokens: acc.tokens,
            cache_read_tokens: acc.cache_read,
            messages: acc.messages,
            duration_ms: duration,
            kinds: acc.kinds,
            token_kinds: acc.token_kinds,
            models,
            outcome,
            items,
            items_other_usd: items_other,
            flags,
            unpriced_tokens: acc.unpriced,
        });
    }

    let total = row.cost.usd;
    let remainder = |parts: f64| total.map_or(0.0, |t| t - parts);

    // The chat-wide big items: a file read in several threads is one line.
    let mut merged: Vec<(RawItem, Vec<Option<String>>)> = Vec::new();
    {
        let mut ix: HashMap<String, usize> = HashMap::new();
        for (agent, it) in all_items {
            let key = if it.kind == "read" { it.key.clone() } else { format!("{}@{:?}", it.key, agent) };
            match ix.get(&key) {
                Some(&i) => {
                    let (m, owners) = &mut merged[i];
                    m.count += it.count;
                    m.tokens += it.tokens;
                    m.est = match (m.est, it.est) {
                        (Some(a), Some(b)) => Some(a + b),
                        (a, b) => a.or(b),
                    };
                    if !owners.contains(&agent) {
                        owners.push(agent);
                    }
                }
                None => {
                    ix.insert(key, merged.len());
                    merged.push((it, vec![agent]));
                }
            }
        }
    }
    merged.sort_by(|a, b| by_size(&a.0, &b.0));
    let mut flags: Vec<Flag> = Vec::new();
    for (it, owners) in &merged {
        let owner = if owners.len() == 1 { owners[0].clone() } else { None };
        if let Some(f) = repeat_flag(it, owner) {
            flags.push(f);
        }
    }
    for (agent, r, est) in &huge_all {
        flags.push(huge_flag(r, *est, agent.clone()));
    }
    for t in &threads {
        flags.extend(t.flags.iter().filter(|f| f.kind == "heavy_helper" || f.kind == "cache_miss").cloned());
    }
    rank_flags(&mut flags, TOP_FLAGS);

    let items: Vec<ItemLine> = merged
        .iter()
        .take(TOP_ITEMS)
        .map(|(it, owners)| {
            let thread = if owners.len() == 1 { names.get(&owners[0]).cloned() } else { None };
            item_line(it, thread)
        })
        .collect();
    let items_other = remainder(items.iter().filter_map(|i| i.usd).sum());

    let threads_sum: f64 = threads.iter().map(|t| t.usd).sum();
    let models = model_lines(&models_total);
    let models_sum: f64 = models.iter().map(|m| m.usd).sum();

    Ok(Some(Receipt {
        session_id: id.to_string(),
        total_usd: total,
        complete: row.cost.complete,
        scanned: scan.is_some(),
        threads,
        threads_other_usd: remainder(threads_sum),
        models,
        models_other_usd: remainder(models_sum),
        kinds: kinds_total,
        kinds_other_usd: remainder(kinds_total.sum()),
        total_tokens: row.tokens.total,
        token_kinds: token_kinds_total,
        items,
        items_other_usd: items_other,
        flags,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn res(tool: &str, path: Option<&str>, tokens: u64, turn: u32) -> ResultScan {
        ResultScan { tool: tool.into(), path: path.map(str::to_string), tokens, turn }
    }

    #[test]
    fn a_result_costs_one_write_and_a_read_per_later_turn() {
        // 1M tokens, written at $6.25/M, read at $0.50/M, 10 turns total, arrived after turn 2:
        // the next turn writes it (not a read), the 7 after that read it.
        let c = result_cost(&res("Bash", None, 1_000_000, 2), 10, Some((6.25, 0.5))).unwrap();
        assert!((c - (6.25 + 7.0 * 0.5)).abs() < 1e-9, "{c}");
        assert!(result_cost(&res("Bash", None, 10, 2), 10, None).is_none());
    }

    #[test]
    fn estimates_never_exceed_what_the_thread_spent_on_context() {
        let ts = ThreadScan {
            turns: 20,
            results: vec![res("Read", Some("a.md"), 500_000, 0), res("Bash", None, 400_000, 1)],
            ..Default::default()
        };
        let ins = analyze(&ts, Some((6.25, 0.5)), 3.0);
        let sum: f64 = ins.items.iter().filter_map(|i| i.est).sum();
        assert!((sum - 3.0).abs() < 1e-9, "scaled to the budget, got {sum}");
        // With room to spare nothing is scaled.
        let ins = analyze(&ts, Some((6.25, 0.5)), 1_000.0);
        assert!(ins.items.iter().filter_map(|i| i.est).sum::<f64>() < 1_000.0);
    }

    #[test]
    fn reads_group_by_file_and_small_outputs_group_by_tool() {
        let mut results = vec![res("Read", Some("docs/tech.md"), 9_000, 0); 7];
        results.push(res("Bash", None, 1_000, 3));
        results.push(res("Bash", None, 2_000, 4));
        results.push(res("Bash", None, 60_000, 5));
        let ts = ThreadScan { turns: 12, results, ..Default::default() };
        let ins = analyze(&ts, None, 10.0);
        let read = ins.items.iter().find(|i| i.kind == "read").unwrap();
        assert_eq!((read.count, read.tokens), (7, 63_000));
        assert!(read.est.is_none(), "no price for the model: no dollar guess");
        let many = ins.items.iter().find(|i| i.kind == "outputs").unwrap();
        assert_eq!((many.count, many.tokens), (2, 3_000));
        assert_eq!(ins.huge.len(), 1);
        assert!(repeat_flag(read, None).is_some());
        let few = RawItem { key: "k".into(), kind: "read", tool: "Read".into(), path: Some("x".into()), count: 3, tokens: 90_000, est: None };
        assert!(repeat_flag(&few, None).is_none(), "three reads is not many");
    }

    #[test]
    fn outcomes_prefer_the_notification_then_how_the_thread_ended() {
        let notes: HashMap<&str, &str> = HashMap::from([("a", "failed"), ("b", "killed"), ("c", "completed")]);
        assert_eq!(outcome_of("a", &notes, None).as_deref(), Some("errored"));
        assert_eq!(outcome_of("b", &notes, None).as_deref(), Some("stopped"));
        assert_eq!(outcome_of("c", &notes, None).as_deref(), Some("finished"));
        let done = ThreadScan { last_stop: Some("end_turn".into()), ..Default::default() };
        assert_eq!(outcome_of("d", &notes, Some(&done)).as_deref(), Some("finished"));
        let running = ThreadScan { last_stop: Some("tool_use".into()), ..Default::default() };
        assert_eq!(outcome_of("d", &notes, Some(&running)), None, "unknown stays unknown");
        let cut = ThreadScan { last_stop: Some("tool_use".into()), interrupted: true, ..Default::default() };
        assert_eq!(outcome_of("d", &notes, Some(&cut)).as_deref(), Some("stopped"));
        let broke = ThreadScan { last_api_error: true, ..Default::default() };
        assert_eq!(outcome_of("d", &notes, Some(&broke)).as_deref(), Some("errored"));
    }
}
