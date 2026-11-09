//! The helper-run ledger and its queries (`docs/specs/agent-scorecard.md` Unit 1) against
//! `fixtures/claude-ledger`. Fixture ids: chat S1 `aaaa1001`, S2 `bbbb1002` (headless, ran as the
//! code-reviewer agent), S3 `cccc1003`; workers W1..W7 and reviewers R1..R4 are `a0...01..0b`.

mod common;

use common::*;
use atlas_core::usage::scorecard::*;
use atlas_core::usage::time::Tz;

const S1: &str = "aaaa1001-0000-4000-8000-000000000001";
const S2: &str = "bbbb1002-0000-4000-8000-000000000002";

fn id(n: u32) -> String {
    format!("a{n:016x}")
}

/// (end_status, end_source, verdict_word, verdict, findings_n, tool_calls) of one run.
type Row = (Option<String>, Option<String>, Option<String>, Option<String>, i64, i64);

fn run(fx: &Fx, session: &str, agent: &str) -> Row {
    fx.db()
        .query_row(
            "SELECT end_status, end_source, verdict_word, verdict, findings_n, tool_calls FROM agent_runs WHERE session_id=?1 AND agent_id=?2",
            [session, agent],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
        )
        .unwrap()
}

fn s(x: &str) -> Option<String> {
    Some(x.to_string())
}

fn fx() -> Fx {
    start(&fixture("claude-ledger"), Tz::Fixed(0))
}

fn card<'a>(sc: &'a Scorecard, t: &str) -> &'a TypeCard {
    sc.types.iter().find(|c| c.agent_type == t).unwrap_or_else(|| panic!("no card for {t}"))
}

// Criterion 3: the rows, with every end source and the two tie rules.
#[test]
fn runs_end_by_notice_then_sidecar_then_thread() {
    let fx = fx();
    // W1: the parent's "completed" notice.
    assert_eq!(run(&fx, S1, &id(1)), (s("finished"), s("notice"), None, None, 0, 1));
    // R1: the sidecar says finished; its report has a PASS verdict.
    let r1 = run(&fx, S1, &id(2));
    assert_eq!((r1.0.as_deref(), r1.1.as_deref(), r1.3.as_deref()), (Some("finished"), Some("sidecar"), Some("pass")));
    // W2: end_turn on the thread's last line.
    assert_eq!((run(&fx, S1, &id(3)).0, run(&fx, S1, &id(3)).1), (s("finished"), s("thread")));
    // R2: a verifier whose "MERGE" counts as a pass.
    let r2 = run(&fx, S1, &id(4));
    assert_eq!((r2.2.as_deref(), r2.3.as_deref()), (Some("MERGE"), Some("pass")));
    // W5 interrupted -> stopped; W6 api error -> errored; W7 no end seen -> unknown.
    assert_eq!(run(&fx, S1, &id(9)).0, s("stopped"));
    assert_eq!(run(&fx, S1, &id(10)).0, s("errored"));
    assert_eq!((run(&fx, S1, &id(11)).0, run(&fx, S1, &id(11)).1), (None, None));
    // R3 asked for changes: three finding lines kept, the masked one dropped.
    let r3 = run(&fx, S1, &id(7));
    assert_eq!((r3.2.as_deref(), r3.3.as_deref(), r3.4), (Some("FIX-REQUIRED"), Some("findings"), 3));
    // The headless chat that ran as the code-reviewer agent has one run with an empty id.
    let main = run(&fx, S2, "");
    assert_eq!((main.0.as_deref(), main.3.as_deref()), (Some("finished"), Some("pass")));
    assert_eq!(fx.one("SELECT COUNT(*) FROM agent_runs"), 12);
}

#[test]
fn reviews_tie_by_name_by_window_and_by_branch_and_sent_back_follows_a_findings_review() {
    let fx = fx();
    let sc = fx.engine.agent_scorecard(&ScorecardArgs::default()).unwrap();
    let coder = card(&sc, "coder");
    let rv = coder.reviews.expect("coder is a worker type");
    // W1 (R1 named it), W2 (R2 ended in its window), W4 (R4 named its branch; R3, which tied to no one,
    // is tied to W4 only because a SendMessage sent it back): four tied reviews, three passes, one sent back.
    assert_eq!(rv.tied, 4, "{rv:?}");
    assert_eq!(rv.passed, 3, "{rv:?}");
    assert_eq!(rv.sent_back, 1, "{rv:?}");
    // W3 (two workers ended in R3's window, none named) and W7 (never reviewed) are not tied.
    assert_eq!(rv.not_tied, 2, "{rv:?}");
    assert!(!rv.rate_ok, "four tied reviews is below the rate threshold");
    // The reviewer types carry verdicts, never review ties.
    let cr = card(&sc, "code-reviewer");
    assert!(cr.reviewer && cr.reviews.is_none());
    let v = cr.verdicts.unwrap();
    assert_eq!((v.pass, v.findings, v.other, v.none), (2, 1, 0, 0)); // R1, S2's own run; R3
}

// Criterion 4: no prompt, no key ever reaches the cache file.
#[test]
fn the_cache_never_holds_a_prompt_or_a_key() {
    let fx = fx();
    fx.engine.stop();
    let mut bytes = std::fs::read(&fx.cache).unwrap();
    for ext in ["sqlite-wal", "sqlite-shm"] {
        if let Ok(b) = std::fs::read(fx.cache.with_extension(ext)) {
            bytes.extend(b);
        }
    }
    assert!(bytes.len() > 4096);
    let has = |needle: &str| bytes.windows(needle.len()).any(|w| w == needle.as_bytes());
    assert!(!has("SENTINEL-PROMPT-7731"), "a dispatch prompt was stored");
    // R3's report has a finding line holding `password=...`: the mask would change it, so it is dropped.
    assert!(!has("fixturepw12345"), "a secret-looking finding line was stored");
    assert!(!has("debug log"), "the dropped finding line was stored");
    // Sanity: the check can fail. The finding lines that are kept are in the file.
    assert!(has("Retry loop in net.rs"));
}

// Criterion 5: a version-4 cache gains the ledger on the next start and equals a fresh index.
#[test]
fn a_version_4_cache_migrates_and_matches_a_fresh_index() {
    let first = fx();
    let totals = |fx: &Fx| -> Vec<i64> {
        ["agent_runs", "agent_links", "review_findings", "agent_notices", "agent_run_models"]
            .iter()
            .map(|t| fx.one(&format!("SELECT COUNT(*) FROM {t}")))
            .collect()
    };
    let fresh = totals(&first);
    assert_eq!(fresh, vec![12, 14, 3, 1, 12]);
    first.engine.stop();
    let Fx { engine, data, config, cache } = first;
    drop(engine);
    {
        let c = rusqlite::Connection::open(&cache).unwrap();
        c.execute_batch(
            "DROP TABLE agent_runs; DROP TABLE agent_links; DROP TABLE review_findings; DROP TABLE agent_notices; DROP TABLE agent_run_models;
             ALTER TABLE sessions DROP COLUMN agent_setting;
             UPDATE meta SET value='3' WHERE key='parser_version';
             PRAGMA user_version = 4;",
        )
        .unwrap();
    }
    let again = start_in(&config, data, Tz::Fixed(0));
    assert_eq!(again.one("PRAGMA user_version"), atlas_core::cache::SCHEMA_VERSION);
    assert_eq!(totals(&again), fresh);
    assert_eq!(
        again.db().query_row("SELECT agent_setting FROM sessions WHERE session_id=?1", [S2], |r| r.get::<_, Option<String>>(0)).unwrap().as_deref(),
        Some("code-reviewer")
    );
}

#[test]
fn a_full_reread_leaves_the_ledger_unchanged() {
    let fx = fx();
    let dump = |fx: &Fx| -> String {
        let c = fx.db();
        let mut out = String::new();
        for q in [
            "SELECT group_concat(session_id||agent_id||agent_type||ifnull(end_status,'-')||ifnull(verdict,'-')||findings_n||tool_calls||first_ts||last_ts, ';') FROM (SELECT * FROM agent_runs ORDER BY 1,2)",
            "SELECT group_concat(kind||tool_use_id||target, ';') FROM (SELECT * FROM agent_links ORDER BY 1,3,4)",
            "SELECT group_concat(agent_id||ord||text, ';') FROM (SELECT * FROM review_findings ORDER BY 1,2,3)",
        ] {
            out.push_str(&c.query_row(q, [], |r| r.get::<_, Option<String>>(0)).unwrap().unwrap_or_default());
            out.push('|');
        }
        out
    };
    let before = dump(&fx);
    fx.full_reread();
    assert_eq!(dump(&fx), before);
    fx.rescan();
    assert_eq!(dump(&fx), before);
}

#[test]
fn the_scorecard_counts_ends_time_and_the_started_from_split() {
    let fx = fx();
    let all = fx.engine.agent_scorecard(&ScorecardArgs::default()).unwrap();
    assert_eq!(all.total_runs, 12);
    let coder = card(&all, "coder");
    assert_eq!(coder.runs, 5);
    assert_eq!((coder.ends.finished, coder.ends.unknown, coder.ends.errored, coder.ends.stopped), (4, 1, 0, 0));
    assert_eq!(coder.finish_rate, Some(1.0));
    assert_eq!(coder.weekly.len(), 12);
    assert_eq!(coder.weekly.iter().sum::<u32>(), 5);
    assert_eq!((coder.started.interactive, coder.started.headless), (5, 0));
    assert!(!coder.reviewer);
    let ex = card(&all, "Explore");
    assert_eq!(ex.ends.stopped, 1);
    assert_eq!(ex.finish_rate, Some(0.0));
    assert_eq!(card(&all, "general-purpose").ends.errored, 1);
    // The median is of each helper's own span: W1 115 s, W2 115 s, W3 120 s, W4 140 s, W7 50 s... never summed.
    let m = coder.duration_ms_median.unwrap();
    assert!((100_000..=140_000).contains(&m), "{m}");
    // The headless run is the code-reviewer's second run and the only Headless one.
    let cr = card(&all, "code-reviewer");
    assert_eq!((cr.started.interactive, cr.started.headless), (2, 1));
    let head = fx.engine.agent_scorecard(&ScorecardArgs { started_from: StartedFrom::Headless, ..Default::default() }).unwrap();
    assert_eq!(head.total_runs, 1);
    assert_eq!(head.types.len(), 1);
    assert_eq!(head.types[0].recent[0].agent_id, "");
    let one = fx.engine.agent_scorecard(&ScorecardArgs { agent_type: Some("verifier".into()), ..Default::default() }).unwrap();
    assert_eq!(one.types.len(), 1);
    assert_eq!(one.types[0].display_name, "Verifier");
    // The range: the chats sit 2.4 days before NOW, so a 2-day window is empty and a 3-day one holds all 12.
    let none = fx.engine.agent_scorecard(&ScorecardArgs { days: Some(2), ..Default::default() }).unwrap();
    assert_eq!(none.total_runs, 0);
    assert!(none.types.is_empty());
    assert_eq!(fx.engine.agent_scorecard(&ScorecardArgs { days: Some(3), ..Default::default() }).unwrap().total_runs, 12);
    assert!(all.history_days.unwrap() >= 2);
    // The newest run comes first and its cost can be priced or honestly unpriced.
    let rows = &coder.recent;
    assert!(rows.windows(2).all(|w| w[0].started >= w[1].started));
}

#[test]
fn themes_need_three_findings_from_two_runs() {
    let fx = fx();
    let t = fx.engine.review_themes(&ThemeArgs::default()).unwrap();
    // The fixture has one reviewer run with findings; nothing repeats, so no theme.
    assert_eq!(t.findings, 3);
    assert!(t.themes.is_empty());
    assert_eq!(t.total, 0);
}

#[test]
fn the_debrief_gathers_one_chats_helpers_and_reviews() {
    let fx = fx();
    let d = fx.engine.run_debrief(&DebriefArgs { session_id: S1.into(), since: None }).unwrap().unwrap();
    assert_eq!(d.helpers.len(), 11);
    assert_eq!(d.ends.finished, 8);
    assert_eq!(d.ends.errored, 1);
    assert_eq!(d.ends.stopped, 1);
    assert_eq!(d.ends.unknown, 1);
    assert_eq!(d.open.len(), 1);
    assert_eq!(d.open[0].agent_id, id(11));
    assert_eq!((d.reviews.passed, d.reviews.findings, d.reviews.no_verdict), (3, 1, 0));
    assert_eq!(d.reviews.sent_back, 1);
    // Since the 4th dispatch: only later helpers.
    let late = fx.engine.run_debrief(&DebriefArgs { session_id: S1.into(), since: Some(1_793_956_800_000) }).unwrap().unwrap();
    assert_eq!(late.helpers.len(), 3);
    assert!(fx.engine.run_debrief(&DebriefArgs { session_id: "nope".into(), since: None }).unwrap().is_none());
}

// Every run carries its exact model id and recorded effort; a model the price list has never
// heard of is still counted and named from its id; no recorded effort stays "none".
#[test]
fn runs_carry_their_model_and_effort() {
    let fx = fx();
    let sc = fx.engine.agent_scorecard(&ScorecardArgs::default()).unwrap();
    let coder = card(&sc, "coder");
    let mix: Vec<(&str, &str, Option<&str>, u32, u32)> = coder
        .mix
        .iter()
        .map(|m| (m.model.as_str(), m.model_name.as_str(), m.effort.as_deref(), m.messages, m.runs))
        .collect();
    assert_eq!(
        mix,
        vec![
            ("claude-sonnet-5-5", "Sonnet 5.5", Some("high"), 6, 3),
            ("claude-fable-5-2", "Fable 5.2", None, 2, 1),
            ("claude-opus-5-5", "Opus 5.5", Some("medium"), 2, 1),
        ]
    );
    assert_eq!(coder.top_model.as_ref().unwrap().model_name, "Sonnet 5.5");
    // Per run: W2 ran on Opus 5.5 at medium; W3 on a new model with no effort recorded.
    let by_agent = |a: &str| coder.recent.iter().find(|r| r.agent_id == a).unwrap().model.clone().unwrap();
    let w2 = by_agent(&id(3));
    assert_eq!((w2.model.as_str(), w2.model_name.as_str(), w2.effort.as_deref()), ("claude-opus-5-5", "Opus 5.5", Some("medium")));
    let w3 = by_agent(&id(5));
    assert_eq!((w3.model_name.as_str(), w3.effort), ("Fable 5.2", None));
    // The chat that ran as an agent has its own model row too.
    let cr = card(&sc, "code-reviewer");
    assert!(cr.recent.iter().any(|r| r.agent_id.is_empty() && r.model.is_some()));
    // The debrief names them as well.
    let d = fx.engine.run_debrief(&DebriefArgs { session_id: S1.into(), since: None }).unwrap().unwrap();
    assert_eq!(d.helpers.iter().filter(|h| h.model.is_some()).count(), 11);
    // A full re-read does not double the counts.
    fx.full_reread();
    let again = fx.engine.agent_scorecard(&ScorecardArgs::default()).unwrap();
    assert_eq!(card(&again, "coder").mix, coder.mix);
}

#[test]
fn effort_is_read_from_the_top_level_keys_only() {
    use atlas_core::usage::line::effort_of;
    let line = |content: &str, tail: &str| format!(r#"{{"type":"assistant","message":{{"model":"m","content":[{content}],"usage":{{"input_tokens":1}}}}{tail}}}"#);
    assert_eq!(effort_of(line("", r#","effort":"high","perTurnEffort":"medium","userType":"external""#).as_bytes()).as_deref(), Some("medium"));
    assert_eq!(effort_of(line("", r#","effort":"XHigh","userType":"external""#).as_bytes()).as_deref(), Some("xhigh"));
    // None recorded is None, never a guess.
    assert_eq!(effort_of(line("", r#","userType":"external""#).as_bytes()), None);
    // A tool input that happens to hold the key is not the level.
    let inner = r#"{"type":"tool_use","input":{"effort":"max","perTurnEffort":"max"}}"#;
    assert_eq!(effort_of(line(inner, r#","userType":"external""#).as_bytes()), None);
    assert_eq!(effort_of(b"{}"), None);
}

#[test]
fn model_ids_are_named_from_the_id() {
    assert_eq!(model_name("claude-opus-5-5"), "Opus 5.5");
    assert_eq!(model_name("claude-opus-5-5-20261001"), "Opus 5.5");
    assert_eq!(model_name("claude-fable-5-2"), "Fable 5.2");
    assert_eq!(model_name("claude-sonnet-4-5-20250929"), "Sonnet 4.5");
    assert_eq!(model_name("claude-3-5-sonnet-20241022"), "Sonnet 3.5");
    assert_eq!(model_name("claude-opus-4"), "Opus 4");
    assert_eq!(model_name("claude-haiku-5-5[1m]"), "Haiku 5.5");
    // Shapes it cannot read stay exactly as written, never dropped or guessed.
    assert_eq!(model_name("gpt-9"), "gpt-9");
    assert_eq!(model_name("claude-new-fancy-7"), "claude-new-fancy-7");
    assert_eq!(model_name("claude-opus-5-5-6-7"), "claude-opus-5-5-6-7");
}
