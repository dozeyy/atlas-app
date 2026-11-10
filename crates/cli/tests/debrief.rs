//! `atlas-usage debrief` end to end (docs/specs/agent-scorecard.md, criteria 30-33): the real
//! program against `fixtures/claude-ledger`, read-only, with its own scratch index. Chat S1
//! (`aaaa1001`) has 14 helpers; S2 (`bbbb1002`) is a headless chat that ran as an agent and has none.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use atlas_core::usage::debrief_text;
use serde_json::Value;

const S1: &str = "aaaa1001-0000-4000-8000-000000000001";
const S2: &str = "bbbb1002-0000-4000-8000-000000000002";

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..")
}

fn fixture() -> PathBuf {
    root().join("fixtures").join("claude-ledger")
}

struct Scratch {
    _tmp: tempfile::TempDir,
    cache: PathBuf,
}

impl Scratch {
    fn new() -> Scratch {
        let tmp = tempfile::tempdir().unwrap();
        let cache = tmp.path().join("cache");
        Scratch { _tmp: tmp, cache }
    }

    fn run(&self, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_atlas-usage"))
            .arg("debrief")
            .args(args)
            .args(["--config-dir", fixture().to_str().unwrap(), "--cache-dir", self.cache.to_str().unwrap()])
            .env_remove("CLAUDE_CONFIG_DIR")
            .env_remove("ATLAS_DATA_DIR")
            .env_remove("ATLAS_USAGE_CACHE")
            .env_remove("CLAUDE_CODE_SESSION_ID")
            .env_remove("CLAUDE_PROJECT_DIR")
            .output()
            .unwrap()
    }

    fn text(&self, args: &[&str]) -> String {
        let o = self.run(args);
        assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
        String::from_utf8(o.stdout).unwrap().trim_end().to_string()
    }
}

fn golden(name: &str) -> String {
    let p = root().join("crates").join("cli").join("tests").join("golden").join(name);
    std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display())).replace("\r\n", "\n").trim_end().to_string()
}

// Criterion 30: the default debrief, as a golden file, within 10 lines and 900 characters.
#[test]
fn the_low_debrief_matches_its_golden_file_and_fits_its_limits() {
    let s = Scratch::new();
    let t = s.text(&["--session", S1]);
    assert_eq!(t, golden("debrief-ledger-s1-low.txt"));
    assert!(t.lines().count() <= debrief_text::LOW_LINES && t.chars().count() <= debrief_text::LOW_CHARS, "{} lines, {} chars", t.lines().count(), t.chars().count());
    for label in ["Ran:", "Helpers:", "Reviews:", "Tokens:"] {
        assert!(t.lines().any(|l| l.starts_with(label)), "{label} in {t}");
    }
    assert!(!t.contains('$'), "no dollars unless asked");
    assert!(!t.contains('#') && !t.contains('|') && !t.contains("```"), "no headings, tables or fences: {t}");
}

// Criterion 31: high adds one line per helper within 40 lines and 3000 characters.
#[test]
fn the_high_debrief_has_one_line_per_helper() {
    let s = Scratch::new();
    let t = s.text(&["--session", S1, "--detail", "high"]);
    assert_eq!(t, golden("debrief-ledger-s1-high.txt"));
    assert_eq!(t.lines().filter(|l| l.starts_with("- ")).count(), 14, "{t}");
    assert!(t.lines().count() <= debrief_text::HIGH_LINES && t.chars().count() <= debrief_text::HIGH_CHARS);
    // Model and effort, how it ended and the verdict are on a helper's line.
    assert!(t.contains("- code-reviewer \"fixture code-reviewer 07\": finished, asked for changes (FIX-REQUIRED), "), "{t}");
    assert!(t.contains("Opus 5.5 medium"), "{t}");
}

#[test]
fn cost_is_added_only_when_asked() {
    let s = Scratch::new();
    let plain = s.text(&["--session", S1]);
    let with = s.text(&["--session", S1, "--cost"]);
    assert!(!plain.contains("API prices"));
    assert!(with.contains("at API prices (an estimate)"), "{with}");
    assert!(with.chars().count() <= debrief_text::LOW_CHARS);
}

// Criterion 32: JSON carries the same facts; an unknown chat exits 2; a chat with no helpers is a valid debrief.
#[test]
fn json_has_the_facts_and_the_same_text() {
    let s = Scratch::new();
    let o = s.run(&["--session", S1, "--json"]);
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    let v: Value = serde_json::from_slice(&o.stdout).unwrap();
    assert_eq!(v["kind"], "debrief");
    assert_eq!(v["debrief"]["helpers"].as_array().unwrap().len(), 14);
    assert_eq!(v["debrief"]["ends"]["finished"], 11);
    assert_eq!(v["debrief"]["reviews"]["passed"], 3);
    assert_eq!(v["debrief"]["reviews"]["findings"], 3);
    assert_eq!(v["debrief"]["sessionId"], S1);
    assert_eq!(v["text"].as_str().unwrap(), s.text(&["--session", S1]));
    // Per helper: model, effort, goal and branch are fields.
    let h = v["debrief"]["helpers"].as_array().unwrap().iter().find(|h| h["worktreeBranch"].is_string()).expect("a helper on a worktree branch");
    assert_eq!(h["worktreeBranch"], "worktree-agent-w4branch");
    assert_eq!(h["goal"], "fixture coder 06");
    assert_eq!(h["model"]["modelName"], "Sonnet 5.5");
}

#[test]
fn an_unknown_chat_exits_2_and_a_chat_without_helpers_is_still_a_debrief() {
    let s = Scratch::new();
    let o = s.run(&["--session", "no-such-chat"]);
    assert_eq!(o.status.code(), Some(2));
    assert_eq!(String::from_utf8_lossy(&o.stderr).lines().last().unwrap(), "atlas-usage: No chat with that id.");
    assert!(o.stdout.is_empty());

    let t = s.text(&["--session", S2]);
    assert!(t.lines().any(|l| l == "Helpers: none"), "{t}");
    assert!(t.starts_with("Ran: ") && t.contains("\nTokens: "), "{t}");
    assert!(!t.contains("Reviews:"));
}

// Criterion 33: --since limits every figure to lines at or after that time.
#[test]
fn since_limits_the_window() {
    let s = Scratch::new();
    // 2026-11-06T09:20:00Z: after the 4th dispatch, so only the later six helpers remain.
    let late = s.text(&["--session", S1, "--since", "2026-11-06T09:20:00Z"]);
    assert!(late.contains("Helpers: 6 ("), "{late}");
    assert_eq!(late, s.text(&["--session", S1, "--since", "1793956800000"]), "ISO and epoch milliseconds agree");
    let all = s.text(&["--session", S1]);
    let tokens = |t: &str| t.lines().find(|l| l.starts_with("Tokens:")).unwrap().to_string();
    assert_ne!(tokens(&late), tokens(&all), "the tokens shrink with the window");
    let v: Value = serde_json::from_slice(&s.run(&["--session", S1, "--since", "1793956800000", "--json"]).stdout).unwrap();
    assert_eq!(v["debrief"]["fromTs"], 1_793_956_800_000_i64);
    assert!(v["debrief"]["helpers"].as_array().unwrap().iter().all(|h| h["started"].as_i64().unwrap() >= 1_793_956_800_000));
}

#[test]
fn last_picks_the_newest_chat_with_helpers_in_the_project() {
    let s = Scratch::new();
    let t = s.text(&["--last", "--project", "ledger"]);
    assert_eq!(t, s.text(&["--session", S1]), "S1 is the only chat of the project with helpers");
}

#[test]
fn bad_options_get_a_plain_line_and_exit_2() {
    let s = Scratch::new();
    for args in [&["--detail", "medium"][..], &["--since", "yesterday"], &["--bogus"], &["--session"]] {
        let o = s.run(args);
        assert_eq!(o.status.code(), Some(2), "{args:?}");
        assert!(String::from_utf8_lossy(&o.stderr).starts_with("atlas-usage:"));
    }
}

#[test]
fn the_fixture_folder_is_never_written() {
    let before = tree(&fixture());
    let s = Scratch::new();
    let _ = s.text(&["--session", S1, "--detail", "high"]);
    assert_eq!(tree(&fixture()), before, "transcripts are only read");
}

fn tree(dir: &Path) -> Vec<(String, u64, std::time::SystemTime)> {
    let mut out = Vec::new();
    fn walk(base: &Path, dir: &Path, out: &mut Vec<(String, u64, std::time::SystemTime)>) {
        for e in std::fs::read_dir(dir).unwrap().flatten() {
            let m = e.metadata().unwrap();
            let rel = e.path().strip_prefix(base).unwrap().to_string_lossy().replace('\\', "/");
            out.push((rel, m.len(), m.modified().unwrap()));
            if m.is_dir() {
                walk(base, &e.path(), out);
            }
        }
    }
    walk(dir, dir, &mut out);
    out.sort();
    out
}
