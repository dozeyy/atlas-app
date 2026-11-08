//! The history store: `history.sqlite` (the index) plus `blobs/<ab>/<sha256>` (the contents,
//! content-addressed and deduplicated). The only place in the history module that writes.
//!
//! History is not rebuildable the way the usage cache is, so it lives in its own folder
//! and survives a cache reset. Everything in it is Atlas's own data.

use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};

pub const SCHEMA_VERSION: i64 = 1;

/// Where a version came from.
pub mod source {
    /// Atlas read the file itself.
    pub const SNAPSHOT: &str = "atlas_snapshot";
    /// One of Claude Code's own `.claude.json` copies.
    pub const BACKUP: &str = "claude_backup";
    /// A copy Claude Code kept in `file-history/` while editing.
    pub const EDIT: &str = "claude_edit";
    /// Only the file's modified date (nothing to compare).
    pub const DATE: &str = "file_date";
}

pub struct Store {
    dir: PathBuf,
    conn: Mutex<Connection>,
}

/// What the store remembers about a tracked item between passes.
#[derive(Debug, Clone)]
pub struct ItemState {
    pub item_key: String,
    pub kind: String,
    pub scope: String,
    pub project: Option<String>,
    pub name: String,
    pub path: String,
    pub first_seen_at: i64,
    pub gone_at: Option<i64>,
    pub last_sha: Option<String>,
    pub last_size: i64,
    pub last_mtime: i64,
    pub last_version: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct NewVersion<'a> {
    pub item_key: &'a str,
    pub sha: Option<&'a str>,
    pub bytes: i64,
    pub captured_at: i64,
    pub observed_mtime: i64,
    pub source: &'a str,
    pub origin_ref: Option<&'a str>,
    pub session_id: Option<&'a str>,
    pub agent_id: Option<&'a str>,
}

#[derive(Debug, Clone)]
pub struct NewEvent<'a> {
    pub item_key: &'a str,
    pub at: i64,
    pub kind: &'a str,
    pub from_version: Option<i64>,
    pub to_version: Option<i64>,
    pub source: &'a str,
    pub summary: &'a str,
}

pub fn sha_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

pub fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    bytes.iter().fold(String::with_capacity(bytes.len() * 2), |mut s, b| {
        let _ = write!(s, "{b:02x}");
        s
    })
}

impl Store {
    /// Open (creating it if needed) the store in `dir`.
    pub fn open(dir: &Path) -> Result<Store, String> {
        fs::create_dir_all(dir.join("blobs")).map_err(|e| format!("The history folder can't be made: {e}"))?;
        let mut conn = Connection::open(dir.join("history.sqlite")).map_err(|e| format!("The history index can't be opened: {e}"))?;
        let _ = conn.pragma_update(None, "journal_mode", "WAL");
        let _ = conn.pragma_update(None, "synchronous", "NORMAL");
        let _ = conn.busy_timeout(std::time::Duration::from_secs(5));
        let v: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).map_err(|e| e.to_string())?;
        if v > SCHEMA_VERSION {
            return Err("This history was written by a newer Atlas.".into());
        }
        if v < 1 {
            let tx = conn.transaction().map_err(|e| e.to_string())?;
            tx.execute_batch(H0001).map_err(|e| e.to_string())?;
            tx.execute_batch("PRAGMA user_version = 1").map_err(|e| e.to_string())?;
            tx.commit().map_err(|e| e.to_string())?;
        }
        Ok(Store { dir: dir.to_path_buf(), conn: Mutex::new(conn) })
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Run `f` on the connection. SQL errors become a plain message.
    pub fn with<T>(&self, f: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> Result<T, String> {
        let g = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        f(&g).map_err(|e| format!("The history index could not be read ({e})."))
    }

    /// Run `f` in one transaction.
    pub fn tx<T>(&self, f: impl FnOnce(&rusqlite::Transaction) -> rusqlite::Result<T>) -> Result<T, String> {
        let mut g = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        let tx = g.transaction().map_err(|e| e.to_string())?;
        let out = f(&tx).map_err(|e| format!("The history index could not be written ({e})."))?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(out)
    }

    // ------------------------------------------------------------ blobs

    pub fn blob_path(&self, sha: &str) -> PathBuf {
        self.dir.join("blobs").join(&sha[..2.min(sha.len())]).join(sha)
    }

    /// Store `bytes` (a no-op when they are already there). Returns their hash.
    pub fn put_blob(&self, bytes: &[u8]) -> io::Result<String> {
        let sha = sha_hex(bytes);
        let p = self.blob_path(&sha);
        if !p.exists() {
            if let Some(parent) = p.parent() {
                fs::create_dir_all(parent)?;
            }
            let tmp = p.with_extension(format!("tmp{}", std::process::id()));
            fs::write(&tmp, bytes)?;
            if fs::rename(&tmp, &p).is_err() {
                let _ = fs::remove_file(&tmp);
                if !p.exists() {
                    return Err(io::Error::other("could not place the copy"));
                }
            }
        }
        Ok(sha)
    }

    pub fn has_blob(&self, sha: &str) -> bool {
        self.blob_path(sha).is_file()
    }

    pub fn read_blob(&self, sha: &str) -> Option<Vec<u8>> {
        if sha.len() < 4 || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        fs::read(self.blob_path(sha)).ok()
    }

    /// Bytes on disk: the index and every copy.
    pub fn disk_bytes(&self) -> u64 {
        fn walk(p: &Path) -> u64 {
            let Ok(rd) = fs::read_dir(p) else { return 0 };
            rd.flatten()
                .map(|e| match e.metadata() {
                    Ok(m) if m.is_dir() => walk(&e.path()),
                    Ok(m) => m.len(),
                    Err(_) => 0,
                })
                .sum()
        }
        walk(&self.dir)
    }

    // ------------------------------------------------------------ meta

    pub fn meta(&self, key: &str) -> Option<String> {
        self.with(|c| c.query_row("SELECT value FROM meta WHERE key=?1", [key], |r| r.get(0)).optional()).ok().flatten()
    }

    pub fn set_meta(&self, key: &str, value: &str) -> Result<(), String> {
        self.with(|c| c.execute("INSERT INTO meta(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![key, value]).map(|_| ()))
    }

    // ------------------------------------------------------------ items

    pub fn items(&self) -> Result<HashMap<String, ItemState>, String> {
        self.with(|c| {
            let mut st = c.prepare(
                "SELECT i.item_key,i.kind,i.scope,i.project,i.name,i.path,i.first_seen_at,i.gone_at,
                        i.last_sha,i.last_size,i.last_mtime,
                        (SELECT MAX(version_id) FROM versions v WHERE v.item_key=i.item_key AND v.source='atlas_snapshot')
                 FROM items i",
            )?;
            let rows = st.query_map([], |r| {
                Ok(ItemState {
                    item_key: r.get(0)?,
                    kind: r.get(1)?,
                    scope: r.get(2)?,
                    project: r.get(3)?,
                    name: r.get(4)?,
                    path: r.get(5)?,
                    first_seen_at: r.get(6)?,
                    gone_at: r.get(7)?,
                    last_sha: r.get(8)?,
                    last_size: r.get(9)?,
                    last_mtime: r.get(10)?,
                    last_version: r.get(11)?,
                })
            })?;
            rows.map(|r| r.map(|i| (i.item_key.clone(), i))).collect()
        })
    }
}

/// Insert or refresh an item row. Used inside a transaction.
#[allow(clippy::too_many_arguments)]
pub fn upsert_item(
    tx: &rusqlite::Transaction,
    key: &str,
    kind: &str,
    scope: &str,
    project: Option<&str>,
    name: &str,
    path: &str,
    now: i64,
) -> rusqlite::Result<()> {
    tx.execute(
        "INSERT INTO items(item_key,kind,scope,project,name,path,first_seen_at) VALUES(?1,?2,?3,?4,?5,?6,?7)
         ON CONFLICT(item_key) DO UPDATE SET kind=excluded.kind, scope=excluded.scope, project=excluded.project,
           name=excluded.name, path=excluded.path",
        params![key, kind, scope, project, name, path, now],
    )?;
    Ok(())
}

pub fn set_stat(tx: &rusqlite::Transaction, key: &str, sha: Option<&str>, size: i64, mtime: i64) -> rusqlite::Result<()> {
    tx.execute("UPDATE items SET last_sha=?2,last_size=?3,last_mtime=?4,gone_at=NULL WHERE item_key=?1", params![key, sha, size, mtime])?;
    Ok(())
}

pub fn set_gone(tx: &rusqlite::Transaction, key: &str, at: i64) -> rusqlite::Result<()> {
    tx.execute("UPDATE items SET gone_at=?2 WHERE item_key=?1", params![key, at])?;
    Ok(())
}

/// Add a version. `None` when the same (item, source, origin) is already stored.
pub fn add_version(tx: &rusqlite::Transaction, v: &NewVersion) -> rusqlite::Result<Option<i64>> {
    let n = tx.execute(
        "INSERT OR IGNORE INTO versions(item_key,sha256,bytes,captured_at,observed_mtime,source,origin_ref,session_id,agent_id)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        params![v.item_key, v.sha, v.bytes, v.captured_at, v.observed_mtime, v.source, v.origin_ref, v.session_id, v.agent_id],
    )?;
    Ok(if n == 0 { None } else { Some(tx.last_insert_rowid()) })
}

pub fn add_event(tx: &rusqlite::Transaction, e: &NewEvent) -> rusqlite::Result<i64> {
    tx.execute(
        "INSERT INTO events(item_key,at,kind,from_version,to_version,source,summary) VALUES(?1,?2,?3,?4,?5,?6,?7)",
        params![e.item_key, e.at, e.kind, e.from_version, e.to_version, e.source, e.summary],
    )?;
    Ok(tx.last_insert_rowid())
}

/// The newest version of `key` observed at or before `t` (by file time, then id), if any.
pub fn version_before(tx: &Connection, key: &str, t: i64, not_id: i64) -> rusqlite::Result<Option<(i64, Option<String>)>> {
    tx.query_row(
        "SELECT version_id, sha256 FROM versions
         WHERE item_key=?1 AND version_id<>?3 AND COALESCE(observed_mtime,captured_at) <= ?2
         ORDER BY COALESCE(observed_mtime,captured_at) DESC, version_id DESC LIMIT 1",
        params![key, t, not_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()
}

const H0001: &str = r#"
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE items (
  item_key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  scope TEXT NOT NULL,
  project TEXT,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  gone_at INTEGER,
  last_sha TEXT,
  last_size INTEGER NOT NULL DEFAULT 0,
  last_mtime INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE versions (
  version_id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_key TEXT NOT NULL,
  sha256 TEXT,
  bytes INTEGER NOT NULL DEFAULT 0,
  captured_at INTEGER NOT NULL,
  observed_mtime INTEGER,
  source TEXT NOT NULL,
  origin_ref TEXT,
  session_id TEXT,
  agent_id TEXT
);
CREATE UNIQUE INDEX versions_origin ON versions(item_key, source, origin_ref) WHERE origin_ref IS NOT NULL;
CREATE INDEX versions_item ON versions(item_key, observed_mtime);
CREATE TABLE events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_key TEXT NOT NULL,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  from_version INTEGER,
  to_version INTEGER,
  source TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT ''
);
CREATE INDEX events_at ON events(at DESC, event_id DESC);
CREATE INDEX events_item ON events(item_key, at);
"#;
