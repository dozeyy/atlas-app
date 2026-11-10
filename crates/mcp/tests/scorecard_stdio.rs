//! The three helper-report tools over real stdio JSON-RPC (docs/specs/agent-scorecard.md,
//! criterion 35): the real `atlas-mcp` program against a scratch copy of `fixtures/claude-ledger`
//! with its own data folder. Nothing here touches the real Claude folder or Atlas data.

use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{Receiver, channel};
use std::time::{Duration, SystemTime};

use serde_json::{Value, json};

const S1: &str = "aaaa1001-0000-4000-8000-000000000001";
const S2: &str = "bbbb1002-0000-4000-8000-000000000002";

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..")
}

fn copy_dir(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for e in fs::read_dir(from).unwrap().flatten() {
        let (src, dst) = (e.path(), to.join(e.file_name()));
        if e.file_type().unwrap().is_dir() {
            copy_dir(&src, &dst);
        } else {
            fs::copy(&src, &dst).unwrap();
        }
    }
}

/// Every file and folder under `dir` with its size and modified time.
fn tree(dir: &Path) -> Vec<(String, u64, SystemTime)> {
    fn walk(base: &Path, dir: &Path, out: &mut Vec<(String, u64, SystemTime)>) {
        for e in fs::read_dir(dir).unwrap().flatten() {
            let m = e.metadata().unwrap();
            out.push((e.path().strip_prefix(base).unwrap().to_string_lossy().replace('\\', "/"), m.len(), m.modified().unwrap()));
            if m.is_dir() {
                walk(base, &e.path(), out);
            }
        }
    }
    let mut out = vec![(".".to_string(), 0, fs::metadata(dir).unwrap().modified().unwrap())];
    walk(dir, dir, &mut out);
    out.sort();
    out
}

struct Sandbox {
    _tmp: tempfile::TempDir,
    config: PathBuf,
    data: PathBuf,
}

impl Sandbox {
    fn new() -> Sandbox {
        let tmp = tempfile::tempdir().unwrap();
        let config = tmp.path().join("claude");
        let data = tmp.path().join("data");
        copy_dir(&root().join("fixtures").join("claude-ledger"), &config);
        fs::create_dir_all(&data).unwrap();
        Sandbox { _tmp: tmp, config, data }
    }
}

struct Client {
    child: Child,
    stdin: ChildStdin,
    lines: Receiver<String>,
    next: u64,
}

impl Client {
    fn start(sb: &Sandbox, extra: &[&str]) -> Client {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_atlas-mcp"));
        cmd.arg("--config-dir").arg(&sb.config).arg("--data-dir").arg(&sb.data).args(extra);
        cmd.env_remove("CLAUDE_CONFIG_DIR").env_remove("ATLAS_DATA_DIR").env("ATLAS_NO_TRASH", "1");
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        let mut child = cmd.spawn().expect("start atlas-mcp");
        let stdin = child.stdin.take().unwrap();
        let out = child.stdout.take().unwrap();
        let (tx, lines) = channel();
        std::thread::spawn(move || {
            for l in BufReader::new(out).lines().map_while(Result::ok) {
                if tx.send(l).is_err() {
                    break;
                }
            }
        });
        let mut c = Client { child, stdin, lines, next: 1 };
        let init = c.request("initialize", json!({"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test", "version": "0"}}));
        assert_eq!(init["result"]["serverInfo"]["name"], "atlas", "{init}");
        c.send(json!({"jsonrpc": "2.0", "method": "notifications/initialized"}));
        c
    }

    fn send(&mut self, v: Value) {
        writeln!(self.stdin, "{v}").unwrap();
        self.stdin.flush().unwrap();
    }

    fn request(&mut self, method: &str, params: Value) -> Value {
        let id = self.next;
        self.next += 1;
        self.send(json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}));
        loop {
            let line = self.lines.recv_timeout(Duration::from_secs(120)).expect("a reply from atlas-mcp");
            let v: Value = serde_json::from_str(&line).unwrap_or(Value::Null);
            if v.get("id") == Some(&json!(id)) {
                return v;
            }
        }
    }

    /// (is_error, parsed JSON of the text, raw text)
    fn call(&mut self, name: &str, args: Value) -> (bool, Value, String) {
        let r = self.request("tools/call", json!({"name": name, "arguments": args}));
        let res = &r["result"];
        assert!(res.is_object(), "no result for {name}: {r}");
        let text = res["content"][0]["text"].as_str().unwrap_or("").to_string();
        (res["isError"].as_bool().unwrap_or(false), serde_json::from_str(&text).unwrap_or(Value::Null), text)
    }
}

impl Drop for Client {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

const TOOLS: [&str; 3] = ["get_agent_scorecard", "get_review_themes", "get_run_debrief"];

#[test]
fn the_three_tools_are_listed_read_only_in_both_modes() {
    let sb = Sandbox::new();
    for extra in [&[][..], &["--propose"]] {
        let mut c = Client::start(&sb, extra);
        let r = c.request("tools/list", json!({}));
        let tools = r["result"]["tools"].as_array().unwrap();
        for name in TOOLS {
            let t = tools.iter().find(|t| t["name"] == name).unwrap_or_else(|| panic!("{name} not listed"));
            assert_eq!(t["annotations"]["readOnlyHint"], true, "{name}");
            assert_eq!(t["annotations"]["openWorldHint"], false, "{name}");
            assert!(t["description"].as_str().unwrap().contains("Read-only"), "{name}");
        }
        assert!(tools.iter().any(|t| t["name"] == "find_repeated_requests"), "the other tools are still there");
    }
}

// Criterion 35: the debrief text is the CLI's text (both call `debrief_text::render`), and the
// tools write nothing in the Claude folder.
#[test]
fn get_run_debrief_returns_the_same_text_as_the_cli_and_writes_nothing() {
    let sb = Sandbox::new();
    // NTFS posts a folder's modified time into its parent's listing a moment after the copy, so
    // let that settle (read twice) before taking the baseline.
    let _ = tree(&sb.config);
    std::thread::sleep(Duration::from_millis(500));
    let _ = tree(&sb.config);
    let before = tree(&sb.config);
    let mut c = Client::start(&sb, &[]);

    let golden = root().join("crates").join("cli").join("tests").join("golden");
    let want = |n: &str| fs::read_to_string(golden.join(n)).unwrap().replace("\r\n", "\n").trim_end().to_string();

    let (err, _, low) = c.call("get_run_debrief", json!({"sessionId": S1}));
    assert!(!err, "{low}");
    assert_eq!(low, want("debrief-ledger-s1-low.txt"), "byte-identical to the CLI's golden text");

    let (err, _, high) = c.call("get_run_debrief", json!({"sessionId": S1, "detail": "high"}));
    assert!(!err);
    assert_eq!(high, want("debrief-ledger-s1-high.txt"));

    let (_, _, with_cost) = c.call("get_run_debrief", json!({"sessionId": S1, "includeCost": true}));
    assert!(with_cost.contains("at API prices (an estimate)") && !low.contains('$'));

    let (err, _, late) = c.call("get_run_debrief", json!({"sessionId": S1, "since": "2026-11-06T09:20:00Z"}));
    assert!(!err && late.contains("Helpers: 6 ("), "{late}");

    let (err, _, none) = c.call("get_run_debrief", json!({"sessionId": S2}));
    assert!(!err && none.lines().any(|l| l == "Helpers: none"), "{none}");

    // Nothing in the Claude folder changed: same files, sizes and modified times, folders included.
    drop(c);
    assert_eq!(tree(&sb.config), before, "the tools only read the chats");
}

#[test]
fn bad_input_gets_a_plain_error_not_a_crash() {
    let sb = Sandbox::new();
    let mut c = Client::start(&sb, &[]);
    let (err, _, t) = c.call("get_run_debrief", json!({"sessionId": "no-such-chat"}));
    assert!(err && t == "No chat with that id.", "{t}");
    let (err, _, t) = c.call("get_run_debrief", json!({"sessionId": S1, "detail": "medium"}));
    assert!(err && t.contains("low or high"), "{t}");
    let (err, _, t) = c.call("get_run_debrief", json!({"sessionId": S1, "since": "yesterday"}));
    assert!(err && t.starts_with("since:"), "{t}");
    let (err, _, t) = c.call("get_agent_scorecard", json!({"startedFrom": "sideways"}));
    assert!(err && t.contains("interactive"), "{t}");
}

#[test]
fn the_scorecard_and_the_themes_come_back_as_json_facts() {
    let sb = Sandbox::new();
    let mut c = Client::start(&sb, &[]);
    let (err, v, raw) = c.call("get_agent_scorecard", json!({}));
    assert!(!err, "{raw}");
    assert!(v["totalRuns"].as_u64().unwrap() >= 14, "{raw}");
    let types = v["types"].as_array().unwrap();
    assert!(types.iter().any(|t| t["agentType"] == "coder" && t["runs"].as_u64() == Some(6)), "{raw}");
    assert!(types.iter().all(|t| t["recent"].as_array().is_none_or(|r| r.is_empty())), "per-run lists are left out without agentType");
    assert!(v["typesTotal"].as_u64().unwrap() as usize >= types.len());

    let (_, one, _) = c.call("get_agent_scorecard", json!({"agentType": "coder"}));
    assert_eq!(one["types"].as_array().unwrap().len(), 1);
    assert!(one["types"][0]["recent"].as_array().is_some_and(|r| !r.is_empty()), "the one type lists its newest runs");

    let (_, limited, _) = c.call("get_agent_scorecard", json!({"limit": 1}));
    assert_eq!(limited["types"].as_array().unwrap().len(), 1);

    let (_, headless, _) = c.call("get_agent_scorecard", json!({"startedFrom": "headless"}));
    assert!(headless["totalRuns"].as_u64().unwrap() < v["totalRuns"].as_u64().unwrap());

    let (err, t, raw) = c.call("get_review_themes", json!({}));
    assert!(!err, "{raw}");
    assert!(t["themes"].is_array() && t["findings"].is_u64(), "{raw}");
    // Secret-shaped text never leaves: the index masks it before it is stored.
    assert!(!raw.contains("sk-ant-") && !raw.contains("ghp_"), "{raw}");
}
