//! `lifetime` (the Dashboard's "All time" row): the same numbers `scope_report` gives for
//! `first_day()..today`, which is what the `atlas-usage` CLI prints for its `all` scope, plus the
//! busiest day and the active days; chats whose transcripts are gone still count.

mod common;

use atlas_core::usage::query::ScopeArgs;
use atlas_core::usage::time::Tz;
use common::*;

fn line(sid: &str, id: &str, ts: &str, model: &str, i: u64, o: u64) -> String {
    format!("{}\n", jsonl_line(sid, id, ts, model, i, o))
}

/// Four chats over four active days (Nov 1, 2, 4 and "today", Nov 8), a gap on the 3rd and 5th-7th.
fn history(dir: &std::path::Path) {
    let p = dir.join("projects/-p");
    std::fs::create_dir_all(&p).unwrap();
    let mut a = line("sess-a", "a1", "2026-11-01T10:00:00.000Z", "claude-sonnet-5-5", 1000, 200);
    a.push_str(&line("sess-a", "a2", "2026-11-02T09:00:00.000Z", "claude-sonnet-5-5", 300, 30));
    std::fs::write(p.join("sess-a.jsonl"), a).unwrap();
    std::fs::write(p.join("sess-b.jsonl"), line("sess-b", "b1", "2026-11-02T12:00:00.000Z", "claude-opus-5-5", 5000, 500)).unwrap();
    std::fs::write(p.join("sess-c.jsonl"), line("sess-c", "c1", "2026-11-04T08:00:00.000Z", "claude-haiku-5-5", 100, 10)).unwrap();
    std::fs::write(p.join("sess-d.jsonl"), line("sess-d", "d1", "2026-11-08T08:00:00.000Z", "claude-haiku-5-5", 50, 5)).unwrap();
}

fn all(fx: &Fx) -> atlas_core::usage::query::ScopeReport {
    let first = fx.engine.first_day().unwrap().unwrap();
    fx.engine
        .scope_report(&ScopeArgs { from: first, to: fx.engine.today_date(), project_key: None, bucket: "day".into(), top: 0 })
        .unwrap()
}

#[test]
fn lifetime_is_the_all_scope_plus_busiest_day_and_active_days() {
    let dir = tempfile::tempdir().unwrap();
    history(dir.path());
    let fx = start(dir.path(), Tz::Fixed(0));
    let l = fx.engine.lifetime().unwrap();

    assert_eq!(l.first_day.as_deref(), Some("2026-11-01"));
    assert_eq!(l.today, "2026-11-08");
    assert_eq!(l.total.sessions, 4);
    assert_eq!(l.total.tokens.total, 1200 + 330 + 5500 + 110 + 55);
    assert_eq!(l.active_days, ["2026-11-01", "2026-11-02", "2026-11-04", "2026-11-08"]);
    let b = l.busiest.as_ref().unwrap();
    assert_eq!((b.day.as_str(), b.tokens.total), ("2026-11-02", 330 + 5500));
    // Most tokens first: Opus 5,500, Sonnet 1,530, Haiku 165.
    let order: Vec<&str> = l.by_model.iter().map(|m| m.model.as_str()).collect();
    assert_eq!(order, ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);

    // The very report the CLI prints for `all`: same total, same models, same cost.
    let r = all(&fx);
    assert_eq!(l.total.tokens, r.total.tokens);
    assert_eq!(l.total.sessions, r.total.sessions);
    assert_eq!(l.total.cost.usd, r.total.cost.usd);
    assert_eq!(l.by_model.len(), r.by_model.len());
    for (a, b) in l.by_model.iter().zip(&r.by_model) {
        assert_eq!((&a.model, a.tokens), (&b.model, b.tokens));
    }
    assert_eq!(r.points.iter().map(|p| p.tokens.total).sum::<u64>(), l.total.tokens.total);
}

#[test]
fn deleted_transcripts_still_count() {
    let dir = tempfile::tempdir().unwrap();
    history(dir.path());
    let fx = start(dir.path(), Tz::Fixed(0));
    let before = fx.engine.lifetime().unwrap();

    // Claude Code sweeps an old chat: the file is gone, its numbers stay.
    std::fs::remove_file(dir.path().join("projects/-p/sess-b.jsonl")).unwrap();
    fx.rescan();
    assert_eq!(fx.one("SELECT COUNT(*) FROM files WHERE missing = 1"), 1, "the file is marked missing, not removed");
    let after = fx.engine.lifetime().unwrap();
    assert_eq!(after.total.tokens, before.total.tokens);
    assert_eq!(after.total.sessions, 4);
    assert_eq!(after.busiest.as_ref().unwrap().day, "2026-11-02");
    assert_eq!(after.active_days, before.active_days);
}

#[test]
fn an_empty_cache_has_no_first_day() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("projects")).unwrap();
    let fx = start(dir.path(), Tz::Fixed(0));
    let l = fx.engine.lifetime().unwrap();
    assert_eq!(l.first_day, None);
    assert_eq!(l.total.tokens.total, 0);
    assert!(l.busiest.is_none() && l.active_days.is_empty() && l.by_model.is_empty());
}

#[test]
fn a_tie_for_busiest_goes_to_the_earlier_day() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("projects/-p");
    std::fs::create_dir_all(&p).unwrap();
    let mut s = line("sess-t", "t1", "2026-11-03T10:00:00.000Z", "claude-sonnet-5-5", 400, 0);
    s.push_str(&line("sess-t", "t2", "2026-11-05T10:00:00.000Z", "claude-sonnet-5-5", 400, 0));
    std::fs::write(p.join("sess-t.jsonl"), s).unwrap();
    let fx = start(dir.path(), Tz::Fixed(0));
    assert_eq!(fx.engine.lifetime().unwrap().busiest.unwrap().day, "2026-11-03");
}
