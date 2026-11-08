//! Chat-search benchmark. Reads a projects folder (read-only) and writes only to `--data`.
//!
//!   cargo run --release -p atlas-core --example search_bench -- \
//!       --projects <dir> --config <claude root> --data <scratch dir> [--queries N]
//!
//! Prints a markdown report: build time, size, no-change pass, incremental pass, and
//! query latency (p50 / p95 / max) for 1-word, 3-word and phrase queries. It prints counts
//! and timings only, never transcript text.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use atlas_core::search::{db, NullSearchSink, SearchConfig, SearchEngine};

fn arg(name: &str) -> Option<String> {
    let a: Vec<String> = std::env::args().collect();
    a.iter().position(|x| x == name).and_then(|i| a.get(i + 1)).cloned()
}

fn pct(v: &mut [f64], p: f64) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    if v.is_empty() {
        return 0.0;
    }
    v[((v.len() as f64 - 1.0) * p).round() as usize]
}

#[cfg(windows)]
fn peak_working_set_mb() -> f64 {
    use windows_sys::Win32::System::ProcessStatus::{K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
    use windows_sys::Win32::System::Threading::GetCurrentProcess;
    // SAFETY: plain out-struct of the documented size for the current process.
    unsafe {
        let mut c: PROCESS_MEMORY_COUNTERS = std::mem::zeroed();
        c.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
        if K32GetProcessMemoryInfo(GetCurrentProcess(), &mut c, c.cb) != 0 {
            return c.PeakWorkingSetSize as f64 / 1_048_576.0;
        }
    }
    0.0
}
#[cfg(not(windows))]
fn peak_working_set_mb() -> f64 {
    0.0
}

fn main() {
    let projects = PathBuf::from(arg("--projects").expect("--projects"));
    let config = PathBuf::from(arg("--config").expect("--config"));
    let data = PathBuf::from(arg("--data").expect("--data"));
    let reps: usize = arg("--queries").and_then(|v| v.parse().ok()).unwrap_or(15);
    assert!(!atlas_core::usage::is_inside(&data, &config), "--data must not be inside the Claude folder");
    assert!(!atlas_core::usage::is_inside(&data, &projects), "--data must not be inside the projects folder");
    std::fs::create_dir_all(&data).unwrap();
    let dbf = data.join("search-bench.sqlite");
    for ext in ["", "-wal", "-shm"] {
        let mut p = dbf.as_os_str().to_os_string();
        p.push(ext);
        let _ = std::fs::remove_file(PathBuf::from(p));
    }

    let mut cfg = SearchConfig::new(projects, config, dbf.clone());
    cfg.debounce = Duration::from_millis(5);
    let e = SearchEngine::start(cfg, Arc::new(NullSearchSink));

    println!("# Chat search bench\n");
    // ---- full build
    let t = Instant::now();
    e.poke();
    assert!(e.wait_pass(0, Duration::from_secs(1800)), "build did not finish");
    let build = t.elapsed();
    let s = e.status();
    println!("## Build (cold index file, OS cache as it was)");
    println!("- files planned: {}  bytes planned: {:.2} GB", s.files_total, s.bytes_total as f64 / 1e9);
    println!("- build time: {:.1} s", build.as_secs_f64());
    println!("- messages indexed: {}", s.messages);
    println!("- index size: {:.1} MB (incl. WAL)", s.db_bytes as f64 / 1_048_576.0);
    println!("- peak working set so far: {:.0} MB", peak_working_set_mb());

    // ---- no-change passes
    let mut ms: Vec<f64> = Vec::new();
    for _ in 0..7 {
        let n = e.passes();
        let t = Instant::now();
        e.poke();
        assert!(e.wait_pass(n, Duration::from_secs(60)));
        ms.push(t.elapsed().as_secs_f64() * 1000.0);
    }
    println!("\n## No-change pass (stat every file, read nothing)");
    println!("- includes the 5 ms debounce; median {:.0} ms, max {:.0} ms", pct(&mut ms.clone(), 0.5), pct(&mut ms, 1.0));

    // ---- incremental: rewind the 5 newest files by ~256 KB and re-read the tail
    e.stop();
    {
        let c = rusqlite::Connection::open(&dbf).unwrap();
        c.execute_batch(
            "UPDATE sfiles SET offset = MAX(size - 262144, 0), size = 0 \
             WHERE file_id IN (SELECT file_id FROM sfiles WHERE is_subagent=0 ORDER BY mtime_ns DESC LIMIT 5)",
        )
        .unwrap();
    }
    let mut cfg = SearchConfig::new(arg("--projects").map(PathBuf::from).unwrap(), PathBuf::from(arg("--config").unwrap()), dbf.clone());
    cfg.debounce = Duration::from_millis(5);
    let e = SearchEngine::start(cfg, Arc::new(NullSearchSink));
    let t = Instant::now();
    e.poke();
    assert!(e.wait_pass(0, Duration::from_secs(120)));
    println!("\n## Incremental pass (5 newest chats, last ~256 KB of each re-read; messages already indexed are skipped by uuid)");
    println!("- pass time: {:.0} ms (files read: {})", t.elapsed().as_secs_f64() * 1000.0, e.status().files_total);

    // ---- queries
    let sets: Vec<(&str, Vec<&str>)> = vec![
        ("1 word", vec!["build", "error", "session", "function", "config", "refactor", "install", "database", "window", "performance", "settings", "dashboard"]),
        ("3 words", vec!["fix the bug", "run the tests", "update the config", "add new feature", "why does this fail", "make it faster", "check the logs", "write a test"]),
        ("phrase", vec!["\"pull request\"", "\"unit test\"", "\"error message\"", "\"source code\"", "\"on the left\"", "\"as a user\""]),
        ("very common word (worst case)", vec!["the", "to the", "and"]),
        ("rare word", vec!["quokka", "zymurgy", "narwhalbunker"]),
    ];
    println!("\n## Query latency, limit 20, warm connection, {reps} runs per query (first run of each query excluded as warm-up)");
    println!("| class | queries | runs | p50 ms | p95 ms | max ms | avg hits/20 |");
    println!("|---|---|---|---|---|---|---|");
    let mut cold: Vec<f64> = Vec::new();
    for (name, qs) in &sets {
        let mut times: Vec<f64> = Vec::new();
        let mut hits = 0usize;
        for q in qs {
            let t = Instant::now();
            let p = e.search(q, 20, 0).unwrap();
            cold.push(t.elapsed().as_secs_f64() * 1000.0);
            hits += p.hits.len();
            for _ in 0..reps {
                let t = Instant::now();
                let _ = e.search(q, 20, 0).unwrap();
                times.push(t.elapsed().as_secs_f64() * 1000.0);
            }
        }
        println!(
            "| {name} | {} | {} | {:.1} | {:.1} | {:.1} | {:.1} |",
            qs.len(),
            times.len(),
            pct(&mut times.clone(), 0.5),
            pct(&mut times.clone(), 0.95),
            pct(&mut times, 1.0),
            hits as f64 / qs.len() as f64
        );
    }
    println!("\n- first (cold-cache) run of every query: p50 {:.1} ms, p95 {:.1} ms, max {:.1} ms", pct(&mut cold.clone(), 0.5), pct(&mut cold.clone(), 0.95), pct(&mut cold, 1.0));
    // Typing: each prefix of one word, as search-as-you-type would send.
    let mut typing: Vec<f64> = Vec::new();
    for w in ["performance", "dashboard", "refactor"] {
        for n in 1..=w.len() {
            let t = Instant::now();
            let _ = e.search(&w[..n], 20, 0).unwrap();
            typing.push(t.elapsed().as_secs_f64() * 1000.0);
        }
    }
    println!("- search-as-you-type (every prefix of 3 words, {} calls): p50 {:.1} ms, p95 {:.1} ms, max {:.1} ms", typing.len(), pct(&mut typing.clone(), 0.5), pct(&mut typing.clone(), 0.95), pct(&mut typing, 1.0));
    let _ = db::PARSER_VERSION;
    println!("- peak working set at end: {:.0} MB", peak_working_set_mb());
    e.stop();
}
