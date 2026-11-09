//! Repeated requests: find what the person keeps asking Claude for, so the Atlas plugin skill
//! can offer to turn it into a skill (docs/specs/skill-library.md, Unit B).
//!
//! Reads only the chat search index (`search::db`), read-only, and only what the person typed
//! (`msgs.origin` 0 or 1, no helper chats, no assistant text, nothing with a masked secret).
//! No model, no network: `filter` -> `normalize` -> `cluster`. The one thing written is
//! `habits.json` (`notes`) in Atlas's own data folder.

pub mod cluster;
pub mod filter;
pub mod normalize;
pub mod notes;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use rusqlite::Connection;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::search::db;
use crate::usage::time::Tz;
pub use cluster::{Group, Grouping, Prompt, Thresholds, group, id16, project_name};
pub use notes::{Answer, Notes};

pub const NO_INDEX: &str = "Atlas has not read your chats yet. Open the Atlas app once and try again.";
pub const OLD_INDEX: &str = "Open the Atlas app once so it can update its chat index.";
pub const NEW_INDEX: &str = "Atlas's chat index was made by a newer Atlas. Update Atlas and its Claude connector.";
pub const UNREADABLE: &str = "Atlas can't read its chat index right now. Open the Atlas app once and try again.";
pub const FIRST_READ: &str = "Atlas is still reading your chats for the first time. Try again in a minute.";

/// `like` is the request in front of Claude; more than this is cut.
pub const LIKE_MAX_CHARS: usize = 2_000;
pub const DEFAULT_LIMIT: usize = 8;
pub const MAX_LIMIT: usize = 20;
pub const MAX_DAYS: i64 = 365;

/// Open the search index read-only and check it is one Unit B can read: schema 2, parser 2.
pub fn open_index(path: &Path) -> Result<Connection, String> {
    if !path.is_file() {
        return Err(NO_INDEX.into());
    }
    let conn = db::open_reader(path).map_err(|_| UNREADABLE.to_string())?;
    let v: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).map_err(|_| UNREADABLE.to_string())?;
    match v {
        0 => return Err(NO_INDEX.into()),
        1 => return Err(OLD_INDEX.into()),
        v if v > db::SCHEMA_VERSION => return Err(NEW_INDEX.into()),
        _ => {}
    }
    if db::get_meta(&conn, "parser_version").as_deref() != Some(db::PARSER_VERSION) {
        return Err(OLD_INDEX.into());
    }
    Ok(conn)
}

/// Every typed prompt that passes the filters (D30, D31).
pub fn load_prompts(conn: &Connection) -> rusqlite::Result<Vec<Prompt>> {
    let mut st = conn.prepare(
        "SELECT t.text, m.session_id, m.ts, s.project \
         FROM msgs m JOIN fts t ON t.rowid = m.id JOIN sfiles s ON s.file_id = m.file_id \
         WHERE m.role = 0 AND m.origin IN (0, 1) AND m.agent_id IS NULL AND s.is_subagent = 0 AND m.ts IS NOT NULL",
    )?;
    let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?, r.get::<_, Option<String>>(3)?)))?;
    let mut out = Vec::new();
    for row in rows {
        let (text, session, ts, project) = row?;
        if filter::keep(&text) {
            out.push(Prompt { text: text.trim().to_string(), session, ts, project });
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------- the service

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Stamp {
    len: u64,
    modified: Option<SystemTime>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct CacheKey {
    max_id: i64,
    db: Option<Stamp>,
    wal: Option<Stamp>,
}

struct Cached {
    key: CacheKey,
    grouping: Arc<Grouping>,
    indexed_ms: Option<i64>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindArgs {
    pub like: Option<String>,
    pub days: Option<i64>,
    pub project: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteArgs {
    pub group_id: Option<String>,
    pub like: Option<String>,
    pub answer: String,
    pub skill_name: Option<String>,
}

/// What the two MCP tools use. The grouping is kept in memory (D42): the first call groups
/// every typed prompt, later calls with no new rows answer from memory.
pub struct Habits {
    index: PathBuf,
    data_dir: PathBuf,
    tz: Tz,
    cache: Mutex<Option<Cached>>,
}

fn stamp(p: &Path) -> Option<Stamp> {
    let m = std::fs::metadata(p).ok()?;
    Some(Stamp { len: m.len(), modified: m.modified().ok() })
}

fn offer_json(n: &notes::Note) -> Value {
    json!({ "answer": n.answer, "atMs": n.at_ms, "skillName": n.skill_name })
}

fn group_json(g: &Group, th: &Thresholds, notes: &Notes) -> Value {
    json!({
        "id": g.id,
        "count": g.count,
        "sessions": g.sessions,
        "days": g.days,
        "projects": g.projects.iter().take(5).collect::<Vec<_>>(),
        "firstSeenMs": g.first_ms,
        "lastSeenMs": g.last_ms,
        "representative": g.representative,
        "examples": g.examples,
        "meetsBar": g.meets(th),
        "offer": notes.offer_for(g.ids()).map(offer_json),
    })
}

fn cut_like(like: &str) -> String {
    like.chars().take(LIKE_MAX_CHARS).collect()
}

impl Habits {
    pub fn new(index: PathBuf, data_dir: PathBuf) -> Habits {
        Habits { index, data_dir, tz: Tz::Local, cache: Mutex::new(None) }
    }

    /// Time zone for "different days" (tests pin one).
    pub fn with_tz(mut self, tz: Tz) -> Habits {
        self.tz = tz;
        self
    }

    fn grouping(&self) -> Result<(Arc<Grouping>, Option<i64>), String> {
        let conn = open_index(&self.index)?;
        let max_id: i64 = conn.query_row("SELECT COALESCE(MAX(id), 0) FROM msgs", [], |r| r.get(0)).map_err(|_| UNREADABLE.to_string())?;
        let mut wal = self.index.as_os_str().to_os_string();
        wal.push("-wal");
        let key = CacheKey { max_id, db: stamp(&self.index), wal: stamp(Path::new(&wal)) };
        let mut slot = self.cache.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(c) = &*slot
            && c.key == key
        {
            return Ok((Arc::clone(&c.grouping), c.indexed_ms));
        }
        let prompts = load_prompts(&conn).map_err(|_| UNREADABLE.to_string())?;
        if prompts.is_empty() && db::get_meta(&conn, "first_index_done").is_none() {
            return Err(FIRST_READ.into());
        }
        let grouping = Arc::new(group(&prompts, self.tz));
        let indexed_ms = db::get_meta(&conn, "last_indexed_at").and_then(|v| v.parse::<i64>().ok()).map(|s| s * 1000);
        *slot = Some(Cached { key, grouping: Arc::clone(&grouping), indexed_ms });
        Ok((grouping, indexed_ms))
    }

    /// `find_repeated_requests` (D40).
    pub fn find(&self, a: &FindArgs, now_ms: i64) -> Result<Value, String> {
        let (grouping, indexed_ms) = self.grouping()?;
        let th = Thresholds::OFFER;
        let notes = Notes::load(&self.data_dir);
        let days = a.days.unwrap_or(th.window_days).clamp(1, MAX_DAYS);
        let limit = a.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
        let like = a.like.as_deref().map(cut_like).filter(|l| !normalize::normalize(l).is_empty());
        let matched = like.as_deref().and_then(|l| grouping.like(l, th.like_count));
        let mut out_groups: Vec<Value> = Vec::new();
        if let Some((g, _)) = matched {
            out_groups.push(group_json(g, &th, &notes));
        }
        for g in grouping.qualifying(&th, now_ms, days, a.project.as_deref()) {
            if matched.is_some_and(|(m, _)| m.id == g.id) {
                continue;
            }
            out_groups.push(group_json(g, &th, &notes));
        }
        out_groups.truncate(limit);
        let like_offer = like.as_deref().and_then(|l| {
            let own = id16(&normalize::normalize(l));
            let ids: Vec<&str> = std::iter::once(own.as_str()).chain(matched.iter().flat_map(|(g, _)| g.ids())).collect();
            notes.offer_for(ids).map(offer_json)
        });
        Ok(json!({
            "indexedThroughMs": indexed_ms,
            "offersOff": notes.offers_off,
            "offerBar": { "count": th.count, "chats": th.sessions, "days": th.days, "windowDays": th.window_days, "thisChat": th.this_chat },
            "likeMatch": matched.map(|(g, s)| json!({ "groupId": g.id, "similarity": s })),
            "likeOffer": like_offer,
            "groups": out_groups,
        }))
    }

    /// `note_skill_offer` (D43). Writes only `habits.json` in Atlas's data folder.
    pub fn note(&self, a: &NoteArgs, now_ms: i64) -> Result<Value, String> {
        let answer = Answer::parse(&a.answer).ok_or("answer must be one of offered, declined, made or never.")?;
        let skill = a.skill_name.as_deref().map(str::trim).filter(|s| !s.is_empty());
        if let Some(s) = skill
            && !notes::valid_skill_name(s)
        {
            return Err("skillName must be lowercase letters, numbers and dashes, at most 40 characters.".into());
        }
        let like = a.like.as_deref().map(cut_like).map(|l| normalize::normalize(&l)).filter(|n| !n.is_empty());
        let given = a.group_id.as_deref().map(str::trim).filter(|s| !s.is_empty());
        if let Some(g) = given
            && !notes::valid_id(g)
        {
            return Err("groupId must be an id returned by find_repeated_requests.".into());
        }
        // Without the index (Atlas never ran) the answer is still filed under the request's own id.
        let grouping = self.grouping().ok().map(|(g, _)| g);
        let mut id: Option<String> = given.map(str::to_string);
        let mut aliases: Vec<String> = Vec::new();
        let like_group = match (&like, &grouping) {
            (Some(l), Some(g)) => g.like(l, 1).map(|(g, _)| g),
            _ => None,
        };
        let known = id.as_deref().and_then(|i| grouping.as_ref().and_then(|g| g.by_id(i))).or(like_group);
        if let Some(g) = known {
            id.get_or_insert_with(|| g.id.clone());
            aliases.extend(g.member_ids.iter().cloned());
            aliases.push(g.id.clone());
        }
        if let Some(l) = &like {
            let own = id16(l);
            id.get_or_insert_with(|| own.clone());
            aliases.push(own);
        }
        if id.is_none() && answer != Answer::Never {
            return Err("Pass groupId (from find_repeated_requests) or like (the request's text).".into());
        }
        let n = notes::record(&self.data_dir, id.as_deref(), &aliases, answer, skill, now_ms)?;
        Ok(json!({ "ok": true, "groupId": id, "answer": answer, "offersOff": n.offers_off }))
    }
}

#[cfg(test)]
mod tests;
