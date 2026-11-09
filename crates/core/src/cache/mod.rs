//! The usage cache: one SQLite file Atlas owns (D27-D33).
//!
//! Everything that creates, renames, copies or deletes a file for the cache lives
//! in this module (and `pricing_file`), never in `usage/`: the usage engine reads
//! transcripts and must be provably unable to write anywhere (acceptance 20).

pub mod migrate;
pub mod pricing_file;
pub mod receipts;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};

use rusqlite::functions::FunctionFlags;
use rusqlite::{Connection, OpenFlags};
use sha2::{Digest, Sha256};

use crate::usage::pricing::{Basis, Counts, PriceTable};
use crate::usage::time::Tz;

pub use migrate::SCHEMA_VERSION;

/// A price table that can be swapped while readers keep running (D20).
pub type PriceHandle = Arc<RwLock<Arc<PriceTable>>>;

pub fn price_handle(t: PriceTable) -> PriceHandle {
    Arc::new(RwLock::new(Arc::new(t)))
}

/// Where the cache file lives (D27). `real` ledgers share `<data>/cache.sqlite`;
/// every other root (fixtures, `--config-dir` folders) gets its own file so it
/// never mixes into the real ledger.
pub fn cache_file(data_dir: &Path, projects_dir: &Path, real: bool) -> PathBuf {
    if real {
        return data_dir.join("cache.sqlite");
    }
    let canon = projects_dir.canonicalize().unwrap_or_else(|_| projects_dir.to_path_buf());
    let mut h = Sha256::new();
    h.update(canon.to_string_lossy().as_bytes());
    let hex: String = h.finalize().iter().take(8).map(|b| format!("{b:02x}")).collect();
    data_dir.join("caches").join(format!("{hex}.sqlite"))
}

pub fn backup_file(db: &Path) -> PathBuf {
    sibling(db, "bak")
}

fn sibling(db: &Path, ext_suffix: &str) -> PathBuf {
    let mut s = db.as_os_str().to_os_string();
    s.push(".");
    s.push(ext_suffix);
    PathBuf::from(s)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpenKind {
    Ready,
    /// The file is from a newer Atlas: read it, never write it (D29).
    ReadOnly,
}

pub struct Opened {
    pub conn: Connection,
    pub kind: OpenKind,
    /// Set when the file was damaged and replaced (D32).
    pub recovered: Option<Recovery>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Recovery {
    pub from_backup: bool,
    pub set_aside: PathBuf,
}

#[derive(Debug, thiserror::Error)]
pub enum CacheError {
    #[error("cache database: {0}")]
    Sql(#[from] rusqlite::Error),
    #[error("cache file: {0}")]
    Io(#[from] std::io::Error),
}

fn is_corrupt(e: &rusqlite::Error) -> bool {
    use rusqlite::ffi::ErrorCode;
    matches!(
        e,
        rusqlite::Error::SqliteFailure(f, _)
            if matches!(f.code, ErrorCode::DatabaseCorrupt | ErrorCode::NotADatabase)
    )
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Open (creating and migrating if needed) the writer connection. A damaged file
/// is set aside as `*.corrupt-<time>` and replaced by the last good backup, or by
/// an empty database (D32).
pub fn open_writer(db: &Path) -> Result<Opened, CacheError> {
    if let Some(dir) = db.parent() {
        std::fs::create_dir_all(dir)?;
    }
    match try_open(db) {
        Ok((conn, kind)) => Ok(Opened { conn, kind, recovered: None }),
        Err(e) if is_corrupt(&e) => {
            let rec = recover(db)?;
            let (conn, kind) = try_open(db)?;
            Ok(Opened { conn, kind, recovered: Some(rec) })
        }
        Err(e) => Err(e.into()),
    }
}

fn try_open(db: &Path) -> rusqlite::Result<(Connection, OpenKind)> {
    let mut conn = Connection::open(db)?;
    conn.busy_timeout(std::time::Duration::from_millis(5000))?;
    let v = migrate::user_version(&conn)?;
    if v > SCHEMA_VERSION {
        drop(conn);
        let ro = Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        ro.busy_timeout(std::time::Duration::from_millis(5000))?;
        return Ok((ro, OpenKind::ReadOnly));
    }
    let _mode: String = conn.query_row("PRAGMA journal_mode=WAL", [], |r| r.get(0))?;
    conn.execute_batch("PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;")?;
    migrate::migrate(&mut conn)?;
    Ok((conn, OpenKind::Ready))
}

/// Fold the write-ahead log into the database file and close, so nothing is left beside it.
/// For a short-lived writer (Atlas Setup's first read): the engine's read connections are
/// read-only and cannot clear the log when they close last. Best effort; a missing or busy
/// cache is left as it is.
pub fn checkpoint_and_close(db: &Path) {
    if !db.is_file() {
        return;
    }
    if let Ok(conn) = Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_WRITE) {
        let _ = conn.busy_timeout(std::time::Duration::from_millis(2000));
        let _ = conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()));
    }
}

/// Set the damaged database aside and put the newest good backup in its place.
pub fn recover(db: &Path) -> Result<Recovery, CacheError> {
    let aside = sibling(db, &format!("corrupt-{}", now_secs()));
    std::fs::rename(db, &aside)?;
    for ext in ["-wal", "-shm"] {
        let mut p = db.as_os_str().to_os_string();
        p.push(ext);
        let p = PathBuf::from(p);
        if p.exists() {
            let mut a = aside.as_os_str().to_os_string();
            a.push(ext);
            let _ = std::fs::rename(&p, PathBuf::from(a));
        }
    }
    let bak = backup_file(db);
    let mut from_backup = false;
    if bak.is_file() && std::fs::copy(&bak, db).is_ok() {
        let good = Connection::open(db)
            .and_then(|c| {
                let ok = quick_check(&c);
                let v = migrate::user_version(&c)?;
                Ok(ok && v <= SCHEMA_VERSION)
            })
            .unwrap_or(false);
        if good {
            from_backup = true;
        } else {
            let _ = std::fs::remove_file(db);
        }
    }
    Ok(Recovery { from_backup, set_aside: aside })
}

/// `PRAGMA quick_check` says "ok".
pub fn quick_check(conn: &Connection) -> bool {
    conn.query_row("PRAGMA quick_check", [], |r| r.get::<_, String>(0))
        .map(|s| s == "ok")
        .unwrap_or(false)
}

/// One snapshot, atomically replaced (D33): `VACUUM INTO` a temp file, then rename.
pub fn backup(conn: &Connection, db: &Path) -> Result<(), CacheError> {
    let tmp = sibling(db, "bak.tmp");
    let _ = std::fs::remove_file(&tmp);
    let path = tmp.to_string_lossy().replace('\'', "''");
    conn.execute_batch(&format!("VACUUM INTO '{path}'"))?;
    std::fs::rename(&tmp, backup_file(db))?;
    Ok(())
}

/// `cost_usd(model, speed, geo, tier, price_tier, in, out, cw5m, cw1h, cr, web)`:
/// dollars from the live price table, or NULL when the row cannot be priced (D26).
pub fn register_functions(conn: &Connection, prices: &PriceHandle, tz: Tz) -> rusqlite::Result<()> {
    let handle = Arc::clone(prices);
    conn.create_scalar_function("cost_usd", 11, FunctionFlags::SQLITE_UTF8, move |ctx| {
        let table = handle.read().unwrap_or_else(|p| p.into_inner()).clone();
        let text = |i: usize| ctx.get_raw(i).as_str().unwrap_or("");
        let (model, speed, geo, tier) = (text(0), text(1), text(2), text(3));
        let counts = Counts {
            input: ctx.get::<i64>(5)?.max(0) as u64,
            output: ctx.get::<i64>(6)?.max(0) as u64,
            cw5m: ctx.get::<i64>(7)?.max(0) as u64,
            cw1h: ctx.get::<i64>(8)?.max(0) as u64,
            cr: ctx.get::<i64>(9)?.max(0) as u64,
            web_search: ctx.get::<i64>(10)?.max(0) as u64,
        };
        let basis = Basis { model, speed, geo, service_tier: tier, price_tier: ctx.get(4)? };
        Ok(table.cost(&basis, &counts))
    })?;
    // price_tier_of(model, input, cw5m, cw1h, cr): the long-context flag under the live table.
    let handle = Arc::clone(prices);
    conn.create_scalar_function("price_tier_of", 5, FunctionFlags::SQLITE_UTF8, move |ctx| {
        let table = handle.read().unwrap_or_else(|p| p.into_inner()).clone();
        let counts = Counts {
            input: ctx.get::<i64>(1)?.max(0) as u64,
            cw5m: ctx.get::<i64>(2)?.max(0) as u64,
            cw1h: ctx.get::<i64>(3)?.max(0) as u64,
            cr: ctx.get::<i64>(4)?.max(0) as u64,
            ..Default::default()
        };
        Ok(table.price_tier(ctx.get_raw(0).as_str().unwrap_or(""), &counts))
    })?;
    conn.create_scalar_function(
        "hour_of",
        1,
        FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
        move |ctx| {
            let ts: i64 = ctx.get(0)?;
            Ok(tz.hour_bucket(ts))
        },
    )?;
    Ok(())
}

/// Read-only connections for commands (D28): a small pool, no r2d2.
pub struct ReadPool {
    db: PathBuf,
    prices: PriceHandle,
    tz: Tz,
    conns: Mutex<Vec<Connection>>,
}

impl ReadPool {
    pub fn new(db: PathBuf, prices: PriceHandle, tz: Tz) -> ReadPool {
        ReadPool { db, prices, tz, conns: Mutex::new(Vec::new()) }
    }

    fn open(&self) -> rusqlite::Result<Connection> {
        let c = Connection::open_with_flags(
            &self.db,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        c.busy_timeout(std::time::Duration::from_millis(5000))?;
        register_functions(&c, &self.prices, self.tz)?;
        Ok(c)
    }

    pub fn with<T>(&self, f: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> rusqlite::Result<T> {
        let pooled = self.conns.lock().unwrap_or_else(|p| p.into_inner()).pop();
        let conn = match pooled {
            Some(c) => c,
            None => self.open()?,
        };
        let out = f(&conn);
        let mut g = self.conns.lock().unwrap_or_else(|p| p.into_inner());
        if g.len() < 2 {
            g.push(conn);
        }
        out
    }
}
