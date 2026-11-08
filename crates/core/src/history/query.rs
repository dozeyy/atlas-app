//! What the History page asks for: a feed of events, one item with its versions, and a diff.
//! Read-only. File text is only ever returned masked.

use std::fs;
use std::path::Path;

use rusqlite::{params_from_iter, types::Value as Sql};
use serde::Serialize;

use super::diff::{self, Diff};
use super::store::Store;
use super::{kind_group, GROUPED_KINDS, MCP_KEY};
use crate::setup::secrets;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ItemRef {
    pub key: String,
    pub kind: String,
    pub scope: String,
    pub project: Option<String>,
    pub name: String,
    pub path: String,
    pub gone: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEvent {
    pub id: i64,
    pub at: i64,
    /// added | changed | removed | renamed | dated
    pub kind: String,
    /// atlas_snapshot | claude_backup | claude_edit | file_date
    pub source: String,
    pub summary: String,
    pub item: ItemRef,
    pub from_version: Option<i64>,
    pub to_version: Option<i64>,
    /// A copy of the new side is kept, so a diff can be shown.
    pub has_copy: bool,
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct EventFilter {
    /// Group names: settings, skills, agents, hooks, mcp, instructions, other. Empty = all.
    pub groups: Vec<String>,
    pub project: Option<String>,
    pub text: Option<String>,
    /// `at:event_id` of the last row of the previous page.
    pub cursor: Option<String>,
    pub limit: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EventsPage {
    pub events: Vec<HistoryEvent>,
    pub next: Option<String>,
}

fn like(s: &str) -> String {
    let esc = s.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
    format!("%{esc}%")
}

fn group_sql(groups: &[String], args: &mut Vec<Sql>) -> Option<String> {
    if groups.is_empty() {
        return None;
    }
    let mut parts = Vec::new();
    let mut kinds: Vec<&str> = Vec::new();
    let mut other = false;
    for g in groups {
        if g == "other" {
            other = true;
        } else if let Some(k) = kind_group(g) {
            kinds.extend_from_slice(k);
        }
    }
    if !kinds.is_empty() {
        let q = kinds.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        parts.push(format!("i.kind IN ({q})"));
        args.extend(kinds.iter().map(|k| Sql::Text(k.to_string())));
    }
    if other {
        let q = GROUPED_KINDS.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        parts.push(format!("i.kind NOT IN ({q})"));
        args.extend(GROUPED_KINDS.iter().map(|k| Sql::Text(k.to_string())));
    }
    if parts.is_empty() { None } else { Some(format!("({})", parts.join(" OR "))) }
}

pub fn events(store: &Store, f: &EventFilter) -> Result<EventsPage, String> {
    let limit = f.limit.clamp(1, 100);
    let mut where_ = vec!["1=1".to_string()];
    let mut args: Vec<Sql> = Vec::new();
    if let Some(g) = group_sql(&f.groups, &mut args) {
        where_.push(g);
    }
    if let Some(p) = f.project.as_deref().filter(|p| !p.is_empty()) {
        where_.push("i.project = ?".into());
        args.push(Sql::Text(p.to_string()));
    }
    if let Some(t) = f.text.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        where_.push("(i.name LIKE ? ESCAPE '\\' OR i.path LIKE ? ESCAPE '\\' OR e.summary LIKE ? ESCAPE '\\')".into());
        for _ in 0..3 {
            args.push(Sql::Text(like(t)));
        }
    }
    if let Some((at, id)) = f.cursor.as_deref().and_then(|c| c.split_once(':')).and_then(|(a, b)| Some((a.parse::<i64>().ok()?, b.parse::<i64>().ok()?))) {
        where_.push("(e.at < ? OR (e.at = ? AND e.event_id < ?))".into());
        args.push(Sql::Integer(at));
        args.push(Sql::Integer(at));
        args.push(Sql::Integer(id));
    }
    args.push(Sql::Integer(limit as i64 + 1));
    let sql = format!(
        "SELECT e.event_id,e.at,e.kind,e.source,e.summary,e.from_version,e.to_version,
                i.item_key,i.kind,i.scope,i.project,i.name,i.path,i.gone_at,
                (SELECT sha256 FROM versions v WHERE v.version_id=e.to_version),
                (SELECT session_id FROM versions v WHERE v.version_id=e.to_version)
         FROM events e JOIN items i ON i.item_key=e.item_key
         WHERE {} ORDER BY e.at DESC, e.event_id DESC LIMIT ?",
        where_.join(" AND ")
    );
    let mut rows: Vec<(HistoryEvent, Option<String>)> = store.with(|c| {
        let mut st = c.prepare(&sql)?;
        let it = st.query_map(params_from_iter(args.iter()), |r| {
            let sha: Option<String> = r.get(14)?;
            Ok((
                HistoryEvent {
                    id: r.get(0)?,
                    at: r.get(1)?,
                    kind: r.get(2)?,
                    source: r.get(3)?,
                    summary: r.get(4)?,
                    from_version: r.get(5)?,
                    to_version: r.get(6)?,
                    item: ItemRef { key: r.get(7)?, kind: r.get(8)?, scope: r.get(9)?, project: r.get(10)?, name: r.get(11)?, path: r.get(12)?, gone: r.get::<_, Option<i64>>(13)?.is_some() },
                    has_copy: false,
                    session_id: r.get(15)?,
                },
                sha,
            ))
        })?;
        it.collect::<rusqlite::Result<_>>()
    })?;
    let next = if rows.len() > limit {
        rows.truncate(limit);
        rows.last().map(|(e, _)| format!("{}:{}", e.at, e.id))
    } else {
        None
    };
    let events = rows
        .into_iter()
        .map(|(mut e, sha)| {
            e.has_copy = sha.as_deref().is_some_and(|s| store.has_blob(s));
            e
        })
        .collect();
    Ok(EventsPage { events, next })
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DayCount {
    /// Start of the local day, in ms since the epoch.
    pub day: i64,
    pub count: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    pub items: u32,
    pub versions: u32,
    pub events: u32,
    /// Changes Atlas saw itself (not from Claude's copies or file dates).
    pub watched_events: u32,
    /// When Atlas first looked, 0 when it has not yet.
    pub watching_since: i64,
    pub bytes: u64,
    /// The last 30 local days, oldest first.
    pub days: Vec<DayCount>,
    /// The projects that have anything, for the filter.
    pub projects: Vec<String>,
    pub keep_versions: u32,
}

/// `offset_min` is the viewer's UTC offset in minutes (JavaScript's `-getTimezoneOffset()`).
pub fn overview(store: &Store, now_ms: i64, offset_min: i32, keep_versions: u32) -> Result<Overview, String> {
    let off = offset_min as i64 * 60_000;
    let day_ms = 86_400_000i64;
    let today = (now_ms + off).div_euclid(day_ms) * day_ms - off;
    let first = today - 29 * day_ms;
    let (items, versions, events, watched) = store.with(|c| {
        let n = |sql: &str| c.query_row(sql, [], |r| r.get::<_, i64>(0));
        Ok((n("SELECT COUNT(*) FROM items")?, n("SELECT COUNT(*) FROM versions")?, n("SELECT COUNT(*) FROM events")?, n("SELECT COUNT(*) FROM events WHERE source <> 'file_date'")?))
    })?;
    let rows: Vec<i64> = store.with(|c| {
        let mut st = c.prepare("SELECT at FROM events WHERE at >= ?1 AND source <> 'file_date'")?;
        let it = st.query_map([first], |r| r.get(0))?;
        it.collect::<rusqlite::Result<_>>()
    })?;
    let mut days: Vec<DayCount> = (0..30).map(|i| DayCount { day: first + i * day_ms, count: 0 }).collect();
    for at in rows {
        let idx = (at - first).div_euclid(day_ms);
        if (0..30).contains(&idx) {
            days[idx as usize].count += 1;
        }
    }
    let projects = store.with(|c| {
        let mut st = c.prepare("SELECT DISTINCT i.project FROM items i JOIN events e ON e.item_key=i.item_key WHERE i.project IS NOT NULL ORDER BY i.project")?;
        let it = st.query_map([], |r| r.get::<_, String>(0))?;
        it.collect::<rusqlite::Result<_>>()
    })?;
    let since = store.meta("baseline_at").and_then(|s| s.parse().ok()).unwrap_or(0);
    Ok(Overview { items: items as u32, versions: versions as u32, events: events as u32, watched_events: watched as u32, watching_since: since, bytes: store.disk_bytes(), days, projects, keep_versions })
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VersionRow {
    pub id: i64,
    pub at: i64,
    pub source: String,
    pub bytes: i64,
    pub has_copy: bool,
    pub session_id: Option<String>,
    pub agent_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ItemDetail {
    pub item: ItemRef,
    pub first_seen_at: i64,
    /// Newest first.
    pub versions: Vec<VersionRow>,
    pub events: u32,
}

pub fn item(store: &Store, key: &str) -> Result<Option<ItemDetail>, String> {
    let head = store.with(|c| {
        use rusqlite::OptionalExtension;
        c.query_row("SELECT item_key,kind,scope,project,name,path,gone_at,first_seen_at FROM items WHERE item_key=?1", [key], |r| {
            Ok((ItemRef { key: r.get(0)?, kind: r.get(1)?, scope: r.get(2)?, project: r.get(3)?, name: r.get(4)?, path: r.get(5)?, gone: r.get::<_, Option<i64>>(6)?.is_some() }, r.get::<_, i64>(7)?))
        })
        .optional()
    })?;
    let Some((item, first_seen_at)) = head else { return Ok(None) };
    let raw: Vec<(VersionRow, Option<String>)> = store.with(|c| {
        let mut st = c.prepare(
            "SELECT version_id,COALESCE(observed_mtime,captured_at),source,bytes,session_id,agent_id,sha256 FROM versions
             WHERE item_key=?1 ORDER BY COALESCE(observed_mtime,captured_at) DESC, version_id DESC LIMIT 400",
        )?;
        let it = st.query_map([key], |r| {
            Ok((VersionRow { id: r.get(0)?, at: r.get(1)?, source: r.get(2)?, bytes: r.get(3)?, session_id: r.get(4)?, agent_id: r.get(5)?, has_copy: false }, r.get::<_, Option<String>>(6)?))
        })?;
        it.collect::<rusqlite::Result<_>>()
    })?;
    let versions = raw
        .into_iter()
        .map(|(mut v, sha)| {
            v.has_copy = sha.as_deref().is_some_and(|s| store.has_blob(s));
            v
        })
        .collect();
    let events = store.with(|c| c.query_row("SELECT COUNT(*) FROM events WHERE item_key=?1", [key], |r| r.get::<_, i64>(0)))? as u32;
    Ok(Some(ItemDetail { item, first_seen_at, versions, events }))
}

struct Ver {
    item_key: String,
    path: String,
    sha: Option<String>,
    at: i64,
}

fn version(store: &Store, id: i64) -> Result<Option<Ver>, String> {
    store.with(|c| {
        use rusqlite::OptionalExtension;
        c.query_row(
            "SELECT v.item_key,i.path,v.sha256,COALESCE(v.observed_mtime,v.captured_at) FROM versions v JOIN items i ON i.item_key=v.item_key WHERE v.version_id=?1",
            [id],
            |r| Ok(Ver { item_key: r.get(0)?, path: r.get(1)?, sha: r.get(2)?, at: r.get(3)? }),
        )
        .optional()
    })
}

fn text_of(store: &Store, sha: Option<&str>) -> Option<String> {
    sha.and_then(|s| store.read_blob(s)).map(|b| String::from_utf8_lossy(&b).into_owned())
}

/// What a version is compared against.
#[derive(Debug, Clone)]
pub enum Against {
    /// The copy just before it (what changed in this version).
    Previous,
    Version(i64),
    /// The file as it is now.
    Current,
}

pub fn compare(store: &Store, version_id: i64, against: Against, context: usize) -> Result<Diff, String> {
    let Some(v) = version(store, version_id)? else { return Ok(Diff::note("missing", "That copy is no longer kept.")) };
    let Some(new) = text_of(store, v.sha.as_deref()) else { return Ok(Diff::note(if v.sha.is_some() { "tooLarge" } else { "missing" }, "Atlas didn't keep a readable copy of this one (too big, not text, or cleared).")) };
    let path = if v.item_key == MCP_KEY { "mcp.json".to_string() } else { v.path.clone() };
    let old = match against {
        Against::Previous => {
            let prev = store.with(|c| super::store::version_before(c, &v.item_key, v.at, version_id))?;
            match prev {
                Some((_, sha)) => match text_of(store, sha.as_deref()) {
                    Some(t) => t,
                    None => return Ok(Diff::note("missing", "The copy before this one is no longer kept.")),
                },
                None => String::new(),
            }
        }
        Against::Version(other) => {
            let Some(o) = version(store, other)? else { return Ok(Diff::note("missing", "That copy is no longer kept.")) };
            match text_of(store, o.sha.as_deref()) {
                Some(t) => t,
                None => return Ok(Diff::note("missing", "That copy is no longer kept.")),
            }
        }
        Against::Current => {
            // Older on the left, now on the right: "what changed since this copy".
            let cur = if v.item_key == MCP_KEY {
                let latest = store.with(|c| {
                    use rusqlite::OptionalExtension;
                    c.query_row("SELECT sha256 FROM versions WHERE item_key=?1 AND source='atlas_snapshot' ORDER BY version_id DESC LIMIT 1", [MCP_KEY], |r| r.get::<_, Option<String>>(0)).optional()
                })?;
                match text_of(store, latest.flatten().as_deref()) {
                    Some(t) => t,
                    None => return Ok(Diff::note("missing", "There is no current copy to compare with.")),
                }
            } else {
                let p = Path::new(&v.path);
                let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                if crate::layout::is_denied_name(&name) {
                    return Ok(Diff::note("missing", "That file isn't opened."));
                }
                match fs::metadata(p) {
                    Ok(m) if m.is_file() && m.len() <= super::scan::MAX_COPY => match fs::read(p) {
                        Ok(b) if !b.iter().take(8192).any(|x| *x == 0) => String::from_utf8_lossy(&b).into_owned(),
                        _ => return Ok(Diff::note("binary", "The file as it is now can't be shown as text.")),
                    },
                    Ok(_) => return Ok(Diff::note("tooLarge", "The file as it is now is too big to compare.")),
                    Err(_) => return Ok(Diff::note("missing", "The file isn't there any more.")),
                }
            };
            return Ok(diff::compare(&path, &new, &cur, context));
        }
    };
    // Older on the left, newer on the right: the picked copy is the newer side.
    Ok(diff::compare(&path, &old, &new, context))
}

/// The text of a version with secrets masked (what a copy to the clipboard or a file holds).
pub fn copy_text(store: &Store, version_id: i64) -> Result<String, String> {
    let Some(v) = version(store, version_id)? else { return Err("That copy is no longer kept.".into()) };
    let Some(text) = text_of(store, v.sha.as_deref()) else { return Err("That copy is no longer kept.".into()) };
    let json = v.path.to_ascii_lowercase().ends_with(".json") || v.item_key == MCP_KEY;
    Ok(if json { secrets::mask_json(&text).text } else { secrets::mask_plain(&text).text })
}

/// The item a version belongs to and the name to offer when saving a copy.
pub fn suggested_name(store: &Store, version_id: i64) -> Result<String, String> {
    let Some(v) = version(store, version_id)? else { return Err("That copy is no longer kept.".into()) };
    if v.item_key == MCP_KEY {
        return Ok("mcp-servers.json".into());
    }
    let name = Path::new(&v.path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "copy.txt".into());
    Ok(name)
}
