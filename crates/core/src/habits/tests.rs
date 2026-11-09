//! End to end on `fixtures/claude-habits`: transcripts -> search index -> typed prompts ->
//! groups -> the two tool answers. Nothing real is read; every fixture text line carries
//! `"fixtureText": true`.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use super::*;
use crate::search::{NullSearchSink, SearchConfig, SearchEngine};
use crate::usage::time::parse_iso_ms;

const WAIT: Duration = Duration::from_secs(60);

fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("fixtures").join("claude-habits")
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

struct Built {
    _tmp: tempfile::TempDir,
    projects: PathBuf,
    config: PathBuf,
    data: PathBuf,
    index: PathBuf,
}

fn start(b: &Built) -> Arc<SearchEngine> {
    let mut cfg = SearchConfig::new(b.projects.clone(), b.config.clone(), b.index.clone());
    cfg.debounce = Duration::from_millis(20);
    SearchEngine::start(cfg, Arc::new(NullSearchSink))
}

fn run_pass(e: &SearchEngine) {
    let n = e.passes();
    e.poke();
    assert!(e.wait_pass(n, WAIT), "pass did not finish");
}

/// A scratch copy of the fixture, indexed.
fn build() -> Built {
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("claude");
    copy_dir(&fixture(), &config);
    let data = tmp.path().join("data");
    fs::create_dir_all(&data).unwrap();
    let b = Built { projects: config.join("projects"), index: data.join("search.sqlite"), config, data, _tmp: tmp };
    let e = start(&b);
    run_pass(&e);
    e.stop();
    b
}

fn prompts_of(b: &Built) -> Vec<Prompt> {
    load_prompts(&open_index(&b.index).unwrap()).unwrap()
}

fn grouping_of(b: &Built) -> Grouping {
    group(&prompts_of(b), Tz::Fixed(0))
}

const NOW: &str = "2026-11-02T00:00:00.000Z";

fn now() -> i64 {
    parse_iso_ms(NOW).unwrap()
}

fn qualifying(g: &Grouping) -> Vec<&Group> {
    g.qualifying(&Thresholds::OFFER, now(), 90, None)
}

/// The group a piece of fixture wording belongs to, if any.
fn group_of<'a>(g: &'a Grouping, wording: &str) -> Option<&'a Group> {
    g.like(wording, 1).map(|(g, _)| g)
}

// ---------------------------------------------------------------- the index (criterion 23)

#[test]
fn origin_column_maps_each_kind_of_line_and_leaves_helpers_out() {
    let b = build();
    let conn = open_index(&b.index).unwrap();
    let origin_of = |like: &str| -> Vec<i64> {
        let mut st = conn
            .prepare("SELECT DISTINCT m.origin FROM msgs m JOIN fts t ON t.rowid = m.id JOIN sfiles s ON s.file_id = m.file_id WHERE m.role = 0 AND s.is_subagent = 0 AND t.text LIKE ?1 ORDER BY 1")
            .unwrap();
        st.query_map([format!("{like}%")], |r| r.get(0)).unwrap().map(Result::unwrap).collect()
    };
    assert_eq!(origin_of("Background task finished"), [2], "task notification");
    assert_eq!(origin_of("Peer asks"), [2], "peer");
    assert_eq!(origin_of("Check the build status"), [2], "promptSource system");
    assert_eq!(origin_of("This session is being continued"), [2], "compact summary");
    assert_eq!(origin_of("generate the weekly report"), [2], "headless sdk-cli");
    assert_eq!(origin_of("run the linter"), [1], "origin.kind human");
    assert_eq!(origin_of("Read the README again"), [0], "no marker");
    let helper_rows: i64 = conn.query_row("SELECT COUNT(*) FROM msgs m JOIN sfiles s ON s.file_id = m.file_id WHERE s.is_subagent = 1", [], |r| r.get(0)).unwrap();
    assert_eq!(helper_rows, 20);
    // Assistant lines are never typed prompts.
    let assistant_typed: i64 = conn.query_row("SELECT COUNT(*) FROM msgs WHERE role = 1 AND origin <> 0", [], |r| r.get(0)).unwrap();
    assert_eq!(assistant_typed, 0);
}

#[test]
fn a_schema_one_index_is_read_again_once_and_origin_is_filled() {
    let b = build();
    // Make it look like what the previous Atlas wrote.
    {
        let c = rusqlite::Connection::open(&b.index).unwrap();
        c.execute_batch("ALTER TABLE msgs DROP COLUMN origin; PRAGMA user_version=1; INSERT OR REPLACE INTO meta(key,value) VALUES('parser_version','1');").unwrap();
    }
    assert_eq!(open_index(&b.index).err().as_deref(), Some(OLD_INDEX), "the tool says to open the app, and does not guess");
    let e = start(&b);
    run_pass(&e);
    e.stop();
    let conn = open_index(&b.index).expect("schema 2 after the app ran");
    let machine: i64 = conn.query_row("SELECT COUNT(*) FROM msgs WHERE origin = 2", [], |r| r.get(0)).unwrap();
    let total: i64 = conn.query_row("SELECT COUNT(*) FROM msgs", [], |r| r.get(0)).unwrap();
    assert_eq!(machine, 51, "30 task notifications + 10 headless + 6 scheduled + 3 peer + 2 compact (rows in all: {total})");
    // One re-read only: the next start does not wipe again.
    let rows: i64 = conn.query_row("SELECT COUNT(*) FROM msgs", [], |r| r.get(0)).unwrap();
    let e = start(&b);
    run_pass(&e);
    e.stop();
    let again: i64 = open_index(&b.index).unwrap().query_row("SELECT COUNT(*) FROM msgs", [], |r| r.get(0)).unwrap();
    assert_eq!(rows, again);
}

#[test]
fn a_missing_or_old_index_gets_the_plain_sentences() {
    let d = tempfile::tempdir().unwrap();
    assert_eq!(open_index(&d.path().join("none.sqlite")).err().as_deref(), Some(NO_INDEX));
    let h = Habits::new(d.path().join("none.sqlite"), d.path().to_path_buf());
    assert_eq!(h.find(&FindArgs::default(), now()).err().as_deref(), Some(NO_INDEX));
}

// ---------------------------------------------------------------- grouping (criterion 24)

#[test]
fn the_planted_request_is_one_group_of_seven() {
    let g = grouping_of(&build());
    let hit = group_of(&g, "Read the README and give me a three bullet summary in plain words").expect("a group");
    assert_eq!((hit.count, hit.sessions, hit.days), (7, 4, 3), "{hit:#?}");
    assert_eq!(hit.projects, ["notes", "site"]);
    assert!(hit.examples.len() <= EXAMPLES_MAX && !hit.examples.is_empty());
    assert!(hit.representative.to_lowercase().contains("readme"));
    assert!(hit.meets(&Thresholds::OFFER));
    let q = qualifying(&g);
    assert_eq!(q.len(), 1, "the planted request is the only repeated request: {:#?}", q.iter().map(|x| (&x.representative, x.count, x.sessions, x.days)).collect::<Vec<_>>());
    assert_eq!(q[0].id, hit.id);
    assert_eq!(hit.id.len(), 16);
}

const EXAMPLES_MAX: usize = cluster::EXAMPLES;

/// No group at all has this wording in it (it was dropped before grouping).
fn assert_absent(g: &Grouping, wording: &str) {
    if let Some((hit, s)) = g.like(wording, 1) {
        panic!("{wording:?} should not be grouped but matches {:?} ({s}, count {})", hit.representative, hit.count);
    }
}

#[test]
fn a_request_20_times_in_one_chat_is_not_a_group() {
    let g = grouping_of(&build());
    let hit = group_of(&g, "run the linter and fix everything it complains about").expect("it is counted");
    assert_eq!((hit.count, hit.sessions), (20, 1));
    assert!(!qualifying(&g).iter().any(|x| x.id == hit.id), "one chat is never enough");
}

#[test]
fn a_helpers_prompt_20_times_is_not_a_group() {
    assert_absent(&grouping_of(&build()), "Search every file for the deprecated fetchLegacy helper and list each file and line");
}

#[test]
fn a_task_notification_30_times_is_not_a_group() {
    assert_absent(&grouping_of(&build()), "Background task finished: the nightly export completed with exit code 0");
}

#[test]
fn a_slash_command_10_times_is_not_a_group() {
    assert_absent(&grouping_of(&build()), "/review-changes please check the diff for the login page");
}

#[test]
fn a_pasted_log_6_times_is_not_a_group() {
    assert_absent(&grouping_of(&build()), "Traceback (most recent call last): File export.py line 88 in run rows = load(path) ValueError: Expecting value");
}

#[test]
fn a_two_word_prompt_15_times_is_not_a_group() {
    assert_absent(&grouping_of(&build()), "continue please");
}

#[test]
fn a_prompt_with_a_masked_secret_6_times_is_not_a_group() {
    let b = build();
    assert_absent(&grouping_of(&b), "deploy to staging with the key and nothing else please");
    // ...and the secret itself never reaches the index.
    let leaked: i64 = open_index(&b.index).unwrap().query_row("SELECT COUNT(*) FROM fts WHERE fts MATCH 'FIXTUREFIXTUREFIXTURE0123456789abc'", [], |r| r.get(0)).unwrap();
    assert_eq!(leaked, 0);
}

#[test]
fn machine_prompts_that_repeat_do_not_count() {
    let g = grouping_of(&build());
    for t in ["generate the weekly report from the usage cache and save it", "Check the build status and report anything that is failing", "Peer asks: please share the latest design notes for the sidebar"] {
        assert_absent(&g, t);
    }
}

#[test]
fn nothing_the_assistant_said_is_ever_returned() {
    let g = grouping_of(&build());
    for grp in &g.groups {
        let all = format!("{} {}", grp.representative, grp.examples.join(" "));
        assert!(!all.contains("zebra") && !all.contains("***"), "{all}");
    }
}

// ---------------------------------------------------------------- determinism (criterion 25)

fn summary(g: &Grouping) -> Vec<(String, usize, usize, usize, String)> {
    g.groups.iter().map(|x| (x.id.clone(), x.count, x.sessions, x.days, x.representative.clone())).collect()
}

#[test]
fn two_runs_and_shuffled_input_give_the_same_ids_counts_and_order() {
    let b = build();
    let prompts = prompts_of(&b);
    let a = group(&prompts, Tz::Fixed(0));
    let again = group(&prompts, Tz::Fixed(0));
    assert_eq!(summary(&a), summary(&again));
    let mut rev = prompts.clone();
    rev.reverse();
    assert_eq!(summary(&a), summary(&group(&rev, Tz::Fixed(0))));
    let mut mixed = prompts.clone();
    mixed.sort_by_key(|p| id16(&format!("{}{}{}", p.ts, p.session, p.text)));
    assert_eq!(summary(&a), summary(&group(&mixed, Tz::Fixed(0))));
    // Examples are newest first and equally stable.
    let first = |g: &Grouping| g.groups.iter().map(|x| x.examples.clone()).collect::<Vec<_>>();
    assert_eq!(first(&a), first(&group(&mixed, Tz::Fixed(0))));
}

#[test]
fn a_new_wording_joins_the_group_without_creating_another() {
    let b = build();
    let mut prompts = prompts_of(&b);
    prompts.push(Prompt { text: "read the README and give me three bullet summary in plain words one more time".into(), session: "habit-s9".into(), ts: now() - 1000, project: Some("C:\\fx\\notes".into()) });
    let g = group(&prompts, Tz::Fixed(0));
    let hit = group_of(&g, "Read the README and give me a three bullet summary in plain words").unwrap();
    assert_eq!((hit.count, hit.sessions), (8, 5));
}

// ---------------------------------------------------------------- performance (criterion 26)

/// `cargo test --release -p atlas-core habits::tests::bench -- --ignored --nocapture`
#[test]
#[ignore = "timing; run in release"]
fn bench_20000_prompts() {
    // Mostly distinct 8 to 14 word sentences from a 900 word vocabulary (a seeded generator, so
    // the run is repeatable), plus a few hundred near copies so groups really form.
    let syll = ["ka", "lo", "mi", "ren", "tu", "va", "so", "bi", "dan", "fe", "gor", "hu", "jin", "pel", "qua", "ris", "ty", "wex"];
    let vocab: Vec<String> = (0..900usize).map(|i| format!("{}{}{}", syll[i % 18], syll[(i / 18) % 18], syll[(i / 324) % 18])).collect();
    let mut seed: u64 = 0x2545_F491_4F6C_DD1D;
    let mut next = move || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed
    };
    let mut prompts = Vec::new();
    let mut last = String::new();
    for i in 0..20_000usize {
        let text = if i % 25 == 0 && !last.is_empty() {
            format!("{last} again")
        } else {
            let n = 8 + (next() % 7) as usize;
            let words: Vec<&str> = (0..n).map(|_| vocab[(next() % 900) as usize].as_str()).collect();
            words.join(" ")
        };
        last.clone_from(&text);
        prompts.push(Prompt { text, session: format!("s{}", i % 400), ts: 1_790_000_000_000 + (i as i64 % 90) * 86_400_000, project: Some(format!("C:\\p\\{}", i % 7)) });
    }
    let t = Instant::now();
    let g = group(&prompts, Tz::Fixed(0));
    let ms = t.elapsed().as_millis();
    println!("habits bench: {} prompts -> {} groups in {ms} ms", prompts.len(), g.groups.len());
    assert!(ms <= 2_000, "{ms} ms");
}

// ---------------------------------------------------------------- the two tool answers (criteria 27, 28)

fn args(v: Value) -> FindArgs {
    serde_json::from_value(v).unwrap()
}

#[test]
fn find_returns_the_planted_group_and_nothing_else_typed_or_untyped() {
    let b = build();
    let h = Habits::new(b.index.clone(), b.data.clone()).with_tz(Tz::Fixed(0));
    let r = h.find(&FindArgs::default(), now()).unwrap();
    let groups = r["groups"].as_array().unwrap();
    assert_eq!(groups.len(), 1, "{r:#}");
    let g = &groups[0];
    assert_eq!((g["count"].as_u64(), g["sessions"].as_u64(), g["days"].as_u64()), (Some(7), Some(4), Some(3)));
    assert_eq!(g["projects"], json!(["notes", "site"]));
    assert!(g["examples"].as_array().unwrap().len() <= 5);
    assert_eq!(g["meetsBar"], true);
    assert_eq!(g["offer"], Value::Null);
    assert_eq!(r["offersOff"], false);
    assert_eq!(r["likeMatch"], Value::Null);
    assert!(r["indexedThroughMs"].as_i64().unwrap_or(0) > 0);
    let text = r.to_string();
    assert!(!text.contains("***") && !text.contains("zebra") && !text.contains("fetchLegacy"), "{text}");
}

#[test]
fn like_finds_the_group_even_when_it_is_under_the_bar() {
    let b = build();
    let h = Habits::new(b.index.clone(), b.data.clone()).with_tz(Tz::Fixed(0));
    // A fresh wording of the planted request.
    let r = h.find(&args(json!({"like": "Read the README for me and give a three bullet summary in plain words"})), now()).unwrap();
    assert!(r["likeMatch"]["similarity"].as_f64().unwrap() >= 0.55, "{r:#}");
    assert_eq!(r["groups"][0]["id"], r["likeMatch"]["groupId"]);
    // A request asked 20 times in one chat is under the bar but is still answered.
    let r = h.find(&args(json!({"like": "run the linter and fix everything it complains about"})), now()).unwrap();
    assert_eq!(r["groups"][0]["count"], 20);
    assert_eq!(r["groups"][0]["meetsBar"], false);
    // A one-off matches nothing.
    let r = h.find(&args(json!({"like": "translate the onboarding text into French and keep the tone"})), now()).unwrap();
    assert_eq!(r["likeMatch"], Value::Null);
}

#[test]
fn the_window_the_project_and_the_limit_filter_groups() {
    let b = build();
    let h = Habits::new(b.index.clone(), b.data.clone()).with_tz(Tz::Fixed(0));
    // The planted request was last asked on Oct 30; a clock 120 days later is outside 90 days.
    let later = now() + 120 * 86_400_000;
    assert!(h.find(&FindArgs::default(), later).unwrap()["groups"].as_array().unwrap().is_empty());
    assert_eq!(h.find(&args(json!({"days": 365})), later).unwrap()["groups"].as_array().unwrap().len(), 1);
    assert_eq!(h.find(&args(json!({"project": "site"})), now()).unwrap()["groups"].as_array().unwrap().len(), 1);
    assert_eq!(h.find(&args(json!({"project": "C:\\fx\\site"})), now()).unwrap()["groups"].as_array().unwrap().len(), 1);
    assert!(h.find(&args(json!({"project": "nothing-here"})), now()).unwrap()["groups"].as_array().unwrap().is_empty());
}

#[test]
fn note_declined_shows_as_the_offer_and_never_turns_offers_off() {
    let b = build();
    let h = Habits::new(b.index.clone(), b.data.clone()).with_tz(Tz::Fixed(0));
    let before = fs::read(&b.index).unwrap();
    let id = h.find(&FindArgs::default(), now()).unwrap()["groups"][0]["id"].as_str().unwrap().to_string();
    let r = h.note(&NoteArgs { group_id: Some(id.clone()), answer: "declined".into(), ..Default::default() }, now()).unwrap();
    assert_eq!((r["ok"].as_bool(), r["answer"].as_str(), r["offersOff"].as_bool()), (Some(true), Some("declined"), Some(false)));
    let r = h.find(&FindArgs::default(), now()).unwrap();
    assert_eq!(r["groups"][0]["offer"]["answer"], "declined");
    let r = h.find(&args(json!({"like": "Read the README for me and give a three bullet summary in plain words"})), now()).unwrap();
    assert_eq!(r["likeOffer"]["answer"], "declined");
    // Stop asking, with no group at all.
    let r = h.note(&NoteArgs { answer: "never".into(), ..Default::default() }, now()).unwrap();
    assert_eq!(r["offersOff"], true);
    assert_eq!(h.find(&FindArgs::default(), now()).unwrap()["offersOff"], true);
    // The index was only read.
    assert_eq!(fs::read(&b.index).unwrap(), before);
}

#[test]
fn habits_json_holds_ids_and_answers_and_no_prompt_text() {
    let b = build();
    let h = Habits::new(b.index.clone(), b.data.clone()).with_tz(Tz::Fixed(0));
    let id = h.find(&FindArgs::default(), now()).unwrap()["groups"][0]["id"].as_str().unwrap().to_string();
    h.note(&NoteArgs { group_id: Some(id), like: Some("Read the README and give me a three bullet summary in plain words".into()), answer: "made".into(), skill_name: Some("readme-summary".into()) }, now()).unwrap();
    let raw = fs::read_to_string(notes::path(&b.data)).unwrap();
    for word in ["README", "bullet", "plain words", "fixture", "jargon"] {
        assert!(!raw.contains(word), "{word} in {raw}");
    }
    assert!(raw.contains("readme-summary") && raw.contains("\"made\""));
    // The Claude folder (the fixture copy) was not written.
    assert!(!b.config.join("habits.json").exists());
}

#[test]
fn a_recorded_answer_survives_a_change_of_leader() {
    let b = build();
    let h = Habits::new(b.index.clone(), b.data.clone()).with_tz(Tz::Fixed(0));
    let id = h.find(&FindArgs::default(), now()).unwrap()["groups"][0]["id"].as_str().unwrap().to_string();
    h.note(&NoteArgs { group_id: Some(id.clone()), answer: "declined".into(), ..Default::default() }, now()).unwrap();
    // The answer is also filed for the group's other wordings, so a different leader finds it.
    let n = Notes::load(&b.data);
    assert!(n.groups[&id].aliases.len() >= 5, "{:?}", n.groups[&id]);
    let other_leader = &n.groups[&id].aliases[0];
    assert_eq!(n.offer_for([other_leader.as_str()]).map(|x| x.answer), Some(Answer::Declined));
}

#[test]
fn bad_input_gets_one_plain_sentence() {
    let b = build();
    let h = Habits::new(b.index.clone(), b.data.clone());
    let e = |a: NoteArgs| h.note(&a, now()).unwrap_err();
    assert!(e(NoteArgs { answer: "maybe".into(), ..Default::default() }).contains("offered, declined, made or never"));
    assert!(e(NoteArgs { answer: "declined".into(), ..Default::default() }).contains("groupId"));
    assert!(e(NoteArgs { group_id: Some("zz".into()), answer: "declined".into(), ..Default::default() }).contains("groupId must be an id"));
    assert!(e(NoteArgs { like: Some("a b c d e f g h".into()), answer: "made".into(), skill_name: Some("Bad Name".into()), ..Default::default() }).contains("skillName"));
}

#[test]
fn the_second_call_with_no_new_rows_answers_from_memory() {
    let b = build();
    let h = Habits::new(b.index.clone(), b.data.clone()).with_tz(Tz::Fixed(0));
    h.find(&FindArgs::default(), now()).unwrap();
    let t = Instant::now();
    h.find(&FindArgs::default(), now()).unwrap();
    assert!(t.elapsed() < Duration::from_millis(50), "{:?}", t.elapsed());
    // New rows invalidate it.
    let e = start(&b);
    let mut line = serde_json::to_string(&json!({"type":"user","uuid":"late-1","sessionId":"habit-s1","timestamp":"2026-10-31T09:00:00.000Z","cwd":"C:\\fx\\notes","fixtureText":true,
        "message":{"role":"user","content":"Read the README and give me a three bullet summary in plain words"}})).unwrap();
    line.push('\n');
    let file = b.projects.join("-fx-notes").join("habit-s1.jsonl");
    let mut f = fs::OpenOptions::new().append(true).open(file).unwrap();
    std::io::Write::write_all(&mut f, line.as_bytes()).unwrap();
    drop(f);
    run_pass(&e);
    e.stop();
    assert_eq!(h.find(&FindArgs::default(), now()).unwrap()["groups"][0]["count"], 8);
}

// ---------------------------------------------------------------- review fixes

fn typed_in(b: &Built, folder: &str) -> Vec<String> {
    prompts_of(b).into_iter().filter(|p| p.project.as_deref().is_some_and(|x| x.ends_with(folder))).map(|p| p.text.trim().to_string()).collect()
}

#[test]
fn wordings_never_leave_their_project_unless_asked() {
    let b = build();
    let h = Habits::new(b.index.clone(), b.data.clone()).with_tz(Tz::Fixed(0));
    let texts = |r: &Value| -> Vec<String> {
        let g = &r["groups"][0];
        let mut t: Vec<String> = g["representative"].as_str().map(str::to_string).into_iter().collect();
        t.extend(g["examples"].as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()));
        t
    };
    // No project given: counts only, no wording at all.
    let r = h.find(&FindArgs::default(), now()).unwrap();
    assert_eq!((r["groups"][0]["count"].as_u64(), r["wordingsFrom"].as_str()), (Some(7), Some("none")));
    assert!(texts(&r).is_empty(), "{r:#}");
    // This project: the count still spans every project, the wordings are this project's only.
    let (notes_texts, site_texts) = (typed_in(&b, "notes"), typed_in(&b, "site"));
    assert!(!notes_texts.is_empty() && !site_texts.is_empty());
    let r = h.find(&args(json!({"currentProject": "C:\\fx\\notes"})), now()).unwrap();
    assert_eq!((r["groups"][0]["count"].as_u64(), r["wordingsFrom"].as_str()), (Some(7), Some("this project")));
    let mine = texts(&r);
    assert!(!mine.is_empty() && mine.iter().all(|t| notes_texts.contains(t)), "{mine:?}");
    // Asked for: every project.
    let r = h.find(&args(json!({"currentProject": "notes", "allProjectsText": true})), now()).unwrap();
    let all = texts(&r);
    assert!(all.len() >= mine.len() && all.iter().all(|t| notes_texts.contains(t) || site_texts.contains(t)));
    assert!(all.iter().any(|t| site_texts.contains(t) && !notes_texts.contains(t)), "{all:?}");
}

#[test]
fn like_is_never_stricter_than_the_grouping() {
    // Every wording that was grouped finds a group again through `like`, whatever LSH did.
    let b = build();
    let g = group(&prompts_of(&b), Tz::Fixed(0));
    for p in prompts_of(&b) {
        let (hit, sim) = g.like(&p.text, 1).unwrap_or_else(|| panic!("no group for {:?}", p.text));
        assert!(sim >= 0.55, "{sim} {:?} -> {:?}", p.text, hit.representative);
    }
}
