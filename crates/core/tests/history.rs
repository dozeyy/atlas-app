//! History: baseline, rescans, renames, imports, redaction, pruning, and the promise that
//! nothing in the watched folder is ever written.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use atlas_core::history::query::{self, Against, EventFilter};
use atlas_core::history::store::Store;
use atlas_core::history::{file_key, import, scan, Tracked, MCP_KEY};

const SECRET: &str = "sk-ant-SECRETSECRETSECRET1234567890";

fn tracked(path: &Path, kind: &str) -> Tracked {
    Tracked { key: file_key(path), kind: kind.into(), scope: "user".into(), project: None, name: path.file_name().unwrap().to_string_lossy().into_owned(), path: path.to_path_buf() }
}

fn write(path: &Path, text: &str, age_s: u64) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
    let f = fs::OpenOptions::new().write(true).open(path).unwrap();
    f.set_modified(SystemTime::now() - Duration::from_secs(age_s)).unwrap();
}

struct Env {
    _t: tempfile::TempDir,
    claude: PathBuf,
    store: Store,
}

fn env() -> Env {
    let t = tempfile::tempdir().unwrap();
    let claude = t.path().join("claude");
    fs::create_dir_all(&claude).unwrap();
    let store = Store::open(&t.path().join("data").join("history")).unwrap();
    Env { _t: t, claude, store }
}

fn all_events(store: &Store) -> Vec<query::HistoryEvent> {
    query::events(store, &EventFilter { limit: 100, ..Default::default() }).unwrap().events
}

#[test]
fn baseline_then_changes_then_quiet() {
    let e = env();
    let a = e.claude.join("settings.json");
    let b = e.claude.join("skills").join("x").join("SKILL.md");
    write(&a, "{\"model\":\"sonnet\"}\n", 5000);
    write(&b, "---\nname: x\ndescription: one\n---\nbody\n", 4000);
    let t = vec![tracked(&a, "settings"), tracked(&b, "skill")];
    let now = 1_800_000_000_000i64;

    let r = scan::scan(&e.store, &t, None, now).unwrap();
    assert!(r.baseline);
    assert_eq!(r.items, 2);
    let ev = all_events(&e.store);
    assert_eq!(ev.len(), 2);
    assert!(ev.iter().all(|x| x.kind == "dated" && x.source == "file_date"), "{ev:?}");

    // Nothing changed: nothing recorded, and nothing re-read.
    let r = scan::scan(&e.store, &t, None, now + 1000).unwrap();
    assert!(r.is_empty(), "{r:?}");

    // A real change.
    write(&a, "{\"model\":\"opus\"}\n", 1);
    let r = scan::scan(&e.store, &t, None, now + 2000).unwrap();
    assert_eq!((r.changed, r.added), (1, 0));
    let ev = all_events(&e.store);
    assert_eq!(ev[0].kind, "changed");
    assert!(ev[0].summary.contains("model from sonnet to opus"), "{}", ev[0].summary);

    // Only the time moved: same bytes, so no event and no new copy.
    write(&a, "{\"model\":\"opus\"}\n", 0);
    let before = e.store.with(|c| c.query_row("SELECT COUNT(*) FROM versions", [], |r| r.get::<_, i64>(0))).unwrap();
    let r = scan::scan(&e.store, &t, None, now + 3000).unwrap();
    assert!(r.is_empty(), "{r:?}");
    let after = e.store.with(|c| c.query_row("SELECT COUNT(*) FROM versions", [], |r| r.get::<_, i64>(0))).unwrap();
    assert_eq!(before, after);

    // The diff of the change is a line diff with word marks.
    let d = query::compare(&e.store, ev[0].to_version.unwrap(), Against::Previous, 3).unwrap();
    assert_eq!(d.kind, "text");
    assert_eq!((d.added, d.removed), (1, 1));
}

#[test]
fn renames_and_removals_are_paired_and_a_failed_listing_removes_nothing() {
    let e = env();
    let a = e.claude.join("agents").join("old.md");
    write(&a, "---\nname: old\n---\nsame words\n", 9000);
    let now = 1_800_000_000_000i64;
    scan::scan(&e.store, &[tracked(&a, "agent")], None, now).unwrap();

    // An empty listing is a failure to look, not a delete.
    let r = scan::scan(&e.store, &[], None, now + 10).unwrap();
    assert_eq!(r.removed, 0);

    let b = e.claude.join("agents").join("new.md");
    fs::rename(&a, &b).unwrap();
    let r = scan::scan(&e.store, &[tracked(&b, "agent")], None, now + 20).unwrap();
    assert_eq!((r.renamed, r.removed, r.added), (1, 0, 0), "{r:?}");
    assert!(all_events(&e.store)[0].summary.starts_with("Renamed from old.md"));

    fs::remove_file(&b).unwrap();
    let c = e.claude.join("agents").join("other.md");
    write(&c, "different\n", 10);
    let r = scan::scan(&e.store, &[tracked(&c, "agent")], None, now + 30).unwrap();
    assert_eq!((r.removed, r.added), (1, 1), "{r:?}");
}

#[test]
fn the_mcp_view_keeps_servers_and_hides_everything_else() {
    let e = env();
    let cj = e.claude.join(".claude.json");
    let body = format!(
        "{{\"oauthAccount\":{{\"emailAddress\":\"someone@example.com\"}},\"userID\":\"abcdef0123456789\",\"mcpServers\":{{\"fs\":{{\"type\":\"stdio\",\"command\":\"npx\",\"args\":[\"-y\",\"srv\"],\"env\":{{\"API_KEY\":\"{SECRET}\"}}}}}},\"projects\":{{\"C:/p\":{{\"history\":[{{\"display\":\"private chat words\"}}],\"mcpServers\":{{}},\"disabledMcpServers\":[\"fs\"]}}}}}}"
    );
    write(&cj, &body, 100);
    let a = e.claude.join("settings.json");
    write(&a, "{}\n", 100);
    scan::scan(&e.store, &[tracked(&a, "settings")], Some(&cj), 1_800_000_000_000).unwrap();

    // Search every byte the store wrote.
    let mut hay = Vec::new();
    fn walk(p: &Path, out: &mut Vec<u8>) {
        for en in fs::read_dir(p).unwrap().flatten() {
            let q = en.path();
            if q.is_dir() { walk(&q, out) } else { out.extend(fs::read(&q).unwrap_or_default()) }
        }
    }
    walk(e.store.dir(), &mut hay);
    let hay = String::from_utf8_lossy(&hay).into_owned();
    assert!(!hay.contains("SECRETSECRET"), "a secret reached the store");
    assert!(!hay.contains("someone@example.com") && !hay.contains("private chat words"));
    assert!(hay.contains("\"fs\"") && hay.contains("disabledMcpServers"));
    let it = query::item(&e.store, MCP_KEY).unwrap().unwrap();
    assert_eq!(it.versions.len(), 1);
}

#[test]
fn claude_codes_own_copies_become_older_versions_once() {
    let e = env();
    let cj = e.claude.join(".claude.json");
    write(&cj, "{\"mcpServers\":{\"a\":{\"command\":\"x\"}}}", 100);
    // Two backups: one identical to an earlier view, one different.
    write(&e.claude.join("backups").join(".claude.json.backup.1790000000000"), "{\"mcpServers\":{}}", 100000);
    write(&e.claude.join("backups").join(".claude.json.backup.1791000000000"), "{\"mcpServers\":{\"a\":{\"command\":\"x\"}}}", 90000);
    write(&e.claude.join("backups").join(".claude.json.backup.1792000000000"), "{\"mcpServers\":{\"a\":{\"command\":\"x\"}}}", 80000);

    let f = e.claude.join("skills").join("s").join("SKILL.md");
    write(&f, "line one\nline two\n", 100);
    let sid = "11111111-2222-3333-4444-555555555555";
    write(&e.claude.join("file-history").join(sid).join("abcd@v1"), "line one\n", 100);
    write(&e.claude.join("file-history").join(sid).join("abcd@v2"), "line one\nline 1.5\n", 100);
    let dir = f.parent().unwrap().to_string_lossy().replace('\\', "\\\\");
    let snap = |name: &str, t: &str| format!("{{\"type\":\"file-history-snapshot\",\"messageId\":\"m\",\"snapshot\":{{\"trackedFileBackups\":{{\"SKILL.md\":{{\"backupFileName\":\"{name}\",\"version\":1,\"backupTime\":\"{t}\",\"realParentDir\":\"{dir}\"}}}}}}}}\n");
    let tr = format!("{}{}{{\"type\":\"user\"}}\n{}", snap("abcd@v1", "2026-10-10T10:00:00.000Z"), snap("abcd@v2", "2026-10-10T11:00:00.000Z"), "half a line");
    write(&e.claude.join("projects").join("p").join(format!("{sid}.jsonl")), &tr, 100);

    let t = vec![tracked(&f, "skill")];
    let now = 1_800_000_000_000i64;
    // Imports wait for the baseline.
    assert_eq!(import::import_backups(&e.store, &e.claude, &cj, now).unwrap(), 0);
    scan::scan(&e.store, &t, Some(&cj), now).unwrap();
    let a = import::import_backups(&e.store, &e.claude, &cj, now).unwrap();
    let b = import::import_file_history(&e.store, &e.claude, &e.claude.join("projects"), &t, now).unwrap();
    assert_eq!(a, 1, "the empty-servers backup differs; the two identical ones collapse");
    assert_eq!(b, 2);
    // A second pass finds everything already stored.
    assert_eq!(import::import_backups(&e.store, &e.claude, &cj, now).unwrap(), 0);
    assert_eq!(import::import_file_history(&e.store, &e.claude, &e.claude.join("projects"), &t, now).unwrap(), 0);

    let it = query::item(&e.store, &file_key(&f)).unwrap().unwrap();
    assert_eq!(it.versions.iter().filter(|v| v.source == "claude_edit").count(), 2);
    let ev = all_events(&e.store).into_iter().filter(|x| x.source == "claude_edit").collect::<Vec<_>>();
    assert_eq!(ev.len(), 1, "the first copy has nothing before it to differ from: {ev:?}");
    assert_eq!(ev[0].kind, "changed");
}

#[test]
fn pruning_keeps_the_newest_and_the_first() {
    let e = env();
    let a = e.claude.join("CLAUDE.md");
    let mut now = 1_800_000_000_000i64;
    for i in 0..8 {
        write(&a, &format!("version {i}\n"), 10_000 - i * 100);
        scan::scan(&e.store, &[tracked(&a, "instructions")], None, now).unwrap();
        now += 1000;
    }
    let (dropped, freed) = scan::prune(&e.store, 3).unwrap();
    assert_eq!(dropped, 4, "8 versions, keep 3 newest plus the first");
    assert!(freed > 0);
    let it = query::item(&e.store, &file_key(&a)).unwrap().unwrap();
    assert_eq!(it.versions.len(), 4);
    assert!(it.versions.iter().all(|v| v.has_copy));
    // The events survive.
    assert_eq!(all_events(&e.store).len(), 8);
}

#[test]
fn nothing_in_the_watched_folder_is_written() {
    let e = env();
    let a = e.claude.join("settings.json");
    write(&a, "{\"a\":1}\n", 100);
    let cj = e.claude.join(".claude.json");
    write(&cj, "{\"mcpServers\":{\"a\":{\"command\":\"x\"}}}", 100);
    write(&e.claude.join("backups").join(".claude.json.backup.1790000000000"), "{\"mcpServers\":{}}", 100);
    fn snap(p: &Path, out: &mut Vec<(PathBuf, Vec<u8>, SystemTime)>) {
        for en in fs::read_dir(p).unwrap().flatten() {
            let q = en.path();
            if q.is_dir() { snap(&q, out) } else { out.push((q.clone(), fs::read(&q).unwrap(), fs::metadata(&q).unwrap().modified().unwrap())) }
        }
    }
    let mut before = Vec::new();
    snap(&e.claude, &mut before);
    let t = vec![tracked(&a, "settings")];
    scan::scan(&e.store, &t, Some(&cj), 1_800_000_000_000).unwrap();
    import::import_backups(&e.store, &e.claude, &cj, 1_800_000_000_000).unwrap();
    import::import_file_history(&e.store, &e.claude, &e.claude.join("projects"), &t, 1_800_000_000_000).unwrap();
    let mut after = Vec::new();
    snap(&e.claude, &mut after);
    assert_eq!(before, after);
}

#[test]
fn filters_and_cursor_page_through_events() {
    let e = env();
    let mut ts = Vec::new();
    for i in 0..5 {
        let p = e.claude.join("skills").join(format!("s{i}")).join("SKILL.md");
        write(&p, &format!("s{i}\n"), 1000 + i);
        ts.push(tracked(&p, "skill"));
    }
    let h = e.claude.join("settings.json");
    write(&h, "{}\n", 1000);
    ts.push(tracked(&h, "settings"));
    scan::scan(&e.store, &ts, None, 1_800_000_000_000).unwrap();
    let page = query::events(&e.store, &EventFilter { groups: vec!["skills".into()], limit: 2, ..Default::default() }).unwrap();
    assert_eq!(page.events.len(), 2);
    assert!(page.next.is_some());
    let page2 = query::events(&e.store, &EventFilter { groups: vec!["skills".into()], limit: 10, cursor: page.next.clone(), ..Default::default() }).unwrap();
    assert_eq!(page2.events.len(), 3);
    assert!(page2.next.is_none());
    let none = query::events(&e.store, &EventFilter { groups: vec!["hooks".into()], limit: 10, ..Default::default() }).unwrap();
    assert!(none.events.is_empty());
    let other = query::events(&e.store, &EventFilter { groups: vec!["settings".into()], limit: 10, ..Default::default() }).unwrap();
    assert_eq!(other.events.len(), 1);
    let text = query::events(&e.store, &EventFilter { text: Some("s3".into()), limit: 10, ..Default::default() }).unwrap();
    assert_eq!(text.events.len(), 1);
    let ov = query::overview(&e.store, 1_800_000_000_000, 0, 50).unwrap();
    assert_eq!((ov.items, ov.versions), (6, 6));
    assert_eq!(ov.days.len(), 30);
}
