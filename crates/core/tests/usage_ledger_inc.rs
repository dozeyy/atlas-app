//! The helper ledger across reads: what an incremental read leaves in the cache must equal what a
//! full re-read of the same files leaves (`docs/specs/agent-scorecard.md` D1-D10, review round of
//! ecfb7ce). Each test writes its own small config folder, indexes it, appends lines the way Claude
//! Code does (hours later, a message at a time) and compares with `full_reread`.

mod common;

use std::io::Write;
use std::path::{Path, PathBuf};

use atlas_core::usage::time::Tz;
use common::*;

const SID: &str = "dddd1004-0000-4000-8000-000000000004";

fn aid(n: u64) -> String {
    format!("a{n:016x}")
}

fn at(h: u32, m: u32, s: u32) -> String {
    format!("2026-11-06T{h:02}:{m:02}:{s:02}.000Z")
}

fn user(sid: &str, ts: &str, text: &str, side: bool) -> String {
    format!(
        r#"{{"type":"user","uuid":"uu-{ts}","parentUuid":null,"sessionId":"{sid}","timestamp":"{ts}","cwd":"/fixture/inc","isSidechain":{side},"version":"2.1.296","message":{{"role":"user","content":"{text}"}},"entrypoint":"cli","fixtureText":true}}"#
    )
}

/// One assistant line; `stop` is "end_turn", "tool_use" or "null". Lines that share `key` are one message.
fn asst(sid: &str, ts: &str, key: &str, text: &str, stop: &str, tool: bool, side: bool) -> String {
    let tool = if tool { r#",{"type":"tool_use","id":"toolu_x","name":"Read","input":{}}"# } else { "" };
    let stop = if stop == "null" { "null".to_string() } else { format!("\"{stop}\"") };
    format!(
        r#"{{"type":"assistant","uuid":"u-{key}-{ts}","sessionId":"{sid}","timestamp":"{ts}","cwd":"/fixture/inc","isSidechain":{side},"version":"2.1.296","entrypoint":"cli","requestId":"req_{key}","message":{{"id":"msg_{key}","type":"message","role":"assistant","model":"claude-sonnet-5-5","content":[{{"type":"text","text":"{text}"}}{tool}],"stop_reason":{stop},"usage":{{"input_tokens":10,"output_tokens":50,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"cache_creation":{{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0}},"server_tool_use":{{"web_search_requests":0,"web_fetch_requests":0}},"service_tier":"standard","speed":"standard","inference_geo":"global"}}}},"effort":"high","perTurnEffort":"high"}}"#
    )
}

struct Cfg {
    _dir: tempfile::TempDir,
    root: PathBuf,
}

impl Cfg {
    fn new() -> Cfg {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        std::fs::create_dir_all(root.join("projects/-fx-inc").join(SID).join("subagents")).unwrap();
        Cfg { _dir: dir, root }
    }
    fn chat(&self) -> PathBuf {
        self.root.join("projects/-fx-inc").join(format!("{SID}.jsonl"))
    }
    fn helper(&self, n: u64) -> PathBuf {
        self.root.join("projects/-fx-inc").join(SID).join("subagents").join(format!("agent-{}.jsonl", aid(n)))
    }
}

fn write(p: &Path, lines: &[String]) {
    let mut s = lines.join("\n");
    s.push('\n');
    std::fs::write(p, s).unwrap();
}

fn append(p: &Path, lines: &[String]) {
    let mut f = std::fs::OpenOptions::new().append(true).open(p).unwrap();
    for l in lines {
        writeln!(f, "{l}").unwrap();
    }
}

fn run_dump(fx: &Fx) -> String {
    let c = fx.db();
    let mut st = c
        .prepare(
            "SELECT agent_id||'|'||active_ms||'|'||resumes||'|'||ifnull(seg_start,'-')||'|'||ifnull(first_ts,'-')||'|'||ifnull(last_ts,'-')||'|'||
                    ifnull(last_stop,'-')||'|'||ifnull(end_status,'-')||'|'||ifnull(end_source,'-')||'|'||ifnull(verdict_word,'-')||'|'||tool_calls
             FROM agent_runs ORDER BY session_id, agent_id",
        )
        .unwrap();
    let rows: Vec<String> = st.query_map([], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect();
    rows.join("\n")
}

fn models_n(fx: &Fx, agent: &str) -> i64 {
    fx.db()
        .query_row("SELECT COALESCE(SUM(n),0) FROM agent_run_models WHERE agent_id = ?1", [agent], |r| r.get(0))
        .unwrap()
}

/// active_ms, resumes, seg_start, first_ts, last_ts, last_stop, end_status, end_source
type RunRow = (i64, i64, Option<i64>, Option<i64>, Option<i64>, Option<String>, Option<String>, Option<String>);

fn row_of(fx: &Fx, agent: &str) -> RunRow {
    fx.db()
        .query_row(
            "SELECT active_ms, resumes, seg_start, first_ts, last_ts, last_stop, end_status, end_source FROM agent_runs WHERE agent_id = ?1",
            [agent],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?)),
        )
        .unwrap()
}

fn start_cfg(c: &Cfg) -> Fx {
    start(&c.root, Tz::Fixed(0))
}

/// Finding 1: a helper indexed to its `end_turn`, woken hours later, read incrementally: the idle
/// gap is not work, the resume is counted once, and every column equals a full re-read.
#[test]
fn a_resume_appended_in_a_later_read_equals_a_full_reread() {
    let c = Cfg::new();
    write(&c.chat(), &[
        user(SID, &at(8, 59, 0), "[fixture parent]", false),
        user(SID, &at(9, 2, 0), "<task-notification>\\n<task-id>a0000000000000001</task-id>\\n<status>completed</status>\\n</task-notification>", false),
    ]);
    write(&c.helper(1), &[
        user(SID, &at(9, 0, 0), "[fixture prompt]", true),
        asst(SID, &at(9, 0, 10), "k1", "[fixture work]", "tool_use", true, true),
        asst(SID, &at(9, 1, 0), "k2", "[fixture report]", "end_turn", false, true),
    ]);
    let fx = start_cfg(&c);
    let (active, resumes, _, first, last, stop, ..) = row_of(&fx, &aid(1));
    assert_eq!((active, resumes, stop.as_deref()), (0, 0, Some("end_turn")));
    assert_eq!(last.unwrap() - first.unwrap(), 60_000);

    // Three hours later a message wakes the helper and it answers.
    append(&c.helper(1), &[
        user(SID, &at(12, 0, 0), "[fixture resume]", true),
        asst(SID, &at(12, 0, 10), "k3", "[fixture work]", "tool_use", true, true),
        asst(SID, &at(12, 0, 30), "k4", "[fixture report]", "end_turn", false, true),
    ]);
    fx.rescan();
    let (active, resumes, seg, first, last, stop, status, _) = row_of(&fx, &aid(1));
    assert_eq!((active, resumes), (60_000, 1), "the first stretch is one minute; the gap is not counted");
    assert_eq!(seg.unwrap() - first.unwrap(), 3 * 3_600_000);
    assert_eq!(last.unwrap() - seg.unwrap(), 30_000);
    assert_eq!((stop.as_deref(), status.as_deref()), (Some("end_turn"), Some("finished")));
    let inc = run_dump(&fx);
    fx.full_reread();
    assert_eq!(run_dump(&fx), inc);

    // Woken again, the message read alone: it is running again, whatever said it was done before
    // (the parent's notice, and the thread's old end_turn).
    append(&c.helper(1), &[user(SID, &at(13, 0, 0), "[fixture again]", true)]);
    fx.rescan();
    let (active, resumes, _, _, _, stop, status, source) = row_of(&fx, &aid(1));
    assert_eq!((active, resumes), (90_000, 2));
    assert_eq!((stop, status, source), (None, None, None), "a woken helper that has not answered is running");
    // A second message before the answer is not another resume.
    append(&c.helper(1), &[user(SID, &at(13, 5, 0), "[fixture more]", true)]);
    fx.rescan();
    assert_eq!(row_of(&fx, &aid(1)).1, 2);
    let inc = run_dump(&fx);
    fx.full_reread();
    assert_eq!(run_dump(&fx), inc);
}

/// Finding 3: a chat that ran as an agent keeps updating on later reads.
#[test]
fn a_chat_that_ran_as_an_agent_keeps_updating() {
    let c = Cfg::new();
    write(&c.chat(), &[
        format!(r#"{{"type":"agent-setting","agentSetting":"code-reviewer","sessionId":"{SID}"}}"#),
        user(SID, &at(10, 0, 0), "[fixture headless]", false),
        asst(SID, &at(10, 0, 20), "c1", "[fixture work]", "tool_use", true, false),
    ]);
    let fx = start_cfg(&c);
    assert_eq!(models_n(&fx, ""), 1);
    append(&c.chat(), &[
        asst(SID, &at(10, 2, 0), "c2", "[fixture report]\\nChecked.\\n\\nVerdict: pass", "end_turn", false, false),
    ]);
    fx.rescan();
    assert_eq!(models_n(&fx, ""), 2, "the second read was tracked");
    let (_, _, _, _, _, stop, status, _) = row_of(&fx, "");
    assert_eq!((stop.as_deref(), status.as_deref()), (Some("end_turn"), Some("finished")));
    assert_eq!(
        fx.db().query_row("SELECT verdict FROM agent_runs WHERE agent_id=''", [], |r| r.get::<_, Option<String>>(0)).unwrap().as_deref(),
        Some("pass")
    );
    let inc = run_dump(&fx);
    fx.full_reread();
    assert_eq!(run_dump(&fx), inc);
}

/// Finding 6: a message that streams as several lines and straddles the read offset counts once.
#[test]
fn a_message_straddling_the_read_offset_is_counted_once() {
    let c = Cfg::new();
    write(&c.helper(2), &[
        user(SID, &at(9, 0, 0), "[fixture prompt]", true),
        asst(SID, &at(9, 0, 5), "m1", "[fixture partial]", "null", false, true),
    ]);
    let fx = start_cfg(&c);
    assert_eq!(models_n(&fx, &aid(2)), 1);
    append(&c.helper(2), &[asst(SID, &at(9, 0, 9), "m1", "[fixture final]", "end_turn", false, true)]);
    fx.rescan();
    assert_eq!(models_n(&fx, &aid(2)), 1, "same message id and request id");
    append(&c.helper(2), &[user(SID, &at(9, 5, 0), "[fixture next]", true), asst(SID, &at(9, 5, 5), "m2", "[fixture more]", "end_turn", false, true)]);
    fx.rescan();
    assert_eq!(models_n(&fx, &aid(2)), 2);
    fx.full_reread();
    assert_eq!(models_n(&fx, &aid(2)), 2);
}

/// Finding 7: a final text too long to keep still says how the turn stopped.
#[test]
fn an_oversize_last_line_still_records_its_stop_reason() {
    let c = Cfg::new();
    let big = "x".repeat(300 * 1024);
    write(&c.helper(3), &[
        user(SID, &at(9, 0, 0), "[fixture prompt]", true),
        asst(SID, &at(9, 0, 5), "o1", "[fixture work]", "tool_use", true, true),
        asst(SID, &at(9, 0, 9), "o2", "[fixture report]\\nVerdict: pass", "end_turn", false, true),
    ]);
    let fx = start_cfg(&c);
    let (_, _, _, _, _, stop, _, _) = row_of(&fx, &aid(3));
    assert_eq!(stop.as_deref(), Some("end_turn"));
    assert_eq!(fx.one("SELECT COUNT(*) FROM agent_runs WHERE verdict_word IS NOT NULL"), 1);
    // The next turn is one huge line that ends it: the old verdict no longer stands for it.
    append(&c.helper(3), &[
        user(SID, &at(11, 0, 0), "[fixture resume]", true),
        asst(SID, &at(11, 0, 9), "o3", &big, "end_turn", false, true),
    ]);
    fx.rescan();
    let (_, resumes, _, _, last, stop, status, _) = row_of(&fx, &aid(3));
    assert_eq!(resumes, 1);
    assert_eq!(stop.as_deref(), Some("end_turn"));
    assert_eq!(status.as_deref(), Some("finished"));
    assert!(last.is_some());
    assert_eq!(fx.one("SELECT COUNT(*) FROM agent_runs WHERE verdict_word IS NOT NULL"), 0, "a stale verdict was kept");
}

/// Finding 8: a rewritten parent chat drops the notices it wrote, and a dispatch that names a helper
/// before its files exist is linked once they do.
#[test]
fn notices_follow_their_file_and_pending_links_heal() {
    let c = Cfg::new();
    write(&c.helper(4), &[user(SID, &at(9, 0, 0), "[fixture prompt]", true), asst(SID, &at(9, 0, 5), "n1", "[fixture work]", "tool_use", true, true)]);
    write(&c.chat(), &[
        user(SID, &at(8, 59, 0), "[fixture parent]", false),
        user(SID, &at(9, 3, 0), &format!("<task-notification>\\n<task-id>{}</task-id>\\n<status>completed</status>\\n</task-notification>", aid(4)), false),
    ]);
    let fx = start_cfg(&c);
    assert_eq!(row_of(&fx, &aid(4)).6.as_deref(), Some("finished"));
    // The chat is rewritten without the notice (a new version of the file).
    std::fs::remove_file(c.chat()).unwrap();
    write(&c.chat(), &[user(SID, &at(8, 58, 0), "[fixture parent rewritten and a little different]", false)]);
    fx.rescan();
    assert_eq!(fx.one("SELECT COUNT(*) FROM agent_notices"), 0);
    assert_eq!(row_of(&fx, &aid(4)).6, None, "the old notice no longer ends the run");

    // A dispatch names helper 5 by id before helper 5 exists.
    let dispatch = format!(
        r#"{{"type":"assistant","uuid":"u-d1","sessionId":"{SID}","timestamp":"{}","cwd":"/fixture/inc","isSidechain":false,"version":"2.1.296","entrypoint":"cli","requestId":"req_d1","message":{{"id":"msg_d1","type":"message","role":"assistant","model":"claude-sonnet-5-5","content":[{{"type":"tool_use","id":"toolu_d1","name":"Agent","input":{{"subagent_type":"code-reviewer","description":"Review","prompt":"Review the work of agent {}."}}}}],"stop_reason":"tool_use","usage":{{"input_tokens":10,"output_tokens":50}}}}}}"#,
        at(9, 10, 0),
        aid(5)
    );
    append(&c.chat(), &[dispatch]);
    fx.rescan();
    assert_eq!(fx.one("SELECT COUNT(*) FROM agent_links WHERE kind='dispatch' AND target=''"), 1);
    assert_eq!(fx.one("SELECT COUNT(*) FROM agent_link_pending"), 1);
    write(&c.helper(5), &[user(SID, &at(9, 11, 0), "[fixture prompt]", true), asst(SID, &at(9, 11, 5), "p1", "[fixture work]", "end_turn", false, true)]);
    fx.rescan();
    assert_eq!(fx.one(&format!("SELECT COUNT(*) FROM agent_links WHERE kind='dispatch' AND target='{}'", aid(5))), 1, "linked after the helper appeared");
    assert_eq!(fx.one("SELECT COUNT(*) FROM agent_links WHERE kind='dispatch' AND target=''"), 0);
    assert_eq!(fx.one("SELECT COUNT(*) FROM agent_link_pending"), 0);
}
