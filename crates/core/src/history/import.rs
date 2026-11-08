//! Reading the copies Claude Code leaves behind, so History has a past from day one.
//!
//! - `.claude.json` backups (`<config>/backups/.claude.json.backup.<ms>`, `<file>.backup`,
//!   `<file>.bak-*`) become older versions of the MCP view.
//! - `file-history/<session>/<hash>@vN` copies, named by the `file-history-snapshot` lines
//!   inside the transcripts, become older versions of the tracked file they belong to.
//!
//! Everything is read-only here and idempotent: each version records where it came from
//! (`origin_ref`), and a second pass finds it already stored.

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use memchr::memmem;
use rusqlite::OptionalExtension;
use serde_json::Value;

use super::diff;
use super::scan::{mcp_view, mtime_ms, MAX_COPY};
use super::store::{self, source, NewEvent, NewVersion, Store};
use super::{norm_path, Tracked, MCP_KEY};

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ImportReport {
    pub backups: usize,
    pub edits: usize,
}

fn parse_time(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s).ok().map(|d| d.timestamp_millis())
}

/// Add one imported version and, when it differs from what came just before it in time, an event.
#[allow(clippy::too_many_arguments)]
fn add_imported(store: &Store, key: &str, bytes: &[u8], text_for_diff: &str, diff_path: &str, at: i64, src: &str, origin: &str, session: Option<&str>, agent: Option<&str>, now: i64) -> Result<bool, String> {
    let sha = store.put_blob(bytes).map_err(|e| format!("A copy could not be kept ({e})."))?;
    let added = store.tx(|tx| {
        let vid = store::add_version(
            tx,
            &NewVersion { item_key: key, sha: Some(&sha), bytes: bytes.len() as i64, captured_at: now, observed_mtime: at, source: src, origin_ref: Some(origin), session_id: session, agent_id: agent },
        )?;
        let Some(vid) = vid else { return Ok(false) };
        let prev = store::version_before(tx, key, at, vid)?;
        if let Some((pid, psha)) = prev
            && psha.as_deref() != Some(sha.as_str())
        {
            let old = psha.as_deref().and_then(|s| store.read_blob(s)).map(|b| String::from_utf8_lossy(&b).into_owned());
            let summary = match old {
                Some(o) => diff::one_line(diff_path, Some(&o), text_for_diff),
                None => "Changed.".into(),
            };
            store::add_event(tx, &NewEvent { item_key: key, at, kind: "changed", from_version: Some(pid), to_version: Some(vid), source: src, summary: &summary })?;
        }
        Ok(true)
    })?;
    Ok(added)
}

fn already(store: &Store, key: &str, src: &str, origin: &str) -> bool {
    store
        .with(|c| c.query_row("SELECT 1 FROM versions WHERE item_key=?1 AND source=?2 AND origin_ref=?3", rusqlite::params![key, src, origin], |_| Ok(())).optional())
        .ok()
        .flatten()
        .is_some()
}

// ---------------------------------------------------------------- .claude.json backups

fn backup_files(config_dir: &Path, claude_json: &Path) -> Vec<(PathBuf, String, i64)> {
    let mut out = Vec::new();
    if let Ok(rd) = fs::read_dir(config_dir.join("backups")) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if let Some(ms) = name.strip_prefix(".claude.json.backup.") {
                let t = ms.parse::<i64>().ok().filter(|n| *n > 1_000_000_000_000).or_else(|| e.metadata().ok().map(|m| mtime_ms(&m))).unwrap_or(0);
                out.push((e.path(), format!("backups/{name}"), t));
            }
        }
    }
    if let (Some(dir), Some(base)) = (claude_json.parent(), claude_json.file_name().map(|n| n.to_string_lossy().into_owned()))
        && let Ok(rd) = fs::read_dir(dir)
    {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if name == format!("{base}.backup") || name.starts_with(&format!("{base}.bak-")) {
                let t = e.metadata().ok().map(|m| mtime_ms(&m)).unwrap_or(0);
                out.push((e.path(), name.clone(), t));
            }
        }
    }
    out.sort_by_key(|(_, _, t)| *t);
    out
}

/// Older versions of the MCP view, from Claude Code's own `.claude.json` copies.
pub fn import_backups(store: &Store, config_dir: &Path, claude_json: &Path, now: i64) -> Result<usize, String> {
    let mut n = 0;
    if store.meta("baseline_at").is_none() {
        return Ok(0);
    }
    for (path, origin, t) in backup_files(config_dir, claude_json) {
        if already(store, MCP_KEY, source::BACKUP, &origin) {
            continue;
        }
        let Ok(meta) = fs::metadata(&path) else { continue };
        if meta.len() > 64 * 1024 * 1024 {
            continue;
        }
        let Ok(raw) = fs::read(&path) else { continue };
        let Some(view) = mcp_view(&String::from_utf8_lossy(&raw)) else { continue };
        store.tx(|tx| store::upsert_item(tx, MCP_KEY, "mcpServer", "user", None, "MCP servers", "", now))?;
        // Identical views collapse: only a view that differs from the one before it is kept.
        let sha = store::sha_hex(view.as_bytes());
        let prev = store.with(|c| store::version_before(c, MCP_KEY, t, -1))?;
        if prev.as_ref().and_then(|(_, s)| s.as_deref()) == Some(sha.as_str()) {
            // Remember we looked, without a version, so the next pass skips the read.
            let _ = store.set_meta(&format!("seen:{origin}"), "same");
            continue;
        }
        if store.meta(&format!("seen:{origin}")).is_some() {
            continue;
        }
        if add_imported(store, MCP_KEY, view.as_bytes(), &view, "mcp.json", t, source::BACKUP, &origin, None, None, now)? {
            n += 1;
        }
    }
    Ok(n)
}

// ---------------------------------------------------------------- file-history copies

struct Snap {
    path: PathBuf,
    backup: String,
    at: i64,
}

fn snapshot_entries(line: &[u8]) -> Vec<Snap> {
    let Ok(v) = serde_json::from_slice::<Value>(line) else { return Vec::new() };
    if v.get("type").and_then(Value::as_str) != Some("file-history-snapshot") {
        return Vec::new();
    }
    let Some(Value::Object(m)) = v.pointer("/snapshot/trackedFileBackups") else { return Vec::new() };
    let mut out = Vec::new();
    for (key, b) in m {
        let Some(name) = b.get("backupFileName").and_then(Value::as_str) else { continue };
        let at = b.get("backupTime").and_then(Value::as_str).and_then(parse_time).unwrap_or(0);
        let path = match b.get("realParentDir").and_then(Value::as_str) {
            Some(dir) => Path::new(dir).join(key),
            None if Path::new(key).is_absolute() => PathBuf::from(key),
            None => continue,
        };
        out.push(Snap { path, backup: name.to_string(), at });
    }
    out
}

/// `<projects>/*/<session>.jsonl` and `<projects>/*/<session>/subagents/agent-*.jsonl`.
fn transcripts(projects_dir: &Path) -> Vec<(PathBuf, String, Option<String>)> {
    let mut out = Vec::new();
    let Ok(rd) = fs::read_dir(projects_dir) else { return out };
    for proj in rd.flatten() {
        let Ok(files) = fs::read_dir(proj.path()) else { continue };
        for f in files.flatten() {
            let p = f.path();
            let name = f.file_name().to_string_lossy().into_owned();
            if let Some(sid) = name.strip_suffix(".jsonl") {
                out.push((p, sid.to_string(), None));
            } else if p.is_dir() {
                let Ok(subs) = fs::read_dir(p.join("subagents")) else { continue };
                for s in subs.flatten() {
                    let sn = s.file_name().to_string_lossy().into_owned();
                    if let Some(agent) = sn.strip_suffix(".jsonl").and_then(|a| a.strip_prefix("agent-")) {
                        out.push((s.path(), name.clone(), Some(agent.to_string())));
                    }
                }
            }
        }
    }
    out
}

/// Older versions of tracked files from Claude Code's `file-history/` copies.
pub fn import_file_history(store: &Store, config_dir: &Path, projects_dir: &Path, tracked: &[Tracked], now: i64) -> Result<usize, String> {
    if tracked.is_empty() || store.meta("baseline_at").is_none() {
        return Ok(0);
    }
    let by_path: HashMap<String, &Tracked> = tracked.iter().map(|t| (norm_path(&t.path).to_lowercase(), t)).collect();
    let finder = memmem::Finder::new(b"file-history-snapshot");
    let history = config_dir.join("file-history");
    let mut n = 0;
    let mut line = Vec::new();
    for (path, sid, agent) in transcripts(projects_dir) {
        let Ok(meta) = fs::metadata(&path) else { continue };
        let stamp = format!("{}:{}", meta.len(), mtime_ms(&meta));
        let marker = format!("fh:{}", norm_path(&path).to_lowercase());
        if store.meta(&marker).as_deref() == Some(stamp.as_str()) {
            continue;
        }
        let Ok(f) = fs::File::open(&path) else { continue };
        let mut rd = BufReader::with_capacity(256 * 1024, f);
        loop {
            line.clear();
            match rd.read_until(b'\n', &mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            if line.len() > 2 * 1024 * 1024 || finder.find(&line).is_none() {
                continue;
            }
            for s in snapshot_entries(&line) {
                let Some(t) = by_path.get(&norm_path(&s.path).to_lowercase()) else { continue };
                let origin = format!("{sid}/{}", s.backup);
                if already(store, &t.key, source::EDIT, &origin) {
                    continue;
                }
                let copy = history.join(&sid).join(&s.backup);
                if s.backup.contains(['/', '\\']) || !copy.starts_with(&history) {
                    continue;
                }
                let Ok(m) = fs::metadata(&copy) else { continue };
                if m.len() > MAX_COPY {
                    continue;
                }
                let Ok(bytes) = fs::read(&copy) else { continue };
                if bytes.iter().take(8192).any(|b| *b == 0) {
                    continue;
                }
                let at = if s.at > 0 { s.at } else { mtime_ms(&m) };
                store.tx(|tx| store::upsert_item(tx, &t.key, &t.kind, &t.scope, t.project.as_deref(), &t.name, &t.path.to_string_lossy(), now))?;
                let text = String::from_utf8_lossy(&bytes).into_owned();
                if add_imported(store, &t.key, &bytes, &text, &t.path.to_string_lossy(), at, source::EDIT, &origin, Some(&sid), agent.as_deref(), now)? {
                    n += 1;
                }
            }
        }
        store.set_meta(&marker, &stamp)?;
    }
    Ok(n)
}
