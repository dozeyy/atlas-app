//! The Phase 2 performance harness: `cargo run --release -p atlas-core --example usage_bench`.
//!
//! ```text
//! --projects <dir>   a real Claude projects folder (read-only: listed before and after)
//! --data <dir>       scratch folder for caches and generated files (must not be inside --projects)
//! --runs <n>         repeat the full index and the no-change rescan (default 3)
//! --gen-huge         index a generated 300 MB single file
//! --synth <n>        index <n> generated messages, then time the queries (default 0 = skip)
//! --append-test      append <= 64 KB to a generated file and time append -> changed event
//! --out <file>       also write the markdown report here
//! ```
//! Nothing in `--projects` is ever opened for writing. Message text never enters the
//! output: only counts, sizes and times.

#[path = "../tests/common/synth.rs"]
mod synth;

use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use atlas_core::usage::query::{SessionQuery, TimelineArgs};
use atlas_core::usage::time::Tz;
use atlas_core::usage::{Event, EventSink, UsageConfig, UsageEngine};

const WAIT: Duration = Duration::from_secs(1800);
const MIB: f64 = 1024.0 * 1024.0;

// ---------------------------------------------------------------- memory

#[cfg(windows)]
fn peak_working_set() -> u64 {
    #[repr(C)]
    struct Pmc {
        cb: u32,
        page_faults: u32,
        peak_ws: usize,
        ws: usize,
        a: usize,
        b: usize,
        c: usize,
        d: usize,
        e: usize,
        f: usize,
    }
    unsafe extern "system" {
        fn GetCurrentProcess() -> isize;
        fn K32GetProcessMemoryInfo(h: isize, p: *mut Pmc, cb: u32) -> i32;
    }
    let mut p = Pmc { cb: std::mem::size_of::<Pmc>() as u32, page_faults: 0, peak_ws: 0, ws: 0, a: 0, b: 0, c: 0, d: 0, e: 0, f: 0 };
    // SAFETY: plain FFI into kernel32 with a correctly sized, initialised struct.
    unsafe {
        if K32GetProcessMemoryInfo(GetCurrentProcess(), &mut p, p.cb) == 0 {
            return 0;
        }
    }
    p.peak_ws as u64
}

#[cfg(not(windows))]
fn peak_working_set() -> u64 {
    fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|s| s.lines().find(|l| l.starts_with("VmHWM:")).and_then(|l| l.split_whitespace().nth(1)?.parse::<u64>().ok()))
        .map(|kb| kb * 1024)
        .unwrap_or(0)
}

// ---------------------------------------------------------------- listing

type Listing = BTreeMap<String, (u64, u128)>;

fn list(root: &Path) -> Listing {
    fn walk(dir: &Path, base: &Path, out: &mut Listing) {
        let Ok(rd) = fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let p = e.path();
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_dir() {
                walk(&p, base, out);
            } else if let Ok(m) = e.metadata() {
                let mt = m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_nanos()).unwrap_or(0);
                out.insert(p.strip_prefix(base).unwrap_or(&p).to_string_lossy().replace('\\', "/"), (m.len(), mt));
            }
        }
    }
    let mut o = Listing::new();
    walk(root, root, &mut o);
    o
}

struct Diff {
    grew: usize,
    added: usize,
    removed: usize,
    touched_same_size: usize,
    shrank: usize,
}

fn diff(before: &Listing, after: &Listing) -> Diff {
    let mut d = Diff { grew: 0, added: 0, removed: 0, touched_same_size: 0, shrank: 0 };
    for (k, (sz, mt)) in before {
        match after.get(k) {
            None => d.removed += 1,
            Some((s2, m2)) if s2 > sz => {
                let _ = m2;
                d.grew += 1;
            }
            Some((s2, _)) if s2 < sz => d.shrank += 1,
            Some((_, m2)) if m2 != mt => d.touched_same_size += 1,
            _ => {}
        }
    }
    d.added = after.keys().filter(|k| !before.contains_key(*k)).count();
    d
}

// ---------------------------------------------------------------- engine helpers

#[derive(Default)]
struct Rec {
    changed: Mutex<Vec<Instant>>,
    cv: Condvar,
}
impl EventSink for Rec {
    fn emit(&self, e: Event) {
        if let Event::Changed(_) = e {
            self.changed.lock().unwrap().push(Instant::now());
            self.cv.notify_all();
        }
    }
    fn log(&self, _: &str) {}
}

fn cfg(projects: &Path, data: &Path, now_ms: Option<i64>, watch: bool) -> UsageConfig {
    let config_dir = projects.parent().unwrap_or(projects).to_path_buf();
    let mut c = UsageConfig::new(projects.to_path_buf(), config_dir, data.to_path_buf(), data.join("cache.sqlite"));
    c.tz = Tz::Local;
    c.watch = watch;
    c.now_override_ms = now_ms;
    c
}

fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

fn median(v: &mut [f64]) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[v.len() / 2]
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64
}

// ---------------------------------------------------------------- report

struct Row {
    metric: String,
    budget: String,
    measured: String,
    verdict: &'static str,
}

struct Report {
    rows: Vec<Row>,
    notes: Vec<String>,
}

impl Report {
    fn row(&mut self, metric: &str, budget: &str, measured: String, verdict: &'static str) {
        println!("{verdict:12} {metric}: {measured} (budget {budget})");
        self.rows.push(Row { metric: metric.into(), budget: budget.into(), measured, verdict });
    }
    fn le(&mut self, metric: &str, budget: &str, limit: f64, value: f64, shown: String) {
        self.row(metric, budget, shown, if value <= limit { "PASS" } else { "FAIL" });
    }
    fn note(&mut self, s: String) {
        println!("  note: {s}");
        self.notes.push(s);
    }
    fn markdown(&self, title: &str) -> String {
        let mut s = format!("# {title}\n\n| Metric | Budget | Measured | Result |\n|---|---|---|---|\n");
        for r in &self.rows {
            s.push_str(&format!("| {} | {} | {} | {} |\n", r.metric, r.budget, r.measured, r.verdict));
        }
        if !self.notes.is_empty() {
            s.push_str("\n## Notes\n\n");
            for n in &self.notes {
                s.push_str(&format!("- {n}\n"));
            }
        }
        s
    }
}

// ---------------------------------------------------------------- phases

fn index_once(projects: &Path, data: &Path, now: Option<i64>) -> (Arc<UsageEngine>, Duration) {
    let t = Instant::now();
    let e = UsageEngine::start(cfg(projects, data, now, false), Arc::new(Rec::default()));
    assert!(e.wait_pass(0, WAIT), "index did not finish: {:?}", e.status());
    (e, t.elapsed())
}

fn query_rows(rep: &mut Report, label: &str, engine: &UsageEngine, cache: &Path, now: i64) {
    let ro = rusqlite::Connection::open_with_flags(cache, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let today = synth::iso(now)[..10].to_string();
    let year_ago = synth::iso(now - 364 * 86_400_000)[..10].to_string();
    let runs = 20;

    let time = |name: &str, f: &mut dyn FnMut()| -> (f64, f64) {
        f(); // warm-up: opens the read connection and fills the page cache
        let mut v = Vec::new();
        for _ in 0..runs {
            let t = Instant::now();
            f();
            v.push(ms(t.elapsed()));
        }
        let max = v.iter().cloned().fold(0.0, f64::max);
        let med = median(&mut v);
        println!("  {label} {name}: median {med:.1} ms, max {max:.1} ms");
        (med, max)
    };

    let (med, max) = time("dashboard", &mut || {
        engine.dashboard().unwrap();
    });
    rep.le(&format!("usage_dashboard ({label})"), "<= 50 ms", 50.0, max, format!("median {med:.1} ms, max {max:.1} ms"));

    for group in [None, Some("model")] {
        let a = TimelineArgs { from: year_ago.clone(), to: today.clone(), bucket: "day".into(), group_by: group.map(str::to_string) };
        let (med, max) = time("timeline", &mut || {
            engine.timeline(&a).unwrap();
        });
        let name = format!("usage_timeline 365 d x day{} ({label})", group.map(|g| format!(", by {g}")).unwrap_or_default());
        rep.le(&name, "<= 50 ms", 50.0, max, format!("median {med:.1} ms, max {max:.1} ms"));
    }

    let mut worst: (f64, f64, String) = (0.0, 0.0, String::new());
    for sort in ["started", "cost", "tokens", "duration"] {
        for dir in ["desc", "asc"] {
            let q = SessionQuery { sort: sort.into(), dir: dir.into(), limit: 50, include_missing: true, ..Default::default() };
            let (med, max) = time(&format!("sessions {sort} {dir}"), &mut || {
                let p = engine.sessions_list(&q).unwrap();
                assert!(!p.rows.is_empty());
            });
            if max > worst.1 {
                worst = (med, max, format!("{sort} {dir}"));
            }
        }
    }
    rep.le(
        &format!("sessions_list page of 50, worst of 4 sorts x 2 dirs ({label})"),
        "<= 50 ms",
        50.0,
        worst.1,
        format!("worst = {} (median {:.1} ms, max {:.1} ms)", worst.2, worst.0, worst.1),
    );

    let id: String = ro.query_row("SELECT session_id FROM sessions ORDER BY messages DESC LIMIT 1", [], |r| r.get(0)).unwrap();
    let n: i64 = ro.query_row("SELECT messages FROM sessions WHERE session_id=?1", [&id], |r| r.get(0)).unwrap();
    let (med, max) = time("session_detail", &mut || {
        engine.session_detail(&id).unwrap().unwrap();
    });
    rep.le(&format!("session_detail, largest session ({n} messages) ({label})"), "<= 100 ms", 100.0, max, format!("median {med:.1} ms, max {max:.1} ms"));
}

fn cost_state_report(rep: &mut Report, engine: &UsageEngine, cache: &Path) {
    let ro = rusqlite::Connection::open_with_flags(cache, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let ids: Vec<(String, f64)> = ro
        .prepare("SELECT session_id, cc_cost_usd FROM sessions WHERE cc_cost_usd IS NOT NULL AND cc_cost_usd > 0")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    let mut devs = Vec::new();
    let (mut incomplete, mut signed_sum) = (0usize, 0.0);
    for (id, cc) in &ids {
        let Some(d) = engine.session_detail(id).unwrap() else { continue };
        let Some(est) = d.row.cost.usd else { continue };
        if !d.row.cost.complete {
            incomplete += 1;
        }
        let dev = (est - cc) / cc;
        signed_sum += dev;
        devs.push(dev.abs());
    }
    if devs.is_empty() {
        rep.note("estimate vs Claude Code: no session carries a cost-state line".into());
        return;
    }
    let n = devs.len();
    let max = devs.iter().cloned().fold(0.0, f64::max);
    let mean_signed = signed_sum / n as f64;
    let within2 = devs.iter().filter(|d| **d <= 0.02).count();
    let med = median(&mut devs);
    rep.note(format!(
        "estimate vs Claude Code cost-state, {n} sessions ({incomplete} with unpriced tokens): median deviation {:.2} %, max {:.2} %, mean signed {:+.2} %, {within2} within 2 % (report only, no threshold)",
        med * 100.0,
        max * 100.0,
        mean_signed * 100.0
    ));
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let get = |k: &str| args.iter().position(|a| a == k).and_then(|i| args.get(i + 1)).cloned();
    let has = |k: &str| args.iter().any(|a| a == k);
    let projects = get("--projects").map(PathBuf::from);
    let data_root = get("--data").map(PathBuf::from).unwrap_or_else(|| std::env::temp_dir().join("atlas-usage-bench"));
    let runs: usize = get("--runs").and_then(|s| s.parse().ok()).unwrap_or(3);
    let synth_n: u64 = get("--synth").and_then(|s| s.parse().ok()).unwrap_or(0);
    let out = get("--out").map(PathBuf::from);
    if let Some(p) = &projects {
        assert!(!data_root.starts_with(p) && !data_root.starts_with(p.parent().unwrap_or(p)), "--data must be outside the Claude folder");
    }
    fs::create_dir_all(&data_root).unwrap();
    let mut rep = Report { rows: Vec::new(), notes: Vec::new() };
    println!("usage_bench: {} cores, data {}", std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0), data_root.display());

    // ---- memory baseline: a 1 MiB file, then a 300 MB file, in this order (the peak only rises).
    let mut huge_ok = None;
    if has("--gen-huge") {
        let base = data_root.join("huge");
        let _ = fs::remove_dir_all(&base);
        let small = base.join("small").join("projects").join("-p");
        let big = base.join("big").join("projects").join("-p");
        fs::create_dir_all(&small).unwrap();
        fs::create_dir_all(&big).unwrap();
        let s1 = synth::session_id(1);
        synth::big_file(&small.join(format!("{s1}.jsonl")), 1_000_000, &s1, "/synth/small", 1_793_700_000_000).unwrap();
        let (e, _) = index_once(&base.join("small").join("projects"), &base.join("small-data"), None);
        e.stop();
        let peak_small = peak_working_set();
        let s2 = synth::session_id(2);
        let t = Instant::now();
        let made = synth::big_file(&big.join(format!("{s2}.jsonl")), 300_000_000, &s2, "/synth/big", 1_793_700_000_000).unwrap();
        println!("  generated {:.0} MB, {} messages in {:.1} s", made.bytes as f64 / 1e6, made.messages, t.elapsed().as_secs_f64());
        let mut times = Vec::new();
        for i in 0..runs.max(1) {
            let d = base.join(format!("big-data-{i}"));
            let (e, took) = index_once(&base.join("big").join("projects"), &d, None);
            let n: i64 = rusqlite::Connection::open(d.join("cache.sqlite")).unwrap().query_row("SELECT COUNT(*) FROM messages", [], |r| r.get(0)).unwrap();
            assert_eq!(n as u64, made.messages, "message count");
            e.stop();
            times.push(ms(took));
        }
        let peak_big = peak_working_set();
        let med = median(&mut times.clone());
        rep.le(
            "Synthetic 300 MB single file, full parse",
            "<= 6 s",
            6000.0,
            med,
            format!("{:.0} MB, {} messages: {} ms (median of {}; all: {})", made.bytes as f64 / 1e6, made.messages, med.round(), times.len(), times.iter().map(|t| format!("{t:.0}")).collect::<Vec<_>>().join(", ")),
        );
        let delta = peak_big.saturating_sub(peak_small) as f64 / MIB;
        rep.le(
            "A 300 MB file adds <= 32 MB peak working set over a 1 MB file",
            "<= 32 MB",
            32.0,
            delta,
            format!("1 MB file peak {:.0} MB; 300 MB file peak {:.0} MB; delta {:.1} MB", peak_small as f64 / MIB, peak_big as f64 / MIB, delta),
        );
        huge_ok = Some(base);
    }

    // ---- append -> changed, on a generated tree (never on --projects)
    if has("--append-test") {
        let base = data_root.join("append");
        let _ = fs::remove_dir_all(&base);
        let proj = base.join("cfg").join("projects");
        let dir = proj.join("-p");
        fs::create_dir_all(&dir).unwrap();
        let sid = synth::session_id(7);
        let file = dir.join(format!("{sid}.jsonl"));
        synth::big_file(&file, 20_000_000, &sid, "/synth/app", 1_793_700_000_000).unwrap();
        synth::many_files(&proj, 20_000, 40, 8, 1_793_700_000_000, 100).unwrap();
        let rec = Arc::new(Rec::default());
        let c = cfg(&proj, &base.join("data"), None, true);
        let debounce = c.debounce;
        let engine = UsageEngine::start(c, rec.clone());
        assert!(engine.wait_pass(0, WAIT));
        assert_eq!(engine.status().state, atlas_core::usage::State::Idle, "{:?}", engine.status());
        std::thread::sleep(Duration::from_millis(2500)); // quiet: the changed throttle is idle
        let mut totals = Vec::new();
        let mut work = Vec::new();
        for i in 0..5u64 {
            rec.changed.lock().unwrap().clear();
            let mut buf = Vec::new();
            let mut bytes = 0;
            let mut k = 0u64;
            while bytes < 60_000 {
                let before = buf.len();
                synth::assistant(&mut buf, &sid, "/synth/app", &format!("app{i}-{k}"), now_ms(), "claude-sonnet-5-5", 10, 5, 0, 0, 600);
                bytes += buf.len() - before;
                k += 1;
            }
            let t0 = Instant::now();
            let mut f = OpenOptions::new().append(true).open(&file).unwrap();
            f.write_all(&buf).unwrap();
            drop(f);
            let seen = {
                let g = rec.changed.lock().unwrap();
                let (g, _) = rec.cv.wait_timeout_while(g, Duration::from_secs(10), |v| v.is_empty()).unwrap();
                g.first().copied()
            };
            let Some(t1) = seen else {
                rep.row("Append of <= 64 KB -> changed event", "<= 1.0 s", "no event within 10 s".into(), "FAIL");
                continue;
            };
            let total = ms(t1 - t0);
            totals.push(total);
            work.push((total - ms(debounce)).max(0.0));
            std::thread::sleep(Duration::from_millis(1500));
        }
        if !totals.is_empty() {
            let mx = totals.iter().cloned().fold(0.0, f64::max);
            let wmx = work.iter().cloned().fold(0.0, f64::max);
            let list = totals.iter().map(|t| format!("{t:.0}")).collect::<Vec<_>>().join(", ");
            rep.le("Append on disk -> `changed` event", "<= 1000 ms", 1000.0, mx, format!("{list} ms over {} appends of ~60 KB (500 ms debounce included)", totals.len()));
            rep.le("One append of <= 64 KB -> DB commit, after the debounce", "<= 50 ms", 50.0, wmx, format!("worst {wmx:.0} ms past the debounce (event latency + parse + commit + aggregates)"));
        }
        engine.stop();
    }

    // ---- 1M-message cache: build it with the real pipeline, then time the queries
    if synth_n > 0 {
        let base = data_root.join("synth");
        let _ = fs::remove_dir_all(&base);
        let proj = base.join("cfg").join("projects");
        let now = now_ms();
        let t = Instant::now();
        let mut made = synth::many_files(&proj, synth_n - synth_n / 50, 5000, 40, now, 1000).unwrap();
        made.add(synth::many_files(&proj, synth_n / 50, 1, 1, now, 1).unwrap());
        println!("  generated {} messages, {:.0} MB in {:.1} s", made.messages, made.bytes as f64 / 1e6, t.elapsed().as_secs_f64());
        let data = base.join("data");
        let (engine, took) = index_once(&proj, &data, Some(now));
        let cache = data.join("cache.sqlite");
        let n: i64 = rusqlite::Connection::open(&cache).unwrap().query_row("SELECT COUNT(*) FROM messages", [], |r| r.get(0)).unwrap();
        assert_eq!(n as u64, made.messages);
        rep.note(format!("synthetic cache: {} messages, 5001 sessions, indexed in {:.1} s, cache file {:.0} MB", n, took.as_secs_f64(), fs::metadata(&cache).map(|m| m.len()).unwrap_or(0) as f64 / 1e6));
        let c = cfg(&proj, &data, Some(now), false);
        engine.stop();
        // Re-open as a quiet engine so the queries run against a settled cache.
        let engine = UsageEngine::start(c, Arc::new(Rec::default()));
        assert!(engine.wait_pass(0, WAIT));
        query_rows(&mut rep, "1M synthetic", &engine, &cache, now);
        engine.stop();
        let _ = fs::remove_dir_all(&base);
    }

    // ---- the real folder, read-only
    if let Some(proj) = &projects {
        let before = list(proj);
        let bytes: u64 = before.values().map(|v| v.0).sum();
        println!("  real projects: {} files, {:.2} GB", before.len(), bytes as f64 / 1e9);
        let started_at = now_ms();
        let mut full = Vec::new();
        let mut keep: Option<(Arc<UsageEngine>, PathBuf)> = None;
        for i in 0..runs.max(1) {
            let d = data_root.join(format!("real-{i}"));
            let _ = fs::remove_dir_all(&d);
            let (e, took) = index_once(proj, &d, None);
            let s = e.status();
            println!("  run {i}: {:.2} s, {:?}, {} files tracked, {} malformed, {} long lines", took.as_secs_f64(), s.state, s.files_tracked, s.malformed_lines, s.long_lines);
            full.push(ms(took));
            if i + 1 == runs.max(1) {
                keep = Some((e, d.join("cache.sqlite")));
            } else {
                e.stop();
            }
        }
        let med = median(&mut full.clone());
        let msgs = {
            let (_, c) = keep.as_ref().unwrap();
            rusqlite::Connection::open(c).unwrap().query_row::<i64, _, _>("SELECT COUNT(*) FROM messages", [], |r| r.get(0)).unwrap()
        };
        rep.le(
            "First full index, OS cache warm",
            "<= 30 s",
            30_000.0,
            med,
            format!("median {:.1} s of {} (all: {}) over {} files / {:.2} GB, {} messages", med / 1000.0, full.len(), full.iter().map(|t| format!("{:.1} s", t / 1000.0)).collect::<Vec<_>>().join(", "), before.len(), bytes as f64 / 1e9, msgs),
            );
        rep.row("First full index, cold cache", "<= 90 s", "not measured: the OS file cache cannot be flushed without a reboot or an elevated tool".into(), "NOT MEASURED");
        let peak = peak_working_set() as f64 / MIB;
        rep.le("Indexer peak working set during a full index", "<= 250 MB", 250.0, peak, format!("{peak:.0} MB (whole process, after {} full indexes)", full.len()));

        let (engine, cache) = keep.unwrap();
        // no-change rescan
        // The real folder may belong to a running Claude Code that appends while we measure.
        // One settling pass catches up with the indexing time; then the bytes the rescans
        // read are compared with how much the files actually grew during the window.
        {
            let n = engine.passes();
            engine.reindex(false);
            assert!(engine.wait_pass(n, WAIT));
        }
        let mut re = Vec::new();
        let win_before = list(proj);
        let read0 = engine.bytes_read();
        for _ in 0..(runs.max(3) * 2) {
            let n = engine.passes();
            let t = Instant::now();
            engine.reindex(false);
            assert!(engine.wait_pass(n, WAIT));
            re.push(ms(t.elapsed()));
        }
        let reread = engine.bytes_read() - read0;
        let win_after = list(proj);
        let grown: u64 = win_after.iter().map(|(k, (sz, _))| sz.saturating_sub(win_before.get(k).map(|v| v.0).unwrap_or(0))).sum();
        let rmax = re.iter().cloned().fold(0.0, f64::max);
        let rmed = median(&mut re.clone());
        rep.le("No-change rescan (stat all files, zero bytes parsed)", "<= 300 ms", 300.0, rmax, format!("median {rmed:.0} ms, max {rmax:.0} ms over {} rescans, {reread} bytes read", re.len()));
        if grown == 0 {
            if reread != 0 {
                rep.row("No-change rescan reads zero bytes", "0", format!("{reread} bytes"), "FAIL");
            }
        } else {
            let ok = reread <= grown;
            rep.row(
                "No-change rescan reads only bytes appended during the window",
                "<= bytes the files grew",
                format!("{reread} bytes read, files grew {grown} bytes (a running Claude Code appended while measuring)"),
                if ok { "PASS" } else { "FAIL" },
            );
        }

        query_rows(&mut rep, "real data", &engine, &cache, now_ms());
        cost_state_report(&mut rep, &engine, &cache);
        let s = engine.status();
        rep.note(format!(
            "real data: {} files tracked ({} missing), {} malformed lines, {} over-cap lines, {} cross-file duplicates, {} rows with an assumed 5m cache write, unknown models: {}",
            s.files_tracked, s.files_missing, s.malformed_lines, s.long_lines, s.cross_file_dupes, s.cw_assumed_rows, s.unknown_models.len()
        ));
        engine.stop();

        // read-only proof: the listing before and after
        let after = list(proj);
        let d = diff(&before, &after);
        let clean = d.removed == 0 && d.shrank == 0 && d.touched_same_size == 0;
        let verdict = if d.grew == 0 && d.added == 0 && clean {
            "PASS"
        } else if clean {
            "PASS (live growth)"
        } else {
            "FAIL"
        };
        rep.row(
            "Read-only: size + mtime listing of --projects before and after",
            "no change",
            format!(
                "{} files listed; {} grew and {} added while the bench ran (bench started {} s before the listing ended; only appends by a running Claude Code can do this), {} removed, {} shrank, {} rewritten at the same size",
                before.len(),
                d.grew,
                d.added,
                (now_ms() - started_at) / 1000,
                d.removed,
                d.shrank,
                d.touched_same_size
            ),
            verdict,
        );
    }

    if let Some(base) = huge_ok {
        let _ = fs::remove_dir_all(base);
    }
    let md = rep.markdown(&format!("Usage engine bench, {}", &synth::iso(now_ms())[..10]));
    if let Some(o) = out {
        fs::write(&o, &md).unwrap();
        println!("wrote {}", o.display());
    }
    let fails = rep.rows.iter().filter(|r| r.verdict == "FAIL").count();
    println!("{} rows, {} FAIL", rep.rows.len(), fails);
    if fails > 0 {
        std::process::exit(1);
    }
}
