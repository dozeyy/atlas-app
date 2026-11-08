//! What the setup-cost estimate needs from the usage cache, in one read: how many turns ran
//! in the last N days (by project and model), how many of those started a fresh prompt
//! cache, what the cache cost per token, which skills and helpers ran, and which recent
//! transcripts are worth sampling for the parts of the prompt that are not on disk (MCP).
//!
//! Plain data out; `setup::cost` turns it into dollars. Nothing here knows what a skill is.

use std::collections::HashMap;

use rusqlite::{params, Connection};

use super::query::QueryCtx;

const DAY_MS: i64 = 86_400_000;
/// At most this many transcripts are sampled for MCP (one per project, newest first).
const MAX_SAMPLES: usize = 40;

/// Turns of one model in one project (the key `ingest::project_key` stores; "" = unknown).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnGroup {
    pub project_key: String,
    pub model: String,
    /// Every API turn, helpers included: a helper loads the same setup as its parent.
    pub turns: u64,
    /// Turns that opened a transcript file for this model, so their prompt was written to
    /// the cache instead of read from it.
    pub starts: u64,
}

/// USD per million tokens for one model, as the cache is really used.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CachePrice {
    pub read: f64,
    /// 5 minute and 1 hour writes blended by how many tokens of each were written.
    pub write: f64,
}

/// A recent main transcript to read the start of.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sample {
    pub project_key: String,
    pub path: String,
}

#[derive(Debug, Clone, Default)]
pub struct CostMix {
    pub days: u32,
    pub from_ms: i64,
    pub groups: Vec<TurnGroup>,
    pub prices: HashMap<String, CachePrice>,
    /// Models with turns but no price: their turns are left out and the result says so.
    pub unpriced_turns: u64,
    /// (kind "skill" | "agent", lower-case name) -> uses in the window.
    pub item_uses: HashMap<(String, String), u64>,
    /// Mean turns per main transcript and per helper transcript.
    pub avg_turns_main: f64,
    pub avg_turns_helper: f64,
    pub samples: Vec<Sample>,
}

impl CostMix {
    pub fn total_turns(&self) -> u64 {
        self.groups.iter().map(|g| g.turns).sum()
    }
}

fn nz(v: i64) -> u64 {
    v.max(0) as u64
}

pub fn cost_mix(conn: &Connection, ctx: &QueryCtx, days: u32) -> rusqlite::Result<CostMix> {
    let from_ms = ctx.now_ms - i64::from(days) * DAY_MS;
    let mut mix = CostMix { days, from_ms, ..Default::default() };

    // Turns (and the cache tokens written, to blend the write price) by project and model.
    let mut writes: HashMap<String, (u64, u64)> = HashMap::new();
    {
        let mut st = conn.prepare_cached(
            "SELECT COALESCE(s.project_key, ''), m.model, COUNT(*), SUM(m.cw5m), SUM(m.cw1h)
             FROM messages m LEFT JOIN sessions s ON s.session_id = m.session_id
             WHERE m.ts_utc_ms >= ?1 AND COALESCE(s.is_atlas_assistant, 0) = 0
             GROUP BY 1, 2",
        )?;
        let rows = st.query_map(params![from_ms], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, nz(r.get(2)?), nz(r.get(3)?), nz(r.get(4)?)))
        })?;
        for r in rows {
            let (project_key, model, turns, w5, w1) = r?;
            // Placeholder models ("<synthetic>") carry no prompt.
            if model.starts_with('<') {
                continue;
            }
            if ctx.prices.model(&model).is_none() {
                mix.unpriced_turns += turns;
                continue;
            }
            let e = writes.entry(model.clone()).or_default();
            e.0 += w5;
            e.1 += w1;
            mix.groups.push(TurnGroup { project_key, model, turns, starts: 0 });
        }
    }
    for (model, (w5, w1)) in writes {
        let Some(p) = ctx.prices.model(&model) else { continue };
        let total = (w5 + w1) as f64;
        let share_1h = if total > 0.0 { w1 as f64 / total } else { 0.0 };
        let write = share_1h * p.cache_write1h + (1.0 - share_1h) * p.cache_write5m;
        mix.prices.insert(model, CachePrice { read: p.cache_read, write });
    }

    // Starts: the first turn of each (transcript file, model) when the file began inside the window.
    {
        let mut st = conn.prepare_cached(
            "SELECT COALESCE(s.project_key, ''), t.model, COUNT(*)
             FROM (SELECT file_id, model, MIN(session_id) AS session_id, MIN(ts_utc_ms) AS first
                   FROM messages
                   WHERE file_id IN (SELECT DISTINCT file_id FROM messages WHERE ts_utc_ms >= ?1)
                   GROUP BY file_id, model) t
             LEFT JOIN sessions s ON s.session_id = t.session_id
             WHERE t.first >= ?1 AND COALESCE(s.is_atlas_assistant, 0) = 0
             GROUP BY 1, 2",
        )?;
        let rows = st.query_map(params![from_ms], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, nz(r.get(2)?))))?;
        for r in rows {
            let (key, model, starts) = r?;
            if let Some(g) = mix.groups.iter_mut().find(|g| g.project_key == key && g.model == model) {
                g.starts = starts.min(g.turns);
            }
        }
    }

    // How long a transcript runs: what an on-demand body is re-read for.
    {
        let mut st = conn.prepare_cached(
            "SELECT f.is_subagent, COUNT(DISTINCT m.file_id), COUNT(*)
             FROM messages m JOIN files f ON f.file_id = m.file_id
             WHERE m.ts_utc_ms >= ?1 GROUP BY f.is_subagent",
        )?;
        let rows = st.query_map(params![from_ms], |r| Ok((r.get::<_, i64>(0)? != 0, nz(r.get(1)?), nz(r.get(2)?))))?;
        for r in rows {
            let (helper, files, turns) = r?;
            let avg = if files > 0 { turns as f64 / files as f64 } else { 0.0 };
            if helper {
                mix.avg_turns_helper = avg;
            } else {
                mix.avg_turns_main = avg;
            }
        }
    }

    // Skills and helpers that ran in the window (the hour a use was last seen in).
    {
        let mut st = conn.prepare_cached(
            "SELECT kind, item, SUM(uses) FROM item_use
             WHERE kind IN ('skill', 'agent') AND last_ts >= ?1 GROUP BY kind, item",
        )?;
        let rows = st.query_map(params![from_ms], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, nz(r.get(2)?))))?;
        for r in rows {
            let (kind, item, n) = r?;
            *mix.item_uses.entry((kind, item.to_lowercase())).or_default() += n;
        }
    }

    // The newest main transcript of each project that ran in the window.
    {
        let mut st = conn.prepare_cached(
            "SELECT s.project_key, f.path
             FROM sessions s JOIN files f ON f.session_id = s.session_id AND f.is_subagent = 0 AND f.missing = 0
             WHERE s.last_ts >= ?1 AND s.project_key IS NOT NULL AND s.is_atlas_assistant = 0
             ORDER BY s.last_ts DESC",
        )?;
        let rows = st.query_map(params![from_ms], |r| Ok(Sample { project_key: r.get(0)?, path: r.get(1)? }))?;
        for r in rows {
            let s = r?;
            if mix.samples.len() >= MAX_SAMPLES {
                break;
            }
            if !mix.samples.iter().any(|x| x.project_key == s.project_key) {
                mix.samples.push(s);
            }
        }
    }
    Ok(mix)
}
