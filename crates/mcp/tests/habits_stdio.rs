//! Repeated requests over real stdio JSON-RPC (docs/specs/skill-library.md, criteria 27-29):
//! the real `atlas-mcp` program against a scratch copy of `fixtures/claude-habits`, with the
//! fixture's dates moved to "a few days ago" so the 90-day window never ages the test out.
//! Nothing here touches the real Claude folder or Atlas data.

use std::collections::BTreeMap;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Arc;
use std::sync::mpsc::{Receiver, channel};
use std::time::{Duration, Instant};

use atlas_core::search::db::search_file;
use atlas_core::search::{NullSearchSink, SearchConfig, SearchEngine};
use serde_json::{Value, json};

const PLANTED: &str = "Read the README and give me a three bullet summary in plain words";
const FRESH: &str = "Read the README for me and give a three bullet summary in plain words";

fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("fixtures").join("claude-habits")
}

// ---- dates: Hinnant's civil <-> days, so the fixture can be moved by whole days

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

fn today_days() -> i64 {
    (std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() / 86_400) as i64
}

/// Copy the fixture into `to`, moving every `timestamp` so the newest planted ask is 3 days old.
fn copy_shifted(from: &Path, to: &Path, delta: i64) {
    fs::create_dir_all(to).unwrap();
    for e in fs::read_dir(from).unwrap().flatten() {
        let (src, dst) = (e.path(), to.join(e.file_name()));
        if e.file_type().unwrap().is_dir() {
            copy_shifted(&src, &dst, delta);
        } else if src.extension().is_some_and(|x| x == "jsonl") {
            let mut out = String::new();
            for l in fs::read_to_string(&src).unwrap().lines() {
                let Ok(mut v) = serde_json::from_str::<Value>(l) else {
                    out.push_str(l);
                    out.push('\n');
                    continue;
                };
                if let Some(ts) = v["timestamp"].as_str().map(str::to_string) {
                    let (y, m, d) = (ts[0..4].parse::<i64>().unwrap(), ts[5..7].parse::<i64>().unwrap(), ts[8..10].parse::<i64>().unwrap());
                    let (y, m, d) = civil_from_days(days_from_civil(y, m, d) + delta);
                    v["timestamp"] = json!(format!("{y:04}-{m:02}-{d:02}{}", &ts[10..]));
                }
                out.push_str(&v.to_string());
                out.push('\n');
            }
            fs::write(&dst, out).unwrap();
        } else {
            fs::copy(&src, &dst).unwrap();
        }
    }
}

fn snapshot(dir: &Path) -> BTreeMap<String, Vec<u8>> {
    let mut out = BTreeMap::new();
    fn walk(base: &Path, dir: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
        for e in fs::read_dir(dir).unwrap().flatten() {
            let p = e.path();
            if e.file_type().unwrap().is_dir() {
                walk(base, &p, out);
            } else {
                out.insert(p.strip_prefix(base).unwrap().to_string_lossy().replace('\\', "/"), fs::read(&p).unwrap());
            }
        }
    }
    walk(dir, dir, &mut out);
    out
}

struct Sandbox {
    _tmp: tempfile::TempDir,
    config: PathBuf,
    data: PathBuf,
}

impl Sandbox {
    /// The fixture, dates moved, no index yet.
    fn new() -> Sandbox {
        let tmp = tempfile::tempdir().unwrap();
        let config = tmp.path().join("claude");
        let data = tmp.path().join("data");
        let delta = (today_days() - 3) - days_from_civil(2026, 10, 30);
        copy_shifted(&fixture(), &config, delta);
        fs::create_dir_all(&data).unwrap();
        Sandbox { _tmp: tmp, config, data }
    }

    fn index_file(&self) -> PathBuf {
        // `--config-dir` is not a real root, so the index has its own file under the data folder.
        search_file(&self.data, &self.config.join("projects"), false)
    }

    /// What the app does in the background: read the chats into the search index.
    fn index(&self) {
        let mut cfg = SearchConfig::new(self.config.join("projects"), self.config.clone(), self.index_file());
        cfg.debounce = Duration::from_millis(20);
        let e = SearchEngine::start(cfg, Arc::new(NullSearchSink));
        let n = e.passes();
        e.poke();
        assert!(e.wait_pass(n, Duration::from_secs(60)), "the index pass did not finish");
        e.stop();
    }

    fn indexed() -> Sandbox {
        let sb = Sandbox::new();
        sb.index();
        sb
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

// ---------------------------------------------------------------- criterion 27

#[test]
fn find_repeated_requests_returns_the_planted_group_and_only_what_was_typed() {
    let sb = Sandbox::indexed();
    let before = fs::read(sb.index_file()).unwrap();
    let mut c = Client::start(&sb, &[]);

    let tools = c.request("tools/list", json!({}));
    let find = tools["result"]["tools"].as_array().unwrap().iter().find(|t| t["name"] == "find_repeated_requests").expect("the tool is listed").clone();
    assert_eq!(find["annotations"]["readOnlyHint"], true, "{find}");

    let (err, v, text) = c.call("find_repeated_requests", json!({}));
    assert!(!err, "{text}");
    let groups = v["groups"].as_array().unwrap();
    assert_eq!(groups.len(), 1, "only the planted request is a repeat: {text}");
    let g = &groups[0];
    assert_eq!((g["count"].as_u64(), g["sessions"].as_u64(), g["days"].as_u64()), (Some(7), Some(4), Some(3)), "{text}");
    assert_eq!(g["projects"], json!(["notes", "site"]));
    assert!(g["examples"].as_array().unwrap().len() <= 5);
    assert_eq!(g["meetsBar"], true);
    assert_eq!(g["offer"], Value::Null);
    assert_eq!(v["offersOff"], false);
    assert!(v["indexedThroughMs"].as_i64().unwrap_or(0) > 0);
    assert!(g["lastSeenMs"].as_i64().unwrap() > g["firstSeenMs"].as_i64().unwrap());
    for banned in ["***", "zebra", "fetchLegacy", "task-notification", "Traceback"] {
        assert!(!text.contains(banned), "{banned} in {text}");
    }

    // A fresh wording of the same ask is matched to that group.
    let (err, v, text) = c.call("find_repeated_requests", json!({"like": FRESH}));
    assert!(!err, "{text}");
    assert_eq!(v["likeMatch"]["groupId"], g["id"], "{text}");
    assert!(v["likeMatch"]["similarity"].as_f64().unwrap() >= 0.55);
    assert_eq!(v["groups"][0]["id"], g["id"]);

    // A one-off matches nothing.
    let (_, v, _) = c.call("find_repeated_requests", json!({"like": "translate the onboarding text into French and keep the tone"}));
    assert_eq!(v["likeMatch"], Value::Null);

    // The index was only read (same bytes), and a second call with nothing new is quick (criterion 26).
    let t = Instant::now();
    let (err, _, _) = c.call("find_repeated_requests", json!({}));
    assert!(!err);
    assert!(t.elapsed() < Duration::from_millis(500), "a second call took {:?}", t.elapsed());
    drop(c);
    assert_eq!(fs::read(sb.index_file()).unwrap(), before, "the index file changed");
}

#[test]
fn a_missing_index_and_a_schema_one_index_get_the_plain_sentences() {
    let sb = Sandbox::new();
    let mut c = Client::start(&sb, &[]);
    let (err, _, text) = c.call("find_repeated_requests", json!({}));
    assert!(err);
    assert_eq!(text, "Atlas has not read your chats yet. Open the Atlas app once and try again.");
    drop(c);

    // The previous Atlas's index: schema 1 (user_version is the 4 bytes at offset 60).
    sb.index();
    let mut bytes = fs::read(sb.index_file()).unwrap();
    bytes[60..64].copy_from_slice(&1u32.to_be_bytes());
    fs::write(sb.index_file(), bytes).unwrap();
    let mut c = Client::start(&sb, &[]);
    let (err, _, text) = c.call("find_repeated_requests", json!({}));
    assert!(err);
    assert_eq!(text, "Open the Atlas app once so it can update its chat index.");
}

// ---------------------------------------------------------------- criterion 28

#[test]
fn note_skill_offer_remembers_declined_and_never_and_keeps_prompts_out_of_the_file() {
    let sb = Sandbox::indexed();
    let claude_before = snapshot(&sb.config);
    let mut c = Client::start(&sb, &[]);
    let (_, v, _) = c.call("find_repeated_requests", json!({}));
    let id = v["groups"][0]["id"].as_str().unwrap().to_string();

    let (err, v, text) = c.call("note_skill_offer", json!({"groupId": id, "answer": "offered"}));
    assert!(!err, "{text}");
    assert_eq!(v["offersOff"], false);
    let (err, _, text) = c.call("note_skill_offer", json!({"groupId": id, "answer": "declined"}));
    assert!(!err, "{text}");
    let (_, v, _) = c.call("find_repeated_requests", json!({"like": FRESH}));
    assert_eq!(v["groups"][0]["offer"]["answer"], "declined", "{v}");
    assert_eq!(v["likeOffer"]["answer"], "declined");
    assert_eq!(v["offersOff"], false);

    let (err, v, text) = c.call("note_skill_offer", json!({"answer": "never"}));
    assert!(!err, "{text}");
    assert_eq!(v["offersOff"], true);
    let (_, v, _) = c.call("find_repeated_requests", json!({}));
    assert_eq!(v["offersOff"], true);

    // A new server process still knows it (the answer is on disk).
    drop(c);
    let mut c = Client::start(&sb, &[]);
    let (_, v, _) = c.call("find_repeated_requests", json!({}));
    assert_eq!(v["offersOff"], true);
    assert_eq!(v["groups"][0]["offer"]["answer"], "declined");

    // Bad input is one plain sentence, not a crash.
    let (err, _, text) = c.call("note_skill_offer", json!({"groupId": id, "answer": "maybe"}));
    assert!(err && text.contains("offered, declined, made or never"), "{text}");
    let (err, _, text) = c.call("note_skill_offer", json!({"answer": "declined"}));
    assert!(err && text.contains("groupId"), "{text}");

    // habits.json: ids and answers, no fixture prompt text. The Claude folder: untouched.
    let raw = fs::read_to_string(sb.data.join("habits.json")).unwrap();
    for text in ["README", "bullet", "plain words", "linter", "fetchLegacy", "fixture", "zebra", "***"] {
        assert!(!raw.contains(text), "{text} in {raw}");
    }
    let parsed: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(parsed["schemaVersion"], 1);
    assert_eq!(parsed["offersOff"], true);
    assert_eq!(snapshot(&sb.config), claude_before, "the Claude folder changed");
    let _ = PLANTED;
}

#[test]
fn propose_mode_still_allows_the_two_tools_and_queues_nothing_for_them() {
    let sb = Sandbox::indexed();
    let mut c = Client::start(&sb, &["--propose"]);
    let (err, v, text) = c.call("find_repeated_requests", json!({}));
    assert!(!err, "{text}");
    let id = v["groups"][0]["id"].as_str().unwrap().to_string();
    let (err, v, text) = c.call("note_skill_offer", json!({"groupId": id, "answer": "made", "skillName": "readme-summary"}));
    assert!(!err, "{text}");
    assert_eq!(v["proposed"], Value::Null, "it is not a proposal: {text}");
    assert!(!sb.data.join("pending-changes").exists() || fs::read_dir(sb.data.join("pending-changes")).unwrap().next().is_none());
    let (_, v, _) = c.call("find_repeated_requests", json!({}));
    assert_eq!(v["groups"][0]["offer"]["answer"], "made");
    assert_eq!(v["groups"][0]["offer"]["skillName"], "readme-summary");
}

// ---------------------------------------------------------------- criterion 30 (the file part)

fn frontmatter(text: &str) -> Vec<(String, String)> {
    let mut lines = text.lines();
    assert_eq!(lines.next(), Some("---"));
    lines.take_while(|l| *l != "---").filter_map(|l| l.split_once(": ").map(|(k, v)| (k.to_string(), v.to_string()))).collect()
}

#[test]
fn every_plugin_skill_is_ascii_and_its_frontmatter_will_parse() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("skill").join("skills");
    let mut seen = 0;
    for e in fs::read_dir(&dir).unwrap().flatten() {
        let file = e.path().join("SKILL.md");
        let text = fs::read_to_string(&file).unwrap();
        let name = e.file_name().to_string_lossy().to_string();
        let fm = frontmatter(&text);
        let get = |k: &str| fm.iter().find(|(key, _)| key == k).map(|(_, v)| v.as_str());
        assert_eq!(get("name"), Some(name.as_str()), "{file:?}");
        for key in ["description", "when_to_use", "allowed-tools"] {
            assert!(get(key).is_some_and(|v| !v.is_empty()), "{name} has no {key}");
        }
        // A plain YAML value cannot hold ": ": the usage skill once lost all its metadata that way.
        for (k, v) in &fm {
            if !v.starts_with('"') && !v.starts_with('\'') {
                assert!(!v.contains(": ") && !v.contains(" #"), "{name}: {k} would not parse as YAML");
            }
        }
        if name == "atlas-repeats" {
            assert!(text.is_ascii(), "atlas-repeats must be ASCII");
            let tools = get("allowed-tools").unwrap();
            assert!(tools.contains("mcp__atlas__find_repeated_requests") && tools.contains("mcp__atlas__note_skill_offer"));
            assert!(!tools.contains("create_item"), "the save must ask the user first");
            // The no-app path: the plugin's own launcher, with exactly the two subcommands.
            for want in ["atlas-usage.sh\" repeats *", "atlas-usage.sh\" offer-note *", "atlas-usage.ps1\" repeats *", "atlas-usage.ps1\" offer-note *"] {
                assert!(tools.contains(want), "allowed-tools lacks {want}");
            }
            assert!(dir.join("atlas").join("bin").join("atlas-usage.sh").is_file() && dir.join("atlas").join("bin").join("atlas-usage.ps1").is_file());
            assert!(text.lines().count() <= 120, "keep the skill short");
        }
        seen += 1;
    }
    assert!(seen >= 2, "the usage skill and atlas-repeats");
}

// ---------------------------------------------------------------- criterion 29

const DRAFT: &str = "---\nname: readme-summary\ndescription: Summarizes the README in three plain bullets. Use when the user asks things like 'Read the README and give me a three bullet summary in plain words' or 'give me a 3 bullet summary of the README'.\n---\n\n# README summary\n\nThe user asks for this often. Do it the way they describe it:\n\n> Read the README and give me a three bullet summary in plain words\n\n## Ways they ask\n- 'Read the README again and give me a three bullet summary in plain words'\n- 'read the README and give me a 3 bullet summary in plain words'\n";

#[test]
fn create_item_accepts_the_filled_draft_and_refuses_one_with_allowed_tools() {
    let sb = Sandbox::new();
    let mut c = Client::start(&sb, &[]);
    let (err, v, text) = c.call("create_item", json!({"kind": "skill", "name": "readme-summary", "text": DRAFT}));
    assert!(!err, "{text}");
    assert!(sb.config.join("skills").join("readme-summary").join("SKILL.md").is_file());
    let backup = v["backupId"].as_str().expect("a backup id").to_string();
    let (_, b, _) = c.call("list_backups", json!({}));
    let row = b["backups"].as_array().unwrap().iter().find(|x| x["backupId"] == backup.as_str()).expect("the backup is listed");
    assert_eq!(row["source"], "mcp", "{row}");

    let risky = DRAFT.replace("---\n\n#", "allowed-tools: Bash\n---\n\n#").replace("readme-summary", "readme-summary-2");
    let (err, _, text) = c.call("create_item", json!({"kind": "skill", "name": "readme-summary-2", "text": risky}));
    assert!(err, "a skill with allowed-tools must be refused in direct mode: {text}");
    assert!(!sb.config.join("skills").join("readme-summary-2").exists());
}
