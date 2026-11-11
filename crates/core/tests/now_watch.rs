//! The Now engine against a fake Claude Code: a temp projects folder and a writer that
//! appends transcript lines the way Claude Code does. The real `~/.claude` is never touched.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use atlas_core::now::{NowConfig, NowEngine, NowSnapshot};
use atlas_core::usage::pricing::PriceTable;

struct Rig {
    _dir: tempfile::TempDir,
    projects: PathBuf,
    rx: Receiver<NowSnapshot>,
    engine: NowEngine,
}

fn start(setup: impl FnOnce(&Path)) -> Rig {
    start_with(None, setup)
}

fn start_with(typical: Option<atlas_core::now::TypicalSource>, setup: impl FnOnce(&Path)) -> Rig {
    let dir = tempfile::tempdir().unwrap();
    let projects = dir.path().join("projects");
    fs::create_dir_all(projects.join("proj-a")).unwrap();
    setup(&projects);
    let (tx, rx) = mpsc::channel();
    let tx = Mutex::new(tx);
    let sink = Arc::new(move |s: &NowSnapshot| {
        let _ = tx.lock().unwrap().send(s.clone());
    });
    let mut cfg = NowConfig::new(projects.clone(), PriceTable::seed());
    if let Some(t) = typical {
        cfg = cfg.with_typical(t);
    }
    let engine = NowEngine::start(cfg, sink);
    Rig { _dir: dir, projects, rx, engine }
}

/// Claude Code stamps each line as it writes it: the fake writer does the same.
fn now_iso() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

/// A time long gone, for transcripts that were only copied (a restore), never written to now.
const OLD: &str = "2026-01-02T10:00:00.000Z";

fn prompt() -> String {
    prompt_at(&now_iso())
}

fn prompt_at(ts: &str) -> String {
    format!(r#"{{"type":"user","timestamp":"{ts}","cwd":"C:\\w\\app","message":{{"role":"user","content":"TOPSECRETPROMPT please"}}}}"#)
}

fn tool(id: &str, name: &str, input: &str) -> String {
    tool_at(id, name, input, &now_iso())
}

fn tool_at(id: &str, name: &str, input: &str, ts: &str) -> String {
    format!(
        r#"{{"type":"assistant","timestamp":"{ts}","cwd":"C:\\w\\app","requestId":"r{id}","message":{{"id":"m{id}","model":"claude-opus-5-5","stop_reason":"tool_use","content":[{{"type":"text","text":"TOPSECRETREPLY"}},{{"type":"tool_use","id":"{id}","name":"{name}","input":{input}}}],"usage":{{"input_tokens":10,"output_tokens":5,"cache_creation_input_tokens":100,"cache_read_input_tokens":1000}}}}}}"#
    )
}

fn end_turn() -> String {
    format!(
        r#"{{"type":"assistant","timestamp":"{}","requestId":"rend","message":{{"id":"mend","model":"claude-opus-5-5","stop_reason":"end_turn","content":[{{"type":"text","text":"done"}}],"usage":{{"input_tokens":1,"output_tokens":1}}}}}}"#,
        now_iso()
    )
}

fn append(path: &Path, line: &str) {
    let mut f = OpenOptions::new().append(true).create(true).open(path).unwrap();
    writeln!(f, "{line}").unwrap();
}

/// Wait for a snapshot that satisfies `ok`; returns it and how long it took.
fn wait_for(rig: &Rig, limit: Duration, ok: impl Fn(&NowSnapshot) -> bool) -> Option<(NowSnapshot, Duration)> {
    let t0 = Instant::now();
    while t0.elapsed() < limit {
        if let Ok(s) = rig.rx.recv_timeout(limit.saturating_sub(t0.elapsed()))
            && ok(&s)
        {
            return Some((s, t0.elapsed()));
        }
    }
    None
}

#[test]
fn an_appended_tool_call_reaches_the_page_within_a_second() {
    let rig = start(|p| {
        let f = p.join("proj-a").join("sess-1.jsonl");
        append(&f, &prompt());
        append(&f, &tool("t0", "Read", r#"{"file_path":"C:\\w\\app\\README.md"}"#));
    });
    let (first, _) = wait_for(&rig, Duration::from_secs(5), |s| !s.chats.is_empty()).expect("the running chat is found");
    assert_eq!(first.chats.len(), 1);
    assert_eq!(first.chats[0].project, "app");
    assert_eq!(first.chats[0].steps.len(), 1);

    // The fake writer: Claude Code appends an edit.
    let f = rig.projects.join("proj-a").join("sess-1.jsonl");
    let t0 = Instant::now();
    append(&f, &tool("t1", "Edit", r#"{"file_path":"C:\\w\\app\\src\\App.tsx","old_string":"A","new_string":"B"}"#));
    let (snap, _) = wait_for(&rig, Duration::from_secs(5), |s| {
        s.chats.first().is_some_and(|c| c.steps.iter().any(|st| st.id == "t1"))
    })
    .expect("the new step arrives");
    let took = t0.elapsed();
    assert!(took < Duration::from_secs(1), "took {took:?}");
    let c = &snap.chats[0];
    assert_eq!((c.doing.verb.as_str(), c.doing.target.as_deref()), ("Editing", Some("src/App.tsx")));
    assert_eq!(c.tokens, 2 * 15, "input + output only, by default");
    // The four kinds are always there for the hover, and "all together" is their sum.
    assert_eq!((c.token_kinds.cache_write, c.token_kinds.cache_read), (200, 2000));
    assert_eq!(c.token_kinds.all(), 2 * 1115);
    assert!(c.cost_usd.is_some_and(|x| x > 0.0));
    let cost = c.cost_usd;
    // Turning the setting on re-counts the live chat without a restart; dollars do not move.
    rig.engine.set_count_cache(true);
    let (snap2, _) = wait_for(&rig, Duration::from_secs(5), |s| s.chats.first().is_some_and(|c| c.tokens == 2 * 1115))
        .expect("the snapshot is counted the new way");
    assert_eq!(snap2.chats[0].cost_usd, cost);
    rig.engine.set_count_cache(false);
    wait_for(&rig, Duration::from_secs(5), |s| s.chats.first().is_some_and(|c| c.tokens == 2 * 15)).expect("and back");
    assert_eq!(c.files.first().map(|f| (f.path.as_str(), f.edited)), Some(("src/App.tsx", true)));

    // The results come back and the turn ends: the chat is now waiting for the user.
    for id in ["t0", "t1"] {
        append(&f, &format!(r#"{{"type":"user","message":{{"content":[{{"type":"tool_result","tool_use_id":"{id}","content":"OUTPUT"}}]}}}}"#));
    }
    append(&f, &end_turn());
    let (snap, _) = wait_for(&rig, Duration::from_secs(5), |s| s.chats.first().is_some_and(|c| c.state == "waiting"))
        .expect("the chat waits for you");
    assert_eq!(snap.chats[0].doing.verb, "Waiting for you");

    // The engine's snapshot() agrees with what was pushed.
    assert_eq!(rig.engine.snapshot().chats.len(), 1);
    // Neither the prompt nor the reply text ever left the engine.
    let json = serde_json::to_string(&snap).unwrap();
    assert!(!json.contains("TOPSECRET"), "{json}");
    rig.engine.stop();
}

#[test]
fn a_helper_appears_with_its_own_name_and_spend() {
    let rig = start(|p| {
        let f = p.join("proj-a").join("sess-2.jsonl");
        append(&f, &prompt());
        append(&f, &tool("task", "Task", r#"{"subagent_type":"Explore","prompt":"TOPSECRETTASK"}"#));
    });
    wait_for(&rig, Duration::from_secs(5), |s| !s.chats.is_empty()).expect("chat found");
    let subs = rig.projects.join("proj-a").join("sess-2").join("subagents");
    fs::create_dir_all(&subs).unwrap();
    fs::write(subs.join("agent-aa11.meta.json"), r#"{"agentType":"Explore","description":"Find the callers"}"#).unwrap();
    let t0 = Instant::now();
    append(&subs.join("agent-aa11.jsonl"), &tool("h1", "Grep", r#"{"pattern":"zzz"}"#));
    let (snap, _) = wait_for(&rig, Duration::from_secs(5), |s| s.chats.first().is_some_and(|c| !c.helpers.is_empty()))
        .expect("the helper shows up");
    assert!(t0.elapsed() < Duration::from_secs(1), "took {:?}", t0.elapsed());
    let c = &snap.chats[0];
    assert_eq!(c.helpers[0].name, "Find the callers");
    assert_eq!(c.helpers[0].tokens, 15);
    assert_eq!(c.helpers[0].token_kinds.all(), 1115);
    assert!(c.doing.verb.starts_with("Waiting on"), "{}", c.doing.verb);
    assert!(!serde_json::to_string(&snap).unwrap().contains("TOPSECRET"));
    rig.engine.stop();
}

/// A fake usage cache: `runs` finished Explore runs of 20 tool calls, asked for how many times.
fn fake_typical(runs: u32, asked: Arc<std::sync::atomic::AtomicU32>) -> atlas_core::now::TypicalSource {
    Arc::new(move || {
        asked.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        atlas_core::now::TypicalAnswer::Ready(vec![atlas_core::usage::query::TypicalRun { agent_type: "Explore".into(), calls: 20, ms: 90_000, runs }])
    })
}

fn helper_rig(typical: atlas_core::now::TypicalSource) -> Rig {
    let rig = start_with(Some(typical), |p| {
        let f = p.join("proj-a").join("sess-3.jsonl");
        append(&f, &prompt());
        append(&f, &tool("task", "Task", r#"{"subagent_type":"Explore","prompt":"x"}"#));
    });
    wait_for(&rig, Duration::from_secs(5), |s| !s.chats.is_empty()).expect("chat found");
    let subs = rig.projects.join("proj-a").join("sess-3").join("subagents");
    fs::create_dir_all(&subs).unwrap();
    fs::write(subs.join("agent-bb22.meta.json"), r#"{"agentType":"Explore","description":"Find the callers"}"#).unwrap();
    append(&subs.join("agent-bb22.jsonl"), &tool("h1", "Grep", r#"{"pattern":"zzz"}"#));
    rig
}

#[test]
fn a_helper_carries_its_kinds_typical_run_once_there_are_enough_past_runs() {
    use std::sync::atomic::{AtomicU32, Ordering};
    let asked = Arc::new(AtomicU32::new(0));
    let rig = helper_rig(fake_typical(7, asked.clone()));
    let (snap, _) = wait_for(&rig, Duration::from_secs(5), |s| {
        s.chats.first().is_some_and(|c| c.helpers.first().is_some_and(|h| h.typical.is_some()))
    })
    .expect("the typical run reaches the helper");
    let h = &snap.chats[0].helpers[0];
    assert_eq!((h.agent_type.as_deref(), h.tool_calls), (Some("Explore"), 1));
    let t = h.typical.expect("typical");
    assert_eq!((t.calls, t.runs), (20, 7));

    // Many more updates later, the cache was still asked only once (it is never per update).
    let subs = rig.projects.join("proj-a").join("sess-3").join("subagents");
    for i in 0..15 {
        append(&subs.join("agent-bb22.jsonl"), &tool(&format!("g{i}"), "Grep", r#"{"pattern":"zzz"}"#));
        std::thread::sleep(Duration::from_millis(60));
    }
    wait_for(&rig, Duration::from_secs(5), |s| s.chats.first().is_some_and(|c| c.helpers.first().is_some_and(|h| h.tool_calls >= 16)))
        .expect("the calls keep counting");
    assert_eq!(asked.load(Ordering::SeqCst), 1);
    rig.engine.stop();
}

#[test]
fn too_few_past_runs_give_no_typical_run() {
    use std::sync::atomic::{AtomicU32, Ordering};
    let asked = Arc::new(AtomicU32::new(0));
    let rig = helper_rig(fake_typical(4, asked.clone()));
    wait_for(&rig, Duration::from_secs(5), |s| s.chats.first().is_some_and(|c| !c.helpers.is_empty())).expect("helper");
    // Wait until the (fake) cache has been asked, then let one more update through.
    let t0 = Instant::now();
    while asked.load(Ordering::SeqCst) == 0 && t0.elapsed() < Duration::from_secs(5) {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(asked.load(Ordering::SeqCst), 1);
    std::thread::sleep(Duration::from_millis(100));
    let subs = rig.projects.join("proj-a").join("sess-3").join("subagents");
    append(&subs.join("agent-bb22.jsonl"), &tool("g1", "Grep", r#"{"pattern":"yyy"}"#));
    let (snap, _) = wait_for(&rig, Duration::from_secs(5), |s| s.chats.first().is_some_and(|c| c.helpers.first().is_some_and(|h| h.tool_calls >= 2)))
        .expect("a later update");
    assert!(snap.chats[0].helpers[0].typical.is_none());
    rig.engine.stop();
}

#[test]
fn nothing_running_shows_the_last_chat_and_stays_quiet() {
    let rig = start(|p| {
        let f = p.join("proj-a").join("old.jsonl");
        append(&f, r#"{"type":"custom-title","customTitle":"Fix the build"}"#);
        append(&f, &tool("t", "Read", r#"{"file_path":"x"}"#));
        let hour_ago = SystemTime::now() - Duration::from_secs(3600);
        File::options().write(true).open(&f).unwrap().set_modified(hour_ago).unwrap();
    });
    let (snap, _) = wait_for(&rig, Duration::from_secs(5), |s| s.last.is_some()).expect("a last chat");
    assert!(snap.chats.is_empty());
    assert!(snap.watching);
    let last = snap.last.unwrap();
    assert_eq!((last.title.as_deref(), last.project.as_str()), (Some("Fix the build"), "app"));
    let age = atlas_core::usage::time::now_ms() - last.ended_ms;
    assert!((3_500_000..3_700_000).contains(&age), "{age}");
    // Idle: no further updates arrive.
    assert!(rig.rx.recv_timeout(Duration::from_millis(1500)).is_err());
    rig.engine.stop();
}

#[test]
fn a_restored_folder_with_fresh_write_times_shows_nothing_running() {
    // Time Machine, Migration Assistant or a sync copies every old transcript: each gets a
    // fresh write time, but its entries are as old as they ever were. None of them is running.
    let rig = start(|p| {
        for (name, title) in [("r1", "Restored one"), ("r2", "Restored two"), ("r3", "Restored three")] {
            let f = p.join("proj-a").join(format!("{name}.jsonl"));
            append(&f, &format!(r#"{{"type":"custom-title","customTitle":"{title}"}}"#));
            append(&f, &prompt_at(OLD));
            append(&f, &tool_at(name, "Read", r#"{"file_path":"x"}"#, OLD));
        }
    });
    let (snap, _) = wait_for(&rig, Duration::from_secs(5), |s| s.recent.len() == 3).expect("three finished chats");
    assert!(snap.chats.is_empty(), "restored chats shown as running: {}", snap.chats.len());
    let age = atlas_core::usage::time::now_ms() - snap.last.as_ref().unwrap().ended_ms;
    assert!(age > 86_400_000, "a restored chat ended when its last entry was written, not when it was copied ({age} ms)");

    // The same chat, really used again: it is running.
    let f = rig.projects.join("proj-a").join("r2.jsonl");
    append(&f, &prompt());
    append(&f, &tool("again", "Edit", r#"{"file_path":"C:\\w\\app\\a.ts"}"#));
    let (snap, _) = wait_for(&rig, Duration::from_secs(5), |s| s.chats.len() == 1).expect("the reused chat runs");
    assert_eq!(snap.chats[0].session_id, "r2");
    rig.engine.stop();
}

#[test]
fn a_missing_folder_is_not_an_error() {
    let dir = tempfile::tempdir().unwrap();
    let (tx, rx) = mpsc::channel();
    let tx = Mutex::new(tx);
    let sink = Arc::new(move |s: &NowSnapshot| {
        let _ = tx.lock().unwrap().send(s.clone());
    });
    let engine = NowEngine::start(NowConfig::new(dir.path().join("nope"), PriceTable::seed()), sink);
    let s = rx.recv_timeout(Duration::from_secs(5)).expect("a first snapshot");
    assert!(!s.watching && s.chats.is_empty() && s.last.is_none());
    engine.stop();
}

#[test]
fn finished_chats_are_listed_newest_first_without_a_fake_token_total() {
    let rig = start(|p| {
        for (name, title, mins) in [("one", "First chat", 90u64), ("two", "Second chat", 30), ("three", "Third chat", 200)] {
            let f = p.join("proj-a").join(format!("{name}.jsonl"));
            append(&f, &format!(r#"{{"type":"custom-title","customTitle":"{title}"}}"#));
            append(&f, &tool(name, "Read", r#"{"file_path":"x"}"#));
            let t = SystemTime::now() - Duration::from_secs(mins * 60);
            File::options().write(true).open(&f).unwrap().set_modified(t).unwrap();
        }
    });
    let (snap, _) = wait_for(&rig, Duration::from_secs(5), |s| s.recent.len() == 3).expect("three finished chats");
    assert!(snap.chats.is_empty());
    let titles: Vec<_> = snap.recent.iter().map(|r| r.title.clone().unwrap_or_default()).collect();
    assert_eq!(titles, ["Second chat", "First chat", "Third chat"]);
    assert_eq!(snap.last.as_ref().map(|l| l.session_id.as_str()), Some("two"));
    assert!(snap.recent.iter().all(|r| r.tokens.is_none()), "only the tail was read");
    rig.engine.stop();
}

#[test]
fn a_chat_that_ends_its_turn_flips_to_waiting_and_the_tracker_reports_it_once() {
    use atlas_core::now::finish::NotifyTracker;
    let rig = start(|p| {
        let f = p.join("proj-a").join("live.jsonl");
        append(&f, &prompt());
        append(&f, &tool("t1", "Edit", r#"{"file_path":"C:\\w\\app\\a.ts"}"#));
    });
    let (first, _) = wait_for(&rig, Duration::from_secs(5), |s| s.chats.first().is_some_and(|c| c.state == "working")).expect("working");
    let mut tracker = NotifyTracker::new();
    assert!(tracker.observe(&first).is_empty());
    let live = rig.projects.join("proj-a").join("live.jsonl");
    append(&live, r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"OUTPUT"}]}}"#);
    append(&live, &end_turn());
    let (second, _) = wait_for(&rig, Duration::from_secs(5), |s| s.chats.first().is_some_and(|c| c.state == "waiting")).expect("waiting");
    let got = tracker.observe(&second);
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].kind, "done");
    assert!(!format!("{got:?}").contains("TOPSECRET"), "no prompt or reply text in what is announced");
    rig.engine.stop();
}
