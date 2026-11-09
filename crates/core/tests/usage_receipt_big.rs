//! A chat with about a hundred helpers and large transcripts, generated on the fly (no real
//! transcript is committed; every string is filler). Guards the receipt path for big chats.
//!
//! The timing run is ignored by default:
//! `cargo test --release -p atlas-core --test usage_receipt_big -- --ignored --nocapture`
//! (`ATLAS_BIG_HELPERS`, `ATLAS_BIG_TURNS` size it).

mod common;

use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::Path;
use std::time::Instant;

use atlas_core::usage::time::Tz;
use common::synth::{iso, Rng};
use common::*;
use serde_json::{json, Value};

const SID: &str = "b1660000-0000-4000-8000-000000000101";
/// 2026-11-07T09:00:00Z
const T0: i64 = 1_794_042_000_000;
const OPUS: &str = "claude-opus-5-5";
const SONNET: &str = "claude-sonnet-5-5";

struct Shape {
    helpers: usize,
    /// Assistant turns per helper (the main chat gets twice as many).
    turns: usize,
}

fn assistant(agent: Option<&str>, key: &str, at: i64, model: &str, tools: &[(String, &str, Value)], stop: &str, filler: usize) -> String {
    // Escapes inside the text, as real transcripts have them.
    let mut content = vec![
        json!({"type": "thinking", "thinking": "[fixture \"thinking\"]\n".repeat(filler / 24 + 1), "signature": "s".repeat(400)}),
        json!({"type": "text", "text": "[fixture text]\n".repeat(filler / 16 + 1)}),
    ];
    for (id, name, input) in tools {
        content.push(json!({"type": "tool_use", "id": id, "name": name, "input": input}));
    }
    let mut v = json!({
        "parentUuid": format!("p-{key}"), "isSidechain": agent.is_some(), "userType": "external", "cwd": "/fixture/big",
        "sessionId": SID, "version": "2.1.296", "gitBranch": "main", "type": "assistant", "uuid": format!("u-{key}"),
        "timestamp": iso(at), "requestId": format!("req_{key}"),
        "message": {
            "id": format!("msg_{key}"), "type": "message", "role": "assistant", "model": model, "content": content,
            "stop_reason": stop, "stop_sequence": null,
            "usage": {
                "input_tokens": 12, "output_tokens": 400, "cache_creation_input_tokens": 3_000, "cache_read_input_tokens": 60_000,
                "cache_creation": {"ephemeral_5m_input_tokens": 3_000, "ephemeral_1h_input_tokens": 0},
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

fn tool_result(agent: Option<&str>, tool_use_id: &str, at: i64, bytes: usize) -> String {
    let body = "x = \"fixture\"\n".repeat(bytes / 14 + 1);
    let mut v = json!({
        "parentUuid": format!("p-{tool_use_id}"), "isSidechain": agent.is_some(), "userType": "external", "cwd": "/fixture/big",
        "sessionId": SID, "version": "2.1.296", "type": "user", "uuid": format!("ur-{tool_use_id}"), "timestamp": iso(at),
        "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": tool_use_id, "content": body}]},
        // Claude Code keeps a second copy of the output next to the message.
        "toolUseResult": {"stdout": body, "stderr": "", "interrupted": false}
    });
    if let Some(a) = agent {
        v["agentId"] = json!(a);
    }
    v.to_string()
}

fn prompt(agent: Option<&str>, at: i64) -> String {
    let mut v = json!({
        "type": "user", "uuid": format!("up-{at}"), "sessionId": SID, "timestamp": iso(at), "isSidechain": agent.is_some(),
        "message": {"role": "user", "content": "[fixture prompt]"}
    });
    if let Some(a) = agent {
        v["agentId"] = json!(a);
    }
    v.to_string()
}

fn notice(at: i64, agent: &str, status: &str) -> String {
    json!({
        "type": "queue-operation", "operation": "enqueue", "sessionId": SID, "timestamp": iso(at),
        "content": format!("<task-notification>\n<task-id>{agent}</task-id>\n<tool-use-id>toolu_spawn_{agent}</tool-use-id>\n<status>{status}</status>\n<summary>[fixture]</summary>\n</task-notification>")
    })
    .to_string()
}

/// A result size: mostly small, some medium, now and then a huge one.
fn result_bytes(rng: &mut Rng) -> usize {
    match rng.next() % 20 {
        0 => 120_000 + (rng.next() % 200_000) as usize,
        1..=5 => 8_000 + (rng.next() % 30_000) as usize,
        _ => 300 + (rng.next() % 4_000) as usize,
    }
}

/// One thread's turns: each turn calls one tool and gets its result back.
fn write_thread(out: &mut impl Write, agent: Option<&str>, turns: usize, start: i64, rng: &mut Rng, tag: &str) -> u64 {
    let mut bytes = 0u64;
    let mut put = |l: String| {
        bytes += l.len() as u64 + 1;
        writeln!(out, "{l}").unwrap();
    };
    put(prompt(agent, start));
    for t in 0..turns {
        let at = start + 1_000 + t as i64 * 4_000;
        let id = format!("toolu_{tag}_{t}");
        let (name, input) = match rng.next() % 4 {
            0 | 1 => ("Read", json!({"file_path": format!("src/mod_{}.rs", rng.next() % 40)})),
            2 => ("Bash", json!({"command": "[fixture command]"})),
            _ => ("Grep", json!({"pattern": "[fixture]"})),
        };
        let model = if agent.is_some() { SONNET } else { OPUS };
        put(assistant(agent, &format!("{tag}_{t}"), at, model, &[(id.clone(), name, input)], "tool_use", 800));
        put(tool_result(agent, &id, at + 1_500, result_bytes(rng)));
    }
    put(assistant(agent, &format!("{tag}_end"), start + 1_000 + turns as i64 * 4_000, if agent.is_some() { SONNET } else { OPUS }, &[], "end_turn", 400));
    bytes
}

/// Write the chat; returns the bytes written.
fn build_big_chat(config: &Path, shape: &Shape) -> u64 {
    let proj = config.join("projects").join("-fx-big");
    let subs = proj.join(SID).join("subagents");
    fs::create_dir_all(&subs).unwrap();
    let mut rng = Rng(0x5eed_b16c_4a75);
    let mut total = 0u64;

    let ids: Vec<String> = (0..shape.helpers).map(|i| format!("a{i:015x}")).collect();
    // One in five helpers is started by an earlier helper (two levels at most).
    let parent = |i: usize| -> Option<usize> { (i % 5 == 4).then(|| i - 1 - (i % 3)) };

    let mut main = BufWriter::new(File::create(proj.join(format!("{SID}.jsonl"))).unwrap());
    total += write_thread(&mut main, None, shape.turns * 2, T0, &mut rng, "main");
    let spawn_at = T0 + 10_000 + shape.turns as i64 * 8_000;
    for (i, id) in ids.iter().enumerate() {
        if parent(i).is_none() {
            let call = (format!("toolu_spawn_{id}"), "Agent", json!({"description": format!("Helper {i}"), "subagent_type": "general-purpose", "prompt": "[fixture]"}));
            let l = assistant(None, &format!("spawn_{i}"), spawn_at + i as i64 * 10, OPUS, &[call], "tool_use", 100);
            total += l.len() as u64 + 1;
            writeln!(main, "{l}").unwrap();
        }
    }
    for (i, id) in ids.iter().enumerate() {
        let l = notice(spawn_at + 3_600_000 + i as i64, id, if i % 17 == 3 { "failed" } else { "completed" });
        total += l.len() as u64 + 1;
        writeln!(main, "{l}").unwrap();
    }
    main.flush().unwrap();

    for (i, id) in ids.iter().enumerate() {
        let mut f = BufWriter::new(File::create(subs.join(format!("agent-{id}.jsonl"))).unwrap());
        let start = spawn_at + 1_000 + i as i64 * 1_000;
        total += write_thread(&mut f, Some(id), shape.turns, start, &mut rng, id);
        f.flush().unwrap();
        let mut m = json!({"agentType": "general-purpose", "description": format!("Helper {i}"), "toolUseId": format!("toolu_spawn_{id}"), "spawnDepth": 1});
        if let Some(p) = parent(i) {
            m["parentAgentId"] = json!(ids[p]);
            m["spawnDepth"] = json!(2);
        }
        fs::write(subs.join(format!("agent-{id}.meta.json")), m.to_string()).unwrap();
    }
    total
}

fn env_usize(name: &str, default: usize) -> usize {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

#[test]
fn a_chat_with_a_hundred_helpers_gets_a_whole_receipt() {
    let cfg = tempfile::tempdir().unwrap();
    let shape = Shape { helpers: 101, turns: 12 };
    let bytes = build_big_chat(cfg.path(), &shape);
    let fx = start(cfg.path(), Tz::Fixed(0));
    let before = fx.engine.bytes_read();
    let r = fx.engine.receipt(SID).unwrap().expect("the chat exists");
    // Every transcript is read once for the receipt, however many helpers there are.
    assert_eq!(fx.engine.bytes_read() - before, bytes, "one pass over the chat's files");
    assert!(r.scanned);
    assert_eq!(r.threads.len(), 102, "main chat and 101 helpers");
    let failed = r.threads.iter().filter(|t| t.outcome.as_deref() == Some("errored")).count();
    assert_eq!(failed, (0..101).filter(|i| i % 17 == 3).count());
    for t in r.threads.iter().skip(1) {
        let i: usize = t.name.trim_start_matches("Helper ").parse().unwrap();
        assert_eq!(t.parent_agent_id.is_some(), i % 5 == 4, "{}", t.name);
    }
    let total = r.total_usd.unwrap();
    assert!((r.threads.iter().map(|t| t.usd).sum::<f64>() + r.threads_other_usd - total).abs() < 1e-6);
}

/// Timing only; prints, asserts nothing about speed (machines differ).
#[test]
#[ignore]
fn time_the_receipt_of_a_big_chat() {
    let cfg = tempfile::tempdir().unwrap();
    let shape = Shape { helpers: env_usize("ATLAS_BIG_HELPERS", 101), turns: env_usize("ATLAS_BIG_TURNS", 220) };
    let t = Instant::now();
    let bytes = build_big_chat(cfg.path(), &shape);
    eprintln!("generated {} helpers x {} turns: {:.1} MB in {:.2?}", shape.helpers, shape.turns, bytes as f64 / 1e6, t.elapsed());

    let t = Instant::now();
    let fx = start(cfg.path(), Tz::Fixed(0));
    eprintln!("first index: {:.2?}", t.elapsed());

    let t = Instant::now();
    let d = fx.engine.session_detail(SID).unwrap().unwrap();
    eprintln!("session_detail: {:.2?} ({} tokens)", t.elapsed(), d.row.tokens.total);

    let before = fx.engine.bytes_read();
    let t = Instant::now();
    let r = fx.engine.receipt(SID).unwrap().unwrap();
    eprintln!(
        "receipt, first open: {:.2?} ({} threads, {:.1} MB read)",
        t.elapsed(),
        r.threads.len(),
        (fx.engine.bytes_read() - before) as f64 / 1e6
    );
    let end = Instant::now() + std::time::Duration::from_secs(30);
    while fx.one("SELECT COUNT(*) FROM receipt_scan") == 0 && Instant::now() < end {
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    let t = Instant::now();
    let again = fx.engine.receipt(SID).unwrap().unwrap();
    eprintln!("receipt, stored scan: {:.2?}", t.elapsed());
    assert_eq!(again, r);
}
