//! The Setup write path against a private copy of `fixtures/claude-setup`.
//!
//! Every test works in a temp folder; the real Claude folder is never opened for
//! writing (the guard test only builds plans that point at it and checks that
//! they are refused before anything is read or changed).

use std::fs;
use std::path::{Path, PathBuf};

use atlas_core::paths::{resolve_config_root, ConfigInputs};
use atlas_core::setup_write::{
    apply_delete, apply_save, create_apply, create_draft, restore, validate, Confine, CreateCtx, DeletePlan, SavePlan, Unit, WriteError,
};
use atlas_core::setup::{discover, Cache, Discovery, DiscoveryInputs, ItemKind, ScopeKind, SetupItem};

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("fixtures")
}

fn copy_tree(src: &Path, dst: &Path, root: &str) {
    fs::create_dir_all(dst).unwrap();
    for e in fs::read_dir(src).unwrap() {
        let e = e.unwrap();
        let p = e.path();
        let t = dst.join(e.file_name());
        if p.is_dir() {
            copy_tree(&p, &t, root);
            continue;
        }
        let bytes = fs::read(&p).unwrap();
        let lower = p.to_string_lossy().to_ascii_lowercase();
        let json = lower.ends_with(".json") || lower.ends_with(".jsonl");
        let out = match String::from_utf8(bytes.clone()) {
            Ok(s) if s.contains("@ROOT@") => {
                let r = if json { root.replace('\\', "\\\\") } else { root.to_string() };
                s.replace("@ROOT@", &r).into_bytes()
            }
            _ => bytes,
        };
        fs::write(&t, out).unwrap();
    }
}

struct Fx {
    _tmp: tempfile::TempDir,
    dir: PathBuf,
    home: PathBuf,
    backups: PathBuf,
}

impl Fx {
    fn new() -> Fx {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("machine");
        let root = dir.to_string_lossy().replace('\\', "/");
        copy_tree(&fixtures().join("claude-setup"), &dir, &root);
        let home = dir.join("home");
        let backups = tmp.path().join("atlas-data").join("backups");
        Fx { _tmp: tmp, dir, home, backups }
    }
    fn inputs(&self) -> DiscoveryInputs {
        let root = resolve_config_root(&ConfigInputs { flag: None, settings_override: None, env: None, home: &self.home, cwd: &self.dir });
        DiscoveryInputs { root, home: self.home.clone(), managed_dir: Some(self.dir.join("managed")), include_worktrees: false, sandboxed: false }
    }
    fn discover(&self) -> Discovery {
        discover(&self.inputs(), &mut Cache::default())
    }
    fn claude(&self) -> PathBuf {
        self.home.join(".claude")
    }
    fn cj(&self) -> PathBuf {
        self.inputs().root.claude_json
    }
    /// Where a restore may write in this private copy.
    fn confine(&self) -> Confine {
        let i = self.inputs();
        Confine::from_discovery(&i.root.dir, &i.root.claude_json, &self.discover())
    }
}

fn find<'a>(d: &'a Discovery, kind: ItemKind, scope: ScopeKind, name: &str) -> &'a SetupItem {
    d.snapshot.items.iter().find(|i| i.kind == kind && i.scope == scope && i.name == name).unwrap_or_else(|| panic!("no {kind:?}/{scope:?} item named {name}"))
}

/// Every file under `p` with its bytes, sorted: a byte-exact picture of a folder.
fn snapshot(p: &Path) -> Vec<(String, Vec<u8>)> {
    fn walk(base: &Path, p: &Path, out: &mut Vec<(String, Vec<u8>)>) {
        if p.is_dir() {
            for e in fs::read_dir(p).unwrap() {
                walk(base, &e.unwrap().path(), out);
            }
        } else {
            out.push((p.strip_prefix(base).unwrap().to_string_lossy().replace('\\', "/"), fs::read(p).unwrap()));
        }
    }
    let mut out = Vec::new();
    walk(p, p, &mut out);
    out.sort();
    out
}

fn ctx_of(fx: &Fx) -> (PathBuf, PathBuf) {
    (fx.claude(), fx.cj())
}

// ---- delete + undo -----------------------------------------------------------

#[test]
fn deleting_a_skill_backs_up_the_whole_folder_and_undo_restores_it_byte_for_byte() {
    let fx = Fx::new();
    let d = fx.discover();
    let it = find(&d, ItemKind::Skill, ScopeKind::User, "shared-skill");
    let dir = fx.claude().join("skills").join("shared-skill");
    let before = snapshot(&dir);
    assert!(before.len() >= 3, "SKILL.md plus attachments");

    let plan = d.delete_plan(&it.id).unwrap();
    let out = apply_delete(&plan, &fx.backups).unwrap();
    assert!(!dir.exists(), "folder removed");
    // The backup holds the full folder.
    let payload = fx.backups.join(&out.backup_id).join("payload").join("shared-skill");
    assert_eq!(snapshot(&payload), before);

    let undo = restore(&fx.backups, &out.backup_id, &fx.confine()).unwrap();
    assert_eq!(undo.name, "shared-skill");
    assert_eq!(snapshot(&dir), before, "byte-exact");
}

#[test]
fn deleting_an_agent_file_and_undoing_it_keeps_crlf_bytes() {
    let fx = Fx::new();
    let p = fx.claude().join("agents").join("user-agent.md");
    let mut bytes = fs::read(&p).unwrap();
    bytes = String::from_utf8_lossy(&bytes).replace("\r\n", "\n").replace('\n', "\r\n").into_bytes();
    fs::write(&p, &bytes).unwrap();
    let d = fx.discover();
    let it = find(&d, ItemKind::Agent, ScopeKind::User, "user-agent");
    let out = apply_delete(&d.delete_plan(&it.id).unwrap(), &fx.backups).unwrap();
    assert!(!p.exists());
    restore(&fx.backups, &out.backup_id, &fx.confine()).unwrap();
    assert_eq!(fs::read(&p).unwrap(), bytes);
}

#[test]
fn undo_refuses_when_something_new_sits_in_the_old_place() {
    let fx = Fx::new();
    let d = fx.discover();
    let it = find(&d, ItemKind::Rule, ScopeKind::User, "always");
    let p = fx.claude().join("rules").join("always.md");
    let out = apply_delete(&d.delete_plan(&it.id).unwrap(), &fx.backups).unwrap();
    fs::write(&p, "new content").unwrap();
    let err = restore(&fx.backups, &out.backup_id, &fx.confine()).unwrap_err();
    assert!(matches!(err, WriteError::Refused(_)));
    assert_eq!(fs::read_to_string(&p).unwrap(), "new content", "the new file is untouched");
}

#[test]
fn deleting_an_mcp_entry_keeps_every_other_key_and_undo_is_byte_exact() {
    let fx = Fx::new();
    let cj = fx.cj();
    let before = fs::read(&cj).unwrap();
    let d = fx.discover();
    let it = find(&d, ItemKind::McpServer, ScopeKind::User, "shared-srv");
    let out = apply_delete(&d.delete_plan(&it.id).unwrap(), &fx.backups).unwrap();
    let after: serde_json::Value = serde_json::from_slice(&fs::read(&cj).unwrap()).unwrap();
    let orig: serde_json::Value = serde_json::from_slice(&before).unwrap();
    assert!(after["mcpServers"].get("shared-srv").is_none());
    assert!(after["mcpServers"].get("user-srv").is_some() && after["mcpServers"].get("http-srv").is_some());
    assert_eq!(after["numStartups"], orig["numStartups"]);
    assert_eq!(after["projects"], orig["projects"], "project entries untouched");
    // The backup holds the complete original file.
    assert_eq!(fs::read(fx.backups.join(&out.backup_id).join("file-before")).unwrap(), before);

    restore(&fx.backups, &out.backup_id, &fx.confine()).unwrap();
    assert_eq!(fs::read(&cj).unwrap(), before);
}

#[test]
fn undoing_an_mcp_delete_after_the_file_moved_on_puts_back_only_that_entry_in_place() {
    let fx = Fx::new();
    let cj = fx.cj();
    let d = fx.discover();
    let it = find(&d, ItemKind::McpServer, ScopeKind::User, "shared-srv");
    let out = apply_delete(&d.delete_plan(&it.id).unwrap(), &fx.backups).unwrap();
    // Claude keeps writing this file: bump a counter after the delete.
    let mut v: serde_json::Value = serde_json::from_slice(&fs::read(&cj).unwrap()).unwrap();
    v["numStartups"] = serde_json::json!(99);
    fs::write(&cj, serde_json::to_vec_pretty(&v).unwrap()).unwrap();

    restore(&fx.backups, &out.backup_id, &fx.confine()).unwrap();
    let v: serde_json::Value = serde_json::from_slice(&fs::read(&cj).unwrap()).unwrap();
    assert_eq!(v["numStartups"], 99, "the newer write survives");
    let keys: Vec<&String> = v["mcpServers"].as_object().unwrap().keys().collect();
    assert_eq!(keys, ["user-srv", "shared-srv", "http-srv"], "same position as before");
    assert_eq!(v["mcpServers"]["shared-srv"]["args"][0], "user-shared.js");
}

#[test]
fn deleting_a_hook_removes_the_emptied_groups_and_undo_is_byte_exact() {
    let fx = Fx::new();
    let sp = fx.claude().join("settings.json");
    let before = fs::read(&sp).unwrap();
    let d = fx.discover();
    let hooks: Vec<_> = d.snapshot.items.iter().filter(|i| i.kind == ItemKind::Hook && i.scope == ScopeKind::User).collect();
    assert!(!hooks.is_empty());
    let it = hooks[0];
    let plan = d.delete_plan(&it.id).unwrap();
    let out = apply_delete(&plan, &fx.backups).unwrap();
    let after = fs::read(&sp).unwrap();
    assert_ne!(after, before);
    let d2 = fx.discover();
    assert_eq!(d2.snapshot.items.iter().filter(|i| i.kind == ItemKind::Hook && i.scope == ScopeKind::User).count(), hooks.len() - 1);
    let v: serde_json::Value = serde_json::from_slice(&after).unwrap();
    // No empty hook list is left behind.
    if let Some(h) = v.get("hooks").and_then(|h| h.as_object()) {
        for (_, groups) in h {
            for g in groups.as_array().unwrap() {
                assert!(!g["hooks"].as_array().unwrap().is_empty());
            }
        }
    }
    restore(&fx.backups, &out.backup_id, &fx.confine()).unwrap();
    assert_eq!(fs::read(&sp).unwrap(), before);
}

#[test]
fn plugin_synced_and_managed_items_cannot_be_deleted_and_say_why() {
    let fx = Fx::new();
    let d = fx.discover();
    let plug = find(&d, ItemKind::Skill, ScopeKind::Plugin, "fixture-plugin:plug-skill");
    let synced = find(&d, ItemKind::Skill, ScopeKind::Synced, "anthropic-skills:synced-skill");
    let managed = d.snapshot.items.iter().find(|i| i.scope == ScopeKind::Managed && i.kind == ItemKind::McpServer).unwrap();
    for it in [plug, synced, managed] {
        assert!(!it.deletable && !it.editable, "{}", it.name);
        let why = it.locked.as_deref().expect("a reason is shown instead of the X");
        assert!(!why.is_empty());
        let err = d.delete_plan(&it.id).unwrap_err();
        assert!(matches!(err, WriteError::Refused(_)));
        assert!(d.save_plan(&it.id).is_err());
    }
    assert!(find(&d, ItemKind::Skill, ScopeKind::User, "lf-skill").deletable);
    assert!(find(&d, ItemKind::Instructions, ScopeKind::User, "CLAUDE.md").editable);
    assert!(!find(&d, ItemKind::Instructions, ScopeKind::User, "CLAUDE.md").deletable, "instructions are edited, never removed");
}

#[test]
fn a_failed_backup_check_deletes_nothing() {
    let fx = Fx::new();
    let d = fx.discover();
    let it = find(&d, ItemKind::Agent, ScopeKind::User, "user-agent");
    let p = fx.claude().join("agents").join("user-agent.md");
    // The backups location is a file, so no backup can be made.
    fs::create_dir_all(fx.backups.parent().unwrap()).unwrap();
    fs::write(&fx.backups, "not a folder").unwrap();
    assert!(apply_delete(&d.delete_plan(&it.id).unwrap(), &fx.backups).is_err());
    assert!(p.exists(), "the item is still there");
}

// ---- save --------------------------------------------------------------------

fn save_plan(d: &Discovery, kind: ItemKind, scope: ScopeKind, name: &str) -> (SavePlan, String) {
    let it = find(d, kind, scope, name);
    (d.save_plan(&it.id).unwrap(), it.id.clone())
}

#[test]
fn save_backs_up_writes_atomically_and_reads_back() {
    let fx = Fx::new();
    let d = fx.discover();
    let (plan, id) = save_plan(&d, ItemKind::Agent, ScopeKind::User, "user-agent");
    let raw = d.read_raw(&id, true).unwrap();
    let p = fx.claude().join("agents").join("user-agent.md");
    let old = fs::read(&p).unwrap();
    let new_text = format!("{}\nAn extra line.\n", raw.text.trim_end());
    let out = apply_save(&plan, &new_text, &raw.stamp, false, &fx.backups).unwrap();
    assert!(fs::read_to_string(&p).unwrap().ends_with("An extra line.\n"));
    let bid = out.backup_id.unwrap();
    assert_eq!(fs::read(fx.backups.join(&bid).join("file-before")).unwrap(), old, "the previous version is kept");
    // No temp file is left next to the target.
    let leftovers: Vec<_> = fs::read_dir(p.parent().unwrap()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).filter(|n| n.contains("atlas") || n.ends_with(".tmp")).collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
    // The new stamp is what a following save expects.
    let again = d.read_raw(&id, true).unwrap();
    assert_eq!(again.stamp, out.stamp);
}

#[test]
fn save_keeps_a_files_crlf_endings_and_bom() {
    let fx = Fx::new();
    let p = fx.claude().join("rules").join("always.md");
    let mut b = vec![0xEF, 0xBB, 0xBF];
    b.extend_from_slice(b"# Always\r\n\r\n- one\r\n");
    fs::write(&p, &b).unwrap();
    let d = fx.discover();
    let (plan, id) = save_plan(&d, ItemKind::Rule, ScopeKind::User, "always");
    let raw = d.read_raw(&id, true).unwrap();
    assert!(raw.bom && raw.line_ending == "CRLF");
    assert!(!raw.text.contains('\r') && !raw.text.starts_with('\u{feff}'));
    apply_save(&plan, "# Always\n\n- one\n- two\n", &raw.stamp, false, &fx.backups).unwrap();
    let mut want = vec![0xEF, 0xBB, 0xBF];
    want.extend_from_slice(b"# Always\r\n\r\n- one\r\n- two\r\n");
    assert_eq!(fs::read(&p).unwrap(), want);
}

#[test]
fn save_detects_a_change_on_disk_and_only_force_overwrites() {
    let fx = Fx::new();
    let d = fx.discover();
    let (plan, id) = save_plan(&d, ItemKind::Rule, ScopeKind::User, "always");
    let raw = d.read_raw(&id, true).unwrap();
    let p = fx.claude().join("rules").join("always.md");
    fs::write(&p, "changed by someone else\n").unwrap();
    let err = apply_save(&plan, "my edit\n", &raw.stamp, false, &fx.backups).unwrap_err();
    assert!(matches!(err, WriteError::Conflict));
    assert_eq!(fs::read_to_string(&p).unwrap(), "changed by someone else\n");
    // "Overwrite" keeps the other version in the backup.
    let out = apply_save(&plan, "my edit\n", &raw.stamp, true, &fx.backups).unwrap();
    assert_eq!(fs::read_to_string(&p).unwrap(), "my edit\n");
    assert_eq!(fs::read(fx.backups.join(out.backup_id.unwrap()).join("file-before")).unwrap(), b"changed by someone else\n");
}

#[test]
fn saving_an_mcp_entry_changes_only_that_entry() {
    let fx = Fx::new();
    let cj = fx.cj();
    let d = fx.discover();
    let (plan, id) = save_plan(&d, ItemKind::McpServer, ScopeKind::User, "shared-srv");
    let raw = d.read_raw(&id, true).unwrap();
    assert_eq!(raw.language, "json");
    let before: serde_json::Value = serde_json::from_slice(&fs::read(&cj).unwrap()).unwrap();
    apply_save(&plan, "{\n  \"command\": \"node\",\n  \"args\": [\"changed.js\"]\n}", &raw.stamp, false, &fx.backups).unwrap();
    let after: serde_json::Value = serde_json::from_slice(&fs::read(&cj).unwrap()).unwrap();
    assert_eq!(after["mcpServers"]["shared-srv"]["args"][0], "changed.js");
    assert_eq!(after["mcpServers"]["user-srv"], before["mcpServers"]["user-srv"]);
    assert_eq!(after["projects"], before["projects"]);
    assert_eq!(after["numStartups"], before["numStartups"]);
}

// ---- validation --------------------------------------------------------------

#[test]
fn validation_catches_bad_json_bad_frontmatter_and_a_skill_name_that_does_not_match_its_folder() {
    let bad = validate(ItemKind::Settings, "json", None, false, "{ \"a\": ");
    assert_eq!(bad.len(), 1);
    assert!(bad[0].message.starts_with("Not valid JSON") && bad[0].line.is_some());
    assert!(validate(ItemKind::Settings, "json", None, false, "{\"a\": 1}").is_empty());

    let open = validate(ItemKind::Agent, "markdown", None, false, "---\nname: x\nbody without a closing fence\n");
    assert!(open[0].message.contains("not closed"));
    let yaml = validate(ItemKind::Agent, "markdown", None, false, "---\nname: [oops\n---\nbody\n");
    assert!(yaml[0].message.contains("frontmatter"));
    assert!(validate(ItemKind::Agent, "markdown", None, false, "No frontmatter at all is fine.\n").is_empty());

    let mismatch = validate(ItemKind::Skill, "markdown", Some("lf-skill"), false, "---\nname: other\ndescription: d\n---\nbody\n");
    assert!(mismatch[0].message.contains("lf-skill"));
    assert!(validate(ItemKind::Skill, "markdown", Some("lf-skill"), false, "---\nname: lf-skill\ndescription: d\n---\nbody\n").is_empty());

    // An MCP entry needs a command or a url; a hook needs a type.
    assert!(!validate(ItemKind::McpServer, "json", None, true, "{\"args\": []}").is_empty());
    assert!(validate(ItemKind::McpServer, "json", None, true, "{\"url\": \"https://x.test\"}").is_empty());
    assert!(!validate(ItemKind::Hook, "json", None, true, "{\"command\": \"x\"}").is_empty());
}

#[test]
fn save_refuses_invalid_text_and_changes_nothing() {
    let fx = Fx::new();
    let d = fx.discover();
    let (plan, id) = save_plan(&d, ItemKind::Skill, ScopeKind::User, "lf-skill");
    let raw = d.read_raw(&id, true).unwrap();
    let p = fx.claude().join("skills").join("lf-skill").join("SKILL.md");
    let before = fs::read(&p).unwrap();
    let err = apply_save(&plan, "---\nname: wrong-name\n---\nbody\n", &raw.stamp, false, &fx.backups).unwrap_err();
    assert!(matches!(err, WriteError::Refused(_)));
    assert_eq!(fs::read(&p).unwrap(), before);
    assert!(!fx.backups.exists() || fs::read_dir(&fx.backups).unwrap().next().is_none(), "no stray backup");
    assert_eq!(d.validate_text(&id, "---\nname: wrong-name\n---\n").unwrap().len(), 1);
}

// ---- create ------------------------------------------------------------------

#[test]
fn create_writes_a_new_skill_agent_rule_hook_and_server_and_never_overwrites() {
    let fx = Fx::new();
    let (root, cj) = ctx_of(&fx);
    let ctx = CreateCtx { root: &root, claude_json: &cj };

    let d = create_draft("skill", "fresh-skill", None, &ctx).unwrap();
    assert!(d.text.contains("name: fresh-skill"));
    create_apply("skill", "fresh-skill", None, &d.text, &ctx, &fx.backups).unwrap();
    assert!(root.join("skills/fresh-skill/SKILL.md").exists());
    assert!(create_draft("skill", "fresh-skill", None, &ctx).is_err(), "no second one with the same name");
    assert!(create_draft("skill", "Bad Name!", None, &ctx).is_err());
    // A wrong name inside the text is caught before anything is written.
    assert!(create_apply("skill", "other-skill", None, "---\nname: nope\n---\n", &ctx, &fx.backups).is_err());
    assert!(!root.join("skills/other-skill").exists());

    let a = create_draft("agent", "fresh-agent", None, &ctx).unwrap();
    create_apply("agent", "fresh-agent", None, &a.text, &ctx, &fx.backups).unwrap();
    assert!(root.join("agents/fresh-agent.md").exists());
    let r = create_draft("rule", "fresh-rule", None, &ctx).unwrap();
    create_apply("rule", "fresh-rule", None, &r.text, &ctx, &fx.backups).unwrap();
    assert!(root.join("rules/fresh-rule.md").exists());

    let settings_before: serde_json::Value = serde_json::from_slice(&fs::read(root.join("settings.json")).unwrap()).unwrap();
    let h = create_draft("hook", "", Some("Stop"), &ctx).unwrap();
    create_apply("hook", "", Some("Stop"), &h.text, &ctx, &fx.backups).unwrap();
    let s: serde_json::Value = serde_json::from_slice(&fs::read(root.join("settings.json")).unwrap()).unwrap();
    assert_eq!(s["hooks"]["Stop"].as_array().unwrap().len(), settings_before["hooks"]["Stop"].as_array().map_or(0, Vec::len) + 1);
    assert_eq!(s["permissions"], settings_before["permissions"]);

    let m = create_draft("mcpServer", "fresh-srv", None, &ctx).unwrap();
    create_apply("mcpServer", "fresh-srv", None, &m.text, &ctx, &fx.backups).unwrap();
    let v: serde_json::Value = serde_json::from_slice(&fs::read(&cj).unwrap()).unwrap();
    assert!(v["mcpServers"]["fresh-srv"]["command"].is_string());
    assert!(v["mcpServers"]["user-srv"].is_object());

    // The new things are found by discovery, deletable, and creating CLAUDE.md is refused when it exists.
    let d = fx.discover();
    assert!(find(&d, ItemKind::Skill, ScopeKind::User, "fresh-skill").deletable);
    assert!(create_draft("instructions", "", None, &ctx).is_err());
}

// ---- the guard: the real config is never written from a debug build ----------

#[cfg(debug_assertions)]
#[test]
fn debug_builds_refuse_delete_save_undo_and_create_against_the_real_config() {
    let Some(home) = atlas_core::paths::home_dir() else { return };
    let real = home.join(".claude");
    let backups = tempfile::tempdir().unwrap();
    // Names that do not exist, so even a guard bug could not hurt a real file.
    let ghost_dir = real.join("skills").join("atlas-guard-test-does-not-exist");
    let ghost_file = ghost_dir.join("SKILL.md");
    let ghost_json = home.join(".claude.json");

    let plans = [
        DeletePlan { id: "x".into(), name: "ghost".into(), kind: ItemKind::Skill, unit: Unit::Path { path: ghost_dir.clone(), is_dir: true } },
        DeletePlan { id: "x".into(), name: "ghost".into(), kind: ItemKind::Agent, unit: Unit::Path { path: real.join("agents").join("atlas-guard-test.md"), is_dir: false } },
        DeletePlan { id: "x".into(), name: "ghost".into(), kind: ItemKind::McpServer, unit: Unit::Entry { file: ghost_json.clone(), pointer: vec!["mcpServers".into(), "atlas-guard-test".into()] } },
    ];
    for p in &plans {
        let err = apply_delete(p, backups.path()).unwrap_err();
        assert!(matches!(&err, WriteError::Refused(m) if m.contains("refused")), "{err:?}");
    }
    let save = SavePlan { id: "x".into(), name: "ghost".into(), kind: ItemKind::Skill, unit: Unit::Path { path: ghost_file.clone(), is_dir: false }, folder_name: None, language: "markdown".into() };
    assert!(matches!(apply_save(&save, "hello", "0", true, backups.path()).unwrap_err(), WriteError::Refused(m) if m.contains("refused")));
    let save_json = SavePlan { id: "x".into(), name: "ghost".into(), kind: ItemKind::McpServer, unit: Unit::Entry { file: ghost_json, pointer: vec!["mcpServers".into(), "atlas-guard-test".into()] }, folder_name: None, language: "json".into() };
    assert!(matches!(apply_save(&save_json, "{\"command\": \"x\"}", "0", true, backups.path()).unwrap_err(), WriteError::Refused(m) if m.contains("refused")));

    // Create, aimed at the real folder.
    let cj = home.join(".claude.json");
    let ctx = CreateCtx { root: &real, claude_json: &cj };
    let text = create_draft("skill", "atlas-guard-test-does-not-exist", None, &ctx).unwrap().text;
    assert!(matches!(create_apply("skill", "atlas-guard-test-does-not-exist", None, &text, &ctx, backups.path()).unwrap_err(), WriteError::Refused(m) if m.contains("refused")));

    // Undo, with a hand-made backup whose manifest points at the real folder.
    let id = "0000000000000-0000-guard";
    let dir = backups.path().join(id);
    fs::create_dir_all(dir.join("payload")).unwrap();
    let manifest = serde_json::json!({
        "version": 1, "backupId": id, "createdMs": 0, "action": "delete", "kind": "skill", "name": "ghost",
        "unit": "path", "path": ghost_dir.to_string_lossy(), "isDir": true
    });
    fs::write(dir.join("manifest.json"), manifest.to_string()).unwrap();
    assert!(matches!(restore(backups.path(), id, &Confine::new(&real, &cj, [])).unwrap_err(), WriteError::Refused(m) if m.contains("refused")));

    assert!(!ghost_dir.exists(), "nothing was created in the real folder");
}

// ---- a skill's other files, duplicate, safe paths -----------------------------

#[test]
fn a_skill_lists_its_files_with_skill_md_first() {
    let fx = Fx::new();
    let d = fx.discover();
    let it = find(&d, ItemKind::Skill, ScopeKind::User, "shared-skill");
    let files = d.skill_files(&it.id).unwrap();
    let rels: Vec<&str> = files.iter().map(|f| f.rel.as_str()).collect();
    assert_eq!(rels[0], "SKILL.md");
    assert!(files[0].main);
    assert!(rels.contains(&"reference.md") && rels.contains(&"scripts/run.py"), "{rels:?}");
    assert!(files.iter().filter(|f| f.main).count() == 1);
    assert!(files.iter().all(|f| f.editable), "text files are editable");
    // Anything that is not a skill has no file list.
    let agent = find(&d, ItemKind::Agent, ScopeKind::User, "user-agent");
    assert!(d.skill_files(&agent.id).unwrap().is_empty());
}

#[test]
fn saving_a_supporting_file_backs_up_that_file_and_leaves_skill_md_alone() {
    let fx = Fx::new();
    let d = fx.discover();
    let it = find(&d, ItemKind::Skill, ScopeKind::User, "shared-skill");
    let dir = fx.claude().join("skills").join("shared-skill");
    let skill_md = fs::read(dir.join("SKILL.md")).unwrap();
    let old = fs::read(dir.join("reference.md")).unwrap();
    let raw = d.read_raw_file(&it.id, Some("reference.md"), true).unwrap();
    assert_eq!(raw.language, "markdown");
    assert!(raw.folder_name.is_none(), "the folder-name rule is for SKILL.md only");
    let plan = d.save_plan_file(&it.id, Some("reference.md")).unwrap();
    let out = apply_save(&plan, "# New reference\n", &raw.stamp, false, &fx.backups).unwrap();
    assert_eq!(fs::read_to_string(dir.join("reference.md")).unwrap(), "# New reference\n");
    assert_eq!(fs::read(dir.join("SKILL.md")).unwrap(), skill_md);
    assert_eq!(fs::read(fx.backups.join(out.backup_id.unwrap()).join("file-before")).unwrap(), old);
    // A stale stamp is still a conflict for a supporting file.
    let stale = apply_save(&plan, "again\n", &raw.stamp, false, &fx.backups).unwrap_err();
    assert!(matches!(stale, WriteError::Conflict));
}

#[test]
fn a_skill_file_path_cannot_leave_the_skill_folder() {
    let fx = Fx::new();
    let d = fx.discover();
    let it = find(&d, ItemKind::Skill, ScopeKind::User, "shared-skill");
    for bad in ["../lf-skill/SKILL.md", "..\\lf-skill\\SKILL.md", "/etc/passwd", "C:/Windows/win.ini", "", "scripts/../../x.md", "a/./b"] {
        assert!(d.save_plan_file(&it.id, Some(bad)).is_err(), "{bad:?} must be refused");
        assert!(d.file_target(&it.id, Some(bad)).is_err(), "{bad:?} must be refused");
    }
    // A file name on another item kind is refused as well.
    let agent = find(&d, ItemKind::Agent, ScopeKind::User, "user-agent");
    assert!(d.save_plan_file(&agent.id, Some("SKILL.md")).is_err());
    // An id the scan never produced is refused.
    assert!(d.file_target("not-an-id", None).is_err());
    assert!(d.file_target(&it.id, Some("reference.md")).unwrap().ends_with("reference.md"));
}

#[test]
fn duplicating_a_skill_copies_the_folder_and_renames_it() {
    let fx = Fx::new();
    let d = fx.discover();
    let it = find(&d, ItemKind::Skill, ScopeKind::User, "shared-skill");
    let src = fx.claude().join("skills").join("shared-skill");
    let before = snapshot(&src);
    let out = d.duplicate_skill(&it.id, "shared-copy", &fx.claude()).unwrap();
    assert_eq!(out.name, "shared-copy");
    let dest = fx.claude().join("skills").join("shared-copy");
    assert_eq!(snapshot(&src), before, "the original is untouched");
    let copied = snapshot(&dest);
    assert_eq!(copied.len(), before.len());
    let md = fs::read_to_string(dest.join("SKILL.md")).unwrap();
    assert!(md.contains("name: shared-copy"), "{md}");
    assert!(!md.contains("name: shared-skill"));
    // Everything else is byte for byte the same.
    for (rel, bytes) in &before {
        if rel != "SKILL.md" {
            assert_eq!(copied.iter().find(|(r, _)| r == rel).map(|(_, b)| b), Some(bytes), "{rel}");
        }
    }
    // No scratch folder is left behind.
    let names: Vec<String> = fs::read_dir(fx.claude().join("skills")).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    assert!(names.iter().all(|n| !n.starts_with(".atlas-copy")), "{names:?}");
    // It never replaces an existing skill, and refuses names that are not names.
    assert!(d.duplicate_skill(&it.id, "shared-copy", &fx.claude()).is_err());
    assert!(d.duplicate_skill(&it.id, "lf-skill", &fx.claude()).is_err());
    for bad in ["", "Has Space", "../up", "UPPER", "-lead"] {
        assert!(d.duplicate_skill(&it.id, bad, &fx.claude()).is_err(), "{bad:?}");
    }
    let agent = find(&d, ItemKind::Agent, ScopeKind::User, "user-agent");
    assert!(d.duplicate_skill(&agent.id, "nope", &fx.claude()).is_err());
}

#[test]
fn with_skill_name_edits_only_the_frontmatter_name() {
    use atlas_core::setup_write::with_skill_name;
    assert_eq!(with_skill_name("---\nname: a\ndescription: x\n---\nname: a in the body\n", "b"), "---\nname: b\ndescription: x\n---\nname: a in the body\n");
    assert_eq!(with_skill_name("---\r\nname: a\r\n---\r\nbody\r\n", "b"), "---\r\nname: b\r\n---\r\nbody\r\n");
    assert_eq!(with_skill_name("---\ndescription: x\n---\nbody\n", "b"), "---\ndescription: x\nname: b\n---\nbody\n");
    assert_eq!(with_skill_name("no frontmatter\n", "b"), "no frontmatter\n");
    assert!(with_skill_name("\u{feff}---\nname: a\n---\n", "b").starts_with("\u{feff}---\nname: b\n"));
}

// ---- opening, links and leftovers -------------------------------------------

/// Makes a file link, or says the machine will not let this test (Windows needs a privilege).
fn link_file(target: &Path, at: &Path) -> bool {
    #[cfg(unix)]
    return std::os::unix::fs::symlink(target, at).is_ok();
    #[cfg(windows)]
    return std::os::windows::fs::symlink_file(target, at).is_ok();
    #[cfg(not(any(unix, windows)))]
    return false;
}

fn link_dir(target: &Path, at: &Path) -> bool {
    #[cfg(unix)]
    return std::os::unix::fs::symlink(target, at).is_ok();
    // A junction needs no privilege, and the copy treats it as the folder link it is.
    #[cfg(windows)]
    return std::os::windows::fs::symlink_dir(target, at).is_ok()
        || std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(at).arg(target).output().is_ok_and(|o| o.status.success());
    #[cfg(not(any(unix, windows)))]
    return false;
}

fn contains_text(dir: &Path, needle: &str) -> bool {
    snapshot(dir).iter().any(|(_, b)| String::from_utf8_lossy(b).contains(needle))
}

#[test]
fn the_file_to_open_is_absolute_canonical_and_never_a_network_or_verbatim_path() {
    let fx = Fx::new();
    let d = fx.discover();
    let it = find(&d, ItemKind::Skill, ScopeKind::User, "shared-skill");
    for file in [None, Some("reference.md"), Some("scripts/run.py")] {
        let p = d.file_target(&it.id, file).unwrap();
        let s = p.to_string_lossy();
        assert!(p.is_absolute() && p.is_file(), "{s}");
        assert!(!s.starts_with(r"\\") && !s.starts_with("//") && !s.starts_with('-'), "{s}");
    }
}

#[test]
fn a_skill_md_that_links_outside_its_folder_is_neither_edited_nor_opened() {
    let fx = Fx::new();
    let outside = fx.dir.join("outside.md");
    fs::write(&outside, "---\nname: linked-skill\ndescription: x\n---\nSECRET-BODY\n").unwrap();
    let dir = fx.claude().join("skills").join("linked-skill");
    fs::create_dir_all(&dir).unwrap();
    if !link_file(&outside, &dir.join("SKILL.md")) {
        eprintln!("skipped: this machine does not allow creating links");
        return;
    }
    let d = fx.discover();
    let it = find(&d, ItemKind::Skill, ScopeKind::User, "linked-skill");
    assert!(d.save_plan(&it.id).is_err(), "saving through the link must be refused");
    assert!(d.read_raw(&it.id, true).is_err());
    assert!(d.file_target(&it.id, None).is_err(), "opening the link target must be refused");
    assert_eq!(fs::read_to_string(&outside).unwrap().lines().last(), Some("SECRET-BODY"));
}

#[test]
fn duplicating_never_copies_a_link_that_leaves_the_skill_folder_and_does_not_count_it() {
    let fx = Fx::new();
    let secret = fx.dir.join("credentials.txt");
    fs::write(&secret, "TOP-SECRET-TOKEN").unwrap();
    // Bigger than the copy limit: counting it would wrongly say the skill is too big.
    let huge = fx.dir.join("huge.bin");
    fs::write(&huge, vec![b'x'; 17 * 1024 * 1024]).unwrap();
    let src = fx.claude().join("skills").join("shared-skill");
    if !link_file(&secret, &src.join("leak.txt")) {
        eprintln!("skipped: this machine does not allow creating links");
        return;
    }
    assert!(link_file(&huge, &src.join("huge.txt")));
    assert!(link_file(&src.join("reference.md"), &src.join("alias.md")));
    let d = fx.discover();
    let it = find(&d, ItemKind::Skill, ScopeKind::User, "shared-skill");
    d.duplicate_skill(&it.id, "shared-copy", &fx.claude()).expect("links that leave the folder are skipped, not counted");
    let dest = fx.claude().join("skills").join("shared-copy");
    assert!(!dest.join("leak.txt").exists() && !dest.join("huge.txt").exists());
    assert!(!contains_text(&dest, "TOP-SECRET-TOKEN"));
    // A link to a file inside the folder is copied as that file.
    assert_eq!(fs::read(dest.join("alias.md")).unwrap(), fs::read(src.join("reference.md")).unwrap());
    // The original, links included, is untouched.
    assert_eq!(fs::read(&secret).unwrap(), b"TOP-SECRET-TOKEN");
}

#[test]
fn a_folder_link_out_of_a_skill_is_skipped_and_one_into_itself_stops_the_copy() {
    let fx = Fx::new();
    let elsewhere = fx.dir.join("elsewhere");
    fs::create_dir_all(&elsewhere).unwrap();
    fs::write(elsewhere.join("k.txt"), "TOP-SECRET-TOKEN").unwrap();
    let src = fx.claude().join("skills").join("shared-skill");
    if !link_dir(&elsewhere, &src.join("outlink")) {
        eprintln!("skipped: this machine does not allow creating links");
        return;
    }
    let d = fx.discover();
    let it = find(&d, ItemKind::Skill, ScopeKind::User, "shared-skill");
    // Out of the folder: left out of the copy, never followed.
    d.duplicate_skill(&it.id, "shared-copy", &fx.claude()).unwrap();
    let dest = fx.claude().join("skills").join("shared-copy");
    assert!(!dest.join("outlink").exists());
    assert!(!contains_text(&dest, "TOP-SECRET-TOKEN"));
    // Into the folder itself: refused whole, with nothing left behind.
    assert!(link_dir(&src.join("scripts"), &src.join("inlink")));
    assert!(d.duplicate_skill(&it.id, "second-copy", &fx.claude()).is_err());
    let skills = fx.claude().join("skills");
    assert!(!skills.join("second-copy").exists());
    let names: Vec<String> = fs::read_dir(&skills).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    assert!(names.iter().all(|n| !n.starts_with(".atlas-copy")), "{names:?}");
}
#[test]
fn deleting_a_skill_does_not_copy_a_linked_secret_into_the_backup() {
    let fx = Fx::new();
    let secret = fx.dir.join("credentials.txt");
    fs::write(&secret, "TOP-SECRET-TOKEN").unwrap();
    let src = fx.claude().join("skills").join("shared-skill");
    if !link_file(&secret, &src.join("leak.txt")) {
        eprintln!("skipped: this machine does not allow creating links");
        return;
    }
    let d = fx.discover();
    let it = find(&d, ItemKind::Skill, ScopeKind::User, "shared-skill");
    apply_delete(&d.delete_plan(&it.id).unwrap(), &fx.backups).expect("the delete still works");
    assert!(!src.exists());
    assert!(!contains_text(&fx.backups, "TOP-SECRET-TOKEN"), "the backup must not hold the linked file");
    assert_eq!(fs::read(&secret).unwrap(), b"TOP-SECRET-TOKEN", "the link's target is never touched");
}

#[test]
fn a_skill_md_that_is_not_utf8_is_refused_not_rewritten_with_replacement_characters() {
    let fx = Fx::new();
    let dir = fx.claude().join("skills").join("bytes-skill");
    fs::create_dir_all(&dir).unwrap();
    let mut b = b"---\nname: bytes-skill\ndescription: x\n---\nbody ".to_vec();
    b.extend_from_slice(&[0xFF, 0xFE, b'\n']);
    fs::write(dir.join("SKILL.md"), &b).unwrap();
    let d = fx.discover();
    let it = find(&d, ItemKind::Skill, ScopeKind::User, "bytes-skill");
    assert!(d.duplicate_skill(&it.id, "bytes-copy", &fx.claude()).is_err());
    assert!(!fx.claude().join("skills").join("bytes-copy").exists());
    assert_eq!(fs::read(dir.join("SKILL.md")).unwrap(), b, "the original is untouched");
}

#[test]
fn the_next_duplicate_removes_an_old_half_made_copy_and_leaves_a_fresh_one() {
    let fx = Fx::new();
    let skills = fx.claude().join("skills");
    let old = skills.join(".atlas-copy-1000-1");
    fs::create_dir_all(&old).unwrap();
    fs::write(old.join("SKILL.md"), "half").unwrap();
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis();
    let fresh = skills.join(format!(".atlas-copy-{now}-7"));
    fs::create_dir_all(&fresh).unwrap();
    let odd = skills.join(".atlas-copy-notanumber");
    fs::create_dir_all(&odd).unwrap();
    let d = fx.discover();
    let it = find(&d, ItemKind::Skill, ScopeKind::User, "shared-skill");
    d.duplicate_skill(&it.id, "shared-copy", &fx.claude()).unwrap();
    assert!(!old.exists(), "a crashed copy from long ago is cleaned up");
    assert!(fresh.exists(), "a copy that may still be running is left alone");
    assert!(odd.exists(), "a name Atlas did not write is left alone");
}

#[test]
fn a_taken_name_is_refused_even_when_it_is_only_a_dangling_link() {
    let fx = Fx::new();
    let at = fx.claude().join("skills").join("ghost");
    if !link_dir(&fx.dir.join("does-not-exist"), &at) {
        eprintln!("skipped: this machine does not allow creating links");
        return;
    }
    let d = fx.discover();
    let it = find(&d, ItemKind::Skill, ScopeKind::User, "shared-skill");
    assert!(d.duplicate_skill(&it.id, "ghost", &fx.claude()).is_err());
}

#[test]
fn a_supporting_file_reached_through_a_folder_link_that_leaves_the_skill_is_refused() {
    use atlas_core::setup_write::inside;
    let fx = Fx::new();
    let elsewhere = fx.dir.join("elsewhere");
    fs::create_dir_all(&elsewhere).unwrap();
    fs::write(elsewhere.join("x.md"), "TOP-SECRET-TOKEN").unwrap();
    let src = fx.claude().join("skills").join("shared-skill");
    if !link_dir(&elsewhere, &src.join("jx")) {
        eprintln!("skipped: this machine does not allow creating links");
        return;
    }
    let d = fx.discover();
    let it = find(&d, ItemKind::Skill, ScopeKind::User, "shared-skill");
    assert!(inside(&src, &src.join("jx").join("x.md")).is_err());
    assert!(inside(&src, &src.join("reference.md")).is_ok());
    assert!(d.file_target(&it.id, Some("jx/x.md")).is_err());
    assert!(d.save_plan_file(&it.id, Some("jx/x.md")).is_err());
}