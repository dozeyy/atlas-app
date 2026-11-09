//! `atlas-usage repeats` / `offer-note` end to end, the real program against a scratch copy of
//! `fixtures/claude-habits` with the dates moved to a few days ago. No Atlas app index exists
//! here, so the program reads the transcripts itself. Nothing touches the real Claude folder or
//! Atlas data: every folder is a flag.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use chrono::{Days, NaiveDate, Utc};
use serde_json::Value;

fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("fixtures").join("claude-habits")
}

fn shift(d: NaiveDate, delta: i64) -> NaiveDate {
    if delta >= 0 { d + Days::new(delta as u64) } else { d - Days::new((-delta) as u64) }
}

fn go(from: &Path, to: &Path, delta: i64) {
    fs::create_dir_all(to).unwrap();
    for e in fs::read_dir(from).unwrap().flatten() {
        let (src, dst) = (e.path(), to.join(e.file_name()));
        if e.file_type().unwrap().is_dir() {
            go(&src, &dst, delta);
        } else if src.extension().is_some_and(|x| x == "jsonl") {
            let mut out = String::new();
            for l in fs::read_to_string(&src).unwrap().lines() {
                match serde_json::from_str::<Value>(l) {
                    Ok(mut v) => {
                        if let Some(ts) = v["timestamp"].as_str().map(str::to_string) {
                            let d = shift(NaiveDate::parse_from_str(&ts[..10], "%Y-%m-%d").unwrap(), delta);
                            v["timestamp"] = Value::String(format!("{d}{}", &ts[10..]));
                        }
                        out.push_str(&v.to_string());
                    }
                    Err(_) => out.push_str(l),
                }
                out.push('\n');
            }
            fs::write(&dst, out).unwrap();
        } else {
            fs::copy(&src, &dst).unwrap();
        }
    }
}

struct Scratch {
    _tmp: tempfile::TempDir,
    config: PathBuf,
    data: PathBuf,
    cache: PathBuf,
}

impl Scratch {
    fn new() -> Scratch {
        let tmp = tempfile::tempdir().unwrap();
        let config = tmp.path().join("claude");
        // The fixture's newest planted ask is 2026-10-30; move it to 3 days ago.
        let base = NaiveDate::from_ymd_opt(2026, 10, 30).unwrap();
        let delta = (Utc::now().date_naive() - Days::new(3)).signed_duration_since(base).num_days();
        go(&fixture(), &config, delta);
        let (data, cache) = (tmp.path().join("data"), tmp.path().join("cache"));
        fs::create_dir_all(&data).unwrap();
        Scratch { _tmp: tmp, config, data, cache }
    }

    fn run(&self, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_atlas-usage"))
            .args(args)
            .args(["--config-dir", self.config.to_str().unwrap(), "--data-dir", self.data.to_str().unwrap(), "--cache-dir", self.cache.to_str().unwrap()])
            .env_remove("CLAUDE_CONFIG_DIR")
            .env_remove("ATLAS_DATA_DIR")
            .env_remove("ATLAS_USAGE_CACHE")
            .output()
            .unwrap()
    }

    fn json(&self, args: &[&str]) -> Value {
        let o = self.run(args);
        assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
        serde_json::from_slice(&o.stdout).unwrap_or_else(|e| panic!("not JSON ({e}): {}", String::from_utf8_lossy(&o.stdout)))
    }
}

const FRESH: &str = "Read the README for me and give a three bullet summary in plain words";

#[test]
fn repeats_reads_the_chats_itself_and_finds_the_planted_group_without_the_app() {
    let s = Scratch::new();
    let v = s.json(&["repeats", "--like", FRESH, "--json"]);
    let groups = v["groups"].as_array().unwrap();
    assert!(!groups.is_empty(), "{v}");
    let top = &groups[0];
    assert_eq!(top["meetsBar"], true, "{top}");
    assert!(top["count"].as_i64().unwrap() >= 5 && top["sessions"].as_i64().unwrap() >= 3, "{top}");
    assert!(v["likeMatch"]["groupId"].is_string(), "{v}");
    assert_eq!(v["offersOff"], false);
    assert!(s.cache.join("search.sqlite").is_file(), "its own index lives in the cache folder");
    // A second run answers from the same index without re-reading everything.
    assert_eq!(s.json(&["repeats"])["groups"][0]["id"], top["id"]);
}

#[test]
fn offer_note_declined_is_remembered_by_the_next_repeats_and_holds_ids_only() {
    let s = Scratch::new();
    let id = s.json(&["repeats"])["groups"][0]["id"].as_str().unwrap().to_string();
    let n = s.json(&["offer-note", &id, "declined"]);
    assert_eq!(n["ok"], true);
    let after = s.json(&["repeats"]);
    assert_eq!(after["groups"][0]["offer"]["answer"], "declined", "{after}");
    let file = fs::read_to_string(s.data.join("habits.json")).unwrap();
    for w in ["README", "readme", "summary", "bullet"] {
        assert!(!file.contains(w), "habits.json holds no prompt text: {file}");
    }
}

#[test]
fn offer_note_off_turns_offers_off_with_no_id() {
    let s = Scratch::new();
    let n = s.json(&["offer-note", "off"]);
    assert_eq!(n["offersOff"], true, "{n}");
    assert_eq!(s.json(&["repeats"])["offersOff"], true);
    let n = s.json(&["offer-note", "-", "off"]);
    assert_eq!(n["offersOff"], true);
}

#[test]
fn bad_input_gets_one_plain_line_and_a_failing_exit() {
    let s = Scratch::new();
    for args in [&["offer-note", "abc"][..], &["offer-note", "zz-not-an-id", "declined"], &["repeats", "--days", "x"]] {
        let o = s.run(args);
        assert!(!o.status.success(), "{args:?}");
        let e = String::from_utf8_lossy(&o.stderr);
        assert!(e.starts_with("atlas-usage:"), "{e}");
    }
    // No transcripts at all.
    let o = Command::new(env!("CARGO_BIN_EXE_atlas-usage"))
        .args(["repeats", "--config-dir", s.data.join("nope").to_str().unwrap(), "--data-dir", s.data.to_str().unwrap(), "--cache-dir", s.cache.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(!o.status.success() && String::from_utf8_lossy(&o.stderr).contains("no Claude Code transcripts"));
}

#[test]
fn the_cache_folder_may_not_sit_inside_the_claude_folder() {
    let s = Scratch::new();
    let inside = s.config.join("cache");
    let o = Command::new(env!("CARGO_BIN_EXE_atlas-usage"))
        .args(["repeats", "--config-dir", s.config.to_str().unwrap(), "--data-dir", s.data.to_str().unwrap(), "--cache-dir", inside.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(!o.status.success());
    assert!(!inside.exists(), "nothing was created inside the Claude folder");
}
