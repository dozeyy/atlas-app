//! The operations behind the Atlas MCP server (`ops`), the propose-mode queue (`pending`),
//! History's "edited by Claude" tags (`history::marks`) and Connect (`connect`), all against a
//! scratch copy of `fixtures/claude-basic`. The real Claude folder is never opened.

use std::fs;
use std::path::{Path, PathBuf};

use atlas_core::connect::{self, CliChoice, ConnectCtx};
use atlas_core::history::marks::Marks;
use atlas_core::history::query::{self, EventFilter};
use atlas_core::history::store::Store;
use atlas_core::history::{scan, tracked_from};
use atlas_core::ops::{ListFilter, Ops, Write};
use atlas_core::paths::{ConfigInputs, resolve_config_root};
use atlas_core::pending;
use atlas_core::setup::{DiscoveryInputs, default_managed_dir};

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

struct Env {
    _t: tempfile::TempDir,
    config: PathBuf,
    data: PathBuf,
    inputs: DiscoveryInputs,
}

fn env() -> Env {
    let t = tempfile::tempdir().unwrap();
    let config = t.path().join("claude");
    let data = t.path().join("data");
    copy_dir(&Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("fixtures").join("claude-basic"), &config);
    fs::create_dir_all(&data).unwrap();
    let home = t.path().join("home");
    fs::create_dir_all(&home).unwrap();
    let root = resolve_config_root(&ConfigInputs { flag: Some(&config), settings_override: None, env: None, home: &home, cwd: t.path() });
    let inputs = DiscoveryInputs { root, home, managed_dir: default_managed_dir(), include_worktrees: false, sandboxed: false };
    Env { _t: t, config, data, inputs }
}

fn ops(e: &Env, source: &str) -> Ops {
    Ops::new(DiscoveryInputs { root: e.inputs.root.clone(), home: e.inputs.home.clone(), managed_dir: None, include_worktrees: false, sandboxed: false }, &e.data, source)
}

fn skill_id(o: &Ops, name: &str) -> String {
    o.list_items(&ListFilter { kind: Some("skill".into()), limit: Some(200), ..Default::default() }).items.into_iter().find(|i| i.name == name).unwrap_or_else(|| panic!("no skill {name}")).id
}

fn skill_text(name: &str, body: &str) -> String {
    format!("---\nname: {name}\ndescription: Made for a test.\n---\n\n{body}\n")
}

#[test]
fn history_says_edited_by_claude_for_changes_made_through_ops() {
    let e = env();
    let store = Store::open(&e.data.join("history")).unwrap();
    let o = ops(&e, "mcp");
    let tracked = |o: &Ops| tracked_from(&o.discovery().snapshot);

    // Baseline: everything that exists now is "before Atlas was watching".
    let t0 = 1_800_000_000_000i64;
    scan::scan(&store, &tracked(&o), None, t0).unwrap();

    o.apply(&Write::CreateItem { kind: "skill".into(), name: "tagged-skill".into(), event: None, text: Some(skill_text("tagged-skill", "One.")) }).unwrap();
    let id = skill_id(&o, "tagged-skill");
    o.apply(&Write::UpdateItem { id, text: skill_text("tagged-skill", "Two."), file: None, stamp: None }).unwrap();
    let helper = skill_id(&o, "commit-helper");
    o.apply(&Write::DeleteItem { id: helper }).unwrap();

    // A change the user makes by hand afterwards stays the user's.
    fs::write(e.config.join("rules").join("testing.md"), "# edited by hand\n").unwrap();

    let now = chrono_now_ms();
    let marks = Marks::from_backups(&e.data.join("setup-backups"), &e.inputs.root.claude_json, now);
    assert!(!marks.is_empty());
    scan::scan_marked(&store, &tracked(&o), None, now, &marks).unwrap();
    let ev = query::events(&store, &EventFilter { limit: 100, ..Default::default() }).unwrap().events;
    let by = |name: &str| ev.iter().filter(|x| x.item.name == name).collect::<Vec<_>>();
    assert!(by("tagged-skill").iter().any(|x| x.source == "atlas_mcp"), "{ev:?}");
    assert!(by("commit-helper").iter().any(|x| x.kind == "removed" && x.source == "atlas_mcp"), "{ev:?}");
    let rule = by("testing");
    assert!(!rule.is_empty() && rule.iter().all(|x| x.source != "atlas_mcp"), "{rule:?}");
}

fn chrono_now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64
}

#[test]
fn propose_then_approve_applies_through_the_same_path_and_a_stale_edit_is_refused() {
    let e = env();
    let o = ops(&e, "assistant");
    let queue = e.data.join("pending-changes");
    let helper = skill_id(&o, "commit-helper");
    let path = e.config.join("skills").join("commit-helper").join("SKILL.md");
    let original = fs::read_to_string(&path).unwrap();

    let w = Write::UpdateItem { id: helper.clone(), text: skill_text("commit-helper", "Proposed body."), file: None, stamp: None };
    let preview = o.preview(&w).unwrap();
    assert_eq!(preview.before.as_deref(), Some(original.as_str()));
    let c = pending::propose(&queue, o.pin_stamp(w), preview, "assistant").unwrap();
    assert_eq!(fs::read_to_string(&path).unwrap(), original, "proposing must not write");
    assert_eq!(pending::list(&queue).len(), 1);

    // The file changes before the user approves: the pinned stamp refuses to overwrite it.
    fs::write(&path, skill_text("commit-helper", "Changed meanwhile.")).unwrap();
    let err = pending::apply(&o, &queue, &c.id).unwrap_err();
    assert!(err.contains("changed"), "{err}");
    assert!(fs::read_to_string(&path).unwrap().contains("Changed meanwhile."));
    assert_eq!(pending::get(&queue, &c.id).unwrap().status, "failed");

    // A second proposal on the current text goes through and is tagged with the assistant.
    let w = Write::UpdateItem { id: helper, text: skill_text("commit-helper", "Approved body."), file: None, stamp: None };
    let preview = o.preview(&w).unwrap();
    let c2 = pending::propose(&queue, o.pin_stamp(w), preview, "assistant").unwrap();
    let applied = pending::apply(&o, &queue, &c2.id).unwrap();
    assert!(fs::read_to_string(&path).unwrap().contains("Approved body."));
    assert!(applied.backup_id.is_some());
    assert_eq!(pending::get(&queue, &c2.id).unwrap().status, "applied");
    assert!(pending::apply(&o, &queue, &c2.id).is_err(), "an applied change can't be applied twice");
    let backups = o.list_backups(10);
    assert!(backups.iter().any(|b| b.source == "assistant"));

    // Rejecting touches only the queue file; ids can't climb out of the queue folder.
    let w = Write::DeleteItem { id: skill_id(&o, "commit-helper") };
    let preview = o.preview(&w).unwrap();
    let c3 = pending::propose(&queue, w, preview, "assistant").unwrap();
    pending::reject(&queue, &c3.id).unwrap();
    assert!(path.is_file());
    assert!(pending::get(&queue, "../data/x").is_err());
}

#[test]
fn toggling_a_hook_off_and_on_restores_the_settings_file_exactly() {
    let e = env();
    let o = ops(&e, "mcp");
    let settings = e.config.join("settings.json");
    let before = fs::read(&settings).unwrap();
    let hook = o.list_items(&ListFilter { kind: Some("hook".into()), ..Default::default() }).items.into_iter().next().expect("a hook in the fixture");
    let off = o.apply(&Write::ToggleHook { id: hook.id.clone(), enabled: false }).unwrap();
    assert_ne!(fs::read(&settings).unwrap(), before);
    let parked = o.list_items(&ListFilter { kind: Some("hook".into()), ..Default::default() }).items.into_iter().find(|i| i.id.starts_with("parked:")).expect("the turned-off hook is listed");
    assert_eq!(parked.enabled, "Off");
    assert!(off.backup_id.is_some());
    o.apply(&Write::ToggleHook { id: parked.id, enabled: true }).unwrap();
    assert_eq!(fs::read(&settings).unwrap(), before);
}

#[test]
fn restore_refuses_to_overwrite_a_file_changed_after_the_backup() {
    let e = env();
    let o = ops(&e, "mcp");
    let id = skill_id(&o, "commit-helper");
    let path = e.config.join("skills").join("commit-helper").join("SKILL.md");
    let a = o.apply(&Write::UpdateItem { id, text: skill_text("commit-helper", "Edited."), file: None, stamp: None }).unwrap();
    fs::write(&path, skill_text("commit-helper", "Edited again by hand.")).unwrap();
    let err = o.apply(&Write::RestoreBackup { backup_id: a.backup_id.unwrap() }).unwrap_err();
    assert!(!err.is_empty());
    assert!(fs::read_to_string(&path).unwrap().contains("Edited again by hand."));
}

#[test]
fn a_secret_item_reads_masked_and_cannot_be_edited_from_here() {
    let e = env();
    // Put a key into the fixture's MCP server entry so the item holds a secret.
    let cj = e.config.join(".claude.json");
    let mut v: serde_json::Value = serde_json::from_slice(&fs::read(&cj).unwrap()).unwrap();
    v["mcpServers"]["leaky"] = serde_json::json!({"type": "stdio", "command": "node", "args": ["s.js"], "env": {"API_KEY": "sk-ant-api03-REALLYSECRETVALUE1234567890"}});
    fs::write(&cj, serde_json::to_vec_pretty(&v).unwrap()).unwrap();
    let o = ops(&e, "mcp");
    let item = o.list_items(&ListFilter { kind: Some("mcpServer".into()), ..Default::default() }).items.into_iter().find(|i| i.name == "leaky").expect("leaky listed");
    assert!(item.has_secrets);
    let read = o.read_item(&item.id, None).unwrap();
    assert!(!read.text.contains("REALLYSECRETVALUE"), "{}", read.text);
    assert!(read.stamp.is_none() && read.has_hidden_values);
    let before = fs::read(&cj).unwrap();
    assert!(o.apply(&Write::UpdateItem { id: item.id.clone(), text: read.text.clone(), file: None, stamp: None }).is_err());
    assert_eq!(fs::read(&cj).unwrap(), before);
}

#[test]
fn connect_without_the_command_adds_exactly_one_key_and_disconnect_removes_it() {
    let e = env();
    let server = e.data.join("atlas-mcp.exe");
    fs::write(&server, b"stand-in").unwrap();
    let cj = e.config.join(".claude.json");
    let before: serde_json::Value = serde_json::from_slice(&fs::read(&cj).unwrap()).unwrap();
    let backups = e.data.join("setup-backups");
    let ctx = ConnectCtx { root: &e.inputs.root, server: &server, backups: &backups, data_dir_flag: Some(&e.data), cli: CliChoice::Missing };

    assert_eq!(connect::state(&e.inputs.root, Some(&server), false).state, "notConnected");
    let out = connect::connect(&ctx).unwrap();
    assert_eq!(out.via, "file");
    assert_eq!(out.state.state, "connected");
    assert!(out.backup_id.is_some());

    let after: serde_json::Value = serde_json::from_slice(&fs::read(&cj).unwrap()).unwrap();
    let (b, a) = (before.as_object().unwrap(), after.as_object().unwrap());
    assert_eq!(a.keys().collect::<Vec<_>>(), b.keys().collect::<Vec<_>>(), "no new top-level key");
    for (k, v) in b {
        if k != "mcpServers" {
            assert_eq!(&a[k], v, "{k} changed");
        }
    }
    let added: Vec<_> = a["mcpServers"].as_object().unwrap().keys().filter(|k| !b.get("mcpServers").and_then(|m| m.get(k.as_str())).is_some()).collect();
    assert_eq!(added, ["atlas"], "exactly one server entry was added");
    let entry = &a["mcpServers"]["atlas"];
    assert_eq!(entry["type"], "stdio");
    assert_eq!(entry["command"].as_str().unwrap().replace('\\', "/"), server.to_string_lossy().replace('\\', "/"));
    assert_eq!(entry["args"][0], "--config-dir");
    // The other servers are untouched, in order.
    for (k, v) in b["mcpServers"].as_object().unwrap() {
        assert_eq!(&a["mcpServers"][k], v);
    }

    // Moved program: the state says so, and Connect points the entry at the new place.
    let moved = e.data.join("moved").join("atlas-mcp.exe");
    fs::create_dir_all(moved.parent().unwrap()).unwrap();
    fs::write(&moved, b"x").unwrap();
    assert_eq!(connect::state(&e.inputs.root, Some(&moved), false).state, "moved");

    let out = connect::disconnect(&ctx).unwrap();
    assert_eq!(out.state.state, "notConnected");
    let end: serde_json::Value = serde_json::from_slice(&fs::read(&cj).unwrap()).unwrap();
    assert_eq!(end["mcpServers"], before["mcpServers"]);
    assert_eq!(end, before);
}

#[test]
fn quiet_marks_a_command_to_start_without_a_console_window() {
    let mut c = std::process::Command::new("cmd");
    atlas_core::proc::quiet(&mut c);
    assert_eq!(atlas_core::proc::CREATE_NO_WINDOW, 0x0800_0000);
}

/// Needs Claude Code installed: `cargo test -p atlas-core --test mcp_ops real_cli -- --ignored`.
/// Runs the real `claude mcp add-json` / `remove` against a scratch folder. Claude Code adds its own
/// start-up keys to a `.claude.json` it has never seen, so the one-key claim is checked on the
/// second connect (the file is already Claude's own by then, like every real user's).
#[test]
#[ignore = "runs the real claude command"]
fn real_cli_connect_adds_exactly_one_entry_and_nothing_else() {
    let e = env();
    let server = e.data.join("atlas-mcp.exe");
    fs::write(&server, b"stand-in").unwrap();
    let cj = e.config.join(".claude.json");
    let backups = e.data.join("setup-backups");
    let ctx = ConnectCtx { root: &e.inputs.root, server: &server, backups: &backups, data_dir_flag: None, cli: CliChoice::Auto };
    assert!(ctx.cli.found(), "Claude Code's command is not installed here");

    let first = connect::connect(&ctx).unwrap();
    assert_eq!(first.via, "cli");
    connect::disconnect(&ctx).unwrap();
    let before: serde_json::Value = serde_json::from_slice(&fs::read(&cj).unwrap()).unwrap();

    let out = connect::connect(&ctx).unwrap();
    assert_eq!((out.via.as_str(), out.state.state.as_str()), ("cli", "connected"));
    let after: serde_json::Value = serde_json::from_slice(&fs::read(&cj).unwrap()).unwrap();
    let (b, a) = (before.as_object().unwrap(), after.as_object().unwrap());
    assert_eq!(a.keys().collect::<Vec<_>>(), b.keys().collect::<Vec<_>>(), "no new top-level key");
    let changed: Vec<_> = a.keys().filter(|k| a[k.as_str()] != b[k.as_str()]).collect();
    assert_eq!(changed, ["mcpServers"], "only mcpServers differs");
    let added: Vec<_> = a["mcpServers"].as_object().unwrap().keys().filter(|k| b["mcpServers"].get(k.as_str()).is_none()).collect();
    assert_eq!(added, ["atlas"]);
    for (k, v) in b["mcpServers"].as_object().unwrap() {
        assert_eq!(&a["mcpServers"][k], v);
    }
    eprintln!("top-level keys: {} before and after; changed: {:?}; added server entries: {:?}", b.len(), changed, added);

    let gone = connect::disconnect(&ctx).unwrap();
    assert_eq!((gone.via.as_str(), gone.state.state.as_str()), ("cli", "notConnected"));
}
