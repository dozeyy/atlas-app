//! The accuracy fixture (`tools/make-fixtures.py` -> `accuracy_fx`): the shapes a recount of a
//! real machine turned up. Streamed copies, a zeroed rewrite of a reply, effort per reply,
//! new and unknown model ids, a helper on a sidechain.

mod common;

use std::fs;
use std::io::Write;

use atlas_core::usage::query::{EffortUse, ScopeArgs};
use atlas_core::usage::time::Tz;
use common::*;

const S: &str = "acc00001-eeee-4eee-8eee-000000000001";

fn mix(v: &[(&str, u64)]) -> Vec<EffortUse> {
    v.iter().map(|(e, n)| EffortUse { effort: (*e).into(), replies: *n }).collect()
}

#[test]
fn totals_match_the_independent_recount() {
    let fx = start(&fixture("claude-accuracy"), Tz::Fixed(0));
    assert_eq!(fx.one("SELECT COUNT(*) FROM messages"), 7, "streamed copies and the rewrite are one reply each");
    let m = fx.month().tokens;
    // The same numbers `python tools/recount.py --projects fixtures/claude-accuracy/projects` prints.
    assert_eq!((m.input, m.output, m.cache_write5m, m.cache_write1h, m.cache_read), (220, 570, 1000, 0, 13000));
}

#[test]
fn a_zeroed_rewrite_never_replaces_the_real_reply() {
    let fx = start(&fixture("claude-accuracy"), Tz::Fixed(0));
    assert_eq!(fx.one("SELECT output FROM messages WHERE msg_key LIKE 'msg_Z|%'"), 300);
    assert_eq!(fx.one("SELECT cr FROM messages WHERE msg_key LIKE 'msg_Z|%'"), 8000);
    assert_eq!(fx.one("SELECT output FROM messages WHERE msg_key LIKE 'msg_ST|%'"), 120, "the fullest streamed copy");
}

#[test]
fn a_zeroed_rewrite_in_a_later_read_does_not_count_either() {
    let dir = tempfile::tempdir().unwrap();
    copy_tree(&fixture("claude-accuracy"), dir.path());
    let fx = start(dir.path(), Tz::Fixed(0));
    let before = fx.month().tokens;
    let path = dir.path().join("projects/-fixture-accuracy").join(format!("{S}.jsonl"));
    let mut f = fs::OpenOptions::new().append(true).open(&path).unwrap();
    writeln!(
        f,
        r#"{{"type":"assistant","uuid":"acc-late","sessionId":"{S}","timestamp":"2026-11-06T11:00:00.000Z","cwd":"/fixture/accuracy","requestId":"req_ST","message":{{"id":"msg_ST","model":"claude-fable-5-2","usage":{{"input_tokens":0,"output_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"cache_creation":{{"ephemeral_5m_input_tokens":1000,"ephemeral_1h_input_tokens":0}}}}}}}}"#
    )
    .unwrap();
    drop(f);
    fx.rescan();
    assert_eq!(fx.one("SELECT output FROM messages WHERE msg_key LIKE 'msg_ST|%'"), 120);
    assert_eq!(fx.month().tokens, before, "nothing moved");
}

#[test]
fn effort_is_stored_per_reply_and_never_guessed() {
    let fx = start(&fixture("claude-accuracy"), Tz::Fixed(0));
    let effort = |k: &str| -> Option<String> {
        fx.db().query_row("SELECT effort FROM messages WHERE msg_key LIKE ?1", [format!("{k}|%")], |r| r.get(0)).unwrap()
    };
    assert_eq!(effort("msg_ST").as_deref(), Some("high"));
    assert_eq!(effort("msg_Z").as_deref(), Some("xhigh"), "older lines carry `effort` only");
    assert_eq!(effort("msg_NOEFF"), None, "absent stays absent");
    assert_eq!(effort("msg_SUBA").as_deref(), Some("max"), "perTurnEffort wins over effort");
}

#[test]
fn sessions_helpers_and_models_carry_the_effort_mix() {
    let fx = start(&fixture("claude-accuracy"), Tz::Fixed(0));
    let d = fx.engine.session_detail(S).unwrap().expect("the session");
    assert_eq!(d.row.main_model, "claude-fable-5-2", "the main thread's biggest model");
    assert_eq!(d.row.efforts, mix(&[("high", 2), ("low", 1), ("medium", 1), ("xhigh", 1)]), "main thread only, ties by the ladder");
    let fable = d.by_model.iter().find(|m| m.model == "claude-fable-5-2").unwrap();
    assert_eq!(fable.efforts, mix(&[("high", 2)]));
    let sonnet = d.by_model.iter().find(|m| m.model == "claude-sonnet-5-5").unwrap();
    assert!(sonnet.efforts.is_empty());
    let helper = d.agents.iter().find(|a| a.agent_id == "accsub").expect("the helper");
    assert_eq!(helper.model, "claude-haiku-5-5");
    assert_eq!(helper.efforts, mix(&[("max", 1)]));
    let a = fx.engine.agent_detail(S, "accsub").unwrap().expect("helper detail");
    assert_eq!(a.by_model[0].efforts, mix(&[("max", 1)]));
}

#[test]
fn new_models_are_priced_and_unknown_ones_are_flagged() {
    let fx = start(&fixture("claude-accuracy"), Tz::Fixed(0));
    let r = fx
        .engine
        .scope_report(&ScopeArgs { from: "2026-11-06".into(), to: "2026-11-06".into(), project_key: None, bucket: "day".into(), top: 10 })
        .unwrap();
    let known = |id: &str| r.by_model.iter().find(|m| m.model == id).unwrap_or_else(|| panic!("{id}: {:?}", r.by_model)).known;
    assert!(known("claude-fable-5-2"));
    assert!(known("claude-mythos-5-2"));
    assert!(!known("claude-nova-9-1"));
    let opus = r.by_model.iter().find(|m| m.model == "claude-opus-5-5").unwrap();
    assert_eq!(opus.efforts, mix(&[("xhigh", 1)]));
    // Fable 5.2: (100 + 10) in at $8, (120 + 20) out at $40, 1000 5m writes at $10, 5000 reads at $0.20.
    let fable = r.by_model.iter().find(|m| m.model == "claude-fable-5-2").unwrap();
    let want = (110.0 * 8.0 + 140.0 * 40.0 + 1000.0 * 10.0 + 5000.0 * 0.2) / 1e6;
    assert!((fable.cost.usd.unwrap() - want).abs() < 1e-12, "{:?} vs {want}", fable.cost);
}

#[test]
fn the_effort_column_migrates_in_and_a_rolled_back_version_still_opens() {
    let data = tempfile::tempdir().unwrap();
    // A version-4 cache (no effort column) gains it.
    let old = data.path().join("v4.sqlite");
    {
        let mut c = rusqlite::Connection::open(&old).unwrap();
        atlas_core::cache::migrate::migrate(&mut c).unwrap();
        c.execute_batch("ALTER TABLE messages DROP COLUMN effort; PRAGMA user_version = 4;").unwrap();
    }
    let opened = atlas_core::cache::open_writer(&old).unwrap();
    let n: i64 = opened.conn.query_row("SELECT COUNT(*) FROM pragma_table_info('messages') WHERE name='effort'", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 1);
    drop(opened);
    // A cache that already has the column but says version 4 (rolled back) opens too.
    let rolled = data.path().join("rolled.sqlite");
    {
        let mut c = rusqlite::Connection::open(&rolled).unwrap();
        atlas_core::cache::migrate::migrate(&mut c).unwrap();
        c.execute_batch("PRAGMA user_version = 4;").unwrap();
    }
    let opened = atlas_core::cache::open_writer(&rolled).unwrap();
    let v: i64 = opened.conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
    assert_eq!(v, atlas_core::cache::SCHEMA_VERSION);
}
