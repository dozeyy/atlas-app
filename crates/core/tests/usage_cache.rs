//! Acceptance 22: the cache file's lifecycle (versions, damage, resume).

mod common;

use std::fs;
use std::sync::Arc;

use atlas_core::cache;
use atlas_core::usage::time::Tz;
use atlas_core::usage::{NullSink, State, UsageEngine};
use common::*;
use rusqlite::Connection;

fn user_version(db: &std::path::Path) -> i64 {
    let c = Connection::open_with_flags(db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    c.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap()
}

fn engine_on(config: &std::path::Path, data: &std::path::Path) -> Arc<UsageEngine> {
    UsageEngine::start(config_for(config, data, Tz::Fixed(0)), Arc::new(NullSink))
}

fn sibling(db: &std::path::Path, suffix: &str) -> std::path::PathBuf {
    let mut s = db.as_os_str().to_os_string();
    s.push(suffix);
    s.into()
}

#[test]
fn a_fresh_db_gets_the_current_user_version() {
    let fx = start(&fixture("basic"), Tz::Fixed(0));
    assert_eq!(user_version(&fx.cache), cache::SCHEMA_VERSION);
}

#[test]
fn an_empty_db_migrates() {
    let data = tempfile::tempdir().unwrap();
    let db = data.path().join("cache.sqlite");
    drop(Connection::open(&db).unwrap()); // a zero-byte file is a valid empty database
    let engine = engine_on(&fixture("basic"), data.path());
    assert!(engine.wait_pass(0, WAIT));
    assert_eq!(engine.status().state, State::Idle, "{:?}", engine.status());
    assert_eq!(user_version(&db), cache::SCHEMA_VERSION);
    let n: i64 = Connection::open(&db).unwrap().query_row("SELECT COUNT(*) FROM messages", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 6);
}

#[test]
fn a_newer_schema_opens_read_only_and_is_never_touched() {
    let data = tempfile::tempdir().unwrap();
    let db = data.path().join("cache.sqlite");
    {
        let c = Connection::open(&db).unwrap();
        c.execute_batch("CREATE TABLE future(x); PRAGMA user_version = 99;").unwrap();
    }
    let before = fs::read(&db).unwrap();
    let engine = engine_on(&fixture("basic"), data.path());
    assert!(engine.wait_pass(0, WAIT));
    let s = engine.status();
    assert_eq!(s.state, State::ReadOnly, "{s:?}");
    assert!(s.note.is_some());
    engine.stop();
    assert_eq!(fs::read(&db).unwrap(), before, "file bytes must not change");
    assert!(!sibling(&db, "-wal").exists());
    assert_eq!(user_version(&db), 99);
}

/// A good cache plus its `.bak`, built the way the engine does.
fn make_good_cache(data: &std::path::Path) -> std::path::PathBuf {
    let db = data.join("cache.sqlite");
    let engine = engine_on(&fixture("basic"), data);
    assert!(engine.wait_pass(0, WAIT));
    engine.stop();
    let conn = cache::open_writer(&db).unwrap().conn;
    cache::backup(&conn, &db).unwrap();
    drop(conn);
    assert!(cache::backup_file(&db).exists());
    db
}

fn garbage_over(db: &std::path::Path) {
    for ext in ["-wal", "-shm"] {
        let _ = fs::remove_file(sibling(db, ext));
    }
    let junk: Vec<u8> = (0..8192u32).map(|i| (i.wrapping_mul(2654435761) >> 13) as u8).collect();
    fs::write(db, junk).unwrap();
}

fn corrupt_siblings(db: &std::path::Path) -> Vec<std::path::PathBuf> {
    fs::read_dir(db.parent().unwrap())
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.file_name().unwrap().to_string_lossy().contains(".corrupt-"))
        .collect()
}

#[test]
fn a_damaged_db_is_set_aside_and_the_backup_restored() {
    let data = tempfile::tempdir().unwrap();
    let db = make_good_cache(data.path());
    garbage_over(&db);
    let engine = engine_on(&fixture("basic"), data.path());
    assert!(engine.wait_pass(0, WAIT));
    let s = engine.status();
    assert_eq!(s.state, State::Idle, "{s:?}");
    assert!(s.note.as_deref().is_some_and(|n| n.contains("restored")), "{:?}", s.note);
    assert_eq!(corrupt_siblings(&db).len(), 1);
    engine.stop();
    let n: i64 = Connection::open(&db).unwrap().query_row("SELECT COUNT(*) FROM messages", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 6, "everything on disk is read again, with no duplicates");
}

#[test]
fn a_damaged_db_without_a_backup_starts_empty_and_indexes() {
    let data = tempfile::tempdir().unwrap();
    let db = make_good_cache(data.path());
    fs::remove_file(cache::backup_file(&db)).unwrap();
    garbage_over(&db);
    let engine = engine_on(&fixture("basic"), data.path());
    assert!(engine.wait_pass(0, WAIT));
    let s = engine.status();
    assert_eq!(s.state, State::Idle, "{s:?}");
    assert!(s.note.as_deref().is_some_and(|n| n.contains("started over")), "{:?}", s.note);
    assert_eq!(corrupt_siblings(&db).len(), 1);
    engine.stop();
    let n: i64 = Connection::open(&db).unwrap().query_row("SELECT COUNT(*) FROM messages", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 6);
}

#[test]
fn stopping_between_batches_and_restarting_resumes_with_identical_totals() {
    // One reference run in one go.
    let reference = start(&fixture("usage"), Tz::Fixed(0));
    let want: Vec<(String, i64, i64)> = totals(&reference);

    let data = tempfile::tempdir().unwrap();
    let mut cfg = config_for(&fixture("usage"), data.path(), Tz::Fixed(0));
    cfg.ingest.batch_lines = 2;
    cfg.ingest.workers = 1;
    cfg.ingest.stop_after_batches = Some(2);
    let cache_db = cfg.cache_db.clone();
    let first = UsageEngine::start(cfg, Arc::new(NullSink));
    // A halted pass is not a finished pass: it leaves the engine idle without counting.
    assert!(first.wait_status(WAIT, |s, _| s.state == State::Idle));
    assert_eq!(first.passes(), 0);
    first.stop();
    let partial: i64 = Connection::open(&cache_db).unwrap().query_row("SELECT COUNT(*) FROM messages", [], |r| r.get(0)).unwrap();
    assert!(partial > 0 && partial < want.len() as i64, "partial={partial} of {}", want.len());

    // Restart with no hook: it resumes from the committed offsets.
    let again = engine_on(&fixture("usage"), data.path());
    assert!(again.wait_pass(0, WAIT));
    again.stop();
    let c = Connection::open(&cache_db).unwrap();
    let got: Vec<(String, i64, i64)> = c
        .prepare("SELECT msg_key, input, output FROM messages ORDER BY 1")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(got, want);
    let sessions: i64 = c.query_row("SELECT COUNT(*) FROM sessions WHERE messages > 0", [], |r| r.get(0)).unwrap();
    let ref_sessions = reference.one("SELECT COUNT(*) FROM sessions WHERE messages > 0");
    assert_eq!(sessions, ref_sessions);
    let h: i64 = c.query_row("SELECT SUM(output) FROM usage_hour", [], |r| r.get(0)).unwrap();
    assert_eq!(h, want.iter().map(|x| x.2).sum::<i64>(), "aggregates agree with the rows");
}

fn totals(fx: &Fx) -> Vec<(String, i64, i64)> {
    fx.db()
        .prepare("SELECT msg_key, input, output FROM messages ORDER BY 1")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap()
        .map(Result::unwrap)
        .collect()
}
