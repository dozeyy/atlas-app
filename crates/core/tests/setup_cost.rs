//! What the setup costs, against `fixtures/claude-setup` (a whole fake machine) with a usage
//! mix built by hand so every dollar can be checked with arithmetic, plus one test of the
//! SQL that builds the mix from a real cache and one of the MCP prompt sampler.
//!
//! The mix: model `m` prices 0.50 to read and 6.25 to write per million tokens. Project `app`
//! ran 100 turns (10 of them opened a transcript), project `other` ran 50 (none did).
//! One token therefore costs, per turn mix:
//!   everywhere:  (90 * 0.50 + 10 * 6.25 + 50 * 0.50) / 1e6 = 132.5e-6 over 150 turns
//!   in `app`:    (90 * 0.50 + 10 * 6.25)             / 1e6 = 107.5e-6 over 100 turns

mod common;

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use atlas_core::paths::{resolve_config_root, ConfigInputs};
use atlas_core::setup::cost::{estimate, sample_mcp, CostReport, CostRow, McpSample, CHARS_PER_TOKEN};
use atlas_core::setup::projects::{encode_lossy, norm_key};
use atlas_core::setup::{discover, Cache, Discovery, DiscoveryInputs};
use atlas_core::usage::costmix::{CachePrice, CostMix, Sample, TurnGroup};
use atlas_core::usage::time::Tz;

fn tok(chars: usize) -> u64 {
    (chars as f64 / CHARS_PER_TOKEN).round() as u64
}

fn near(a: f64, b: f64) {
    assert!((a - b).abs() <= 1e-9 * b.abs().max(1.0), "{a} != {b}");
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
}

impl Fx {
    fn new() -> Fx {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().to_path_buf();
        let root = dir.to_string_lossy().replace('\\', "/");
        copy_tree(&common::fixture("claude-setup"), &dir, &root);
        let home = dir.join("home");
        let gone = format!("{root}/work/gone");
        let mem = home.join(".claude").join("projects").join(encode_lossy(&gone)).join("memory");
        fs::create_dir_all(&mem).unwrap();
        fs::write(mem.join("MEMORY.md"), "# Gone project memory\n[fixture]\n").unwrap();
        Fx { _tmp: tmp, dir, home }
    }

    fn discover(&self) -> Discovery {
        let root = resolve_config_root(&ConfigInputs { flag: None, settings_override: None, env: None, home: &self.home, cwd: &self.dir });
        let inputs = DiscoveryInputs { root, home: self.home.clone(), managed_dir: Some(self.dir.join("managed")), include_worktrees: false, sandboxed: false };
        discover(&inputs, &mut Cache::default())
    }
}

fn app_key(d: &Discovery) -> String {
    let p = d.snapshot.projects.iter().find(|p| p.name == "app").expect("project app");
    norm_key(&p.path)
}

fn mix_for(app: &str) -> CostMix {
    let mut prices = HashMap::new();
    prices.insert("m".to_string(), CachePrice { read: 0.5, write: 6.25 });
    CostMix {
        days: 7,
        from_ms: 0,
        groups: vec![
            TurnGroup { project_key: app.to_string(), model: "m".into(), turns: 100, starts: 10 },
            TurnGroup { project_key: "/elsewhere/other".into(), model: "m".into(), turns: 50, starts: 0 },
        ],
        prices,
        ..Default::default()
    }
}

fn row<'a>(r: &'a CostReport, suffix: &str) -> &'a CostRow {
    let want = suffix.replace('\\', "/");
    r.rows
        .iter()
        .find(|x| x.path.as_deref().is_some_and(|p| p.replace('\\', "/").ends_with(&want)))
        .unwrap_or_else(|| panic!("no row for {suffix}; have {:?}", r.rows.iter().map(|x| x.path.clone()).collect::<Vec<_>>()))
}

fn chars_of(fx: &Fx, rel: &str) -> usize {
    fs::read_to_string(fx.dir.join(rel)).unwrap().chars().count()
}

fn named<'a>(r: &'a CostReport, kind: &str, name: &str) -> &'a CostRow {
    r.rows.iter().find(|x| x.kind == kind && x.name == name).unwrap_or_else(|| panic!("no {kind} row named {name}"))
}

#[test]
fn instructions_cost_their_size_times_the_turns_they_load_in() {
    let fx = Fx::new();
    let d = fx.discover();
    let rep = estimate(&d, &mix_for(&app_key(&d)), &McpSample::default());

    // The global file loads in all 150 turns.
    let g = row(&rep, "home/.claude/CLAUDE.md");
    assert_eq!(g.tokens, tok(chars_of(&fx, "home/.claude/CLAUDE.md")));
    assert_eq!(g.turns, 150);
    assert!(g.global);
    assert_eq!(g.loads_in, "All chats");
    near(g.usd_loaded, g.tokens as f64 * 132.5e-6);
    near(g.usd_week, g.usd_loaded);

    // A project file loads only in the project's 100 turns, at that project's price mix.
    let p = row(&rep, "work/app/CLAUDE.md");
    assert_eq!(p.tokens, tok(chars_of(&fx, "work/app/CLAUDE.md")));
    assert_eq!(p.turns, 100);
    assert!(!p.global);
    assert_eq!(p.loads_in, "Chats in app");
    near(p.usd_loaded, p.tokens as f64 * 107.5e-6);

    // Claude Code does not read AGENTS.md, so it costs nothing.
    assert!(rep.rows.iter().all(|r| !r.path.as_deref().unwrap_or("").ends_with("AGENTS.md")));
}

#[test]
fn rules_load_unless_they_are_scoped_to_paths() {
    let fx = Fx::new();
    let d = fx.discover();
    let rep = estimate(&d, &mix_for(&app_key(&d)), &McpSample::default());

    let always = row(&rep, "home/.claude/rules/always.md");
    assert_eq!(always.tokens, tok(chars_of(&fx, "home/.claude/rules/always.md")));
    assert_eq!(always.body_tokens, 0);
    assert!(always.usd_week > 0.0);

    // A rule with `paths` loads when a matching file is touched: size only, no dollars.
    let scoped = row(&rep, "home/.claude/rules/ts-only.md");
    assert_eq!(scoped.tokens, 0);
    assert_eq!(scoped.turns, 0);
    assert_eq!(scoped.body_tokens, tok(chars_of(&fx, "home/.claude/rules/ts-only.md")));
    assert_eq!(scoped.uses, None);
    near(scoped.usd_week, 0.0);
}

#[test]
fn a_skill_costs_its_listing_line_every_turn_and_its_body_when_it_runs() {
    let fx = Fx::new();
    let d = fx.discover();
    let mut mix = mix_for(&app_key(&d));
    mix.avg_turns_main = 40.0;
    mix.item_uses.insert(("skill".into(), "user-only".into()), 3);
    let rep = estimate(&d, &mix, &McpSample::default());

    let s = named(&rep, "skill", "user-only");
    // "- user-only: Only at user scope." plus the newline.
    let line = "- user-only: Only at user scope.".chars().count() + 1;
    assert_eq!(s.tokens, tok(line));
    assert_eq!(s.turns, 150);
    near(s.usd_loaded, s.tokens as f64 * 132.5e-6);

    // Three runs; each writes the body once and re-reads it for half a 40 turn chat.
    // Mean prices over all 150 turns: read 0.5, write 6.25.
    assert_eq!(s.uses, Some(3));
    assert!(s.body_tokens > 0);
    near(s.usd_used, 3.0 * s.body_tokens as f64 * (6.25 + 20.0 * 0.5) / 1e6);
    near(s.usd_week, s.usd_loaded + s.usd_used);

    // A skill that never ran has a listing cost and a zero run cost, not a missing figure.
    let idle = named(&rep, "skill", "lf-skill");
    assert_eq!(idle.uses, Some(0));
    near(idle.usd_used, 0.0);
    assert!(idle.usd_loaded > 0.0);
}

#[test]
fn helpers_are_re_read_for_their_whole_run() {
    let fx = Fx::new();
    let d = fx.discover();
    let mut mix = mix_for(&app_key(&d));
    mix.avg_turns_helper = 10.0;
    mix.item_uses.insert(("agent".into(), "user-agent".into()), 2);
    let rep = estimate(&d, &mix, &McpSample::default());
    let a = named(&rep, "agent", "user-agent");
    assert_eq!(a.uses, Some(2));
    near(a.usd_used, 2.0 * a.body_tokens as f64 * (6.25 + 10.0 * 0.5) / 1e6);
    // Helpers list as "- name: description (Tools: All tools)".
    let line = "- user-agent: Only at user scope. (Tools: All tools)".chars().count() + 1;
    assert_eq!(a.tokens, tok(line));
}

#[test]
fn plugin_and_synced_skills_use_the_names_claude_lists() {
    let fx = Fx::new();
    let d = fx.discover();
    let rep = estimate(&d, &mix_for(&app_key(&d)), &McpSample::default());
    named(&rep, "skill", "fixture-plugin:plug-skill");
    named(&rep, "skill", "anthropic-skills:synced-skill");
}

#[test]
fn a_hidden_skill_keeps_its_body_but_loses_its_listing_line() {
    let fx = Fx::new();
    let dir = fx.home.join(".claude").join("skills").join("quiet");
    fs::create_dir_all(&dir).unwrap();
    fs::write(
        dir.join("SKILL.md"),
        "---\nname: quiet\ndescription: Only when asked for.\ndisable-model-invocation: true\n---\n\nSteps go here and are long enough to count.\n",
    )
    .unwrap();
    let d = fx.discover();
    let rep = estimate(&d, &mix_for(&app_key(&d)), &McpSample::default());
    let q = named(&rep, "skill", "quiet");
    assert_eq!(q.tokens, 0, "not in the listing");
    assert!(q.body_tokens > 0, "still has a body to load when run");
}

#[test]
fn the_skill_listing_adds_when_to_use() {
    let fx = Fx::new();
    let dir = fx.home.join(".claude").join("skills").join("hinted");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("SKILL.md"), "---\nname: hinted\ndescription: Does a thing.\nwhen_to_use: Use when the thing is needed.\n---\n\nBody.\n").unwrap();
    let d = fx.discover();
    let rep = estimate(&d, &mix_for(&app_key(&d)), &McpSample::default());
    let h = named(&rep, "skill", "hinted");
    let line = "- hinted: Does a thing. - Use when the thing is needed.".chars().count() + 1;
    assert_eq!(h.tokens, tok(line));
}

#[test]
fn memory_counts_only_the_index_for_its_own_project() {
    let fx = Fx::new();
    let d = fx.discover();
    let rep = estimate(&d, &mix_for(&app_key(&d)), &McpSample::default());
    let m = named(&rep, "autoMemory", "MEMORY.md");
    // Exact-project reach: `app` only, never the folders below it.
    assert!(m.turns <= 100);
    assert!(!m.global);
    // Notes other than the index are read on request and cost nothing here.
    assert!(rep.rows.iter().all(|r| !(r.kind == "autoMemory" && r.name != "MEMORY.md")));
}

#[test]
fn no_usage_still_gives_sizes_and_says_it_is_incomplete() {
    let fx = Fx::new();
    let d = fx.discover();
    let rep = estimate(&d, &CostMix { days: 7, ..Default::default() }, &McpSample::default());
    assert!(rep.incomplete);
    assert_eq!(rep.turns, 0);
    near(rep.usd_week, 0.0);
    assert!(rep.global_tokens > 0, "sizes need no usage");
    assert!(row(&rep, "home/.claude/CLAUDE.md").tokens > 0);
}

#[test]
fn an_unpriced_model_marks_the_figures_incomplete() {
    let fx = Fx::new();
    let d = fx.discover();
    let mut mix = mix_for(&app_key(&d));
    mix.unpriced_turns = 12;
    assert!(estimate(&d, &mix, &McpSample::default()).incomplete);
}

#[test]
fn rows_come_most_expensive_first_and_the_total_is_their_sum() {
    let fx = Fx::new();
    let d = fx.discover();
    let rep = estimate(&d, &mix_for(&app_key(&d)), &McpSample::default());
    assert!(rep.rows.windows(2).all(|w| w[0].usd_week >= w[1].usd_week));
    near(rep.usd_week, rep.rows.iter().map(|r| r.usd_week).sum::<f64>());
    assert_eq!(rep.global_tokens, rep.rows.iter().filter(|r| r.global).map(|r| r.tokens).sum::<u64>());
    assert!(rep.rows.iter().all(|r| r.tokens > 0 || r.body_tokens > 0), "nothing empty is listed");
}

#[test]
fn folders_above_a_project_load_in_every_chat_below_them() {
    let fx = Fx::new();
    // `work/CLAUDE.md` is not a setup item: it sits above both projects.
    fs::write(fx.dir.join("work").join("CLAUDE.md"), "# Work folder notes\n[fixture]\n").unwrap();
    let d = fx.discover();
    let app = app_key(&d);
    let rep = estimate(&d, &mix_for(&app), &McpSample::default());
    let f = row(&rep, "work/CLAUDE.md");
    assert_eq!(f.id, None);
    assert_eq!(f.loads_in, "Chats under work");
    assert!(!f.global);
    // `app` sits under `work`, `other` does not: 100 turns.
    assert_eq!(f.turns, 100);
}

#[test]
fn mcp_tools_are_measured_from_a_real_prompt_and_unknown_servers_group_together() {
    let fx = Fx::new();
    let d = fx.discover();
    let app = app_key(&d);

    let tmp = tempfile::tempdir().unwrap();
    let file = tmp.path().join("t.jsonl");
    let lines = [
        r#"{"type":"attachment","attachment":{"type":"deferred_tools_delta","addedNames":["mcp__proj-srv__alpha","mcp__proj-srv__beta","mcp__ghost__one","Bash"],"readdedNames":[],"removedNames":[]}}"#,
        r#"{"type":"attachment","attachment":{"type":"mcp_instructions_delta","addedNames":["proj-srv"],"addedBlocks":["Use proj-srv carefully."],"removedNames":[]}}"#,
        r#"{"type":"attachment","attachment":{"type":"deferred_tools_delta","addedNames":[],"readdedNames":[],"removedNames":["mcp__proj-srv__beta"]}}"#,
        "not json at all",
    ];
    fs::write(&file, lines.join("\n") + "\n").unwrap();
    let sample = sample_mcp(&[
        Sample { project_key: app.clone(), path: file.to_string_lossy().into_owned() },
        Sample { project_key: app.clone(), path: tmp.path().join("missing.jsonl").to_string_lossy().into_owned() },
    ]);
    assert_eq!(sample.projects.len(), 1, "an unreadable transcript is skipped");
    let servers = &sample.projects[0].1;
    // Names count with a separator; a removed tool no longer counts; instructions add their text.
    let alpha = "mcp__proj-srv__alpha".len() + 1;
    assert_eq!(servers["proj-srv"], alpha + "Use proj-srv carefully.".chars().count());
    assert_eq!(servers["ghost"], "mcp__ghost__one".len() + 1);
    assert!(!servers.contains_key("Bash"));

    let rep = estimate(&d, &mix_for(&app), &sample);
    let ghost = rep.rows.iter().find(|r| r.name.starts_with("Other connected tools")).expect("grouped row");
    assert!(ghost.measured);
    assert_eq!(ghost.turns, 100, "only the chats that connected them");
    assert!(ghost.usd_week > 0.0);
}

#[test]
fn the_mix_is_read_from_the_cache_for_the_last_week_only() {
    let fx = common::start(&common::fixture("claude-items"), Tz::Fixed(0));
    let mix = fx.engine.cost_mix(7).unwrap();
    assert_eq!(mix.days, 7);
    assert!(mix.total_turns() > 0);
    assert_eq!(mix.unpriced_turns, 0);
    assert!(mix.groups.iter().all(|g| g.starts <= g.turns));
    assert!(!mix.prices.is_empty());
    // Skills run on Nov 5 and 6 count; the ones from Oct 1 are outside the week.
    assert_eq!(mix.item_uses.get(&("skill".to_string(), "ui-ux-pro-max".to_string())), Some(&2));
    assert_eq!(mix.item_uses.get(&("skill".to_string(), "orchestrate".to_string())), Some(&2));
    assert!(!mix.item_uses.contains_key(&("skill".to_string(), "old-skill".to_string())));
    assert!(mix.avg_turns_main > 0.0);
    assert_eq!(mix.samples.len(), 1, "the newest transcript of each project");
    // A longer window brings the old session back.
    let wide = fx.engine.cost_mix(90).unwrap();
    assert!(wide.total_turns() > mix.total_turns());
    assert_eq!(wide.item_uses.get(&("skill".to_string(), "ui-ux-pro-max".to_string())), Some(&3));
}

/// The keys the page reads from `setup_cost`. `fixtures/setup-cost-wire-keys.json` is the one
/// list; src/lib/setup-cost-wire.test.ts checks the TypeScript types and the browser mock
/// against it. Run with ATLAS_WRITE_WIRE=1 to rewrite it after an intended change.
#[test]
fn the_wire_format_matches_the_front_end_key_list() {
    use std::collections::BTreeMap;

    let fx = Fx::new();
    let d = fx.discover();
    let mut mix = mix_for(&app_key(&d));
    mix.item_uses.insert(("skill".into(), "user-only".into()), 1);
    let rep = estimate(&d, &mix, &McpSample::default());
    let v = serde_json::to_value(&rep).unwrap();
    let keys = |o: &serde_json::Value| -> Vec<String> {
        let mut k: Vec<String> = o.as_object().unwrap().keys().cloned().collect();
        k.sort();
        k
    };
    let mut got: BTreeMap<&str, Vec<String>> = BTreeMap::new();
    got.insert("costReport", keys(&v));
    let rows = v["rows"].as_array().unwrap();
    assert!(!rows.is_empty());
    for r in rows {
        assert_eq!(keys(r), keys(&rows[0]), "every row names the same keys");
    }
    got.insert("costRow", keys(&rows[0]));

    let path = common::fixtures().join("setup-cost-wire-keys.json");
    if std::env::var_os("ATLAS_WRITE_WIRE").is_some() {
        fs::write(&path, serde_json::to_string_pretty(&got).unwrap() + "\n").unwrap();
    }
    let want: BTreeMap<String, Vec<String>> = serde_json::from_str(&fs::read_to_string(&path).expect("fixtures/setup-cost-wire-keys.json")).unwrap();
    let have: BTreeMap<String, Vec<String>> = got.into_iter().map(|(k, v)| (k.to_string(), v)).collect();
    assert_eq!(have, want, "the Rust wire format changed: update setup-types.ts, the mock, then ATLAS_WRITE_WIRE=1");
}
