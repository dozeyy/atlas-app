//! Dev probe: the setup-cost estimate on a real machine, read only.
//! Usage: setup_cost_probe <home> <scratch-data-dir> [rows]
//! Reads `<home>/.claude` and its transcripts; writes only inside the scratch folder.
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use atlas_core::paths::{resolve_config_root, ConfigInputs};
use atlas_core::setup::cost::{estimate, sample_mcp, CostRow};
use atlas_core::setup::{discover, Cache, DiscoveryInputs};
use atlas_core::usage::time::Tz;
use atlas_core::usage::{NullSink, UsageConfig, UsageEngine};

fn usd(v: f64) -> String {
    format!("${v:.2}")
}

fn show(r: &CostRow) {
    println!(
        "{:>8}/wk  {:>6} tok x {:>6} turns  body {:>6} x {:>3} uses -> {:>7}  {:<12} {:<34} {}",
        usd(r.usd_week),
        r.tokens,
        r.turns,
        r.body_tokens,
        r.uses.map_or("-".to_string(), |u| u.to_string()),
        usd(r.usd_used),
        r.kind,
        r.name.chars().take(34).collect::<String>(),
        r.loads_in
    );
}

fn main() {
    let mut a = std::env::args().skip(1);
    let home = PathBuf::from(a.next().expect("home"));
    let data = PathBuf::from(a.next().expect("data dir"));
    let top: usize = a.next().and_then(|s| s.parse().ok()).unwrap_or(25);
    std::fs::create_dir_all(&data).unwrap();

    let root = resolve_config_root(&ConfigInputs { flag: None, settings_override: None, env: None, home: &home, cwd: &home });
    let t = Instant::now();
    let d = discover(
        &DiscoveryInputs { root: root.clone(), home: home.clone(), managed_dir: None, include_worktrees: false, sandboxed: false },
        &mut Cache::default(),
    );
    println!("discovery: {} items, {} projects, {} ms", d.snapshot.items.len(), d.snapshot.projects.len(), t.elapsed().as_millis());

    let t = Instant::now();
    let mut c = UsageConfig::new(root.projects_dir.clone(), root.dir.clone(), data.clone(), data.join("cache.sqlite"));
    c.tz = Tz::Local;
    let engine = UsageEngine::start(c, Arc::new(NullSink));
    assert!(engine.wait_pass(0, Duration::from_secs(900)), "index did not finish");
    println!("index: {} ms", t.elapsed().as_millis());

    let t = Instant::now();
    let mix = engine.cost_mix(7).expect("cost mix");
    println!(
        "mix: {} groups, {} turns, {} unpriced, avg turns main {:.1} helper {:.1}, {} samples, {} ms",
        mix.groups.len(),
        mix.total_turns(),
        mix.unpriced_turns,
        mix.avg_turns_main,
        mix.avg_turns_helper,
        mix.samples.len(),
        t.elapsed().as_millis()
    );
    for (m, p) in &mix.prices {
        println!("  price {m}: read {:.3} write {:.3} per MTok", p.read, p.write);
    }
    let starts: u64 = mix.groups.iter().map(|g| g.starts).sum();
    println!("  starts {starts} of {} turns", mix.total_turns());

    let t = Instant::now();
    let mcp = sample_mcp(&mix.samples);
    println!("mcp sample: {} transcripts, {} ms", mcp.projects.len(), t.elapsed().as_millis());
    let t = Instant::now();
    let rep = estimate(&d, &mix, &mcp);
    println!("estimate: {} rows, {} ms; {} turns, global {} tok/turn, total {}/wk, incomplete {}", rep.rows.len(), t.elapsed().as_millis(), rep.turns, rep.global_tokens, usd(rep.usd_week), rep.incomplete);

    println!("--- top {top}");
    for r in rep.rows.iter().take(top) {
        show(r);
    }
    let mut by: std::collections::BTreeMap<&str, (f64, u64)> = Default::default();
    for r in &rep.rows {
        let e = by.entry(r.kind.as_str()).or_default();
        e.0 += r.usd_week;
        e.1 += 1;
    }
    println!("--- by kind");
    for (k, (v, n)) in by {
        println!("{k:<14} {n:>4} rows {:>9}/wk", usd(v));
    }
}
