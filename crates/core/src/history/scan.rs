//! Looking at the tracked files and recording what changed since last time.
//!
//! The first pass is the baseline: every file is stored once and dated by its modified time
//! ("before Atlas was watching"). Later passes only re-read a file whose size or modified
//! time moved, store a new copy when the contents really differ, and pair a file that
//! vanished with one that appeared with the same contents as a rename.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::Path;

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use super::diff;
use super::marks::Marks;
use super::store::{self, source, ItemState, NewEvent, NewVersion, Store};
use super::{Tracked, MCP_KEY};
use crate::setup::secrets;

/// Text files up to this size keep a readable copy; anything larger is tracked by hash only.
pub const MAX_COPY: u64 = 1024 * 1024;

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ScanReport {
    pub baseline: bool,
    pub items: usize,
    pub added: usize,
    pub changed: usize,
    pub removed: usize,
    pub renamed: usize,
    /// Rows that got a Library install's sentence after they were made.
    pub relabeled: usize,
}

impl ScanReport {
    pub fn is_empty(&self) -> bool {
        self.added + self.changed + self.removed + self.renamed + self.relabeled == 0 && !self.baseline
    }
}

pub fn mtime_ms(m: &fs::Metadata) -> i64 {
    m.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// What reading a file gave: its hash, size, and the text when a copy is kept.
pub struct Read_ {
    pub sha: String,
    pub len: u64,
    pub bytes: Option<Vec<u8>>,
}

/// Read `path` for keeping: a hash always, the bytes only for small text files.
pub fn read_for_history(path: &Path) -> std::io::Result<Read_> {
    let mut f = fs::File::open(path)?;
    let len = f.metadata()?.len();
    if len <= MAX_COPY {
        let mut buf = Vec::with_capacity(len as usize);
        (&mut f).take(MAX_COPY + 1).read_to_end(&mut buf)?;
        let binary = buf.iter().take(8192).any(|b| *b == 0);
        let sha = store::sha_hex(&buf);
        let len = buf.len() as u64;
        return Ok(Read_ { sha, len, bytes: if binary { None } else { Some(buf) } });
    }
    let mut h = Sha256::new();
    let mut chunk = vec![0u8; 64 * 1024];
    loop {
        let n = f.read(&mut chunk)?;
        if n == 0 {
            break;
        }
        h.update(&chunk[..n]);
    }
    Ok(Read_ { sha: store::hex(&h.finalize()), len, bytes: None })
}

// ---------------------------------------------------------------- the MCP view

fn sorted(v: &Value) -> Value {
    match v {
        Value::Object(m) => {
            let mut keys: Vec<&String> = m.keys().collect();
            keys.sort();
            let mut out = Map::new();
            for k in keys {
                out.insert(k.clone(), sorted(&m[k]));
            }
            Value::Object(out)
        }
        Value::Array(a) => Value::Array(a.iter().map(sorted).collect()),
        other => other.clone(),
    }
}

/// The MCP part of `.claude.json` and nothing else (it also holds the account, caches and every
/// project's chat history), with secret values masked. `None` when the text isn't usable JSON
/// or has no MCP data at all.
pub fn mcp_view(text: &str) -> Option<String> {
    let v: Value = serde_json::from_str(text.strip_prefix('\u{feff}').unwrap_or(text)).ok()?;
    let mut out = Map::new();
    if let Some(m) = v.get("mcpServers").filter(|m| m.as_object().is_some_and(|o| !o.is_empty())) {
        out.insert("mcpServers".into(), m.clone());
    }
    let mut projects = Map::new();
    if let Some(Value::Object(ps)) = v.get("projects") {
        for (path, p) in ps {
            let mut keep = Map::new();
            for f in ["mcpServers", "disabledMcpServers", "enabledMcpServers", "enabledMcpjsonServers", "disabledMcpjsonServers"] {
                match p.get(f) {
                    Some(Value::Object(o)) if o.is_empty() => {}
                    Some(Value::Array(a)) if a.is_empty() => {}
                    Some(x) => {
                        keep.insert(f.into(), x.clone());
                    }
                    None => {}
                }
            }
            if !keep.is_empty() {
                projects.insert(path.clone(), Value::Object(keep));
            }
        }
    }
    if !projects.is_empty() {
        out.insert("projects".into(), Value::Object(projects));
    }
    if out.is_empty() {
        return None;
    }
    let text = serde_json::to_string_pretty(&sorted(&Value::Object(out))).ok()?;
    Some(secrets::mask_json(&text).text)
}

// ---------------------------------------------------------------- scanning

struct Seen<'a> {
    t: &'a Tracked,
    mtime: i64,
    size: i64,
    sha: String,
    bytes: Option<Vec<u8>>,
}

fn blob_for(store: &Store, bytes: &Option<Vec<u8>>) -> Result<(), String> {
    if let Some(b) = bytes {
        store.put_blob(b).map_err(|e| format!("A copy could not be kept ({e})."))?;
    }
    Ok(())
}

fn text_of(bytes: &Option<Vec<u8>>) -> Option<String> {
    bytes.as_ref().map(|b| String::from_utf8_lossy(b).into_owned())
}

/// One pass. `claude_json` is the global state file, read only for its MCP part.
pub fn scan(store: &Store, tracked: &[Tracked], claude_json: Option<&Path>, now_ms: i64) -> Result<ScanReport, String> {
    scan_marked(store, tracked, claude_json, now_ms, &Marks::default())
}

/// `scan`, with `marks` saying which changes Claude made through the MCP server or the
/// assistant, so their rows say so.
pub fn scan_marked(store: &Store, tracked: &[Tracked], claude_json: Option<&Path>, now_ms: i64, marks: &Marks) -> Result<ScanReport, String> {
    let known = store.items()?;
    let baseline = store.meta("baseline_at").is_none();
    let mut report = ScanReport { baseline, ..Default::default() };

    // 1. Look at the files (no lock held).
    let mut seen: Vec<Seen> = Vec::new();
    let mut touched: Vec<(&Tracked, i64, i64)> = Vec::new(); // same bytes, new stat
    let tracked_keys: HashSet<&str> = tracked.iter().map(|t| t.key.as_str()).collect();
    for t in tracked {
        let Ok(meta) = fs::metadata(&t.path) else { continue };
        if !meta.is_file() {
            continue;
        }
        let (mtime, size) = (mtime_ms(&meta), meta.len() as i64);
        let st = known.get(&t.key);
        if let Some(s) = st
            && s.gone_at.is_none()
            && s.last_sha.is_some()
            && s.last_size == size
            && s.last_mtime == mtime
        {
            continue;
        }
        let Ok(r) = read_for_history(&t.path) else { continue };
        if let Some(s) = st
            && s.gone_at.is_none()
            && s.last_sha.as_deref() == Some(r.sha.as_str())
        {
            touched.push((t, mtime, size));
            continue;
        }
        seen.push(Seen { t, mtime, size: r.len as i64, sha: r.sha, bytes: r.bytes });
    }

    // 2. The MCP view.
    let mcp = mcp_pass(store, &known, claude_json)?;

    // 3. What disappeared (a file that is really gone, not just missing from the list).
    let mut gone: Vec<&ItemState> = known
        .values()
        .filter(|s| s.gone_at.is_none() && s.item_key != MCP_KEY && !tracked_keys.contains(s.item_key.as_str()) && !Path::new(&s.path).exists())
        .collect();
    if tracked.is_empty() {
        gone.clear(); // a failed discovery is not a deletion
    }
    gone.sort_by(|a, b| a.item_key.cmp(&b.item_key));

    for s in &seen {
        blob_for(store, &s.bytes)?;
    }
    if let Some(m) = &mcp {
        blob_for(store, &Some(m.text.clone().into_bytes()))?;
    }

    // 4. Write it all in one transaction.
    let at_of = |mtime: i64| if mtime > 0 && mtime <= now_ms { mtime } else { now_ms };
    store.tx(|tx| {
        for (t, mtime, size) in &touched {
            store::set_stat(tx, &t.key, known.get(&t.key).and_then(|s| s.last_sha.as_deref()), *size, *mtime)?;
        }
        let mut renamed_from: HashSet<String> = HashSet::new();
        let mut gone_by_sha: HashMap<&str, Vec<&ItemState>> = HashMap::new();
        for g in &gone {
            if let Some(sha) = g.last_sha.as_deref() {
                gone_by_sha.entry(sha).or_default().push(g);
            }
        }
        for s in &seen {
            let t = s.t;
            store::upsert_item(tx, &t.key, &t.kind, &t.scope, t.project.as_deref(), &t.name, &norm_display(&t.path), now_ms)?;
            let prev = known.get(&t.key);
            let first_time = prev.is_none();
            let came_back = prev.is_some_and(|p| p.gone_at.is_some());
            let old_text = prev.and_then(|p| p.last_sha.as_deref()).and_then(|sha| store.read_blob(sha)).map(|b| String::from_utf8_lossy(&b).into_owned());
            // A change Claude made through Atlas's own server says so; the baseline never does.
            let by = if baseline { None } else { marks.version(&t.key, &s.sha) };
            let src = by.unwrap_or(source::SNAPSHOT);
            let vid = store::add_version(
                tx,
                &NewVersion { item_key: &t.key, sha: Some(&s.sha), bytes: s.size, captured_at: now_ms, observed_mtime: s.mtime, source: src, origin_ref: None, session_id: None, agent_id: None },
            )?;
            store::set_stat(tx, &t.key, Some(&s.sha), s.size, s.mtime)?;
            let to = vid;
            if first_time && baseline {
                store::add_event(tx, &NewEvent { item_key: &t.key, at: at_of(s.mtime), kind: "dated", from_version: None, to_version: to, source: source::DATE, summary: "Last changed here." })?;
                report.items += 1;
                continue;
            }
            if first_time || came_back {
                // A rename: the same contents just left another path.
                let mate = gone_by_sha.get_mut(s.sha.as_str()).and_then(|v| if v.is_empty() { None } else { Some(v.remove(0)) });
                if let Some(m) = mate {
                    renamed_from.insert(m.item_key.clone());
                    store::set_gone(tx, &m.item_key, now_ms)?;
                    let summary = format!("Renamed from {}.", m.name);
                    store::add_event(tx, &NewEvent { item_key: &t.key, at: now_ms, kind: "renamed", from_version: m.last_version, to_version: to, source: src, summary: &summary })?;
                    report.renamed += 1;
                } else {
                    store::add_event(tx, &NewEvent { item_key: &t.key, at: at_of(s.mtime), kind: "added", from_version: None, to_version: to, source: src, summary: "New." })?;
                    report.added += 1;
                }
                report.items += 1;
                continue;
            }
            let new_text = text_of(&s.bytes);
            // A Library install or removal says so in plain words instead of the raw diff.
            let label = if baseline { None } else { marks.label(&t.key, &s.sha, at_of(s.mtime)) };
            let summary = match (&old_text, &new_text) {
                _ if label.is_some() => label.unwrap_or_default().to_string(),
                (Some(o), Some(n)) => diff::one_line(&t.path.to_string_lossy(), Some(o), n),
                _ => "Changed.".to_string(),
            };
            store::add_event(tx, &NewEvent { item_key: &t.key, at: at_of(s.mtime), kind: "changed", from_version: prev.and_then(|p| p.last_version), to_version: to, source: src, summary: &summary })?;
            report.changed += 1;
        }
        for g in &gone {
            if renamed_from.contains(&g.item_key) {
                continue;
            }
            store::set_gone(tx, &g.item_key, now_ms)?;
            let src = marks.removal(&g.item_key).unwrap_or(source::SNAPSHOT);
            store::add_event(tx, &NewEvent { item_key: &g.item_key, at: now_ms, kind: "removed", from_version: g.last_version, to_version: None, source: src, summary: "Removed." })?;
            report.removed += 1;
        }
        if let Some(m) = &mcp {
            mcp_write(tx, store, &known, m, now_ms, baseline, marks, &mut report)?;
        }
        if baseline {
            tx.execute("INSERT INTO meta(key,value) VALUES('baseline_at',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [now_ms.to_string()])?;
        }
        Ok(())
    })?;
    // A real install takes seconds: the watcher saw the files change before the backup was tagged
    // with its sentence, so rows made earlier get it now.
    report.relabeled = relabel(store, marks, now_ms)?;
    Ok(report)
}

/// Give the rows of recent Library installs and removals their plain sentence and source, however
/// early the row was made. Idempotent: a row that already has it is left alone.
fn relabel(store: &Store, marks: &Marks, now_ms: i64) -> Result<usize, String> {
    if !marks.has_library() {
        return Ok(0);
    }
    let since = now_ms - 25 * 60 * 60 * 1000;
    store.tx(|tx| {
        type Row = (i64, String, i64, String, String, String, Option<String>, Option<i64>, String, String);
        let rows: Vec<Row> = {
            let mut st = tx.prepare(
                "SELECT e.event_id, e.item_key, e.at, e.kind, e.source, e.summary, v.sha256, v.version_id, i.kind, i.name
                 FROM events e JOIN items i ON i.item_key = e.item_key LEFT JOIN versions v ON v.version_id = e.to_version
                 WHERE e.at >= ?1 AND e.kind IN ('changed','added','removed')",
            )?;
            let it = st.query_map([since], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?, r.get(9)?)))?;
            it.collect::<Result<_, _>>()?
        };
        let mut n = 0;
        for (id, key, at, kind, src, summary, sha, vid, ikind, name) in rows {
            let label = match kind.as_str() {
                "changed" => sha.as_deref().and_then(|s| marks.label(&key, s, at)),
                "added" if ikind == "plugin" => marks.plugin_label(&name, "install", at),
                "removed" if ikind == "plugin" => marks.plugin_label(&name, "uninstall", at),
                _ => None,
            };
            let Some(label) = label else { continue };
            if summary == label && src == super::marks::SOURCE_LIBRARY {
                continue;
            }
            tx.execute("UPDATE events SET summary = ?2, source = ?3 WHERE event_id = ?1", rusqlite::params![id, label, super::marks::SOURCE_LIBRARY])?;
            if let Some(v) = vid {
                tx.execute("UPDATE versions SET source = ?2 WHERE version_id = ?1 AND origin_ref IS NULL", rusqlite::params![v, super::marks::SOURCE_LIBRARY])?;
            }
            n += 1;
        }
        Ok(n)
    })
}

fn norm_display(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

struct McpSeen {
    text: String,
    sha: String,
    size: i64,
    mtime: i64,
    stat_only: bool,
}

/// Look at `.claude.json` (only when its size or time moved) and reduce it to the MCP view.
fn mcp_pass(store: &Store, known: &HashMap<String, ItemState>, claude_json: Option<&Path>) -> Result<Option<McpSeen>, String> {
    let Some(p) = claude_json else { return Ok(None) };
    let Ok(meta) = fs::metadata(p) else { return Ok(None) };
    let (mtime, size) = (mtime_ms(&meta), meta.len() as i64);
    if let Some(s) = known.get(MCP_KEY)
        && s.last_size == size
        && s.last_mtime == mtime
        && s.last_sha.is_some()
    {
        return Ok(None);
    }
    if meta.len() > 64 * 1024 * 1024 {
        return Ok(None);
    }
    let Ok(raw) = fs::read(p) else { return Ok(None) };
    let _ = store;
    let Some(text) = mcp_view(&String::from_utf8_lossy(&raw)) else { return Ok(None) };
    let sha = store::sha_hex(text.as_bytes());
    let same = known.get(MCP_KEY).and_then(|s| s.last_sha.as_deref()) == Some(sha.as_str());
    Ok(Some(McpSeen { text, sha, size, mtime, stat_only: same }))
}

/// When the only difference between two MCP views is Atlas's own `atlas` server (it was
/// connected, disconnected or re-pointed), say so in those words.
fn atlas_connection_summary(old: Option<&str>, new: &str) -> Option<&'static str> {
    let parse = |t: &str| serde_json::from_str::<Value>(t).ok();
    let split = |v: Value| -> Option<(Option<Value>, Value)> {
        let mut v = v;
        let mine = v.get_mut("mcpServers").and_then(Value::as_object_mut).and_then(|m| m.shift_remove("atlas"));
        if v.get("mcpServers").and_then(Value::as_object).is_some_and(|m| m.is_empty()) {
            v.as_object_mut()?.remove("mcpServers");
        }
        Some((mine, v))
    };
    let (new_mine, new_rest) = split(parse(new)?)?;
    let (old_mine, old_rest) = match old {
        Some(o) => split(parse(o)?)?,
        None => (None, Value::Object(Map::new())),
    };
    if old_rest != new_rest {
        return None;
    }
    match (old_mine, new_mine) {
        (None, Some(_)) => Some("Connected Atlas to Claude Code."),
        (Some(_), None) => Some("Disconnected Atlas from Claude Code."),
        (Some(a), Some(b)) if a != b => Some("Pointed the Atlas connection at this copy of Atlas."),
        _ => None,
    }
}

#[allow(clippy::too_many_arguments)]
fn mcp_write(tx: &rusqlite::Transaction, store: &Store, known: &HashMap<String, ItemState>, m: &McpSeen, now: i64, baseline: bool, marks: &Marks, report: &mut ScanReport) -> rusqlite::Result<()> {
    if m.stat_only {
        return store::set_stat(tx, MCP_KEY, Some(&m.sha), m.size, m.mtime);
    }
    store::upsert_item(tx, MCP_KEY, "mcpServer", "user", None, "MCP servers", "", now)?;
    let prev = known.get(MCP_KEY);
    let old_text = prev.and_then(|p| p.last_sha.as_deref()).and_then(|s| store.read_blob(s)).map(|b| String::from_utf8_lossy(&b).into_owned());
    let src = if baseline { source::SNAPSHOT } else { marks.claude_json_recent(now).unwrap_or(source::SNAPSHOT) };
    let vid = store::add_version(
        tx,
        &NewVersion { item_key: MCP_KEY, sha: Some(&m.sha), bytes: m.text.len() as i64, captured_at: now, observed_mtime: m.mtime, source: src, origin_ref: None, session_id: None, agent_id: None },
    )?;
    store::set_stat(tx, MCP_KEY, Some(&m.sha), m.size, m.mtime)?;
    let at = if m.mtime > 0 && m.mtime <= now { m.mtime } else { now };
    match prev {
        None if baseline => {
            store::add_event(tx, &NewEvent { item_key: MCP_KEY, at, kind: "dated", from_version: None, to_version: vid, source: source::DATE, summary: "Last changed here." })?;
            report.items += 1;
        }
        None => {
            let summary = atlas_connection_summary(None, &m.text).unwrap_or("New.");
            store::add_event(tx, &NewEvent { item_key: MCP_KEY, at: now, kind: "added", from_version: None, to_version: vid, source: src, summary })?;
            report.added += 1;
        }
        Some(p) => {
            let summary = match &old_text {
                Some(o) => atlas_connection_summary(Some(o), &m.text).map(str::to_string).unwrap_or_else(|| diff::one_line("mcp.json", Some(o), &m.text)),
                None => "Changed.".to_string(),
            };
            store::add_event(tx, &NewEvent { item_key: MCP_KEY, at: now, kind: "changed", from_version: p.last_version, to_version: vid, source: src, summary: &summary })?;
            report.changed += 1;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------- pruning

/// Keep the newest `keep` versions of each item (always the first one too). Events stay; they
/// just lose the pointer to a copy that is gone. Copies nothing refers to are deleted.
/// Returns (versions dropped, bytes freed).
pub fn prune(store: &Store, keep: usize) -> Result<(usize, u64), String> {
    let keep = keep.max(2) as i64;
    let dropped = store.tx(|tx| {
        let ids: Vec<i64> = {
            let mut st = tx.prepare(
                "SELECT version_id FROM (
                   SELECT version_id,
                          ROW_NUMBER() OVER (PARTITION BY item_key ORDER BY COALESCE(observed_mtime,captured_at) DESC, version_id DESC) AS rn,
                          ROW_NUMBER() OVER (PARTITION BY item_key ORDER BY version_id ASC) AS first_rn
                   FROM versions) WHERE rn > ?1 AND first_rn > 1",
            )?;
            let rows = st.query_map([keep], |r| r.get(0))?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        for id in &ids {
            tx.execute("UPDATE events SET from_version=NULL WHERE from_version=?1", [id])?;
            tx.execute("UPDATE events SET to_version=NULL WHERE to_version=?1", [id])?;
            tx.execute("DELETE FROM versions WHERE version_id=?1", [id])?;
        }
        Ok(ids.len())
    })?;
    if dropped == 0 {
        return Ok((0, 0));
    }
    let live: HashSet<String> = store.with(|c| {
        let mut st = c.prepare("SELECT DISTINCT sha256 FROM versions WHERE sha256 IS NOT NULL")?;
        let rows = st.query_map([], |r| r.get::<_, String>(0))?;
        rows.collect::<rusqlite::Result<_>>()
    })?;
    let mut freed = 0u64;
    let blobs = store.dir().join("blobs");
    if let Ok(top) = fs::read_dir(&blobs) {
        for d in top.flatten() {
            let Ok(inner) = fs::read_dir(d.path()) else { continue };
            for f in inner.flatten() {
                let name = f.file_name().to_string_lossy().into_owned();
                if !live.contains(&name)
                    && let Ok(m) = f.metadata()
                    && fs::remove_file(f.path()).is_ok()
                {
                    freed += m.len();
                }
            }
        }
    }
    Ok((dropped, freed))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_plugins_own_rows_get_the_install_and_removal_sentences_late() {
        // Verifier V4: "Plugin added fd@mk" was written while the install still ran.
        let t = tempfile::tempdir().unwrap();
        let store = Store::open(t.path()).unwrap();
        let k = "f:C:/c/plugins/cache/mk/fd/1/.claude-plugin/plugin.json";
        store
            .tx(|tx| {
                store::upsert_item(tx, k, "plugin", "user", None, "fd@mk", "C:/c/plugins/cache/mk/fd/1/.claude-plugin/plugin.json", 1)?;
                store::add_event(tx, &NewEvent { item_key: k, at: 10_000, kind: "added", from_version: None, to_version: None, source: source::SNAPSHOT, summary: "New." })?;
                store::add_event(tx, &NewEvent { item_key: k, at: 50_000, kind: "removed", from_version: None, to_version: None, source: source::SNAPSHOT, summary: "Removed." })?;
                // A plugin of another name, and a row from long after the install, are left alone.
                store::upsert_item(tx, "f:other", "plugin", "user", None, "other@mk", "C:/o", 1)?;
                store::add_event(tx, &NewEvent { item_key: "f:other", at: 10_500, kind: "added", from_version: None, to_version: None, source: source::SNAPSHOT, summary: "New." })?;
                store::add_event(tx, &NewEvent { item_key: k, at: 10_000 + 2 * 60 * 60 * 1000, kind: "added", from_version: None, to_version: None, source: source::SNAPSHOT, summary: "New." })?;
                Ok(())
            })
            .unwrap();
        let marks = Marks::default().with_plugin_op("fd@mk", "install", 9_000, "Installed fd from the Library").with_plugin_op("fd@mk", "uninstall", 49_000, "Uninstalled fd from the Library");
        let now = 20_000 + 3 * 60 * 60 * 1000;
        assert_eq!(relabel(&store, &marks, now).unwrap(), 2);
        let rows: Vec<(i64, String, String)> = store
            .with(|c| {
                let mut st = c.prepare("SELECT at, source, summary FROM events ORDER BY event_id")?;
                let it = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
                it.collect::<rusqlite::Result<_>>()
            })
            .unwrap();
        assert_eq!(rows[0], (10_000, "atlas_library".into(), "Installed fd from the Library".into()));
        assert_eq!(rows[1], (50_000, "atlas_library".into(), "Uninstalled fd from the Library".into()));
        assert_eq!(rows[2].2, "New.", "another plugin is not this install");
        assert_eq!(rows[3].1, "atlas_snapshot", "a row long after the install is not part of it");
        assert_eq!(relabel(&store, &marks, now).unwrap(), 0, "a second look changes nothing");
    }
}
