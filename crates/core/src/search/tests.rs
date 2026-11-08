//! End-to-end tests of the search engine on invented transcripts (nothing real is read).

use std::fs;
use std::io::Write;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use serde_json::json;

use super::*;

const WAIT: Duration = Duration::from_secs(30);

fn user(uuid: &str, session: &str, cwd: &str, ts: &str, text: &str) -> String {
    json!({"type":"user","uuid":uuid,"sessionId":session,"cwd":cwd,"timestamp":ts,"message":{"role":"user","content":text}}).to_string()
}

fn assistant(uuid: &str, session: &str, cwd: &str, ts: &str, text: &str) -> String {
    json!({"type":"assistant","uuid":uuid,"sessionId":session,"cwd":cwd,"timestamp":ts,
           "message":{"id":format!("m-{uuid}"),"role":"assistant","content":[{"type":"thinking","thinking":"private musing zebra"},{"type":"text","text":text}]}})
    .to_string()
}

fn tool_result(uuid: &str, session: &str) -> String {
    json!({"type":"user","uuid":uuid,"sessionId":session,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"huge tool output quokka"}]}}).to_string()
}

fn write(path: &Path, lines: &[String]) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let mut s = lines.join("\n");
    s.push('\n');
    fs::write(path, s).unwrap();
}

fn append(path: &Path, lines: &[String]) {
    let mut f = fs::OpenOptions::new().append(true).open(path).unwrap();
    for l in lines {
        writeln!(f, "{l}").unwrap();
    }
}

struct Fx {
    _dir: tempfile::TempDir,
    projects: std::path::PathBuf,
    db: std::path::PathBuf,
    config: std::path::PathBuf,
}

/// Three chats in two projects, one helper chat, one resumed copy, tool noise, a secret.
fn fixture() -> Fx {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let config = root.join("claude");
    let projects = config.join("projects");
    let db = root.join("data").join("search.sqlite");
    let (pa, pb) = (r"C:\work\alpha", r"C:\work\beta");
    write(
        &projects.join("alpha").join("s-one.jsonl"),
        &[
            user("u1", "s-one", pa, "2026-11-01T09:00:00.000Z", "Why is the flaky checkout test failing on CI?"),
            tool_result("u2", "s-one"),
            assistant("a1", "s-one", pa, "2026-11-01T09:00:05.000Z", "The flaky test retries without backoff. Add exponential backoff to the retry loop."),
            user("u3", "s-one", pa, "2026-11-01T09:01:00.000Z", "My key is sk-ant-api03-AbCdEf0123456789xyzXYZ please keep it secret"),
        ],
    );
    write(
        &projects.join("alpha").join("s-two.jsonl"),
        &[
            user("u4", "s-two", pa, "2026-11-03T10:00:00.000Z", "backoff"),
            assistant("a2", "s-two", pa, "2026-11-03T10:00:09.000Z", "Backoff means waiting longer after each failure. A long unrelated paragraph about gardens and weather follows here to make this message much longer than the short prompt above."),
        ],
    );
    write(
        &projects.join("beta").join("s-three.jsonl"),
        &[
            user("u5", "s-three", pb, "2026-11-05T08:00:00.000Z", "Refactor the parser module"),
            assistant("a3", "s-three", pb, "2026-11-05T08:00:30.000Z", "Refactoring the parser: split tokenizing from parsing."),
            // A resumed copy of an earlier message (same uuid): must not appear twice.
            user("u1", "s-three", pb, "2026-11-01T09:00:00.000Z", "Why is the flaky checkout test failing on CI?"),
        ],
    );
    write(
        &projects.join("alpha").join("s-one").join("subagents").join("agent-abc123.jsonl"),
        &[
            user("h1", "s-one", pa, "2026-11-01T09:00:20.000Z", "Investigate the quokka migration"),
            assistant("h2", "s-one", pa, "2026-11-01T09:00:40.000Z", "The quokka migration touches three tables."),
        ],
    );
    Fx { _dir: dir, projects, db, config }
}

fn start(fx: &Fx) -> Arc<SearchEngine> {
    let mut cfg = SearchConfig::new(fx.projects.clone(), fx.config.clone(), fx.db.clone());
    cfg.debounce = Duration::from_millis(20);
    SearchEngine::start(cfg, Arc::new(NullSearchSink))
}

fn run_pass(e: &SearchEngine) {
    let n = e.passes();
    e.poke();
    assert!(e.wait_pass(n, WAIT), "pass did not finish");
}

fn ids(p: &SearchPage) -> Vec<(String, Option<String>, String)> {
    p.hits.iter().map(|h| (h.session_id.clone(), h.agent_id.clone(), h.role.clone())).collect()
}

fn plain(h: &SearchHit) -> String {
    h.snippet.iter().map(|p| p.text.as_str()).collect()
}

#[test]
fn indexes_text_only_and_finds_it() {
    let fx = fixture();
    let e = start(&fx);
    assert_eq!(e.status().state, SearchState::Waiting);
    run_pass(&e);
    let s = e.status();
    assert!(s.ready && s.state == SearchState::Idle, "{s:?}");
    assert!(s.db_bytes > 0);

    let p = e.search("flaky", 10, 0).unwrap();
    assert_eq!(p.hits.len(), 2, "one user + one assistant, the resumed copy is not a third: {:?}", ids(&p));
    // The resumed copy (same uuid in another session) is indexed once; which session keeps
    // it depends on scan order, so only the count is pinned.
    let own: Vec<_> = p.hits.iter().filter(|h| h.session_id == "s-one").collect();
    assert!(!own.is_empty());
    assert!(own.iter().all(|h| h.project == r"C:\work\alpha" && h.project_name == "alpha"));
    assert!(p.hits.iter().all(|h| h.ts.is_some()));
    // The match is highlighted.
    assert!(p.hits[0].snippet.iter().any(|x| x.hit && x.text.to_lowercase().starts_with("flaky")), "{:?}", p.hits[0].snippet);

    // Tool output and thinking are not searchable.
    assert!(e.search("zebra", 10, 0).unwrap().hits.is_empty());
    assert!(e.search("huge tool output", 10, 0).unwrap().hits.is_empty());
}

#[test]
fn ranking_is_bm25_so_the_tight_match_wins() {
    let fx = fixture();
    let e = start(&fx);
    run_pass(&e);
    let p = e.search("backoff", 10, 0).unwrap();
    assert_eq!(p.hits.len(), 3);
    // The one-word prompt beats the two long messages.
    assert_eq!(plain(&p.hits[0]).trim(), "backoff");
    assert_eq!(p.hits[0].session_id, "s-two");
}

#[test]
fn prefix_phrase_and_paging() {
    let fx = fixture();
    let e = start(&fx);
    run_pass(&e);
    // "refactor" (still typing) finds "Refactoring" and "Refactor".
    assert_eq!(e.search("refactor", 10, 0).unwrap().hits.len(), 2);
    // With a trailing space it is the whole word only.
    assert_eq!(e.search("refactor ", 10, 0).unwrap().hits.len(), 1);
    // A phrase must be adjacent.
    assert_eq!(e.search("\"retry loop\"", 10, 0).unwrap().hits.len(), 1);
    assert_eq!(e.search("\"loop retry\"", 10, 0).unwrap().hits.len(), 0);
    // Case and accents do not matter; operators are plain words.
    assert_eq!(e.search("FLAKY OR", 10, 0).unwrap().hits.len(), 0);
    assert_eq!(e.search("   ", 10, 0).unwrap().hits.len(), 0);
    // Paging.
    let all = e.search("backoff", 10, 0).unwrap();
    let first = e.search("backoff", 2, 0).unwrap();
    let rest = e.search("backoff", 2, 2).unwrap();
    assert!(first.has_more && !rest.has_more);
    assert_eq!(first.hits.len(), 2);
    assert_eq!(rest.hits.len(), 1);
    assert_eq!(first.hits[1].id, all.hits[1].id);
    assert_eq!(rest.hits[0].id, all.hits[2].id);
}

#[test]
fn helper_chats_belong_to_the_parent_session() {
    let fx = fixture();
    let e = start(&fx);
    run_pass(&e);
    let p = e.search("quokka", 10, 0).unwrap();
    assert_eq!(p.hits.len(), 2);
    for h in &p.hits {
        assert_eq!(h.session_id, "s-one");
        assert_eq!(h.agent_id.as_deref(), Some("abc123"));
    }
}

#[test]
fn secrets_never_reach_the_index_or_a_snippet() {
    let fx = fixture();
    let e = start(&fx);
    run_pass(&e);
    assert!(e.search("AbCdEf0123456789xyzXYZ", 10, 0).unwrap().hits.is_empty());
    let p = e.search("keep it secret", 10, 0).unwrap();
    assert_eq!(p.hits.len(), 1);
    assert!(!plain(&p.hits[0]).contains("AbCdEf"), "{}", plain(&p.hits[0]));
    // And not in the file either.
    e.stop();
    let bytes = fs::read(&fx.db).unwrap();
    assert!(!bytes.windows(10).any(|w| w == b"AbCdEf0123"));
}

#[test]
fn incremental_pass_reads_only_what_was_added() {
    let fx = fixture();
    let e = start(&fx);
    run_pass(&e);
    let before = e.status().messages;
    // No change: nothing to read.
    run_pass(&e);
    assert_eq!(e.status().messages, before);
    assert_eq!(e.status().files_total, 0, "an unchanged tree plans no files");
    // One appended line becomes searchable.
    let f = fx.projects.join("beta").join("s-three.jsonl");
    append(&f, &[assistant("a9", "s-three", r"C:\work\beta", "2026-11-06T08:00:00.000Z", "Narwhal handling added to the tokenizer.")]);
    run_pass(&e);
    assert_eq!(e.status().files_total, 1);
    let p = e.search("narwhal", 10, 0).unwrap();
    assert_eq!(p.hits.len(), 1);
    assert_eq!(p.hits[0].session_id, "s-three");
    // Re-running finds it once, never twice.
    run_pass(&e);
    assert_eq!(e.search("narwhal", 10, 0).unwrap().hits.len(), 1);
}

#[test]
fn a_half_written_last_line_waits_for_its_newline() {
    let fx = fixture();
    let e = start(&fx);
    run_pass(&e);
    let f = fx.projects.join("alpha").join("s-two.jsonl");
    let line = assistant("a7", "s-two", r"C:\work\alpha", "2026-11-04T10:00:00.000Z", "Pangolin notes");
    let (head, tail) = line.split_at(line.len() / 2);
    fs::OpenOptions::new().append(true).open(&f).unwrap().write_all(head.as_bytes()).unwrap();
    run_pass(&e);
    assert!(e.search("pangolin", 10, 0).unwrap().hits.is_empty());
    fs::OpenOptions::new().append(true).open(&f).unwrap().write_all(format!("{tail}\n").as_bytes()).unwrap();
    run_pass(&e);
    assert_eq!(e.search("pangolin", 10, 0).unwrap().hits.len(), 1);
}

#[test]
fn deleted_transcripts_stay_searchable_and_replaced_ones_are_reread() {
    let fx = fixture();
    let e = start(&fx);
    run_pass(&e);
    fs::remove_file(fx.projects.join("alpha").join("s-two.jsonl")).unwrap();
    run_pass(&e);
    assert_eq!(e.search("gardens", 10, 0).unwrap().hits.len(), 1, "kept after the file is swept");
    // A file replaced by a new, shorter one: the old text goes, the new text arrives.
    let f = fx.projects.join("beta").join("s-three.jsonl");
    write(&f, &[user("n1", "s-three", r"C:\work\beta", "2026-11-07T08:00:00.000Z", "Totally new axolotl chat")]);
    run_pass(&e);
    assert_eq!(e.search("axolotl", 10, 0).unwrap().hits.len(), 1);
    assert!(e.search("tokenizing", 10, 0).unwrap().hits.is_empty());
}

#[test]
fn stop_cancels_a_long_build_and_the_next_start_finishes_it() {
    let dir = tempfile::tempdir().unwrap();
    let config = dir.path().join("claude");
    let projects = config.join("projects");
    // ~60k messages in one file.
    let lines: Vec<String> = (0..60_000)
        .map(|i| user(&format!("u{i}"), "big", r"C:\work\big", "2026-11-01T09:00:00.000Z", &format!("message number {i} about lemurs and ferns")))
        .collect();
    write(&projects.join("big").join("big.jsonl"), &lines);
    let db = dir.path().join("data").join("search.sqlite");
    let mut cfg = SearchConfig::new(projects.clone(), config.clone(), db.clone());
    cfg.debounce = Duration::from_millis(5);
    cfg.batch_msgs = 500;
    let e = SearchEngine::start(cfg.clone(), Arc::new(NullSearchSink));
    e.poke();
    std::thread::sleep(Duration::from_millis(60));
    let t = std::time::Instant::now();
    e.stop();
    assert!(t.elapsed() < Duration::from_secs(5), "stop took {:?}", t.elapsed());
    let partial = e.status();
    // Whatever was done is consistent; a new engine finishes the job without duplicating.
    let e2 = SearchEngine::start(cfg, Arc::new(NullSearchSink));
    let n = e2.passes();
    e2.poke();
    assert!(e2.wait_pass(n, Duration::from_secs(60)));
    let s = e2.status();
    assert!(s.ready, "{s:?} after partial {partial:?}");
    assert_eq!(s.messages, 60_000);
    assert_eq!(e2.search("lemurs", 50, 0).unwrap().hits.len(), 50);
}

#[test]
fn refuses_to_live_inside_the_claude_folder() {
    let fx = fixture();
    let cfg = SearchConfig::new(fx.projects.clone(), fx.config.clone(), fx.config.join("search.sqlite"));
    let e = SearchEngine::start(cfg, Arc::new(NullSearchSink));
    assert_eq!(e.status().state, SearchState::Error);
    assert!(e.search("x", 5, 0).is_err());
    assert!(!fx.config.join("search.sqlite").exists());
}

#[test]
fn nothing_is_written_under_the_projects_folder() {
    let fx = fixture();
    let snapshot = |p: &Path| -> Vec<(String, u64)> {
        let mut v = Vec::new();
        fn walk(p: &Path, v: &mut Vec<(String, u64)>) {
            for e in fs::read_dir(p).unwrap().flatten() {
                let m = e.metadata().unwrap();
                if m.is_dir() {
                    walk(&e.path(), v);
                } else {
                    v.push((e.path().to_string_lossy().into_owned(), m.len()));
                }
            }
        }
        walk(p, &mut v);
        v.sort();
        v
    };
    let before = snapshot(&fx.config);
    let e = start(&fx);
    run_pass(&e);
    let _ = e.search("flaky", 5, 0).unwrap();
    e.stop();
    assert_eq!(snapshot(&fx.config), before);
}
