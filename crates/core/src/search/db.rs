//! The search database: schema, opening, wiping. Everything in here is rebuildable from
//! the transcripts, so there is no backup: a damaged file is set aside and started over.

use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};
use sha2::{Digest, Sha256};

/// 2: `msgs.origin` (who wrote a user line).
pub const SCHEMA_VERSION: i64 = 2;
/// Bump when `extract` or `mask` change what gets stored: every install re-reads once.
pub const PARSER_VERSION: &str = "2";

/// Where the search file lives. Real ledgers share `<data>/search.sqlite`; every other root
/// (fixtures, `--config-dir` folders) gets its own file so it never mixes into the real one.
pub fn search_file(data_dir: &Path, projects_dir: &Path, real: bool) -> PathBuf {
    if real {
        return data_dir.join("search.sqlite");
    }
    let canon = projects_dir.canonicalize().unwrap_or_else(|_| projects_dir.to_path_buf());
    let mut h = Sha256::new();
    h.update(canon.to_string_lossy().as_bytes());
    let hex: String = h.finalize().iter().take(8).map(|b| format!("{b:02x}")).collect();
    data_dir.join("caches").join(format!("{hex}.search.sqlite"))
}

#[derive(Debug, thiserror::Error)]
pub enum DbError {
    #[error("search database: {0}")]
    Sql(#[from] rusqlite::Error),
    #[error("search file: {0}")]
    Io(#[from] std::io::Error),
    #[error("the search index was made by a newer Atlas")]
    Newer,
}

const SCHEMA: &str = "
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE sfiles(
  file_id     INTEGER PRIMARY KEY,
  path        TEXT NOT NULL UNIQUE,
  fs_id       TEXT NOT NULL DEFAULT '',
  head_hash   BLOB,
  head_len    INTEGER NOT NULL DEFAULT 0,
  size        INTEGER NOT NULL DEFAULT 0,
  mtime_ns    INTEGER NOT NULL DEFAULT 0,
  offset      INTEGER NOT NULL DEFAULT 0,
  missing     INTEGER NOT NULL DEFAULT 0,
  session_id  TEXT NOT NULL,
  is_subagent INTEGER NOT NULL DEFAULT 0,
  project     TEXT
);
CREATE TABLE msgs(
  id         INTEGER PRIMARY KEY,
  uuid       TEXT,
  file_id    INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  agent_id   TEXT,
  role       INTEGER NOT NULL,
  ts         INTEGER,
  origin     INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX msgs_uuid ON msgs(uuid);
CREATE INDEX msgs_file ON msgs(file_id);
CREATE VIRTUAL TABLE fts USING fts5(text, tokenize='unicode61 remove_diacritics 2');
";

fn is_corrupt(e: &rusqlite::Error) -> bool {
    use rusqlite::ffi::ErrorCode;
    matches!(e, rusqlite::Error::SqliteFailure(f, _) if matches!(f.code, ErrorCode::DatabaseCorrupt | ErrorCode::NotADatabase))
}

fn remove_with_sidecars(db: &Path) {
    let _ = std::fs::remove_file(db);
    for ext in ["-wal", "-shm"] {
        let mut p = db.as_os_str().to_os_string();
        p.push(ext);
        let _ = std::fs::remove_file(PathBuf::from(p));
    }
}

fn try_open(db: &Path) -> Result<Connection, DbError> {
    let conn = Connection::open(db)?;
    conn.busy_timeout(std::time::Duration::from_millis(5000))?;
    let v: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if v > SCHEMA_VERSION {
        return Err(DbError::Newer);
    }
    let _mode: String = conn.query_row("PRAGMA journal_mode=WAL", [], |r| r.get(0))?;
    conn.execute_batch("PRAGMA synchronous=NORMAL; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-65536;")?;
    if v == 0 {
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(SCHEMA)?;
        tx.execute_batch(&format!("PRAGMA user_version={SCHEMA_VERSION}"))?;
        tx.commit()?;
    } else if v == 1 {
        // Schema 1 -> 2: the new column. Old rows read as "unknown"; the parser version
        // changed too, so the indexer wipes and re-reads everything once in the background.
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch("ALTER TABLE msgs ADD COLUMN origin INTEGER NOT NULL DEFAULT 0")?;
        tx.execute_batch(&format!("PRAGMA user_version={SCHEMA_VERSION}"))?;
        tx.commit()?;
    }
    // Exercise the FTS table so a damaged index fails here, not mid-build.
    conn.query_row("SELECT COUNT(*) FROM msgs", [], |r| r.get::<_, i64>(0))?;
    Ok(conn)
}

/// Open the writer connection, creating the file. A damaged file is deleted and recreated.
/// If the file is from a newer Atlas: `DbError::Newer` (the caller leaves it alone).
pub fn open_writer(db: &Path) -> Result<Connection, DbError> {
    if let Some(dir) = db.parent() {
        std::fs::create_dir_all(dir)?;
    }
    match try_open(db) {
        Ok(c) => Ok(c),
        Err(DbError::Sql(e)) if is_corrupt(&e) => {
            remove_with_sidecars(db);
            try_open(db)
        }
        Err(e) => Err(e),
    }
}

/// A read-only connection for queries (WAL lets it run beside the writer).
pub fn open_reader(db: &Path) -> rusqlite::Result<Connection> {
    let c = Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
    c.busy_timeout(std::time::Duration::from_millis(5000))?;
    Ok(c)
}

pub fn get_meta(conn: &Connection, key: &str) -> Option<String> {
    use rusqlite::OptionalExtension;
    conn.query_row("SELECT value FROM meta WHERE key=?1", [key], |r| r.get(0)).optional().ok().flatten()
}

pub fn set_meta(conn: &Connection, key: &str, value: &str) {
    let _ = conn.execute("INSERT OR REPLACE INTO meta(key,value) VALUES(?1,?2)", [key, value]);
}

/// Forget everything that was read (rows only; the schema stays).
pub fn wipe(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "DELETE FROM msgs; DELETE FROM sfiles; DELETE FROM meta WHERE key IN ('last_indexed_at','first_index_done'); \
         DELETE FROM fts;",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `wipe` must empty the text table too: with its old statement ('delete-all' is only for
    /// contentless tables) the batch failed after the rows were gone, the old text stayed, and
    /// every row written afterwards hit a duplicate rowid ("constraint failed").
    #[test]
    fn wipe_empties_the_text_table_so_rows_can_be_written_again() {
        let d = tempfile::tempdir().unwrap();
        let c = open_writer(&d.path().join("s.sqlite")).unwrap();
        c.execute("INSERT INTO fts(rowid,text) VALUES(1,'old words')", []).unwrap();
        wipe(&c).unwrap();
        let n: i64 = c.query_row("SELECT COUNT(*) FROM fts WHERE fts MATCH 'old'", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
        c.execute("INSERT INTO fts(rowid,text) VALUES(1,'new words')", []).unwrap();
    }

    #[test]
    fn creates_schema_and_fts5_is_available() {
        let d = tempfile::tempdir().unwrap();
        let c = open_writer(&d.path().join("s.sqlite")).unwrap();
        c.execute("INSERT INTO fts(rowid,text) VALUES(1,'hello brave new world')", []).unwrap();
        let n: i64 = c.query_row("SELECT COUNT(*) FROM fts WHERE fts MATCH 'brave'", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn a_damaged_file_starts_over_and_a_newer_one_is_left_alone() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("s.sqlite");
        std::fs::write(&p, vec![0x42u8; 4096]).unwrap();
        assert!(open_writer(&p).is_ok());
        let c = Connection::open(&p).unwrap();
        c.execute_batch("PRAGMA user_version=99").unwrap();
        drop(c);
        assert!(matches!(open_writer(&p), Err(DbError::Newer)));
    }

    #[test]
    fn files_for_fixtures_never_share_the_real_name() {
        let d = tempfile::tempdir().unwrap();
        let real = search_file(d.path(), Path::new("C:/x/projects"), true);
        let fx = search_file(d.path(), Path::new("C:/x/projects"), false);
        assert_ne!(real, fx);
        assert!(fx.to_string_lossy().ends_with(".search.sqlite"));
    }
}
