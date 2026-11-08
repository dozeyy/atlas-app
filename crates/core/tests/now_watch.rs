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
    let dir = tempfile::tempdir().unwrap();
    let projects = dir.path().join("projects");
    fs::create_dir_all(projects.join("proj-a")).unwrap();
    setup(&projects);
    let (tx, rx) = mpsc::channel();
    let tx = Mutex::new(tx);
    let sink = Arc::new(move |s: &NowSnapshot| {
        let _ = tx.lock().unwrap().send(s.clone());
    });
    let engine = NowEngine::start(NowConfig::new(projects.clone(), PriceTable::seed()), sink);
    Rig { _dir: dir, projects, rx, engine }
}

fn prompt() -> String {
    r#"{"type":"user","timestamp":"2026-11-08T10:00:00.000Z","cwd":"C:\\w\\app","message":{"role":"user","content":"TOPSECRETPROMPT please"}}"#.to_string()
}

fn tool(id: &str, name: &str, input: &str) -> String {
    format!(
        r#"{{"type":"assistant","timestamp":"2026-11-08T10:00:01.000Z","cwd":"C:\\w\\app","requestId":"r{id}","message":{{"id":"m{id}","model":"claude-opus-5-5","stop_reason":"tool_use","content":[{{"type":"text","text":"TOPSECRETREPLY"}},{{"type":"tool_use","id":"{id}","name":"{name}","input":{input}}}],"usage":{{"input_tokens":10,"output_tokens":5,"cache_creation_input_tokens":100,"cache_read_input_tokens":1000}}}}}}"#
    )
}

fn end_turn() -> String {
    r#"{"type":"assistant","timestamp":"2026-11-08T10:00:09.000Z","requestId":"rend","message":{"id":"mend","model":"claude-opus-5-5","stop_reason":"end_turn","content":[{"type":"text","text":"done"}],"usage":{"input_tokens":1,"output_tokens":1}}}"#.to_string()
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
    assert_eq!(c.tokens, 2 * 115);
    assert!(c.cost_usd.is_some_and(|x| x > 0.0));
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
    assert_eq!(c.helpers[0].tokens, 115);
    assert!(c.doing.verb.starts_with("Waiting on"), "{}", c.doing.verb);
    assert!(!serde_json::to_string(&snap).unwrap().contains("TOPSECRET"));
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
