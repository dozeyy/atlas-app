//! The `atlas-debrief` plugin skill (docs/specs/agent-scorecard.md, D60-D63, criteria 34 and 36):
//! small, quiet, and only able to run the debrief through the plugin's own launcher.

use std::path::{Path, PathBuf};

fn skill_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("skill")
}

/// (frontmatter key/value pairs, body)
fn parts() -> (Vec<(String, String)>, String) {
    let text = std::fs::read_to_string(skill_root().join("skills").join("atlas-debrief").join("SKILL.md")).unwrap().replace("\r\n", "\n");
    let rest = text.strip_prefix("---\n").expect("frontmatter");
    let (fm, body) = rest.split_once("\n---\n").expect("frontmatter end");
    let pairs = fm.lines().filter_map(|l| l.split_once(": ")).map(|(k, v)| (k.to_string(), v.to_string())).collect();
    (pairs, body.to_string())
}

fn get<'a>(fm: &'a [(String, String)], k: &str) -> &'a str {
    fm.iter().find(|(key, _)| key == k).map(|(_, v)| v.as_str()).unwrap_or_else(|| panic!("no {k}"))
}

// Criterion 34: description + when_to_use within 300 characters, the body within 1,800.
#[test]
fn the_skill_is_small_and_ascii() {
    let (fm, body) = parts();
    assert_eq!(get(&fm, "name"), "atlas-debrief");
    let meta = get(&fm, "description").chars().count() + get(&fm, "when_to_use").chars().count();
    assert!(meta <= 300, "description + when_to_use are {meta} characters");
    let n = body.trim().chars().count();
    assert!(n <= 1800, "the body is {n} characters");
    let raw = std::fs::read_to_string(skill_root().join("skills").join("atlas-debrief").join("SKILL.md")).unwrap();
    assert!(raw.is_ascii(), "the skill must be ASCII");
    // A plain YAML value cannot hold ": " or " #" (the usage skill once lost its metadata that way).
    for (k, v) in &fm {
        assert!(!v.contains(": ") && !v.contains(" #"), "{k} would not parse as YAML");
    }
}

#[test]
fn it_only_runs_the_debrief_through_the_launcher_and_only_when_asked() {
    let (fm, body) = parts();
    let tools = get(&fm, "allowed-tools");
    // The exact invocations, no wildcard at all: an extra option (--cache-dir, --config-dir, --session,
    // --since) or a different order does not match, so it asks the user instead of running.
    let launcher = "Bash(sh \"${CLAUDE_SKILL_DIR}/../atlas/bin/atlas-usage.sh\" debrief";
    let want: Vec<String> = ["--detail low", "--detail high", "--detail low --cost", "--detail high --cost"].iter().map(|t| format!("{launcher} {t})")).collect();
    let got: Vec<String> = tools.split("), ").map(|e| if e.ends_with(')') { e.to_string() } else { format!("{e})") }).collect();
    assert_eq!(got, want, "allowed-tools must list exactly these invocations: {tools}");
    assert!(!tools.contains('*'), "no wildcard in allowed-tools: {tools}");
    for flag in ["--cache-dir", "--config-dir", "--data-dir", "--session", "--since", "--cwd", "--project", "--json"] {
        assert!(!tools.contains(flag), "{flag} must not be pre-approved: {tools}");
    }
    assert!(!tools.contains("mcp__") && !tools.contains("PowerShell") && !tools.contains("Write") && !tools.contains("Edit"), "{tools}");
    assert!(dir_has_launcher());

    // Quiet: asked for only, no automatic use, and the model is told to follow the user's own style.
    let when = get(&fm, "when_to_use");
    assert!(when.starts_with("Only when the user asks"), "{when}");
    assert!(when.contains("Never on your own initiative") && when.contains("never every turn"), "{when}");
    // Asked for by name only: a plain "debrief me" stays Claude's own recap, without Atlas (Will, 2026-11-09).
    assert!(when.contains("A plain \"debrief me\" gets your normal recap, no Atlas"), "{when}");
    assert!(body.contains("do not run this") && body.contains("Never at the end of a run on its own"), "plain debriefs skip Atlas");
    assert!(body.contains("Do not add a session id"), "it debriefs the current chat through the session environment");
    assert!(body.contains("worktree branches only"), "Changed is labelled as branches");
    assert!(body.contains("Never impose a format") && body.contains("terse user"), "style rules");
    assert!(body.contains("only if the report already has headed sections"), "no Atlas heading by default");
    assert!(body.contains("too old for the debrief"), "the old-program line");
    // The picked-chat line is kept, and any other failure is one sentence with no retry.
    assert!(body.contains("Couldn't tell which chat this is") && body.contains("keep that line, word for word"), "the fallback line is kept");
    assert!(body.contains("Any other error") && body.contains("Don't retry"), "one sentence on any other failure");
}

fn dir_has_launcher() -> bool {
    let bin = skill_root().join("skills").join("atlas").join("bin");
    bin.join("atlas-usage.sh").is_file() && bin.join("atlas-usage.ps1").is_file()
}

// Criterion 36: no Stop hook, no hooks folder, nothing that fires on its own.
#[test]
fn the_plugin_has_no_hooks() {
    let root = skill_root();
    assert!(!root.join("hooks").exists(), "skill/hooks/ must not exist");
    for e in walk(&root) {
        let name = e.file_name().unwrap().to_string_lossy().to_lowercase();
        assert!(name != "hooks.json" && name != "hooks", "{e:?}");
    }
    let plugin = root.parent().unwrap().join(".claude-plugin");
    if plugin.is_dir() {
        for e in walk(&plugin) {
            let t = std::fs::read_to_string(&e).unwrap_or_default();
            assert!(!t.contains("\"hooks\""), "{e:?} declares hooks");
        }
    }
}

fn walk(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for e in std::fs::read_dir(dir).unwrap().flatten() {
        let p = e.path();
        out.push(p.clone());
        if p.is_dir() {
            out.extend(walk(&p));
        }
    }
    out
}
