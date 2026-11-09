//! Setup discovery against `fixtures/claude-setup`, a whole fake machine.
//!
//! Each test copies the tree into a temp folder (replacing `@ROOT@`), runs
//! discovery there and checks what the page would show. The one test that runs
//! on the committed tree itself proves discovery leaves it byte-identical.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Receiver};
use std::time::{Duration, Instant};

use atlas_core::paths::{resolve_config_root, ConfigInputs};
use atlas_core::setup::projects::encode_lossy;
use atlas_core::setup::watch::LiveSetup;
use atlas_core::setup::{discover, Cache, Discovery, DiscoveryInputs, EnabledKind, ItemKind, ScopeKind, SetupItem};

const PLACEHOLDER: &str = "FIXTURE-PLACEHOLDER";

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

/// A private copy of the fixture machine.
struct Fx {
    _tmp: tempfile::TempDir,
    dir: PathBuf,
    home: PathBuf,
}

impl Fx {
    fn new() -> Fx {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().to_path_buf();
        let root = dir.to_string_lossy().replace('\\', "/");
        copy_tree(&fixtures().join("claude-setup"), &dir, &root);
        let home = dir.join("home");
        // A project that is gone from disk keeps its memory under the lossy folder name.
        let gone = format!("{root}/work/gone");
        let mem = home.join(".claude").join("projects").join(encode_lossy(&gone)).join("memory");
        fs::create_dir_all(&mem).unwrap();
        fs::write(mem.join("MEMORY.md"), "# Gone project memory\n[fixture]\n").unwrap();
        Fx { _tmp: tmp, dir, home }
    }

    fn inputs(&self) -> DiscoveryInputs {
        self.inputs_with(false)
    }

    fn inputs_with(&self, worktrees: bool) -> DiscoveryInputs {
        let root = resolve_config_root(&ConfigInputs { flag: None, settings_override: None, env: None, home: &self.home, cwd: &self.dir });
        DiscoveryInputs { root, home: self.home.clone(), managed_dir: Some(self.dir.join("managed")), include_worktrees: worktrees, sandboxed: false }
    }

    fn discover(&self) -> Discovery {
        discover(&self.inputs(), &mut Cache::default())
    }

    fn p(&self, rel: &str) -> PathBuf {
        self.dir.join(rel)
    }
}

fn find<'a>(d: &'a Discovery, kind: ItemKind, scope: ScopeKind, name: &str) -> &'a SetupItem {
    d.snapshot
        .items
        .iter()
        .find(|i| i.kind == kind && i.scope == scope && i.name == name)
        .unwrap_or_else(|| panic!("no {kind:?}/{scope:?} item named {name}"))
}

fn all<'a>(d: &'a Discovery, kind: ItemKind, name: &str) -> Vec<&'a SetupItem> {
    d.snapshot.items.iter().filter(|i| i.kind == kind && i.name == name).collect()
}

// ---- criteria 1-26: what is found --------------------------------------------

#[test]
fn every_kind_and_scope_is_counted_exactly() {
    let fx = Fx::new();
    let d = fx.discover();
    let mut got: BTreeMap<String, usize> = BTreeMap::new();
    for i in &d.snapshot.items {
        *got.entry(format!("{},{:?}", i.kind.as_str(), i.scope)).or_default() += 1;
    }
    let want: &[(&str, usize)] = &[
        ("agent,Plugin", 1), ("agent,Project", 2), ("agent,User", 5), ("agentMemory,Project", 1), ("agentMemory,User", 1),
        ("autoMemory,Project", 2), ("command,Plugin", 1), ("command,Project", 1), ("command,User", 3), ("hook,Plugin", 1),
        ("hook,User", 2), ("hookScript,User", 3), ("instructions,Project", 6), ("instructions,User", 1), ("keybindings,User", 1),
        ("mcpServer,Connector", 1), ("mcpServer,Local", 4), ("mcpServer,Managed", 1), ("mcpServer,Plugin", 1),
        ("mcpServer,Project", 4), ("mcpServer,User", 3), ("other,Project", 1), ("other,User", 5), ("outputStyle,Project", 1),
        ("outputStyle,User", 1), ("permission,Managed", 1), ("permission,Project", 2), ("permission,User", 5), ("plugin,User", 1),
        ("rule,Project", 1), ("rule,User", 2), ("settings,Managed", 1), ("settings,Project", 2), ("settings,User", 2),
        ("skill,Plugin", 1), ("skill,Project", 1), ("skill,Synced", 1), ("skill,User", 7), ("statusLine,User", 1),
        ("theme,User", 1), ("workflow,User", 1),
    ];
    let want: BTreeMap<String, usize> = want.iter().map(|(k, n)| (k.to_string(), *n)).collect();
    assert_eq!(got, want);
}

#[test]
fn ids_are_unique_and_stable_across_runs() {
    let fx = Fx::new();
    let a = fx.discover();
    let b = fx.discover();
    let ids = |d: &Discovery| d.snapshot.items.iter().map(|i| i.id.clone()).collect::<Vec<_>>();
    let mut sorted = ids(&a);
    sorted.sort();
    sorted.dedup();
    assert_eq!(sorted.len(), a.snapshot.items.len(), "duplicate ids");
    assert_eq!(ids(&a), ids(&b), "ids or order changed between runs");
    assert!(a.snapshot.items.iter().all(|i| i.id.starts_with(i.kind.as_str()) && i.id.len() == i.kind.as_str().len() + 17));
}

#[test]
fn skills_carry_attachments_and_read_odd_frontmatter() {
    let fx = Fx::new();
    let d = fx.discover();
    let s = find(&d, ItemKind::Skill, ScopeKind::User, "shared-skill");
    assert!(s.attachments.iter().any(|a| a.replace('\\', "/").ends_with("scripts/run.py")), "{:?}", s.attachments);
    assert!(s.attachments.iter().any(|a| a.ends_with("reference.md")));
    // No name key: the folder name stands in, and the page is told.
    let n = find(&d, ItemKind::Skill, ScopeKind::User, "no-name-skill");
    assert_eq!(n.description, "Takes its folder name.");
    let a = find(&d, ItemKind::Agent, ScopeKind::User, "no-name-agent");
    assert!(a.warnings.iter().any(|w| w.contains("No name")), "{:?}", a.warnings);
    // Broken YAML: still listed, with a warning that names the line.
    let b = find(&d, ItemKind::Skill, ScopeKind::User, "broken-yaml");
    assert!(b.warnings.iter().any(|w| w.contains("Frontmatter")), "{:?}", b.warnings);
    assert!(b.warnings.iter().any(|w| w.contains("line ")), "{:?}", b.warnings);
    assert!(d.read_source(&b.id).is_ok());
}

#[test]
fn crlf_and_bom_twins_read_the_same_but_report_their_own_bytes() {
    let fx = Fx::new();
    let d = fx.discover();
    let c = find(&d, ItemKind::Skill, ScopeKind::User, "crlf-skill");
    let l = find(&d, ItemKind::Skill, ScopeKind::User, "lf-skill");
    assert_eq!(c.description, l.description);
    let cv = d.read_source(&c.id).unwrap();
    let lv = d.read_source(&l.id).unwrap();
    assert_eq!(cv.line_ending, "CRLF");
    assert!(cv.bom);
    assert_eq!(lv.line_ending, "LF");
    assert!(!lv.bom);
    assert!(!cv.text.starts_with('\u{feff}'));
}

#[test]
fn nested_commands_use_colons_and_plugins_prefix_their_names() {
    let fx = Fx::new();
    let d = fx.discover();
    find(&d, ItemKind::Command, ScopeKind::User, "nested:deploy:prod");
    find(&d, ItemKind::Command, ScopeKind::Plugin, "fixture-plugin:plug-cmd");
    find(&d, ItemKind::Skill, ScopeKind::Plugin, "fixture-plugin:plug-skill");
    find(&d, ItemKind::Skill, ScopeKind::Synced, "anthropic-skills:synced-skill");
}

#[test]
fn hooks_scripts_and_status_line_link_up() {
    let fx = Fx::new();
    let d = fx.discover();
    assert_eq!(find(&d, ItemKind::HookScript, ScopeKind::User, "fmt.sh").used_by, Some(1));
    assert_eq!(find(&d, ItemKind::HookScript, ScopeKind::User, "unused.sh").used_by, Some(0));
    assert_eq!(find(&d, ItemKind::HookScript, ScopeKind::User, "statusline.sh").used_by, Some(1));
    // The status-line script is a script, not a loose "other" file.
    assert!(all(&d, ItemKind::Other, "statusline.sh").is_empty());
    find(&d, ItemKind::Hook, ScopeKind::User, "PreToolUse \u{b7} Bash");
    assert_eq!(find(&d, ItemKind::StatusLine, ScopeKind::User, "Status line").enabled.state, EnabledKind::Active);
}

#[test]
fn settings_decide_what_is_on() {
    let fx = Fx::new();
    let d = fx.discover();
    assert_eq!(find(&d, ItemKind::OutputStyle, ScopeKind::User, "Calm Notes").enabled.state, EnabledKind::Active);
    let o = find(&d, ItemKind::Skill, ScopeKind::User, "user-only");
    assert_eq!(o.enabled.state, EnabledKind::Custom);
    assert_eq!(o.enabled.raw.as_deref(), Some("user-invocable-only"));
    assert_eq!(find(&d, ItemKind::Plugin, ScopeKind::User, "fixture-plugin@fixture-market").enabled.state, EnabledKind::On);

    // Switch the plugin off: its skill, agent, command, hook and server follow it.
    let fx2 = Fx::new();
    let p = fx2.p("home/.claude/settings.json");
    let t = fs::read_to_string(&p).unwrap().replace("\"fixture-plugin@fixture-market\": true", "\"fixture-plugin@fixture-market\": false");
    fs::write(&p, t).unwrap();
    let d2 = fx2.discover();
    assert_eq!(find(&d2, ItemKind::Plugin, ScopeKind::User, "fixture-plugin@fixture-market").enabled.state, EnabledKind::Off);
    for i in d2.snapshot.items.iter().filter(|i| i.scope == ScopeKind::Plugin) {
        assert_eq!(i.enabled.state, EnabledKind::Off, "{} {}", i.kind.as_str(), i.name);
    }
}

#[test]
fn instructions_rules_memory_and_other_files_are_found() {
    let fx = Fx::new();
    let d = fx.discover();
    find(&d, ItemKind::Instructions, ScopeKind::User, "CLAUDE.md");
    for n in ["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md"] {
        assert!(d.snapshot.items.iter().any(|i| i.kind == ItemKind::Instructions && i.scope == ScopeKind::Project && i.name == n), "{n}");
    }
    let ts = find(&d, ItemKind::Rule, ScopeKind::User, "ts-only");
    assert!(ts.chips.iter().any(|c| c.contains("*.ts")));
    // Memory in the transcript folder of `work/app`, and in the folder of the gone project.
    let mem: Vec<_> = d.snapshot.items.iter().filter(|i| i.kind == ItemKind::AutoMemory).collect();
    assert!(mem.iter().any(|i| i.project_id.is_some()), "{}", mem.len());
    // Backups are flagged and counted as hidden.
    let b = find(&d, ItemKind::Other, ScopeKind::User, "agents/user-agent.md.bak-20261001");
    assert!(b.backup);
    assert_eq!(d.snapshot.hidden.backups, 1);
    find(&d, ItemKind::Other, ScopeKind::Project, "launch.json");
    assert!(d.snapshot.items.iter().any(|i| i.kind == ItemKind::Other && i.name == "reference/notes.md"));
}

#[test]
fn mcp_servers_at_every_scope_with_winners_and_approval() {
    let fx = Fx::new();
    let d = fx.discover();
    for (scope, name) in [
        (ScopeKind::User, "user-srv"),
        (ScopeKind::User, "http-srv"),
        (ScopeKind::Local, "local-only"),
        (ScopeKind::Managed, "managed-srv"),
        (ScopeKind::Connector, "claude.ai Fixture Connector"),
    ] {
        find(&d, ItemKind::McpServer, scope, name);
    }
    find(&d, ItemKind::McpServer, ScopeKind::Plugin, "plugin:fixture-plugin:plug-srv");
    // Approval of `.mcp.json` servers.
    assert_eq!(find(&d, ItemKind::McpServer, ScopeKind::Project, "proj-srv").enabled.state, EnabledKind::Approved);
    assert_eq!(find(&d, ItemKind::McpServer, ScopeKind::Project, "rejected-srv").enabled.state, EnabledKind::Rejected);
    assert_eq!(find(&d, ItemKind::McpServer, ScopeKind::Project, "pending-srv").enabled.state, EnabledKind::Pending);
    // `shared-srv` is defined three times: the local one wins.
    let three = all(&d, ItemKind::McpServer, "shared-srv");
    assert_eq!(three.len(), 3);
    let local = three.iter().find(|i| i.scope == ScopeKind::Local).unwrap();
    let conflict = local.conflict.as_ref().unwrap();
    assert!(conflict.defined_in.first().unwrap().winner);
    assert_eq!(conflict.defined_in.len(), 3);
    assert_eq!(three.iter().find(|i| i.scope == ScopeKind::User).unwrap().enabled.state, EnabledKind::Shadowed);
    // The user server's per-project matrix: switched off in one of the projects.
    let u = find(&d, ItemKind::McpServer, ScopeKind::User, "user-srv");
    let m = u.mcp.as_ref().unwrap();
    assert!(m.on_count < m.total_projects, "{} of {}", m.on_count, m.total_projects);
    assert_eq!(m.per_project.iter().filter(|p| !p.on).count(), 1);
    assert_eq!(m.per_project.iter().find(|p| !p.on).unwrap().project_name, "app");
    // Keys are shown, values never.
    assert_eq!(u.mcp.as_ref().unwrap().env_keys, vec!["SECRET_TOKEN".to_string()]);
    let h = find(&d, ItemKind::McpServer, ScopeKind::User, "http-srv");
    assert_eq!(h.mcp.as_ref().unwrap().header_keys, vec!["Authorization".to_string()]);
    assert_eq!(h.mcp.as_ref().unwrap().transport, "http");
}

#[test]
fn same_names_in_different_places_are_labelled() {
    let fx = Fx::new();
    let d = fx.discover();
    // Skills: user beats project.
    let u = find(&d, ItemKind::Skill, ScopeKind::User, "shared-skill");
    let p = find(&d, ItemKind::Skill, ScopeKind::Project, "shared-skill");
    assert!(u.conflict.as_ref().unwrap().label.starts_with("Overrides"));
    assert_eq!(p.enabled.state, EnabledKind::Shadowed);
    // Agents: project beats user.
    let pa = find(&d, ItemKind::Agent, ScopeKind::Project, "shared-agent");
    assert!(pa.conflict.as_ref().unwrap().label.starts_with("Overrides"));
    assert_eq!(find(&d, ItemKind::Agent, ScopeKind::User, "shared-agent").enabled.state, EnabledKind::Shadowed);
    // Commands: same name at two scopes has no documented winner.
    let cs = all(&d, ItemKind::Command, "shared-cmd");
    assert_eq!(cs.len(), 2);
    assert!(cs.iter().all(|c| c.conflict.as_ref().unwrap().label == "Conflict"));
    // A skill and a command of one name: the skill wins.
    assert_eq!(find(&d, ItemKind::Command, ScopeKind::User, "same-as-skill").enabled.state, EnabledKind::Shadowed);
    // Two files, one name.
    let dups = all(&d, ItemKind::Agent, "dup");
    assert_eq!(dups.len(), 2);
    assert!(dups.iter().all(|c| c.conflict.as_ref().unwrap().label == "Duplicate"));
    // Each conflict lists the others by id, winner first.
    for it in d.snapshot.items.iter().filter(|i| i.conflict.is_some()) {
        let c = it.conflict.as_ref().unwrap();
        assert!(c.defined_in.iter().any(|x| x.is_self && x.id == it.id), "{}", it.name);
        for x in &c.defined_in {
            assert!(d.item(&x.id).is_some(), "dangling id in {}", it.name);
        }
    }
}

// ---- projects ------------------------------------------------------------------

#[test]
fn projects_come_from_three_sources_and_spellings_merge() {
    let fx = Fx::new();
    let d = fx.discover();
    let names: Vec<_> = d.snapshot.projects.iter().map(|p| p.name.as_str()).collect();
    for n in ["app", "home", "transcript-only", "dotclaude-only", "gone"] {
        assert!(names.contains(&n), "{n} missing from {names:?}");
    }
    // `githubRepoPaths` lists a folder that is not on disk: counted as missing, not shown.
    assert!(!names.contains(&"github-only"));
    assert!(d.snapshot.hidden.missing_projects >= 1);
    // The empty folder has nothing: counted, not shown.
    assert!(!names.contains(&"empty-proj"));
    assert_eq!(d.snapshot.hidden.empty_projects, 1);
    // The project known only from a transcript still shows its agent.
    let t = find(&d, ItemKind::Agent, ScopeKind::Project, "t");
    assert_eq!(d.snapshot.projects.iter().find(|p| Some(&p.id) == t.project_id.as_ref()).unwrap().name, "transcript-only");
    // Home is a project like any other (it holds a CLAUDE.md).
    let home = d.snapshot.projects.iter().find(|p| p.is_home).unwrap();
    assert!(home.item_count >= 1);
    // The gone project exists only in `.claude.json`: flagged.
    assert!(!d.snapshot.projects.iter().find(|p| p.name == "gone").unwrap().exists);
    // Two spellings of `work/app` (Windows only) are one project with both servers.
    if cfg!(windows) {
        assert_eq!(names.iter().filter(|n| **n == "app").count(), 1);
        let app = d.snapshot.projects.iter().find(|p| p.name == "app").unwrap();
        let tw = find(&d, ItemKind::McpServer, ScopeKind::Local, "twin-only");
        assert_eq!(tw.project_id.as_deref(), Some(app.id.as_str()));
        assert_eq!(app.local_mcp_count, 3);
    }
}

#[test]
fn worktrees_stay_out_unless_asked() {
    let fx = Fx::new();
    let d = fx.discover();
    assert!(!d.snapshot.items.iter().any(|i| i.name == "wt-skill"));
    assert_eq!(d.snapshot.hidden.worktrees, 1);
    assert!(!d.snapshot.projects.iter().any(|p| p.is_worktree));
    let d2 = discover(&fx.inputs_with(true), &mut Cache::default());
    let wt = d2.snapshot.projects.iter().find(|p| p.is_worktree).expect("worktree project");
    assert!(wt.parent_id.is_some());
}

#[test]
fn config_root_choice_changes_which_claude_json_is_read() {
    let fx = Fx::new();
    // Default: `~/.claude.json` beside the folder.
    let d = fx.discover();
    assert!(d.snapshot.items.iter().any(|i| i.name == "user-srv"));
    assert!(!d.snapshot.items.iter().any(|i| i.name == "decoy-srv"));
    assert_eq!(d.snapshot.root.claude_json_state, "ok");
    // CLAUDE_CONFIG_DIR style: the file lives inside the folder, so the decoy is read.
    let dir = fx.home.join(".claude");
    let root = resolve_config_root(&ConfigInputs { flag: None, settings_override: None, env: Some(dir.as_os_str()), home: &fx.home, cwd: &fx.dir });
    let inputs = DiscoveryInputs { root, home: fx.home.clone(), managed_dir: None, include_worktrees: false, sandboxed: false };
    let d2 = discover(&inputs, &mut Cache::default());
    assert!(d2.snapshot.items.iter().any(|i| i.name == "decoy-srv"));
    assert!(!d2.snapshot.items.iter().any(|i| i.name == "user-srv"));
}

#[test]
fn a_missing_or_broken_claude_json_degrades_without_failing() {
    let fx = Fx::new();
    fs::write(fx.home.join(".claude.json"), "{ not json").unwrap();
    let d = fx.discover();
    assert_ne!(d.snapshot.root.claude_json_state, "ok");
    find(&d, ItemKind::Skill, ScopeKind::User, "user-only");
    fs::remove_file(fx.home.join(".claude.json")).unwrap();
    let d = fx.discover();
    assert_eq!(d.snapshot.root.claude_json_state, "missing");
}

// ---- reading, masking, limits ----------------------------------------------------

#[test]
fn no_secret_value_reaches_the_snapshot_or_any_source() {
    let fx = Fx::new();
    let d = fx.discover();
    let wire = serde_json::to_string(&d.snapshot).unwrap();
    assert!(!wire.contains(PLACEHOLDER), "a secret value is in the snapshot");
    let mut masked_any = false;
    for it in &d.snapshot.items {
        let v = d.read_source(&it.id).unwrap_or_else(|e| panic!("{} {}: {e}", it.kind.as_str(), it.name));
        assert!(!v.text.contains(PLACEHOLDER), "{} {} leaks", it.kind.as_str(), it.name);
        masked_any |= !v.masked_ranges.is_empty();
    }
    assert!(masked_any);
    // Only the reveal command returns the value, one at a time.
    let s = find(&d, ItemKind::Settings, ScopeKind::User, "settings.json");
    assert!(s.has_secrets);
    let v = d.read_source(&s.id).unwrap();
    assert!(!v.masked_ranges.is_empty());
    for (n, r) in v.masked_ranges.iter().enumerate() {
        assert_eq!(r.index, n);
    }
    assert_eq!(d.reveal(&s.id, 0).unwrap(), PLACEHOLDER);
    assert!(d.reveal(&s.id, 999).is_err());
    // An inline token in a command line is masked too.
    let u = find(&d, ItemKind::McpServer, ScopeKind::User, "user-srv");
    let uv = d.read_source(&u.id).unwrap();
    assert!(!uv.text.contains("FIXTURE"), "{}", uv.text);
    assert!(uv.text.contains("--token="), "the flag name stays: {}", uv.text);
}

#[test]
fn ids_not_produced_by_discovery_are_refused() {
    let fx = Fx::new();
    let d = fx.discover();
    // The denied file is never listed, so no id can name it, forged or not.
    for bad in ["other:0000000000000000", "../.credentials.json", "", "skill:", "settings:ffffffffffffffff"] {
        assert!(d.read_source(bad).is_err(), "{bad}");
        assert!(d.reveal(bad, 0).is_err(), "{bad}");
    }
    for it in &d.snapshot.items {
        let low = it.path.clone().unwrap_or_default().to_ascii_lowercase().replace('\\', "/");
        assert!(!low.ends_with(".credentials.json") && !low.contains("/sessions/") && !low.ends_with("history.jsonl"), "{low}");
    }
}

#[test]
fn a_file_swapped_for_a_denied_one_after_the_scan_is_not_read() {
    let fx = Fx::new();
    let d = fx.discover();
    // The scan listed `user-only`; the file goes away and the id must fail cleanly.
    let it = find(&d, ItemKind::Skill, ScopeKind::User, "user-only");
    fs::remove_file(fx.p("home/.claude/skills/user-only/SKILL.md")).unwrap();
    assert!(d.read_source(&it.id).is_err());
}

#[test]
fn a_huge_file_is_cut_at_one_megabyte() {
    let fx = Fx::new();
    let big = "x".repeat(2 * 1024 * 1024);
    fs::write(fx.p("home/.claude/skills/user-only/SKILL.md"), format!("---\nname: user-only\ndescription: Big.\n---\n\n{big}")).unwrap();
    let d = fx.discover();
    let it = find(&d, ItemKind::Skill, ScopeKind::User, "user-only");
    let v = d.read_source(&it.id).unwrap();
    assert!(v.truncated);
    assert!(v.text.len() <= 1024 * 1024 + 4, "{}", v.text.len());
    assert!(v.size > 2 * 1024 * 1024);
}

#[test]
fn a_binary_file_is_refused_not_shown() {
    let fx = Fx::new();
    fs::write(fx.p("home/.claude/reference/blob.bin"), [0u8, 159, 146, 150, 0, 1, 2, 3]).unwrap();
    let d = fx.discover();
    if let Some(it) = d.snapshot.items.iter().find(|i| i.name == "reference/blob.bin") {
        assert!(d.read_source(&it.id).is_err());
    }
}

#[test]
fn the_snapshot_stays_small() {
    let fx = Fx::new();
    let d = fx.discover();
    let bytes = serde_json::to_vec(&d.snapshot).unwrap().len();
    assert!(bytes < 200 * 1024, "{bytes}");
    // No item carries a body.
    assert!(d.snapshot.items.iter().all(|i| i.description.len() < 600 && i.detail.iter().all(|r| r.value.len() < 2000)));
}

// ---- read only -------------------------------------------------------------------

fn tree(root: &Path) -> Vec<(String, Vec<u8>)> {
    fn walk(dir: &Path, base: &Path, out: &mut Vec<(String, Vec<u8>)>) {
        let mut es: Vec<_> = fs::read_dir(dir).unwrap().map(|e| e.unwrap()).collect();
        es.sort_by_key(|e| e.file_name());
        for e in es {
            let p = e.path();
            if p.is_dir() {
                walk(&p, base, out);
            } else {
                out.push((p.strip_prefix(base).unwrap().to_string_lossy().replace('\\', "/"), fs::read(&p).unwrap()));
            }
        }
    }
    let mut out = Vec::new();
    walk(root, root, &mut out);
    out
}

#[test]
fn discovery_and_reading_leave_the_tree_byte_identical() {
    // Run on the committed tree itself (placeholders stay as they are).
    let src = fixtures().join("claude-setup");
    let before = tree(&src);
    let home = src.join("home");
    let root = resolve_config_root(&ConfigInputs { flag: None, settings_override: None, env: None, home: &home, cwd: &src });
    let inputs = DiscoveryInputs { root, home, managed_dir: Some(src.join("managed")), include_worktrees: true, sandboxed: false };
    let d = discover(&inputs, &mut Cache::default());
    assert!(d.snapshot.items.len() > 50);
    for it in &d.snapshot.items {
        let _ = d.read_source(&it.id);
        let _ = d.reveal(&it.id, 0);
    }
    assert_eq!(tree(&src), before);
}

#[test]
fn the_basic_and_edge_fixtures_still_read_as_before() {
    for (name, want) in [
        ("claude-basic", &["code-reviewer", "commit-helper", "standup", "terse", "testing"][..]),
        ("claude-edge", &["lane-agent", "crlf-skill", "nested:deploy:prod", "unknown-dir/notes.txt", "caf\u{e9} \u{2603}/readme.txt"][..]),
    ] {
        let dir = fixtures().join(name);
        let before = tree(&dir);
        let scratch = tempfile::tempdir().unwrap();
        let root = resolve_config_root(&ConfigInputs { flag: Some(&dir), settings_override: None, env: None, home: scratch.path(), cwd: scratch.path() });
        let inputs = DiscoveryInputs { root, home: scratch.path().to_path_buf(), managed_dir: None, include_worktrees: false, sandboxed: false };
        let d = discover(&inputs, &mut Cache::default());
        for n in want {
            assert!(d.snapshot.items.iter().any(|i| i.name == *n), "{name}: {n} missing");
        }
        for it in &d.snapshot.items {
            let _ = d.read_source(&it.id);
        }
        assert_eq!(tree(&dir), before, "{name} changed");
    }
}

// ---- live refresh ----------------------------------------------------------------

fn wait(rx: &Receiver<u64>, ms: u64) -> Option<u64> {
    rx.recv_timeout(Duration::from_millis(ms)).ok()
}

fn drain(rx: &Receiver<u64>) {
    while rx.try_recv().is_ok() {}
}

#[test]
fn the_watcher_sees_create_edit_and_delete_within_a_second() {
    let fx = Fx::new();
    let (tx, rx) = channel();
    let live = LiveSetup::start(fx.inputs(), move |v| {
        let _ = tx.send(v);
    });
    let (v0, d0) = live.current();
    assert_eq!(v0, 1);
    assert!(!d0.snapshot.items.iter().any(|i| i.name == "fresh-skill"));
    std::thread::sleep(Duration::from_millis(400));
    drain(&rx);

    // Create.
    let dir = fx.p("home/.claude/skills/fresh-skill");
    fs::create_dir_all(&dir).unwrap();
    let t = Instant::now();
    fs::write(dir.join("SKILL.md"), "---\nname: fresh-skill\ndescription: One.\n---\n\n[fixture]\n").unwrap();
    let v1 = wait(&rx, 3000).expect("no change event after create");
    let took = t.elapsed();
    assert!(took < Duration::from_millis(1000), "create took {took:?}");
    let (_, d1) = live.current();
    assert_eq!(d1.snapshot.items.iter().find(|i| i.name == "fresh-skill").unwrap().description, "One.");
    assert!(v1 > v0);

    // Edit.
    drain(&rx);
    let t = Instant::now();
    fs::write(dir.join("SKILL.md"), "---\nname: fresh-skill\ndescription: Two.\n---\n\n[fixture]\n").unwrap();
    wait(&rx, 3000).expect("no change event after edit");
    assert!(t.elapsed() < Duration::from_millis(1000), "edit took {:?}", t.elapsed());
    let (_, d2) = live.current();
    assert_eq!(d2.snapshot.items.iter().find(|i| i.name == "fresh-skill").unwrap().description, "Two.");

    // Delete.
    drain(&rx);
    let t = Instant::now();
    fs::remove_dir_all(&dir).unwrap();
    wait(&rx, 3000).expect("no change event after delete");
    assert!(t.elapsed() < Duration::from_millis(1000), "delete took {:?}", t.elapsed());
    let (_, d3) = live.current();
    assert!(!d3.snapshot.items.iter().any(|i| i.name == "fresh-skill"));
}

#[test]
fn claude_json_churn_that_setup_does_not_read_emits_nothing() {
    let fx = Fx::new();
    let (tx, rx) = channel();
    let live = LiveSetup::start(fx.inputs(), move |v| {
        let _ = tx.send(v);
    });
    std::thread::sleep(Duration::from_millis(400));
    drain(&rx);
    // Claude rewrites this file all the time: a counter moves, nothing Setup shows does.
    let p = fx.home.join(".claude.json");
    let t = fs::read_to_string(&p).unwrap().replace("\"numStartups\": 5", "\"numStartups\": 6");
    fs::write(&p, t).unwrap();
    assert!(wait(&rx, 1200).is_none(), "numStartups alone must not refresh the page");
    // A real change (a new server) does.
    let t = fs::read_to_string(&p).unwrap();
    let t = t.replacen("\"mcpServers\": {", "\"mcpServers\": {\n    \"late-srv\": {\"command\": \"node\"},", 1);
    fs::write(&p, t).unwrap();
    wait(&rx, 3000).expect("a new server must refresh the page");
    let (_, d) = live.current();
    assert!(d.snapshot.items.iter().any(|i| i.name == "late-srv"));
}

#[test]
fn transcripts_writing_does_not_wake_the_page() {
    let fx = Fx::new();
    let (tx, rx) = channel();
    let live = LiveSetup::start(fx.inputs(), move |v| {
        let _ = tx.send(v);
    });
    std::thread::sleep(Duration::from_millis(400));
    drain(&rx);
    let f = fx.p("home/.claude/projects/-encoded-app/00000000-0000-0000-0000-000000000001.jsonl");
    let mut t = fs::read_to_string(&f).unwrap();
    t.push_str("{\"type\":\"assistant\"}\n");
    fs::write(&f, t).unwrap();
    assert!(wait(&rx, 1000).is_none());
    drop(live);
}

#[test]
fn switching_the_root_builds_a_fresh_scan() {
    let fx = Fx::new();
    let a = LiveSetup::start(fx.inputs(), |_| {});
    let other = tempfile::tempdir().unwrap();
    fs::create_dir_all(other.path().join(".claude").join("skills").join("solo")).unwrap();
    fs::write(other.path().join(".claude").join("skills").join("solo").join("SKILL.md"), "---\nname: solo\ndescription: Alone.\n---\n").unwrap();
    let root = resolve_config_root(&ConfigInputs { flag: None, settings_override: None, env: None, home: other.path(), cwd: other.path() });
    let b = LiveSetup::start(DiscoveryInputs { root, home: other.path().to_path_buf(), managed_dir: None, include_worktrees: false, sandboxed: false }, |_| {});
    let (_, da) = a.current();
    let (vb, db) = b.current();
    assert_eq!(vb, 1);
    assert!(da.snapshot.items.iter().any(|i| i.name == "user-only"));
    assert!(!db.snapshot.items.iter().any(|i| i.name == "user-only"));
    assert!(db.snapshot.items.iter().any(|i| i.name == "solo"));
}

// ---- the wire format the page reads ------------------------------------------------

/// Every JSON key the page can receive, per object. `fixtures/setup-wire-keys.json`
/// is the one list; src/lib/setup-wire.test.ts checks the TypeScript mock against it.
/// Run with ATLAS_WRITE_WIRE=1 to rewrite the list after an intended change.
#[test]
fn the_wire_format_matches_the_front_end_key_list() {
    use serde_json::Value;
    use std::collections::BTreeSet;

    fn keys(set: &mut BTreeMap<&'static str, BTreeSet<String>>, name: &'static str, v: &Value) {
        if let Value::Object(m) = v {
            set.entry(name).or_default().extend(m.keys().cloned());
        }
    }

    let fx = Fx::new();
    let d = fx.discover();
    let snap = serde_json::to_value(&d.snapshot).unwrap();
    let mut got: BTreeMap<&'static str, BTreeSet<String>> = BTreeMap::new();
    keys(&mut got, "snapshot", &snap);
    keys(&mut got, "root", &snap["root"]);
    keys(&mut got, "hidden", &snap["hidden"]);
    for p in snap["projects"].as_array().unwrap() {
        keys(&mut got, "project", p);
    }
    for i in snap["items"].as_array().unwrap() {
        keys(&mut got, "item", i);
        keys(&mut got, "enabled", &i["enabled"]);
        if !i["conflict"].is_null() {
            keys(&mut got, "conflict", &i["conflict"]);
            for x in i["conflict"]["definedIn"].as_array().unwrap() {
                keys(&mut got, "definedIn", x);
            }
        }
        for r in i["detail"].as_array().unwrap() {
            keys(&mut got, "detailRow", r);
        }
        if !i["mcp"].is_null() {
            keys(&mut got, "mcp", &i["mcp"]);
            for p in i["mcp"]["perProject"].as_array().unwrap() {
                keys(&mut got, "projectState", p);
            }
        }
    }
    let mut masked = false;
    for i in &d.snapshot.items {
        let v = serde_json::to_value(d.read_source(&i.id).unwrap()).unwrap();
        keys(&mut got, "source", &v);
        if let Some(r) = v["maskedRanges"].as_array().and_then(|a| a.first()) {
            keys(&mut got, "maskedRange", r);
            masked = true;
        }
    }
    assert!(masked);

    // The replies of the write path (the front end names the same keys).
    {
        use atlas_core::setup_write as sw;
        let it = find(&d, ItemKind::Skill, ScopeKind::User, "lf-skill");
        keys(&mut got, "rawEdit", &serde_json::to_value(d.read_raw(&it.id, true).unwrap()).unwrap());
        let bad = sw::validate(ItemKind::Settings, "json", None, false, "{");
        keys(&mut got, "problem", &serde_json::to_value(&bad[0]).unwrap());
        let backups = tempfile::tempdir().unwrap();
        let out = sw::apply_delete(&d.delete_plan(&it.id).unwrap(), backups.path()).unwrap();
        keys(&mut got, "deleteOutcome", &serde_json::to_value(&out).unwrap());
        let (root, cj) = (fx.home.join(".claude"), fx.inputs().root.claude_json);
        let confine = sw::Confine::from_discovery(&root, &cj, &d);
        keys(&mut got, "undoOutcome", &serde_json::to_value(sw::restore(backups.path(), &out.backup_id, &confine).unwrap()).unwrap());
        let draft = sw::create_draft("skill", "wire-check", None, &sw::CreateCtx { root: &root, claude_json: &cj }).unwrap();
        keys(&mut got, "draft", &serde_json::to_value(&draft).unwrap());
    }

    let out: BTreeMap<&str, Vec<String>> = got.iter().map(|(k, v)| (*k, v.iter().cloned().collect())).collect();
    let path = fixtures().join("setup-wire-keys.json");
    if std::env::var_os("ATLAS_WRITE_WIRE").is_some() {
        fs::write(&path, serde_json::to_string_pretty(&out).unwrap() + "\n").unwrap();
    }
    let want: BTreeMap<String, Vec<String>> = serde_json::from_str(&fs::read_to_string(&path).expect("fixtures/setup-wire-keys.json")).unwrap();
    let have: BTreeMap<String, Vec<String>> = out.into_iter().map(|(k, v)| (k.to_string(), v)).collect();
    assert_eq!(have, want, "the Rust wire format changed: update setup-types.ts, the mock, then ATLAS_WRITE_WIRE=1");
}
