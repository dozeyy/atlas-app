//! `scope_report` (what the `atlas-usage` CLI prints) equals the app's timeline for the
//! same days, and its project filter splits the total exactly.

mod common;

use atlas_core::usage::query::ScopeArgs;
use atlas_core::usage::time::Tz;
use common::*;

fn scope(fx: &Fx, from: &str, to: &str, project: Option<&str>) -> atlas_core::usage::query::ScopeReport {
    fx.engine
        .scope_report(&ScopeArgs {
            from: from.into(),
            to: to.into(),
            project_key: project.map(str::to_string),
            bucket: "day".into(),
            top: 50,
        })
        .unwrap()
}

#[test]
fn chats_count_only_their_part_inside_the_range() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("projects/-p");
    std::fs::create_dir_all(&p).unwrap();
    let mut long = String::new();
    long.push_str(&jsonl_line("sess-long", "a", "2026-11-05T10:00:00.000Z", "claude-sonnet-5-5", 1000, 200));
    long.push('\n');
    long.push_str(&jsonl_line("sess-long", "b", "2026-11-06T10:00:00.000Z", "claude-sonnet-5-5", 30, 7));
    long.push('\n');
    std::fs::write(p.join("sess-long.jsonl"), long).unwrap();
    let short = format!("{}\n", jsonl_line("sess-short", "c", "2026-11-06T11:00:00.000Z", "claude-sonnet-5-5", 100, 20));
    std::fs::write(p.join("sess-short.jsonl"), short).unwrap();
    let fx = start(dir.path(), Tz::Fixed(0));

    // Nov 6 only: the long chat counts just its Nov 6 message, so it ranks below the short one.
    let r = scope(&fx, "2026-11-06", "2026-11-06", None);
    let ids: Vec<&str> = r.chats.iter().map(|c| c.session_id.as_str()).collect();
    assert_eq!(ids, ["sess-short", "sess-long"]);
    assert_eq!(r.chats[0].tokens.total, 120);
    assert_eq!(r.chats[1].tokens.total, 37);
    assert_eq!(r.chats.iter().map(|c| c.tokens.total).sum::<u64>(), r.total.tokens.total);

    // Both days: the whole long chat.
    let both = scope(&fx, "2026-11-05", "2026-11-06", None);
    assert_eq!(both.chats[0].session_id, "sess-long");
    assert_eq!(both.chats[0].tokens.total, 1237);

    // A day with nothing lists nothing; top = 0 lists nothing.
    assert!(scope(&fx, "2026-11-07", "2026-11-07", None).chats.is_empty());
    let none = fx
        .engine
        .scope_report(&ScopeArgs { from: "2026-11-06".into(), to: "2026-11-06".into(), project_key: None, bucket: "day".into(), top: 0 })
        .unwrap();
    assert!(none.chats.is_empty());
}

#[test]
fn range_matches_timeline_day_by_day() {
    let fx = start(&fixture("claude-basic"), Tz::Fixed(0));
    let r = scope(&fx, "2026-11-01", "2026-11-30", None);
    assert_eq!(r.points.len(), 30);
    assert_eq!(r.total.tokens, fx.month().tokens);
    assert!(r.total.tokens.total > 0);

    let tl = fx.timeline("2026-11-01", "2026-11-30", "day", None);
    assert_eq!(tl.points.len(), r.points.len());
    for (a, b) in r.points.iter().zip(&tl.points) {
        assert_eq!(a.start, b.start);
        assert_eq!(a.tokens, b.tokens, "day {}", a.start);
        assert_eq!(a.sessions, b.sessions, "chats started on {}", a.start);
    }
    let by_model: u64 = r.by_model.iter().map(|m| m.tokens.total).sum();
    assert_eq!(by_model, r.total.tokens.total);
    let by_chat: u64 = r.chats.iter().map(|c| c.tokens.total).sum();
    assert_eq!(by_chat, r.total.tokens.total, "every chat fits in top 50");
    assert!(fx.engine.first_day().unwrap().is_some_and(|d| d.starts_with("2026-11")));
}

#[test]
fn project_filter_splits_the_total() {
    let fx = start(&fixture("claude-basic"), Tz::Fixed(0));
    let all = scope(&fx, "2026-11-01", "2026-11-30", None);
    assert!(all.projects.len() >= 2, "fixture has two projects");
    let mut sum = 0;
    for p in &all.projects {
        let one = scope(&fx, "2026-11-01", "2026-11-30", Some(&p.project_key));
        assert_eq!(one.total.tokens, p.tokens, "project {}", p.project_key);
        assert_eq!(one.total.sessions, p.sessions);
        assert_eq!(one.projects.len(), 1);
        let per_day: u64 = one.points.iter().map(|d| d.tokens.total).sum();
        assert_eq!(per_day, one.total.tokens.total);
        sum += one.total.tokens.total;
    }
    assert_eq!(sum, all.total.tokens.total);
    let none = scope(&fx, "2026-11-01", "2026-11-30", Some("/no/such/project"));
    assert_eq!(none.total.tokens.total, 0);
    assert_eq!(none.total.sessions, 0);
}
