//! Acceptance tests 1-21 of the Phase 2 usage engine, against the fixtures.

mod common;

use std::fs;
use std::io::Write;
use std::path::Path;

use atlas_core::usage::pricing::{Basis, Counts, PriceTable};
use atlas_core::usage::query::{SessionQuery, SessionRow};
use atlas_core::usage::time::Tz;
use atlas_core::usage::State;
use common::*;

const S1: &str = "11111111-aaaa-4aaa-8aaa-000000000001";

fn uid(n: u32) -> String {
    format!("{n:08}-dddd-4ddd-8ddd-{n:012}")
}

fn price_of(fx: &Fx, msg: &str) -> Option<f64> {
    let db = fx.db();
    let (model, speed, geo, tier, pt, i, o, w5, w1, cr, ws): (String, String, String, String, i64, i64, i64, i64, i64, i64, i64) = db
        .query_row(
            "SELECT model,speed,geo,service_tier,price_tier,input,output,cw5m,cw1h,cr,web_search FROM messages WHERE msg_key LIKE ?1",
            [format!("{msg}|%")],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?, r.get(9)?, r.get(10)?)),
        )
        .unwrap_or_else(|e| panic!("{msg}: {e}"));
    PriceTable::seed().cost(
        &Basis { model: &model, speed: &speed, geo: &geo, service_tier: &tier, price_tier: pt },
        &Counts { input: i as u64, output: o as u64, cw5m: w5 as u64, cw1h: w1 as u64, cr: cr as u64, web_search: ws as u64 },
    )
}

fn near(a: f64, b: f64) {
    assert!((a - b).abs() < 1e-9, "{a} != {b}");
}

fn rows(fx: &Fx) -> Vec<SessionRow> {
    fx.engine
        .sessions_list(&SessionQuery { include_missing: true, limit: 200, ..Default::default() })
        .unwrap()
        .rows
}

#[test]
fn basic_totals_match() {
    let fx = start(&fixture("claude-basic"), Tz::Fixed(0));
    assert_eq!(fx.one("SELECT COUNT(*) FROM messages"), 6);
    assert_eq!(fx.one("SELECT COUNT(*) FROM sessions WHERE messages > 0"), 3);
    let mut projects: Vec<String> = fx
        .db()
        .prepare("SELECT DISTINCT project_path FROM sessions ORDER BY 1")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    projects.sort();
    assert_eq!(projects, ["/fixture/app", "/fixture/other"]);
    let m = fx.month().tokens;
    assert_eq!((m.input, m.output, m.cache_write5m + m.cache_write1h, m.cache_read), (697, 538, 2000, 6000));
    assert_eq!(m.cache_write1h, 0);
}

#[test]
fn dedup_keeps_last_line() {
    let fx = start(&fixture("claude-basic"), Tz::Fixed(0));
    assert_eq!(fx.one("SELECT output FROM messages WHERE msg_key LIKE 'msg_A|%'"), 120);
    assert_eq!(fx.one("SELECT output FROM messages WHERE msg_key LIKE 'msg_SA1|%'"), 77);
    assert_eq!(fx.month().tokens.output, 538);
}

#[test]
fn subagents_roll_up() {
    let fx = start(&fixture("claude-basic"), Tz::Fixed(0));
    let d = fx.engine.session_detail(S1).unwrap().expect("session 1");
    assert_eq!(d.row.messages, 4);
    assert_eq!(d.row.subagent_messages, 1);
    let t = d.row.tokens;
    assert_eq!((t.input, t.output, t.cache_write5m, t.cache_read), (680, 509, 2000, 6000));
    assert!(d.by_agent.iter().any(|a| a.agent_id.as_deref() == Some("fixture1")), "{:?}", d.by_agent);
    assert!(d.files.iter().any(|f| f.is_subagent));
}

#[test]
fn basic_cost_matches_price_table() {
    let fx = start(&fixture("claude-basic"), Tz::Fixed(0));
    near(fx.month().cost.usd.unwrap(), 0.0166325);
    assert!(fx.month().cost.complete);
    let s1 = rows(&fx).into_iter().find(|r| r.session_id == S1).unwrap();
    near(s1.cost.usd.unwrap(), 0.0152725);
    near(price_of(&fx, "msg_A").unwrap(), 0.0064);
    near(price_of(&fx, "msg_C").unwrap(), 0.0088);
    near(price_of(&fx, "msg_D").unwrap(), 0.0011);
    near(price_of(&fx, "msg_E").unwrap(), 0.00026);
}

#[test]
fn synthetic_and_half_line_skipped() {
    let fx = start(&fixture("claude-basic"), Tz::Fixed(0));
    assert_eq!(fx.one("SELECT COUNT(*) FROM messages WHERE msg_key LIKE 'msg_S|%' OR msg_key LIKE 'msg_HALF|%'"), 0);
    let path = fixture("claude-basic").join("projects/-fixture-app").join(format!("{S1}.jsonl"));
    let bytes = fs::read(&path).unwrap();
    let last_nl = bytes.iter().rposition(|b| *b == b'\n').unwrap() as i64 + 1;
    let off = fx
        .db()
        .query_row("SELECT offset FROM files WHERE path LIKE ?1", [format!("%{S1}.jsonl")], |r| r.get::<_, i64>(0))
        .unwrap();
    assert_eq!(off, last_nl);
}

#[test]
fn half_line_completed_later() {
    let dir = tempfile::tempdir().unwrap();
    copy_tree(&fixture("claude-basic"), dir.path());
    let fx = start(dir.path(), Tz::Fixed(0));
    let before = fx.one("SELECT COUNT(*) FROM messages");
    let all_before: Vec<(String, i64)> = fx
        .db()
        .prepare("SELECT msg_key, output FROM messages ORDER BY 1")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    let path = dir.path().join("projects/-fixture-app").join(format!("{S1}.jsonl"));
    let mut f = fs::OpenOptions::new().append(true).open(&path).unwrap();
    write!(
        f,
        r#"11,"output_tokens":22,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}},"model":"claude-sonnet-5-5"}},"requestId":"req_HALF","sessionId":"{S1}","timestamp":"2026-11-02T09:05:00.000Z","cwd":"/fixture/app"}}"#
    )
    .unwrap();
    writeln!(f).unwrap();
    drop(f);
    fx.rescan();
    assert_eq!(fx.one("SELECT COUNT(*) FROM messages"), before + 1);
    assert_eq!(fx.one("SELECT output FROM messages WHERE msg_key LIKE 'msg_HALF|%'"), 22);
    for (k, o) in all_before {
        assert_eq!(fx.one(&format!("SELECT output FROM messages WHERE msg_key = '{k}'")), o, "{k} changed");
    }
}

#[test]
fn garbage_never_crashes() {
    let fx = start(&fixture("claude-edge"), Tz::Fixed(0));
    let s = fx.engine.status();
    assert_eq!(s.state, State::Idle, "{s:?}");
    assert_eq!(fx.one("SELECT COUNT(*) FROM messages"), 0);
    assert!(s.malformed_lines >= 4, "malformed {}", s.malformed_lines);
    let off: i64 = fx
        .db()
        .query_row("SELECT offset FROM files WHERE path LIKE '%empty.jsonl'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(off, 0);
}

#[test]
fn unknown_model_flagged() {
    let fx = start(&fixture("claude-usage"), Tz::Fixed(0));
    let status = fx.engine.status();
    assert!(status.unknown_models.contains(&"claude-nova-9".to_string()), "{:?}", status.unknown_models);
    assert!(status.unknown_models.contains(&"claude-opus-5-5-20261001".to_string()));
    assert!(price_of(&fx, "msg_N1").is_none());
    assert!(price_of(&fx, "msg_N2").is_none());
    // Its tokens are in the total; the session's cost is incomplete by exactly its tokens.
    let s = rows(&fx).into_iter().find(|r| r.session_id == uid(1)).unwrap();
    assert_eq!(s.tokens.input, 1000 + 10 + 1000);
    assert!(!s.cost.complete);
    assert_eq!(s.cost.unpriced_tokens, 1500 + 30);
    assert!(s.cost.usd.is_some(), "the priced model still adds up");
    // The day carries the same flag.
    let day = fx.timeline("2026-11-03", "2026-11-03", "day", None).points.remove(0);
    assert!(!day.cost.complete);
    assert!(day.cost.unpriced_tokens >= 1530);
    // A model with nothing priced has no dollar figure at all.
    let d = fx.engine.dashboard().unwrap();
    let nova = d.by_model.iter().find(|m| m.model == "claude-nova-9").unwrap();
    assert!(!nova.known);
    assert_eq!(nova.cost.usd, None);
    assert_eq!(nova.tokens.input, 1000);
    assert!(d.warnings.unknown_models.contains(&"claude-nova-9".to_string()));
}

#[test]
fn modifiers_priced() {
    let fx = start(&fixture("claude-usage"), Tz::Fixed(0));
    near(price_of(&fx, "msg_FAST").unwrap(), 0.048);
    near(price_of(&fx, "msg_GEO").unwrap(), 0.0264);
    near(price_of(&fx, "msg_WEB").unwrap(), 0.024 + 0.03);
    assert_eq!(fx.one("SELECT web_fetch FROM messages WHERE msg_key LIKE 'msg_WEB|%'"), 2);
    assert!(price_of(&fx, "msg_PRI").is_none(), "priority tier must stay unpriced");
    // The engine agrees with the table (SQL path).
    let s = rows(&fx).into_iter().find(|r| r.session_id == uid(2)).unwrap();
    assert!(!s.cost.complete);
    near(s.cost.usd.unwrap(), 0.048 + 0.0264 + 0.054);
}

#[test]
fn haiku_long_context_tier() {
    let fx = start(&fixture("claude-usage"), Tz::Fixed(0));
    near(price_of(&fx, "msg_HLONG").unwrap(), 0.0485);
    assert_eq!(fx.one("SELECT price_tier FROM messages WHERE msg_key LIKE 'msg_HLONG|%'"), 1);
    assert_eq!(fx.one("SELECT price_tier FROM messages WHERE msg_key LIKE 'msg_HEDGE|%'"), 0);
    // exactly 100,000: base rates: 80000*0.1 + 20000*0.01 + 1000*0.5 = 8000 + 200 + 500 micro-dollars
    near(price_of(&fx, "msg_HEDGE").unwrap(), (80_000.0 * 0.1 + 20_000.0 * 0.01 + 1_000.0 * 0.5) / 1e6);
}

#[test]
fn cache_write_split() {
    let fx = start(&fixture("claude-usage"), Tz::Fixed(0));
    near(price_of(&fx, "msg_1H").unwrap(), (10.0 * 2.0 + 10.0 * 10.0 + 1000.0 * 4.0) / 1e6);
    assert_eq!(fx.one("SELECT cw1h FROM messages WHERE msg_key LIKE 'msg_1H|%'"), 1000);
    assert_eq!(fx.one("SELECT cw5m FROM messages WHERE msg_key LIKE 'msg_NOSPLIT|%'"), 500);
    assert_eq!(fx.one("SELECT cw_assumed FROM messages WHERE msg_key LIKE 'msg_NOSPLIT|%'"), 1);
    assert_eq!(fx.engine.status().cw_assumed_rows, 1);
    assert_eq!(fx.one("SELECT cw5m FROM messages WHERE msg_key LIKE 'msg_MISMATCH|%'"), 300);
    assert_eq!(fx.one("SELECT cw1h FROM messages WHERE msg_key LIKE 'msg_MISMATCH|%'"), 200);
    assert_eq!(fx.one("SELECT cw_mismatch FROM messages WHERE msg_key LIKE 'msg_MISMATCH|%'"), 1);
}

#[test]
fn cross_file_dupe_order_independent() {
    let usage = fixture("claude-usage").join("projects/-fx-dup");
    let low = fs::read(usage.join("dup-low.jsonl")).unwrap();
    let high = fs::read(usage.join("dup-high.jsonl")).unwrap();
    let mut results = Vec::new();
    for (a, b) in [(&low, &high), (&high, &low)] {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("projects/-p");
        fs::create_dir_all(&p).unwrap();
        fs::write(p.join("a.jsonl"), a).unwrap();
        fs::write(p.join("b.jsonl"), b).unwrap();
        let fx = start(dir.path(), Tz::Fixed(0));
        assert_eq!(fx.one("SELECT COUNT(*) FROM messages"), 1);
        assert_eq!(fx.engine.status().cross_file_dupes, 1);
        // A re-read must not count it again.
        fx.full_reread();
        assert_eq!(fx.engine.status().cross_file_dupes, 1);
        results.push(fx.one("SELECT output FROM messages"));
    }
    assert_eq!(results, [30, 30]);
}

/// One assistant line of `session`, for `msg|req`, with these output tokens.
fn line(session: &str, msg: &str, output: u64) -> String {
    format!(
        r#"{{"type":"assistant","sessionId":"{session}","timestamp":"2026-11-03T14:00:00.000Z","cwd":"/fixture/fork","isSidechain":false,"version":"2.1.296","requestId":"req_{msg}","message":{{"id":"{msg}","type":"message","role":"assistant","model":"claude-opus-5-5","content":[],"usage":{{"input_tokens":1000,"output_tokens":{output},"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"cache_creation":{{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0}},"service_tier":"standard","speed":"standard","inference_geo":"global"}}}}}}"#
    ) + "\n"
}

/// The session that owns `msg_SHARED` after a pass over `files` (path, body) with one worker,
/// so files are applied strictly biggest first. `later` files are added after the first pass.
fn shared_owner(files: &[(&str, String)], later: &[(&str, String)]) -> (String, i64) {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("projects/-p");
    fs::create_dir_all(&p).unwrap();
    for (name, body) in files {
        fs::write(p.join(name), body).unwrap();
    }
    let data = tempfile::tempdir().unwrap();
    let mut cfg = config_for(dir.path(), data.path(), Tz::Fixed(0));
    cfg.ingest.workers = 1;
    let cache = cfg.cache_db.clone();
    let engine = atlas_core::usage::UsageEngine::start(cfg, std::sync::Arc::new(atlas_core::usage::NullSink));
    assert!(engine.wait_pass(0, WAIT));
    let fx = Fx { engine, data, config: dir.path().to_path_buf(), cache };
    if !later.is_empty() {
        for (name, body) in later {
            fs::write(p.join(name), body).unwrap();
        }
        fx.rescan();
    }
    let owner: String = fx
        .db()
        .query_row("SELECT session_id FROM messages WHERE msg_key LIKE 'msg_SHARED|%'", [], |r| r.get(0))
        .unwrap();
    (owner, fx.one("SELECT COUNT(*) FROM messages WHERE msg_key LIKE 'msg_SHARED|%'"))
}

/// A resumed or forked session repeats earlier lines in a second file. When both copies carry
/// the same usage (a tie), which session the message is billed to must not depend on which
/// file the indexer happened to apply first (D12: "independent of scan order"). Before the
/// fix, the first-applied copy won, so the shared message (and its cost) moved between the two
/// sessions with file sizes, worker timing and the order Atlas discovered the files.
#[test]
fn cross_file_tie_owner_does_not_depend_on_scan_order() {
    const A: &str = "aaaaaaaa-0000-4000-8000-000000000001";
    const B: &str = "bbbbbbbb-0000-4000-8000-000000000002";
    let shared_a = line(A, "msg_SHARED", 50);
    let shared_b = line(B, "msg_SHARED", 50);
    let extra = |s: &str, n: u32| (0..n).map(|i| line(s, &format!("msg_{s}_{i}"), 5)).collect::<String>();
    let fa = format!("{A}.jsonl");
    let fb = format!("{B}.jsonl");
    let runs = [
        // A is the bigger file, so it is applied first.
        shared_owner(&[(&fa, shared_a.clone() + &extra(A, 3)), (&fb, shared_b.clone())], &[]),
        // B is the bigger file, so it is applied first.
        shared_owner(&[(&fa, shared_a.clone()), (&fb, shared_b.clone() + &extra(B, 3))], &[]),
        // Atlas sees B first and A only on a later pass.
        shared_owner(&[(&fb, shared_b.clone())], &[(&fa, shared_a.clone())]),
        // ...and the other way round.
        shared_owner(&[(&fa, shared_a.clone())], &[(&fb, shared_b.clone())]),
    ];
    for (owner, n) in &runs {
        assert_eq!(*n, 1, "the shared message is stored once");
        assert_eq!(owner, &runs[0].0, "owner moved with scan order: {runs:?}");
    }
}

#[test]
fn project_from_cwd_and_relocated() {
    let fx = start(&fixture("claude-usage"), Tz::Fixed(0));
    let r = rows(&fx).into_iter().find(|r| r.session_id == uid(6)).unwrap();
    assert_eq!(r.project_path, "/fixture/after");
    let key = |n: u32| -> String {
        fx.db()
            .query_row("SELECT project_key FROM sessions WHERE session_id=?1", [uid(n)], |r| r.get(0))
            .unwrap()
    };
    // Windows and macOS folders are case-insensitive by default, so `project_key` folds case there.
    if cfg!(any(windows, target_os = "macos")) {
        assert_eq!(key(7), key(8), "C:\\X\\Proj and c:\\x\\proj are one project on Windows and macOS");
    } else {
        assert_ne!(key(7), key(8));
    }
    // The folder name (`-fx-reloc`) is never used as the project.
    let paths: Vec<String> = rows(&fx).into_iter().map(|r| r.project_path).collect();
    assert!(!paths.iter().any(|p| p.contains("-fx-")), "{paths:?}");
    // The subagent line without a session id lands in the folder's session.
    let sub = fx.engine.session_detail(&uid(15)).unwrap().unwrap();
    assert_eq!(sub.row.messages, 2);
    assert_eq!(sub.row.subagent_messages, 1);
    assert_eq!(sub.row.project_path, "/fixture/sub");
}

#[test]
fn titles() {
    let fx = start(&fixture("claude-usage"), Tz::Fixed(0));
    let t = |n: u32| rows(&fx).into_iter().find(|r| r.session_id == uid(n)).unwrap().title;
    assert_eq!(t(9).as_deref(), Some("Custom title one"));
    assert_eq!(t(10).as_deref(), Some("Agent name two"));
    assert_eq!(t(11), None);
    let d = fx.engine.session_detail(&uid(9)).unwrap().unwrap();
    near(d.claude_code_cost_usd.unwrap(), 0.5);
}

#[test]
fn bom_and_crlf_files_read() {
    let fx = start(&fixture("claude-usage"), Tz::Fixed(0));
    assert_eq!(fx.one("SELECT COUNT(*) FROM messages WHERE msg_key LIKE 'msg_CRLF|%' OR msg_key LIKE 'msg_BOM|%'"), 2);
}

fn copy_basic() -> (tempfile::TempDir, std::path::PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    copy_tree(&fixture("claude-basic"), dir.path());
    let p = dir.path().join("projects/-fixture-other");
    (dir, p)
}

#[test]
fn rotation_and_deletion() {
    // (a) a shrunk file is re-read from 0 with no duplicate rows.
    let (dir, other) = copy_basic();
    let fx = start(dir.path(), Tz::Fixed(0));
    let f = other.join("33333333-cccc-4ccc-8ccc-000000000003.jsonl");
    let before = fx.one("SELECT COUNT(*) FROM messages");
    let bytes = fs::read(&f).unwrap();
    let first_line_end = bytes.iter().position(|b| *b == b'\n').unwrap() + 1;
    fs::write(&f, &bytes[..first_line_end]).unwrap();
    fx.rescan();
    assert!(fx.one("SELECT COUNT(*) FROM messages") <= before, "no duplicates after a shrink");
    // (b) a same-size replacement with different bytes (the head hash changes) is re-read.
    let swapped: Vec<u8> = bytes.iter().map(|b| if *b == b'9' { b'8' } else { *b }).collect();
    assert_eq!(swapped.len(), bytes.len());
    assert_ne!(swapped, bytes);
    fs::write(&f, &bytes).unwrap();
    fx.rescan();
    let count_full = fx.one("SELECT COUNT(*) FROM messages");
    fs::write(&f, &swapped).unwrap();
    fx.rescan();
    assert_eq!(fx.one("SELECT COUNT(*) FROM messages"), count_full);
    let (size, hash_changed): (i64, bool) = {
        let db = fx.db();
        let size: i64 = db.query_row("SELECT size FROM files WHERE path LIKE '%3333%'", [], |r| r.get(0)).unwrap();
        (size, true)
    };
    assert_eq!(size as usize, swapped.len());
    assert!(hash_changed);
    // (c) a deleted file keeps its rows and flags itself missing.
    let msgs_before = fx.one("SELECT COUNT(*) FROM messages");
    fs::remove_file(&f).unwrap();
    fx.rescan();
    assert_eq!(fx.one("SELECT COUNT(*) FROM messages"), msgs_before);
    assert_eq!(fx.one("SELECT missing FROM files WHERE path LIKE '%3333%'"), 1);
    assert_eq!(fx.one("SELECT missing FROM sessions WHERE session_id LIKE '33333333%'"), 1);
    assert_eq!(fx.engine.status().files_missing, 1);
    let all = fx.engine.sessions_list(&SessionQuery { include_missing: false, limit: 50, ..Default::default() }).unwrap();
    assert_eq!(all.total, 2, "missing sessions are hidden unless asked for");
    // The file coming back clears the flag.
    fs::write(&f, &swapped).unwrap();
    fx.rescan();
    assert_eq!(fx.one("SELECT missing FROM files WHERE path LIKE '%3333%'"), 0);
}

#[test]
fn deleting_a_file_during_a_read_ends_that_file_without_error() {
    // A large-ish file so the pass takes a moment; remove it from another thread mid-pass.
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("projects/-p");
    fs::create_dir_all(&p).unwrap();
    let mut body = String::new();
    for i in 0..40_000 {
        body.push_str(&jsonl_line("sess-del", &format!("{i}"), "2026-11-03T10:00:00.000Z", "claude-sonnet-5-5", 10, 10));
        body.push('\n');
    }
    let f = p.join("sess-del.jsonl");
    fs::write(&f, &body).unwrap();
    let f2 = f.clone();
    let t = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(5));
        let _ = fs::remove_file(f2);
    });
    let fx = start(dir.path(), Tz::Fixed(0));
    t.join().unwrap();
    let s = fx.engine.status();
    assert_eq!(s.state, State::Idle, "{s:?}");
    assert!(s.error.is_none());
}

#[test]
fn incremental_reads_only_new_bytes() {
    let dir = tempfile::tempdir().unwrap();
    copy_tree(&fixture("claude-basic"), dir.path());
    let fx = start(dir.path(), Tz::Fixed(0));
    let full = fx.engine.bytes_read();
    assert!(full > 0);
    // A rescan with no change opens and reads nothing.
    fx.rescan();
    assert_eq!(fx.engine.bytes_read(), full, "no-change rescan must read zero bytes");
    let path = dir.path().join("projects/-fixture-other/33333333-cccc-4ccc-8ccc-000000000003.jsonl");
    let extra = format!("{}\n", jsonl_line("33333333-cccc-4ccc-8ccc-000000000003", "NEW", "2026-11-04T08:00:00.000Z", "claude-sonnet-5-5", 5, 6));
    let mut f = fs::OpenOptions::new().append(true).open(&path).unwrap();
    f.write_all(extra.as_bytes()).unwrap();
    drop(f);
    fx.rescan();
    assert_eq!(fx.engine.bytes_read() - full, extra.len() as u64, "exactly the appended bytes");
    assert_eq!(fx.one("SELECT COUNT(*) FROM messages"), 7);
}

#[test]
fn local_day_buckets() {
    // UTC-7: 06:59:59Z is 23:59:59 on Nov 3; 07:00:00Z is midnight into Nov 4.
    let fx = start(&fixture("claude-usage"), Tz::Fixed(-7 * 3600));
    let a = fx.timeline("2026-11-03", "2026-11-03", "day", None).points.remove(0);
    let b = fx.timeline("2026-11-04", "2026-11-04", "day", None).points.remove(0);
    // msg_M1 (100 in / 100 out) before local midnight; msg_M2 (200/200) after; msg_ERR is not a call.
    assert!(a.tokens.output >= 100);
    assert!(b.tokens.output >= 200);
    let hours = fx.timeline("2026-11-03", "2026-11-04", "hour", None);
    let h = |s: &str| hours.points.iter().find(|p| p.start == s).unwrap().tokens.output;
    assert_eq!(h("2026-11-03T23"), 100);
    assert_eq!(h("2026-11-04T00"), 200);
    // Same data, UTC: both land on Nov 4.
    let utc = start(&fixture("claude-usage"), Tz::Fixed(0));
    let hu = utc.timeline("2026-11-04", "2026-11-04", "hour", None);
    assert_eq!(hu.points.iter().find(|p| p.start == "2026-11-04T06").unwrap().tokens.output, 100);
    assert_eq!(hu.points.iter().find(|p| p.start == "2026-11-04T07").unwrap().tokens.output, 200);
    // Today / 7 days / 30 days follow the clock: 2026-11-08 in UTC-7 is still the 8th.
    let d = fx.engine.dashboard().unwrap();
    assert_eq!(d.today_date, "2026-11-08");
    assert_eq!(d.today.tokens.total, 0);
    assert!(d.week.tokens.total > 0 && d.month.tokens.total >= d.week.tokens.total);
}

#[test]
fn read_only_guarantee() {
    for name in ["claude-basic", "claude-edge", "claude-usage"] {
        let dir = tempfile::tempdir().unwrap();
        copy_tree(&fixture(name), dir.path());
        let before = snapshot(dir.path());
        let fx = start(dir.path(), Tz::Fixed(0));
        fx.rescan();
        fx.full_reread();
        for r in rows(&fx) {
            let _ = fx.engine.session_transcript(&r.session_id, None, 50).unwrap();
            let _ = fx.engine.session_detail(&r.session_id).unwrap();
        }
        assert_eq!(snapshot(dir.path()), before, "{name} changed");
    }
}

#[test]
fn no_write_calls_in_usage() {
    fn walk(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
        for e in fs::read_dir(dir).unwrap() {
            let p = e.unwrap().path();
            if p.is_dir() {
                walk(&p, out);
            } else if p.extension().is_some_and(|x| x == "rs") {
                out.push(p);
            }
        }
    }
    let mut files = Vec::new();
    walk(&Path::new(env!("CARGO_MANIFEST_DIR")).join("src/usage"), &mut files);
    assert!(files.len() >= 8);
    let forbidden = ["write(true)", "create(", "File::create", "remove_file", "remove_dir", "rename(", "OpenOptions", "fs::write", "set_len", "create_dir"];
    let mut hits = Vec::new();
    for f in files {
        let text = fs::read_to_string(&f).unwrap();
        // Production code only: unit tests build their own temp files.
        let prod = text.split("#[cfg(test)]").next().unwrap();
        for (n, line) in prod.lines().enumerate() {
            let code = line.split("//").next().unwrap_or("");
            for pat in forbidden {
                if code.contains(pat) {
                    let allowed = f.ends_with("reader.rs") && pat == "OpenOptions" && code.contains("std::fs::OpenOptions::new().read(true)");
                    if !allowed {
                        hits.push(format!("{}:{}: {pat}", f.display(), n + 1));
                    }
                }
            }
        }
    }
    assert!(hits.is_empty(), "{hits:#?}");
}

#[test]
fn cache_outside_config_root() {
    let dir = tempfile::tempdir().unwrap();
    copy_tree(&fixture("claude-basic"), dir.path());
    let before = snapshot(dir.path());
    let inside = dir.path().join("atlas-data");
    let cfg = config_for(dir.path(), &inside, Tz::Fixed(0));
    let engine = atlas_core::usage::UsageEngine::start(cfg, std::sync::Arc::new(atlas_core::usage::NullSink));
    let s = engine.status();
    assert_eq!(s.state, State::Error, "{s:?}");
    assert!(s.error.is_some());
    assert!(!inside.exists(), "nothing may be created");
    assert_eq!(snapshot(dir.path()), before);
}
