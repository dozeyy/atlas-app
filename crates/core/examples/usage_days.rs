//! Prints what the usage charts plot, per local day, from a real projects folder.
//!
//! cargo run -p atlas-core --release --example usage_days -- --projects <dir> --data <scratch> [--days 14]
//!
//! `--projects` is only read; the cache lives in `--data`. Prints numbers only, no text.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use atlas_core::usage::query::TimelineArgs;
use atlas_core::usage::time::Tz;
use atlas_core::usage::{Event, EventSink, UsageConfig, UsageEngine};

struct Quiet;
impl EventSink for Quiet {
    fn emit(&self, _: Event) {}
    fn log(&self, _: &str) {}
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let get = |k: &str| args.iter().position(|a| a == k).and_then(|i| args.get(i + 1)).cloned();
    let projects = PathBuf::from(get("--projects").expect("--projects <dir>"));
    let data = PathBuf::from(get("--data").expect("--data <scratch dir>"));
    let days: i64 = get("--days").and_then(|d| d.parse().ok()).unwrap_or(14);
    assert!(!atlas_core::usage::is_inside(&data, &projects), "--data must not be inside --projects");
    std::fs::create_dir_all(&data).unwrap();

    let config_dir = projects.parent().unwrap_or(&projects).to_path_buf();
    let mut c = UsageConfig::new(projects, config_dir, data.clone(), data.join("cache.sqlite"));
    c.tz = Tz::Local;
    c.watch = false;
    let e = UsageEngine::start(c, Arc::new(Quiet));
    assert!(e.wait_pass(0, Duration::from_secs(1800)), "index did not finish: {:?}", e.status());

    let d = e.dashboard().unwrap();
    let today = d.today_date.clone();
    let from = atlas_core::usage::time::add_days(&today, -(days - 1));
    let t = e.timeline(&TimelineArgs { from, to: today.clone(), bucket: "day".into(), group_by: None }).unwrap();
    println!("today_date {today}");
    for p in &t.points {
        let wd = chrono::NaiveDate::parse_from_str(&p.start, "%Y-%m-%d").map(|d| d.format("%a").to_string()).unwrap_or_default();
        println!("{} {wd} headline {:>14} reads {:>16} sessions {}", p.start, p.tokens.total, p.tokens.cache_read, p.sessions);
    }
    println!("dashboard today {} week {} month {}", d.today.tokens.total, d.week.tokens.total, d.month.tokens.total);
    println!("tray today {}", e.today().unwrap().tokens.total);
    e.stop();
}
