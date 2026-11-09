//! `scope_report` (what the `atlas-usage` CLI prints) equals the app's timeline for the
//! same days, and its project filter splits the total exactly.

mod common;

use atlas_core::usage::query::ScopeArgs;
use atlas_core::usage::time::Tz;
use common::*;

fn scope(fx: &Fx, from: &str, to: &str, project: Option<&str>) -> atlas_core::usage::query::ScopeReport {
    fx.engine
        .scope_report(&ScopeArgs { from: from.into(), to: to.into(), project_key: project.map(str::to_string), bucket: "day".into() })
        .unwrap()
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
