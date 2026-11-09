//! Drives the real `atlas-mcp` program over stdin/stdout, like Claude Code does, against a
//! scratch copy of `fixtures/claude-basic`. Nothing here touches the real Claude folder.

use std::collections::BTreeMap;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{Receiver, channel};
use std::time::Duration;

use serde_json::{Value, json};

fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("fixtures").join("claude-basic")
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

/// Every file under `dir` with its bytes, to prove "nothing changed".
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
    fn new() -> Sandbox {
        let tmp = tempfile::tempdir().unwrap();
        let config = tmp.path().join("claude");
        let data = tmp.path().join("data");
        copy_dir(&fixture(), &config);
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
        // Deletes in the sandbox must not land in the real Recycle Bin.
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

    /// Call a tool: (is_error, parsed JSON of the text, raw text).
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

fn id_of(c: &mut Client, kind: &str, name: &str) -> String {
    let (err, v, t) = c.call("list_items", json!({"kind": kind, "limit": 200}));
    assert!(!err, "{t}");
    v["items"].as_array().unwrap().iter().find(|i| i["name"].as_str().is_some_and(|n| n == name || n.starts_with(&format!("{name} ")))).unwrap_or_else(|| panic!("no {kind} {name} in {t}"))["id"].as_str().unwrap().to_string()
}

#[test]
fn lists_the_eleven_tools_with_descriptions_and_schemas() {
    let sb = Sandbox::new();
    let mut c = Client::start(&sb, &[]);
    let r = c.request("tools/list", json!({}));
    let tools = r["result"]["tools"].as_array().unwrap();
    let mut names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
    names.sort();
    assert_eq!(names, ["create_item", "delete_item", "get_usage_summary", "list_backups", "list_items", "read_item", "rename_item", "restore_backup", "toggle_hook", "toggle_mcp_server", "update_item"]);
    for t in tools {
        assert!(t["description"].as_str().is_some_and(|d| d.len() > 30), "{t}");
        assert_eq!(t["inputSchema"]["type"], "object", "{t}");
    }
    let read = tools.iter().find(|t| t["name"] == "read_item").unwrap();
    assert_eq!(read["inputSchema"]["required"], json!(["id"]));
}

#[test]
fn create_edit_rename_delete_restore_leave_backups_tagged_mcp() {
    let sb = Sandbox::new();
    let mut c = Client::start(&sb, &[]);
    let skill = sb.config.join("skills").join("e2e-skill").join("SKILL.md");

    let (err, v, t) = c.call("create_item", json!({"kind": "skill", "name": "e2e-skill", "text": "---\nname: e2e-skill\ndescription: A skill made through the Atlas MCP server.\n---\n\nSay hello.\n"}));
    assert!(!err, "{t}");
    assert!(skill.is_file());
    let created_backup = v["backupId"].as_str().expect("a backup id").to_string();

    let id = id_of(&mut c, "skill", "e2e-skill");
    let (_, read, _) = c.call("read_item", json!({"id": id}));
    assert!(read["text"].as_str().unwrap().contains("Say hello."));
    let stamp = read["stamp"].as_str().unwrap().to_string();

    // A stale stamp is refused and the file is not touched.
    let (err, _, t) = c.call("update_item", json!({"id": id, "text": "---\nname: e2e-skill\ndescription: x\n---\nnope\n", "stamp": "0000"}));
    assert!(err, "{t}");
    assert!(fs::read_to_string(&skill).unwrap().contains("Say hello."));

    let (err, v, t) = c.call("update_item", json!({"id": id, "stamp": stamp, "text": "---\nname: e2e-skill\ndescription: Edited by Claude.\n---\n\nSay goodbye.\n"}));
    assert!(!err, "{t}");
    assert!(fs::read_to_string(&skill).unwrap().contains("Say goodbye."));
    assert!(v["backupId"].is_string());

    let (err, _, t) = c.call("rename_item", json!({"id": id, "newName": "e2e-renamed"}));
    assert!(!err, "{t}");
    assert!(!skill.exists());
    assert!(sb.config.join("skills").join("e2e-renamed").join("SKILL.md").is_file());

    let id2 = id_of(&mut c, "skill", "e2e-renamed");
    let (err, v, t) = c.call("delete_item", json!({"id": id2}));
    assert!(!err, "{t}");
    assert!(!sb.config.join("skills").join("e2e-renamed").exists());
    let del_backup = v["backupId"].as_str().unwrap().to_string();

    let (err, _, t) = c.call("restore_backup", json!({"backupId": del_backup}));
    assert!(!err, "{t}");
    assert!(sb.config.join("skills").join("e2e-renamed").join("SKILL.md").is_file());

    // Every backup is on disk and tagged as made through the MCP server.
    let (_, b, _) = c.call("list_backups", json!({}));
    let list = b["backups"].as_array().unwrap();
    assert!(list.len() >= 4, "{b}");
    assert!(list.iter().any(|x| x["backupId"] == created_backup.as_str()));
    assert!(list.iter().all(|x| x["source"] == "mcp"), "{b}");
    assert!(sb.data.join("setup-backups").join(&del_backup).join("manifest.json").is_file());
}

#[test]
fn credentials_and_keys_are_never_listed_read_or_written() {
    let sb = Sandbox::new();
    let mut c = Client::start(&sb, &[]);
    let before = snapshot(&sb.config);

    let (err, _, all) = c.call("list_items", json!({"limit": 200}));
    assert!(!err);
    for needle in [".credentials", "fixture-session.key", "credentials.json"] {
        assert!(!all.contains(needle), "list_items leaked {needle}");
    }

    // Made-up ids and paths that point at the secret files are all refused.
    let cred = sb.config.join(".credentials.json");
    let key = sb.config.join("sessions").join("fixture-session.key");
    let guesses = [
        cred.to_string_lossy().to_string(),
        key.to_string_lossy().to_string(),
        "../.credentials.json".to_string(),
        "..\\.credentials.json".to_string(),
        "file:.credentials.json".to_string(),
        "creds".to_string(),
        String::new(),
    ];
    for g in &guesses {
        let (err, _, t) = c.call("read_item", json!({"id": g}));
        assert!(err, "read_item({g:?}) was allowed: {t}");
        assert!(!t.contains("accessToken") && !t.contains("sk-ant"), "{t}");
        let (err, _, t) = c.call("update_item", json!({"id": g, "text": "x"}));
        assert!(err, "update_item({g:?}) was allowed: {t}");
        let (err, _, t) = c.call("delete_item", json!({"id": g}));
        assert!(err, "delete_item({g:?}) was allowed: {t}");
    }

    // A real skill id with a `file` that escapes the skill folder or names a key file.
    let skill = id_of(&mut c, "skill", "commit-helper");
    for f in ["../../.credentials.json", "..\\..\\.credentials.json", "../../sessions/fixture-session.key", cred.to_str().unwrap(), "secrets.key", ".credentials.json", ".env"] {
        let (err, _, t) = c.call("read_item", json!({"id": skill, "file": f}));
        assert!(err, "read_item file {f:?} was allowed: {t}");
        let (err, _, t) = c.call("update_item", json!({"id": skill, "file": f, "text": "x"}));
        assert!(err, "update_item file {f:?} was allowed: {t}");
    }

    // Names that try to leave the folder.
    for n in ["../evil", "..\\evil", "a/b", "C:\\evil", ".credentials"] {
        let (err, _, t) = c.call("create_item", json!({"kind": "skill", "name": n}));
        assert!(err, "create_item {n:?} was allowed: {t}");
        let (err, _, t) = c.call("rename_item", json!({"id": skill, "newName": n}));
        assert!(err, "rename_item {n:?} was allowed: {t}");
    }

    // The dots Atlas shows in place of a secret can't be written back.
    let (err, _, t) = c.call("update_item", json!({"id": skill, "text": "---\nname: commit-helper\ndescription: x\n---\n\u{2022}\u{2022}\u{2022}\u{2022}\u{2022}\u{2022}\u{2022}\u{2022}\n"}));
    assert!(err, "{t}");

    assert_eq!(snapshot(&sb.config), before, "a refused call changed something on disk");
}

#[test]
fn the_server_has_no_network_listener() {
    // Source-level guard: the transport is stdio only and no socket or HTTP feature is enabled.
    let manifest = fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml")).unwrap();
    assert!(manifest.contains("transport-io") && !manifest.contains("streamable-http") && !manifest.contains("server-side-http") && !manifest.contains("axum") && !manifest.contains("hyper"));
    let main = fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("main.rs")).unwrap();
    for banned in ["TcpListener", "UdpSocket", "bind(", "http_server", "hyper::", "axum::"] {
        assert!(!main.contains(banned), "{banned} appears in main.rs");
    }
}

#[test]
fn direct_mode_will_not_plant_a_command_but_propose_mode_queues_it() {
    let sb = Sandbox::new();
    let before = snapshot(&sb.config);
    {
        let mut c = Client::start(&sb, &[]);
        let (err, _, t) = c.call("create_item", json!({"kind": "hook", "name": "x", "event": "PostToolUse"}));
        assert!(err && t.contains("approval"), "{t}");
        let (err, _, t) = c.call("create_item", json!({"kind": "mcpServer", "name": "evil", "text": "{\"command\":\"calc\"}"}));
        assert!(err && t.contains("approval"), "{t}");
        let hook = id_of(&mut c, "hook", "PostToolUse");
        let (err, _, t) = c.call("update_item", json!({"id": hook, "text": "{}"}));
        assert!(err && t.contains("approval"), "{t}");
    }
    assert_eq!(snapshot(&sb.config), before);

    let queue = sb.data.join("pending-changes");
    let mut c = Client::start(&sb, &["--propose"]);
    let (err, v, t) = c.call("create_item", json!({"kind": "skill", "name": "queued-skill"}));
    assert!(!err, "{t}");
    assert_eq!(v["proposed"], true);
    let (err, v2, t) = c.call("create_item", json!({"kind": "hook", "name": "x", "event": "PostToolUse"}));
    assert!(!err, "{t}");
    assert_eq!(v2["status"], "pending");
    let skill = id_of(&mut c, "skill", "commit-helper");
    let (_, read, _) = c.call("read_item", json!({"id": skill}));
    let (err, _, t) = c.call("update_item", json!({"id": skill, "text": format!("{}\nExtra line.\n", read["text"].as_str().unwrap())}));
    assert!(!err, "{t}");
    let (err, _, t) = c.call("delete_item", json!({"id": skill}));
    assert!(!err, "{t}");

    // Nothing in the Claude folder changed; the queue holds four pending changes with before/after.
    assert_eq!(snapshot(&sb.config), before);
    assert!(!sb.data.join("setup-backups").exists() || fs::read_dir(sb.data.join("setup-backups")).unwrap().count() == 0);
    let files: Vec<_> = fs::read_dir(&queue).unwrap().flatten().collect();
    assert_eq!(files.len(), 4);
    let id = v["changeId"].as_str().unwrap();
    let rec: Value = serde_json::from_slice(&fs::read(queue.join(format!("{id}.json"))).unwrap()).unwrap();
    assert_eq!(rec["status"], "pending");
    assert_eq!(rec["tool"], "create_item");
    assert!(rec["before"].is_null() && rec["after"].as_str().unwrap().contains("queued-skill"));
    assert_eq!(rec["request"]["tool"], "create_item");
    // An edit proposal is pinned to the file as it was.
    let edit = files.iter().filter_map(|f| serde_json::from_slice::<Value>(&fs::read(f.path()).unwrap()).ok()).find(|r| r["tool"] == "update_item").unwrap();
    assert!(edit["request"]["stamp"].is_string());
}

#[test]
fn usage_summary_reads_the_fixture_chats() {
    let sb = Sandbox::new();
    let mut c = Client::start(&sb, &[]);
    let (err, v, t) = c.call("get_usage_summary", json!({"period": "all"}));
    assert!(!err, "{t}");
    assert!(v["tokens"]["total"].is_number(), "{t}");
    assert!(v["costNote"].is_string());
    let (err, _, t) = c.call("get_usage_summary", json!({"period": "someday"}));
    assert!(err, "{t}");
}

/// The program must never open a console window, whoever starts it: on Windows that means the
/// GUI subsystem (2) in the PE header, not the console one (3).
#[cfg(windows)]
#[test]
fn the_windows_build_has_no_console_subsystem() {
    let bytes = fs::read(env!("CARGO_BIN_EXE_atlas-mcp")).unwrap();
    let pe = u32::from_le_bytes(bytes[0x3c..0x40].try_into().unwrap()) as usize;
    assert_eq!(&bytes[pe..pe + 4], b"PE  ");
    // Optional header starts 24 bytes in; Subsystem sits 68 bytes into it (same for PE32 and PE32+).
    let sub = u16::from_le_bytes(bytes[pe + 24 + 68..pe + 24 + 70].try_into().unwrap());
    assert_eq!(sub, 2, "atlas-mcp must be a windowed (GUI subsystem) program, got subsystem {sub}");
}

/// The registration Connect writes actually starts the server. Needs Claude Code installed:
/// `cargo test -p atlas-mcp --test stdio registered_entry -- --ignored --nocapture`.
/// Connects into a scratch folder (`--config-dir` style, never the real one), then has Claude
/// Code's own `claude mcp get atlas` start the program from that entry and report its health.
#[test]
#[ignore = "runs the real claude command"]
fn the_registered_entry_starts_the_server_when_claude_code_launches_it() {
    use atlas_core::connect::{self, CliChoice, ConnectCtx};
    use atlas_core::paths::{ConfigInputs, resolve_config_root};
    let sb = Sandbox::new();
    let home = sb._tmp.path().join("home");
    fs::create_dir_all(&home).unwrap();
    let root = resolve_config_root(&ConfigInputs { flag: Some(&sb.config), settings_override: None, env: None, home: &home, cwd: sb._tmp.path() });
    let server = PathBuf::from(env!("CARGO_BIN_EXE_atlas-mcp"));
    let backups = sb.data.join("setup-backups");
    let ctx = ConnectCtx { root: &root, server: &server, backups: &backups, data_dir_flag: Some(&sb.data), cli: CliChoice::Auto };
    assert!(ctx.cli.found(), "Claude Code's command is not installed here");
    let out = connect::connect(&ctx).unwrap();
    assert_eq!((out.via.as_str(), out.state.state.as_str()), ("cli", "connected"));

    let claude = atlas_core::connect::find_claude_cli(std::env::var_os("PATH").as_deref(), &atlas_core::paths::home_dir().unwrap()).expect("claude");
    let mut cmd = Command::new(claude);
    cmd.args(["mcp", "get", "atlas"]).env("CLAUDE_CONFIG_DIR", &sb.config).env_remove("ATLAS_DATA_DIR").stdin(Stdio::null());
    atlas_core::proc::quiet(&mut cmd);
    let got = cmd.output().expect("run claude mcp get");
    let text = format!("{}{}", String::from_utf8_lossy(&got.stdout), String::from_utf8_lossy(&got.stderr));
    eprintln!("{text}");
    assert!(text.contains("Connected"), "Claude Code could not start the registered server:\n{text}");
    connect::disconnect(&ctx).unwrap();
}
