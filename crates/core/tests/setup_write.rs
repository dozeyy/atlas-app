//! The Setup write path against a private copy of `fixtures/claude-setup`.
//!
//! Every test works in a temp folder; the real Claude folder is never opened for
//! writing (the guard test only builds plans that point at it and checks that
//! they are refused before anything is read or changed).

use std::fs;
use std::path::{Path, PathBuf};

use atlas_core::paths::{resolve_config_root, ConfigInputs};
use atlas_core::setup_write::{
    apply_delete, apply_save, create_apply, create_draft, restore, validate, CreateCtx, DeletePlan, SavePlan, Unit, WriteError,
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

    let undo = restore(&fx.backups, &out.backup_id).unwrap();
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
    restore(&fx.backups, &out.backup_id).unwrap();
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
    let err = restore(&fx.backups, &out.backup_id).unwrap_err();
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

    restore(&fx.backups, &out.backup_id).unwrap();
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

    restore(&fx.backups, &out.backup_id).unwrap();
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
    restore(&fx.backups, &out.backup_id).unwrap();
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
    assert!(matches!(restore(backups.path(), id).unwrap_err(), WriteError::Refused(m) if m.contains("refused")));

    assert!(!ghost_dir.exists(), "nothing was created in the real folder");
}
