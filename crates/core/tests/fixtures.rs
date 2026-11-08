//! Tests against the committed fixture config folders (`fixtures/`).
//!
//! They check three things: the fixtures still have the byte-exact shapes the
//! later phases depend on (CRLF, BOM, duplicate usage lines, subagent files,
//! a half-written last line); no real text or secret ever got into them; and
//! Sandbox Mode copies them without ever changing the originals.

use std::fs;
use std::path::{Path, PathBuf};

use atlas_core::paths::{ConfigInputs, ConfigRoot, ConfigSource, resolve_config_root};
use atlas_core::sandbox::{self, SandboxOptions, SkipReason};
use serde_json::Value;

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("fixtures")
}

fn basic() -> PathBuf {
    fixtures().join("claude-basic")
}

fn edge() -> PathBuf {
    fixtures().join("claude-edge")
}

/// Every file under `root` as (relative path, bytes), sorted.
fn snapshot(root: &Path) -> Vec<(String, Vec<u8>)> {
    fn walk(dir: &Path, base: &Path, out: &mut Vec<(String, Vec<u8>)>) {
        let mut es: Vec<_> = fs::read_dir(dir).unwrap().map(|e| e.unwrap()).collect();
        es.sort_by_key(|e| e.file_name());
        for e in es {
            let p = e.path();
            if p.is_dir() {
                walk(&p, base, out);
            } else {
                let rel = p.strip_prefix(base).unwrap().to_string_lossy().replace('\\', "/");
                out.push((rel, fs::read(&p).unwrap()));
            }
        }
    }
    let mut out = Vec::new();
    walk(root, root, &mut out);
    out
}

fn root_of(dir: &Path) -> ConfigRoot {
    let home = dir.parent().unwrap();
    resolve_config_root(&ConfigInputs {
        flag: Some(dir),
        settings_override: None,
        env: None,
        home,
        cwd: home,
    })
}

fn lines(path: &Path) -> Vec<String> {
    fs::read_to_string(path).unwrap().split('\n').map(str::to_owned).collect()
}

const S1: &str = "11111111-aaaa-4aaa-8aaa-000000000001";

#[test]
fn the_edge_fixture_keeps_its_awkward_bytes() {
    let e = edge();
    let settings = fs::read(e.join("settings.json")).unwrap();
    assert!(settings.starts_with(b"\xEF\xBB\xBF"), "settings.json lost its BOM");
    assert!(settings.windows(2).any(|w| w == b"\r\n"), "settings.json lost its CRLF");
    for f in ["agents/lane-agent.md", "skills/crlf-skill/SKILL.md", ".claude.json"] {
        let b = fs::read(e.join(f)).unwrap();
        assert!(b.windows(2).any(|w| w == b"\r\n"), "{f} lost its CRLF");
    }
    let claude_md = fs::read(e.join("CLAUDE.md")).unwrap();
    assert!(!claude_md.ends_with(b"\n"), "CLAUDE.md should have no trailing newline");
    assert!(e.join("empty-dir").is_dir());
    assert!(e.join("caf\u{e9} \u{2603}").join("readme.txt").is_file());
}

#[test]
fn transcripts_have_duplicates_subagents_and_a_half_written_line() {
    let sess = basic().join("projects").join("-fixture-app").join(format!("{S1}.jsonl"));
    let all = lines(&sess);
    let (last, complete) = all.split_last().unwrap();
    // The newest line of a live session is half-written: it must not parse.
    assert!(serde_json::from_str::<Value>(last).is_err(), "last line should be cut off");

    let mut by_key: std::collections::BTreeMap<String, Vec<u64>> = Default::default();
    let mut types = std::collections::BTreeSet::new();
    for l in complete.iter().filter(|l| !l.is_empty()) {
        let v: Value = serde_json::from_str(l).expect("complete lines are valid JSON");
        let t = v["type"].as_str().unwrap().to_string();
        if t == "assistant" {
            let key = format!("{}+{}", v["message"]["id"].as_str().unwrap(), v["requestId"].as_str().unwrap());
            by_key.entry(key).or_default().push(v["message"]["usage"]["output_tokens"].as_u64().unwrap());
        }
        types.insert(t);
    }
    for t in ["user", "assistant", "api-request", "custom-title", "cost-state"] {
        assert!(types.contains(t), "missing line type {t}");
    }
    // Duplicates repeat one message.id + requestId; only output_tokens grows and
    // the last line holds the maximum (the recon's rule: keep the last).
    let dup = &by_key["msg_A+req_A"];
    assert_eq!(dup, &vec![5, 40, 120]);
    assert_eq!(dup.last(), dup.iter().max());
    assert!(by_key.len() >= 4);

    let sub = basic()
        .join("projects")
        .join("-fixture-app")
        .join(S1)
        .join("subagents")
        .join("agent-fixture1.jsonl");
    let sub_lines = lines(&sub);
    let first: Value = serde_json::from_str(&sub_lines[0]).unwrap();
    assert_eq!(first["isSidechain"], true);
    assert_eq!(first["agentId"], "fixture1");
    assert_eq!(first["sessionId"], S1, "subagent rolls up into its parent session");
}

#[test]
fn the_garbage_transcripts_cannot_parse_as_usage() {
    let dir = edge().join("projects").join("-edge");
    assert_eq!(fs::metadata(dir.join("empty.jsonl")).unwrap().len(), 0);
    let ok = lines(&dir.join("garbage.jsonl"))
        .iter()
        .filter(|l| !l.is_empty())
        .filter(|l| {
            serde_json::from_str::<Value>(l)
                .ok()
                .is_some_and(|v| v["type"] == "assistant")
        })
        .count();
    assert_eq!(ok, 0);
}

#[test]
fn fixtures_hold_no_real_text_and_no_real_secrets() {
    for (rel, bytes) in snapshot(&fixtures()) {
        let text = String::from_utf8_lossy(&bytes);
        for banned in ["sk-ant-", "BEGIN PRIVATE KEY", "ghp_", "AKIA"] {
            assert!(!text.contains(banned), "{rel} contains {banned}");
        }
        if rel.ends_with(".jsonl") && rel.contains("projects/") {
            for l in text.split('\n').filter(|l| !l.is_empty()) {
                let Ok(v) = serde_json::from_str::<Value>(l) else { continue };
                if let Some(c) = v["message"]["content"].as_str() {
                    // Invented sample prompts (so names and summaries can be tested) carry `fixtureText`.
                    assert!(c.starts_with("[fixture") || v["fixtureText"] == true, "{rel}: message text is not a placeholder");
                }
                if let Some(parts) = v["message"]["content"].as_array() {
                    for p in parts {
                        if let Some(t) = p["text"].as_str() {
                            assert!(t.starts_with("[fixture"), "{rel}: text is not a placeholder");
                        }
                    }
                }
            }
        }
        if rel.ends_with(".credentials.json") || rel.ends_with(".key") {
            assert!(text.contains("PLACEHOLDER"), "{rel} must be an obvious placeholder");
        }
    }
}

#[test]
fn flag_resolves_fixtures_with_claude_json_inside() {
    let r = root_of(&basic());
    assert_eq!(r.source, ConfigSource::Flag);
    assert!(r.dir.join("settings.json").is_file());
    assert!(r.claude_json.is_file(), "{:?}", r.claude_json);
    let j: Value = serde_json::from_slice(&fs::read(&r.claude_json).unwrap()).unwrap();
    assert!(j["mcpServers"]["fixture-notes"].is_object());
    assert!(j["projects"]["/fixture/app"]["mcpServers"]["fixture-local"].is_object());
}

#[test]
fn sandbox_of_the_fixtures_excludes_secrets_and_never_touches_the_original() {
    let tmp = tempfile::tempdir().unwrap();
    let before = snapshot(&fixtures());
    let src = root_of(&basic());

    let sb = sandbox::create(&src, tmp.path(), &SandboxOptions::default()).unwrap();
    let copy = snapshot(&sb.root.dir);
    let names: Vec<&str> = copy.iter().map(|(p, _)| p.as_str()).collect();

    for want in [
        "CLAUDE.md",
        "settings.json",
        "settings.local.json",
        "agents/code-reviewer.md",
        "skills/commit-helper/SKILL.md",
        "skills/commit-helper/references/style.md",
        "commands/standup.md",
        "output-styles/terse.md",
        "rules/testing.md",
        "hooks/format.sh",
        "plugins/installed_plugins.json",
        ".claude.json",
    ] {
        assert!(names.contains(&want), "{want} missing from the sandbox");
    }
    for banned in [
        ".credentials.json",
        "history.jsonl",
        "sessions/fixture-session.key",
        "backups/.claude.json.backup.1762560000000",
        "cache/cache.bin",
        "daemon.lock",
    ] {
        assert!(!names.contains(&banned), "{banned} must not be copied");
    }
    assert!(names.iter().all(|n| !n.starts_with("projects/")), "transcripts must not be copied");
    assert!(sb.root.projects_read_only);
    assert_eq!(sb.root.projects_dir, src.projects_dir);
    assert!(sb.report.skipped.iter().any(|s| s.path == ".credentials.json" && s.reason == SkipReason::Sensitive));
    assert!(copy.iter().all(|(_, b)| !String::from_utf8_lossy(b).contains("PLACEHOLDER")));

    // Edit, delete and add things the way the app will; the originals must not move.
    fs::write(sb.root.dir.join("settings.json"), b"{}").unwrap();
    fs::remove_dir_all(sb.root.dir.join("skills")).unwrap();
    fs::write(sb.root.dir.join("new-file.md"), b"x").unwrap();
    assert_eq!(before, snapshot(&fixtures()), "fixtures changed");

    let dir = sb.root.dir.clone();
    sb.discard().unwrap();
    assert!(!dir.exists());
    assert_eq!(before, snapshot(&fixtures()));
}

#[test]
fn sandbox_of_the_edge_fixture_keeps_bytes_exactly() {
    let tmp = tempfile::tempdir().unwrap();
    let src = root_of(&edge());
    let sb = sandbox::create(&src, tmp.path(), &SandboxOptions::default()).unwrap();
    for rel in [
        "agents/lane-agent.md",
        "agents/lane-agent.md.bak-20261001",
        "skills/crlf-skill/SKILL.md",
        "CLAUDE.md",
        "commands/nested/deploy/prod.md",
        "unknown-dir/notes.txt",
        "caf\u{e9} \u{2603}/readme.txt",
    ] {
        assert_eq!(
            fs::read(edge().join(rel)).unwrap(),
            fs::read(sb.root.dir.join(rel)).unwrap(),
            "{rel} differs in the sandbox copy"
        );
    }
    // The two JSON config files pass through redaction, so their bytes are
    // rewritten; with nothing secret in the fixture the content is unchanged,
    // key order included.
    for rel in ["settings.json", ".claude.json"] {
        let text = |p: std::path::PathBuf| {
            String::from_utf8(fs::read(p).unwrap()).unwrap().trim_start_matches('\u{feff}').to_string()
        };
        let before: serde_json::Value = serde_json::from_str(&text(edge().join(rel))).unwrap();
        let after: serde_json::Value = serde_json::from_str(&text(sb.root.dir.join(rel))).unwrap();
        assert_eq!(before, after, "{rel} content differs in the sandbox copy");
        let keys = |v: &serde_json::Value| v.as_object().unwrap().keys().cloned().collect::<Vec<_>>();
        assert_eq!(keys(&before), keys(&after), "{rel} key order changed");
    }
    assert!(sb.root.dir.join("empty-dir").is_dir(), "empty folders are copied too");
}

#[test]
fn a_sandbox_cannot_be_made_inside_the_fixtures() {
    let src = root_of(&basic());
    let inside = basic().join("skills");
    let r = sandbox::create(&src, &inside, &SandboxOptions::default());
    assert!(r.is_err());
    assert!(!fs::read_dir(&inside).unwrap().any(|e| {
        e.unwrap().file_name().to_string_lossy().starts_with(sandbox::DIR_PREFIX)
    }));
}
