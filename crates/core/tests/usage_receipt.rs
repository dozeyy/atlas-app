//! "Where the money went" and the helper tree's numbers, against a generated chat with nested
//! helpers (every text is invented; tool-result sizes are what matter). The receipt must add up
//! to the chat's existing cost figure in every view, parent links must be right, and nothing
//! typed into the chat may leak into the result.

mod common;

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use atlas_core::usage::query::SessionDetail;
use atlas_core::usage::receipt::{Receipt, Thread};
use atlas_core::usage::time::Tz;
use common::synth::iso;
use common::*;
use serde_json::{json, Value};

const SID: &str = "rrrr0001-0000-4000-8000-000000000001";
/// 2026-11-07T09:00:00Z
const T0: i64 = 1_794_042_000_000;
const MIN: i64 = 60_000;

fn ts(minutes: f64) -> String {
    iso(T0 + (minutes * MIN as f64) as i64)
}

/// One assistant line: a message with the given tool calls and usage.
#[allow(clippy::too_many_arguments)]
fn asst(agent: Option<&str>, key: &str, at: f64, model: &str, usage: (u64, u64, u64, u64), tools: &[(&str, &str, Value)], stop: &str) -> String {
    let (i, o, cw, cr) = usage;
    let mut content = vec![json!({"type": "text", "text": "[fixture assistant text]"})];
    for (id, name, input) in tools {
        content.push(json!({"type": "tool_use", "id": id, "name": name, "input": input}));
    }
    let mut v = json!({
        "type": "assistant", "uuid": format!("u-{key}"), "sessionId": SID, "timestamp": ts(at), "cwd": "/fixture/receipt",
        "isSidechain": agent.is_some(), "version": "2.1.296", "requestId": format!("req_{key}"),
        "message": {
            "id": format!("msg_{key}"), "type": "message", "role": "assistant", "model": model, "content": content,
            "stop_reason": stop,
            "usage": {
                "input_tokens": i, "output_tokens": o, "cache_creation_input_tokens": cw, "cache_read_input_tokens": cr,
                "cache_creation": {"ephemeral_5m_input_tokens": cw, "ephemeral_1h_input_tokens": 0},
                "server_tool_use": {"web_search_requests": 0, "web_fetch_requests": 0},
                "service_tier": "standard", "speed": "standard", "inference_geo": "global"
            }
        }
    });
    if let Some(a) = agent {
        v["agentId"] = json!(a);
    }
    v.to_string()
}

/// A tool result of `bytes` bytes of text (as a string, like Read and Bash write them).
fn result(agent: Option<&str>, tool_use_id: &str, at: f64, bytes: usize) -> String {
    let mut v = json!({
        "type": "user", "uuid": format!("ur-{tool_use_id}"), "sessionId": SID, "timestamp": ts(at),
        "isSidechain": agent.is_some(), "fixtureText": true,
        "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": tool_use_id, "content": "x".repeat(bytes)}]},
        // The same text again, as Claude Code writes it; the receipt must not read this copy.
        "toolUseResult": {"stdout": "y".repeat(bytes)}
    });
    if let Some(a) = agent {
        v["agentId"] = json!(a);
    }
    v.to_string()
}

fn prompt(agent: Option<&str>, at: f64, text: &str) -> String {
    let mut v = json!({
        "type": "user", "uuid": format!("up-{at}"), "sessionId": SID, "timestamp": ts(at), "isSidechain": agent.is_some(),
        "fixtureText": true, "message": {"role": "user", "content": text}
    });
    if let Some(a) = agent {
        v["agentId"] = json!(a);
    }
    v.to_string()
}

fn notice(at: f64, agent: &str, tool_use: &str, status: &str) -> String {
    json!({
        "type": "queue-operation", "operation": "enqueue", "sessionId": SID, "timestamp": ts(at),
        "content": format!("<task-notification>\n<task-id>{agent}</task-id>\n<tool-use-id>{tool_use}</tool-use-id>\n<output-file>C:\\fx\\{agent}.output</output-file>\n<status>{status}</status>\n<summary>SECRET-SUMMARY</summary>\n</task-notification>")
    })
    .to_string()
}

fn spawn(id: &str, desc: &str, kind: &str) -> (String, &'static str, Value) {
    (format!("toolu_spawn_{id}"), "Agent", json!({"description": desc, "subagent_type": kind, "prompt": "SECRET-PROMPT"}))
}

fn write_lines(path: &Path, lines: &[String]) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, lines.join("\n") + "\n").unwrap();
}

fn meta(dir: &Path, id: &str, kind: &str, desc: &str, depth: u32, parent: Option<&str>) {
    let mut m = json!({"agentType": kind, "description": desc, "toolUseId": format!("toolu_spawn_{id}"), "spawnDepth": depth});
    if let Some(p) = parent {
        m["parentAgentId"] = json!(p);
    }
    fs::write(dir.join(format!("agent-{id}.meta.json")), m.to_string()).unwrap();
}

const OPUS: &str = "claude-opus-5-5";
const SONNET: &str = "claude-sonnet-5-5";
const HAIKU: &str = "claude-haiku-5-5";

/// The chat: the main thread reads one doc seven times, runs one huge command, starts three
/// helpers and then comes back after a half-hour pause; helper B starts C, which starts D.
fn build_chat(config: &Path) -> PathBuf {
    let proj = config.join("projects").join("-fx-receipt");
    let main = proj.join(format!("{SID}.jsonl"));
    let subs = proj.join(SID).join("subagents");
    fs::create_dir_all(&subs).unwrap();
    let doc = json!({"file_path": "docs/tech.md"});

    let mut m = vec![prompt(None, 0.0, "SECRET-PROMPT: tidy the billing rounding")];
    for i in 0..7 {
        let at = 1.0 + i as f64;
        let id = format!("toolu_read_{i}");
        m.push(asst(None, &format!("R{i}"), at, OPUS, (50, 100, 2_000, 20_000), &[(&id, "Read", doc.clone())], "tool_use"));
        m.push(result(None, &id, at + 0.2, 40_000));
    }
    m.push(asst(None, "BASH", 8.0, OPUS, (50, 100, 2_000, 22_000), &[("toolu_bash", "Bash", json!({"command": "echo SECRET-COMMAND"}))], "tool_use"));
    m.push(result(None, "toolu_bash", 8.2, 200_000));
    let (a, b, e, f) = (spawn("hA", "Survey the billing module", "Explore"), spawn("hB", "Implement the rounding fix", "general-purpose"), spawn("hE", "Check the changelog", "general-purpose"), spawn("hF", "Review the diff", "general-purpose"));
    m.push(asst(None, "SPAWN", 9.0, OPUS, (50, 100, 2_000, 24_000), &[(&a.0, a.1, a.2), (&b.0, b.1, b.2), (&e.0, e.1, e.2), (&f.0, f.1, f.2)], "tool_use"));
    for (at, id, status) in [(14.0, "hA", "completed"), (20.0, "hB", "completed"), (18.0, "hC", "failed"), (17.0, "hD", "killed")] {
        m.push(notice(at, id, &format!("toolu_spawn_{id}"), status));
        // Claude Code repeats the notice as a user line.
        m.push(notice(at, id, &format!("toolu_spawn_{id}"), status).replace("queue-operation", "user"));
    }
    // Half an hour later: the cache is gone and the whole conversation is written back.
    m.push(asst(None, "LATE", 39.0, OPUS, (50, 100, 60_000, 0), &[], "end_turn"));
    m.push(r#"{"type":"cost-state","sessionId":"rrrr0001-0000-4000-8000-000000000001","totalCostUSD":1.0}"#.to_string());
    write_lines(&main, &m);

    // A: an expensive model looking things up, nothing else.
    write_lines(
        &subs.join("agent-hA.jsonl"),
        &[
            prompt(Some("hA"), 9.5, "SECRET-PROMPT survey"),
            asst(Some("hA"), "A1", 10.0, OPUS, (30, 200, 150_000, 0), &[("toolu_a1", "Read", json!({"file_path": "src/billing.rs"})), ("toolu_a2", "Grep", json!({"pattern": "SECRET-PATTERN"}))], "tool_use"),
            result(Some("hA"), "toolu_a1", 10.2, 8_000),
            asst(Some("hA"), "A2", 11.0, OPUS, (20, 300, 1_000, 150_000), &[], "end_turn"),
        ],
    );
    meta(&subs, "hA", "Explore", "Survey the billing module", 1, None);

    // B: does real work (edits, runs), and starts C.
    let c = spawn("hC", "Run the rounding tests", "general-purpose");
    write_lines(
        &subs.join("agent-hB.jsonl"),
        &[
            prompt(Some("hB"), 9.6, "SECRET-PROMPT fix"),
            asst(Some("hB"), "B1", 10.0, SONNET, (40, 400, 9_000, 0), &[("toolu_b1", "Read", doc.clone()), ("toolu_b2", "Edit", json!({"file_path": "src/billing.rs"}))], "tool_use"),
            result(Some("hB"), "toolu_b1", 10.3, 40_000),
            asst(Some("hB"), "B2", 12.0, SONNET, (40, 600, 1_000, 9_000), &[(&c.0, c.1, c.2)], "tool_use"),
            asst(Some("hB"), "B3", 19.0, SONNET, (40, 300, 500, 10_000), &[], "end_turn"),
        ],
    );
    meta(&subs, "hB", "general-purpose", "Implement the rounding fix", 1, None);

    // C (inside B) fails; it starts D, which is stopped.
    let d = spawn("hD", "Probe the failing case", "general-purpose");
    write_lines(
        &subs.join("agent-hC.jsonl"),
        &[
            prompt(Some("hC"), 12.5, "SECRET-PROMPT tests"),
            asst(Some("hC"), "C1", 13.0, HAIKU, (20, 100, 4_000, 0), &[("toolu_c1", "Bash", json!({"command": "SECRET-CMD"})), (&d.0, d.1, d.2)], "tool_use"),
            result(Some("hC"), "toolu_c1", 13.2, 6_000),
            asst(Some("hC"), "C2", 15.0, HAIKU, (20, 100, 500, 4_000), &[("toolu_c2", "Bash", json!({"command": "SECRET-CMD"}))], "tool_use"),
        ],
    );
    meta(&subs, "hC", "general-purpose", "Run the rounding tests", 2, Some("hB"));

    write_lines(
        &subs.join("agent-hD.jsonl"),
        &[
            prompt(Some("hD"), 13.5, "SECRET-PROMPT probe"),
            asst(Some("hD"), "D1", 14.0, HAIKU, (20, 100, 3_000, 0), &[("toolu_d1", "Bash", json!({"command": "SECRET-CMD"}))], "tool_use"),
        ],
    );
    meta(&subs, "hD", "general-purpose", "Probe the failing case", 3, Some("hC"));

    // E ends on its own (no notice), F is cut off mid-work (no notice, no end).
    write_lines(
        &subs.join("agent-hE.jsonl"),
        &[prompt(Some("hE"), 9.7, "SECRET-PROMPT log"), asst(Some("hE"), "E1", 10.0, SONNET, (30, 200, 2_000, 0), &[], "end_turn")],
    );
    meta(&subs, "hE", "general-purpose", "Check the changelog", 1, None);
    write_lines(
        &subs.join("agent-hF.jsonl"),
        &[prompt(Some("hF"), 9.8, "SECRET-PROMPT diff"), asst(Some("hF"), "F1", 10.0, SONNET, (30, 200, 2_000, 0), &[("toolu_f1", "Read", doc)], "tool_use")],
    );
    meta(&subs, "hF", "general-purpose", "Review the diff", 1, None);
    main
}

fn chat_fx() -> (tempfile::TempDir, Fx) {
    let cfg = tempfile::tempdir().unwrap();
    build_chat(cfg.path());
    let fx = start(cfg.path(), Tz::Fixed(0));
    (cfg, fx)
}

fn receipt(fx: &Fx) -> Receipt {
    fx.engine.receipt(SID).unwrap().expect("the chat exists")
}

fn thread<'a>(r: &'a Receipt, id: &str) -> &'a Thread {
    r.threads.iter().find(|t| t.agent_id.as_deref() == Some(id)).unwrap_or_else(|| panic!("no helper {id}"))
}

fn near(a: f64, b: f64) {
    assert!((a - b).abs() < 1e-9, "{a} != {b}");
}

fn wait_for(what: &str, mut ok: impl FnMut() -> bool) {
    let end = Instant::now() + Duration::from_secs(10);
    while Instant::now() < end {
        if ok() {
            return;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("timed out waiting for {what}");
}

#[test]
fn every_view_of_the_receipt_adds_up_to_the_chats_cost() {
    let (_cfg, fx) = chat_fx();
    // Both ways of counting: the lines must add up to the headline either way, and the headline
    // is the same figure the sessions page shows.
    for on in [false, true] {
        fx.engine.set_count_cache(on);
        let count = atlas_core::usage::count::TokenCount::new(on);
        let r = receipt(&fx);
        assert_eq!(r.counts_cache, on);
        let d: SessionDetail = fx.engine.session_detail(SID).unwrap().unwrap();
        let total = d.row.cost.usd.unwrap();
        assert!(total > 1.0, "a chat worth looking at: {total}");
        near(r.total_usd.unwrap(), total);
        assert!(r.complete && r.scanned);

        near(r.threads.iter().map(|t| t.usd).sum::<f64>() + r.threads_other_usd, total);
        near(r.models.iter().map(|m| m.usd).sum::<f64>() + r.models_other_usd, total);
        near(r.kinds.sum() + r.kinds_other_usd, total);
        near(r.items.iter().filter_map(|i| i.usd).sum::<f64>() + r.items_other_usd, total);
        assert!(r.threads_other_usd.abs() < 1e-9 && r.kinds_other_usd.abs() < 1e-9, "nothing unpriced here");
        assert!(r.items_other_usd > 0.0, "the biggest items are not the whole bill");

        // Each thread is exactly what the sessions page says it is, and its own slice adds up too.
        near(thread_main(&r).usd, d.main.cost.usd.unwrap());
        for a in &d.agents {
            near(thread(&r, &a.agent_id).usd, a.cost.usd.unwrap());
            assert_eq!(thread(&r, &a.agent_id).tokens, a.tokens.total);
        }
        for t in &r.threads {
            near(t.kinds.sum(), t.usd);
            near(t.models.iter().map(|m| m.usd).sum::<f64>(), t.usd);
            near(t.items.iter().filter_map(|i| i.usd).sum::<f64>() + t.items_other_usd, t.usd);
        }
        // Tokens add up the same way: by thread, and by kind (cache reads listed apart).
        assert_eq!(r.total_tokens, d.row.tokens.total);
        assert_eq!(r.threads.iter().map(|t| t.tokens).sum::<u64>(), r.total_tokens);
        assert_eq!(r.token_kinds.total(count), r.total_tokens);
        assert_eq!(r.token_kinds.cache_read, d.row.tokens.cache_read);
        assert_eq!(r.token_kinds.all(), r.token_kinds.input + r.token_kinds.output + r.token_kinds.cache_write + r.token_kinds.cache_read);
        if on {
            assert_eq!(r.total_tokens, r.token_kinds.all(), "cache is in the headline");
        } else {
            assert!(r.total_tokens < r.token_kinds.all(), "cache is left out of the headline");
        }
        for t in &r.threads {
            assert_eq!(t.token_kinds.total(count), t.tokens);
            assert_eq!(t.token_kinds.cache_read, t.cache_read_tokens);
        }
        // By model: the same figures the detail page shows.
        for m in &d.by_model {
            let line = r.models.iter().find(|x| x.model == m.model).unwrap();
            near(line.usd, m.cost.usd.unwrap());
            assert_eq!(line.tokens, m.tokens.total);
        }
    }
}

fn thread_main(r: &Receipt) -> &Thread {
    let t = &r.threads[0];
    assert!(t.agent_id.is_none() && t.name == "Main chat", "main chat comes first");
    t
}

#[test]
fn nested_helpers_keep_their_parents_and_each_ends_the_way_the_transcript_says() {
    let (_cfg, fx) = chat_fx();
    let r = receipt(&fx);
    assert_eq!(r.threads.len(), 7, "main chat and six helpers");
    let parent = |id: &str| thread(&r, id).parent_agent_id.clone();
    assert_eq!((parent("hA"), parent("hB"), parent("hE"), parent("hF")), (None, None, None, None));
    assert_eq!(parent("hC").as_deref(), Some("hB"));
    assert_eq!(parent("hD").as_deref(), Some("hC"));
    assert_eq!([1, 1, 2, 3], ["hA", "hB", "hC", "hD"].map(|i| thread(&r, i).spawn_depth));
    assert_eq!(thread(&r, "hC").name, "Run the rounding tests");

    let out = |id: &str| thread(&r, id).outcome.clone();
    assert_eq!(out("hA").as_deref(), Some("finished"), "completed notice");
    assert_eq!(out("hB").as_deref(), Some("finished"));
    assert_eq!(out("hC").as_deref(), Some("errored"), "failed notice");
    assert_eq!(out("hD").as_deref(), Some("stopped"), "killed notice");
    assert_eq!(out("hE").as_deref(), Some("finished"), "no notice, but it ended its turn");
    assert_eq!(out("hF"), None, "no notice and no ending: not guessed");
    assert_eq!(thread_main(&r).outcome, None);

    // Every helper is one node and the helpers' spend plus the main chat's is the chat.
    let ids: Vec<_> = r.threads.iter().filter_map(|t| t.agent_id.clone()).collect();
    let mut dedup = ids.clone();
    dedup.sort();
    dedup.dedup();
    assert_eq!(ids.len(), dedup.len());
}

#[test]
fn the_biggest_items_and_the_flags_are_found() {
    let (_cfg, fx) = chat_fx();
    let r = receipt(&fx);

    let top = &r.items[0];
    assert_eq!((top.kind.as_str(), top.path.as_deref()), ("read", Some("docs/tech.md")));
    assert_eq!(top.count, 8, "seven in the main chat and one in helper B (helper F's read never got a result)");
    assert_eq!(top.tokens, 8 * 10_000);
    assert_eq!(top.thread, None, "read in several threads");
    let bash = r.items.iter().find(|i| i.tool == "Bash" && i.kind == "output").expect("the huge command output");
    assert_eq!((bash.count, bash.tokens, bash.thread.as_deref()), (1, 50_000, Some("Main chat")));
    assert!(top.usd.unwrap() > 0.0 && bash.usd.unwrap() > 0.0);

    let flag = |kind: &str| r.flags.iter().find(|f| f.kind == kind).unwrap_or_else(|| panic!("no {kind} flag in {:?}", r.flags));
    let rr = flag("repeat_read");
    assert_eq!((rr.label.as_str(), rr.count), ("docs/tech.md", 8));
    let huge = flag("huge_output");
    assert_eq!((huge.label.as_str(), huge.tokens), ("Bash", 50_000));
    let heavy = flag("heavy_helper");
    assert_eq!((heavy.label.as_str(), heavy.agent_id.as_deref(), heavy.model.as_deref()), ("Survey the billing module", Some("hA"), Some(OPUS)));
    assert_eq!(heavy.tools, vec!["Grep".to_string(), "Read".to_string()], "most used first, ties by name");
    let miss = flag("cache_miss");
    assert_eq!(miss.count, 1);
    assert_eq!(miss.minutes, Some(30), "the pause before the late message");
    near(miss.usd.unwrap(), 60_000.0 * (5.0 - 0.2) / 1e6);

    // A busy worker on a mid-tier model is not "an expensive model on a trivial helper".
    assert!(!r.flags.iter().any(|f| f.kind == "heavy_helper" && f.agent_id.as_deref() == Some("hB")));
    // The flags also sit on the thread they belong to.
    assert!(thread(&r, "hA").flags.iter().any(|f| f.kind == "heavy_helper"));
    assert!(thread_main(&r).flags.iter().any(|f| f.kind == "cache_miss"));
    assert!(thread_main(&r).flags.iter().any(|f| f.kind == "repeat_read" && f.count == 7));
}

#[test]
fn nothing_typed_into_the_chat_reaches_the_receipt() {
    let (_cfg, fx) = chat_fx();
    let json = serde_json::to_string(&receipt(&fx)).unwrap();
    for secret in ["SECRET-PROMPT", "SECRET-COMMAND", "SECRET-CMD", "SECRET-PATTERN", "SECRET-SUMMARY", "fixture assistant text", "xxxx", "yyyy"] {
        assert!(!json.contains(secret), "{secret} leaked into the receipt");
    }
}

#[test]
fn the_scan_is_kept_until_a_file_changes() {
    let (cfg, fx) = chat_fx();
    let first = receipt(&fx);
    wait_for("the scan to be stored", || fx.one("SELECT COUNT(*) FROM receipt_scan") == 1);
    let read_once = fx.engine.bytes_read();
    assert_eq!(receipt(&fx), first, "same answer from the stored scan");
    assert_eq!(fx.engine.bytes_read(), read_once, "no transcript was read the second time");
    let sig: String = fx.db().query_row("SELECT sig FROM receipt_scan", [], |r| r.get(0)).unwrap();

    // The chat grows: a new line, then the ledger sees it.
    let main = cfg.path().join("projects").join("-fx-receipt").join(format!("{SID}.jsonl"));
    let mut text = fs::read_to_string(&main).unwrap();
    text.push_str(&asst(None, "MORE", 41.0, OPUS, (50, 100, 2_000, 60_000), &[], "end_turn"));
    text.push('\n');
    fs::write(&main, text).unwrap();
    fx.rescan();
    let again = receipt(&fx);
    assert!(fx.engine.bytes_read() > read_once, "a changed chat is read again");
    assert!(again.total_usd.unwrap() > first.total_usd.unwrap());
    wait_for("the new scan to replace the old", || {
        fx.db().query_row::<String, _, _>("SELECT sig FROM receipt_scan", [], |r| r.get(0)).map(|s| s != sig).unwrap_or(false)
    });
    assert_eq!(fx.one("SELECT COUNT(*) FROM receipt_scan"), 1, "one stored scan per chat");
    near(again.threads.iter().map(|t| t.usd).sum::<f64>() + again.threads_other_usd, again.total_usd.unwrap());
}

#[test]
fn without_the_transcripts_the_numbers_still_add_up() {
    let cfg = tempfile::tempdir().unwrap();
    let main = build_chat(cfg.path());
    let fx = start(cfg.path(), Tz::Fixed(0));
    fs::remove_file(&main).unwrap();
    fs::remove_dir_all(cfg.path().join("projects").join("-fx-receipt").join(SID)).unwrap();
    let r = receipt(&fx);
    assert!(!r.scanned, "nothing to read");
    assert!(r.items.is_empty() && thread_main(&r).items.is_empty());
    assert!(thread(&r, "hC").outcome.is_none(), "no transcript, no outcome to claim");
    near(r.threads.iter().map(|t| t.usd).sum::<f64>() + r.threads_other_usd, r.total_usd.unwrap());
    assert_eq!(fx.one("SELECT COUNT(*) FROM receipt_scan"), 0, "an empty scan is not stored");
    // The money flags come from the ledger and still show.
    assert!(r.flags.iter().any(|f| f.kind == "cache_miss"));
}

#[test]
fn an_unknown_chat_has_no_receipt() {
    let (_cfg, fx) = chat_fx();
    assert!(fx.engine.receipt("ffffffff-0000-4000-8000-000000000000").unwrap().is_none());
}

#[test]
fn the_cache_table_migrates_in_from_an_older_ledger() {
    let (_cfg, fx) = chat_fx();
    let c = rusqlite::Connection::open(&fx.cache).unwrap();
    assert_eq!(c.query_row::<i64, _, _>("PRAGMA user_version", [], |r| r.get(0)).unwrap(), atlas_core::cache::SCHEMA_VERSION);
    const _: () = assert!(atlas_core::cache::SCHEMA_VERSION >= 4);
    // A version-3 ledger gains the table and keeps working.
    drop(c);
    let data = tempfile::tempdir().unwrap();
    let db = data.path().join("old.sqlite");
    {
        let mut c = rusqlite::Connection::open(&db).unwrap();
        c.execute_batch("PRAGMA user_version = 0;").unwrap();
        atlas_core::cache::migrate::migrate(&mut c).unwrap();
        c.execute_batch("DROP TABLE receipt_scan; ALTER TABLE messages DROP COLUMN effort; PRAGMA user_version = 3;").unwrap();
    }
    let opened = atlas_core::cache::open_writer(&db).unwrap();
    let n: i64 = opened.conn.query_row("SELECT COUNT(*) FROM receipt_scan", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 0);
}
