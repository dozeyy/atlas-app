//! Review themes (`docs/specs/agent-scorecard.md` D14, D24, D25): rewordings of one finding from
//! several runs make one theme. Extra reviewer runs are written straight into a scratch cache.

mod common;

use common::*;
use atlas_core::usage::scorecard::ThemeArgs;
use atlas_core::usage::time::Tz;

const S1: &str = "aaaa1001-0000-4000-8000-000000000001";

#[test]
fn rewordings_of_one_finding_from_several_runs_make_a_theme() {
    let fx = start(&fixture("claude-ledger"), Tz::Fixed(0));
    fx.engine.stop();
    {
        let c = rusqlite::Connection::open(&fx.cache).unwrap();
        let ts = 1_793_960_000_000i64;
        let sets: [[(&str, &str); 2]; 2] = [
            [("High", "Retry loop in net.rs never backs off between attempts (src/net.rs:41)"), ("Low", "Rename the helper to match the module naming")],
            [("High", "retry loop never backs off between attempts in net.rs"), ("Medium", "Missing test for the empty cache case")],
        ];
        for (i, rows) in sets.iter().enumerate() {
            let agent = format!("a{:016x}", 0x20 + i);
            let at = ts + i as i64 * 600_000;
            c.execute(
                "INSERT INTO agent_runs(session_id, agent_id, file_id, agent_type, first_ts, last_ts, end_status, end_source, verdict, verdict_word, findings_n) \
                 VALUES (?1, ?2, 1, 'code-reviewer', ?3, ?4, 'finished', 'thread', 'findings', 'FIX-REQUIRED', 2)",
                rusqlite::params![S1, agent, at, at + 5000],
            )
            .unwrap();
            for (ord, (sev, text)) in rows.iter().enumerate() {
                c.execute(
                    "INSERT INTO review_findings(session_id, agent_id, ord, severity, text, ts) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    rusqlite::params![S1, agent, ord as i64, sev, text, at + 5000],
                )
                .unwrap();
            }
        }
    }
    let t = fx.engine.review_themes(&ThemeArgs::default()).unwrap();
    assert_eq!(t.findings, 7);
    assert_eq!(t.total, 1, "{:?}", t.themes.iter().map(|x| &x.label).collect::<Vec<_>>());
    let th = &t.themes[0];
    // The fixture's own R3 finding plus the two rewordings.
    assert_eq!((th.count, th.runs), (3, 3));
    assert!(th.label.contains("backs off"), "{}", th.label);
    let sev: Vec<(&str, u32)> = th.severities.iter().map(|s| (s.severity.as_str(), s.count)).collect();
    assert_eq!(sev, vec![("High", 2), ("none", 1)]);
    assert_eq!(th.reviewers.len(), 1);
    assert_eq!((th.reviewers[0].agent_type.as_str(), th.reviewers[0].count), ("code-reviewer", 3));
    assert!(th.examples.len() <= 3 && th.examples.iter().all(|e| !e.session_id.is_empty()));
    // The one-off findings stay out: a theme needs three findings from two runs.
    assert!(t.themes.iter().all(|x| x.count >= 3 && x.runs >= 2));
    // A range that excludes the added runs sees only the fixture's three findings.
    let old = fx.engine.review_themes(&ThemeArgs { days: Some(1), limit: None }).unwrap();
    assert_eq!(old.findings, 0);
}

/// Findings read out of a coder's report ("Issues fixed:" bullets, a quoted sample) are not review
/// findings: only reviewer-type helpers feed themes.
#[test]
fn a_workers_bullets_never_become_review_findings() {
    let fx = start(&fixture("claude-ledger"), Tz::Fixed(0));
    fx.engine.stop();
    {
        let c = rusqlite::Connection::open(&fx.cache).unwrap();
        let ts = 1_793_960_000_000i64;
        for i in 0..3usize {
            let agent = format!("a{:016x}", 0x30 + i);
            let at = ts + i as i64 * 600_000;
            c.execute(
                "INSERT INTO agent_runs(session_id, agent_id, file_id, agent_type, first_ts, last_ts, end_status, end_source, findings_n) \
                 VALUES (?1, ?2, 1, 'desktop-app-dev', ?3, ?4, 'finished', 'thread', 1)",
                rusqlite::params![S1, agent, at, at + 5000],
            )
            .unwrap();
            c.execute(
                "INSERT INTO review_findings(session_id, agent_id, ord, severity, text, ts) VALUES (?1, ?2, 0, NULL, ?3, ?4)",
                rusqlite::params![S1, agent, "Issues fixed: the cache is invalidated again on every write", at + 5000],
            )
            .unwrap();
        }
    }
    let t = fx.engine.review_themes(&ThemeArgs::default()).unwrap();
    assert_eq!(t.findings, 3, "only the fixture's own reviewer findings count");
    assert!(t.themes.iter().all(|x| !x.label.contains("Issues fixed")), "{:?}", t.themes.iter().map(|x| &x.label).collect::<Vec<_>>());
}
