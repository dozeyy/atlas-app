//! Acceptance 23: the live price file.

mod common;

use std::fs;
use std::sync::{Arc, Mutex};

use atlas_core::cache::pricing_file;
use atlas_core::usage::pricing::PriceTable;
use atlas_core::usage::time::Tz;
use atlas_core::usage::{Event, EventSink, UsageEngine};
use common::*;

#[derive(Default)]
struct Capture(Mutex<Vec<String>>);
impl EventSink for Capture {
    fn emit(&self, e: Event) {
        if let Event::Pricing(p) = e {
            self.0.lock().unwrap().push(format!("pricing error={:?}", p.error));
        }
    }
    fn log(&self, _: &str) {}
}

fn seed_json() -> String {
    include_str!("../pricing/pricing.default.json").to_string()
}

fn with_updated(json: &str, updated: &str) -> String {
    let mut v: serde_json::Value = serde_json::from_str(json).unwrap();
    v["updated"] = updated.into();
    serde_json::to_string_pretty(&v).unwrap()
}

#[test]
fn the_seed_is_copied_on_first_run() {
    let data = tempfile::tempdir().unwrap();
    let l = pricing_file::init(data.path(), None);
    assert!(l.error.is_none());
    let live = pricing_file::live_path(data.path());
    assert_eq!(fs::read_to_string(&live).unwrap(), seed_json());
    assert_eq!(l.table, PriceTable::seed());
}

#[test]
fn every_seed_model_has_a_source_and_the_file_has_updated() {
    let t = PriceTable::seed();
    assert!(!t.updated.is_empty());
    for (id, m) in &t.models {
        assert!(!m.source.is_empty(), "{id}");
    }
}

#[test]
fn d21_an_unedited_live_file_is_upgraded_to_a_newer_seed() {
    let data = tempfile::tempdir().unwrap();
    let old = with_updated(&seed_json(), "2026-01-01");
    pricing_file::init_with_seed(data.path(), &old, None);
    let l = pricing_file::init_with_seed(data.path(), &seed_json(), None);
    assert!(!l.newer_seed_available);
    assert_eq!(l.table.updated, PriceTable::seed().updated);
    assert_eq!(fs::read_to_string(pricing_file::live_path(data.path())).unwrap(), seed_json());
}

#[test]
fn d21_an_edited_live_file_is_kept_and_a_newer_seed_is_offered() {
    let data = tempfile::tempdir().unwrap();
    let old = with_updated(&seed_json(), "2026-01-01");
    pricing_file::init_with_seed(data.path(), &old, None);
    let live = pricing_file::live_path(data.path());
    let edited = old.replace("\"updated\": \"2026-01-01\"", "\"updated\": \"2026-01-01\" ").replace("\"input\": 2,", "\"input\": 2.5,");
    assert_ne!(edited, old);
    fs::write(&live, &edited).unwrap();
    let l = pricing_file::init_with_seed(data.path(), &seed_json(), None);
    assert!(l.newer_seed_available);
    assert_eq!(fs::read_to_string(&live).unwrap(), edited, "the user's edit must survive");
}

#[test]
fn editing_a_price_reprices_with_zero_transcript_bytes_and_emits() {
    let config = tempfile::tempdir().unwrap();
    copy_tree(&fixture("claude-basic"), config.path());
    let data = tempfile::tempdir().unwrap();
    let cfg = config_for(config.path(), data.path(), Tz::Fixed(0));
    let sink = Arc::new(Capture::default());
    let engine = UsageEngine::start(cfg, sink.clone());
    assert!(engine.wait_pass(0, WAIT));
    let before = engine.dashboard().unwrap().month.cost.usd.unwrap();
    let bytes = engine.bytes_read();
    assert!(bytes > 0);

    let live = pricing_file::live_path(data.path());
    let mut v: serde_json::Value = serde_json::from_str(&fs::read_to_string(&live).unwrap()).unwrap();
    for m in v["models"].as_object_mut().unwrap().values_mut() {
        for k in ["input", "output"] {
            if let Some(x) = m[k].as_f64() {
                m[k] = (x * 2.0).into();
            }
        }
    }
    fs::write(&live, serde_json::to_string_pretty(&v).unwrap()).unwrap();
    engine.reload_pricing();

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    let mut after = before;
    while std::time::Instant::now() < deadline {
        after = engine.dashboard().unwrap().month.cost.usd.unwrap();
        if (after - before).abs() > 1e-12 {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    assert!(after > before, "{before} -> {after}");
    assert_eq!(engine.bytes_read(), bytes, "a price edit must not read any transcript bytes");
    assert!(sink.0.lock().unwrap().iter().any(|l| l == "pricing error=None"), "{:?}", sink.0.lock().unwrap());

    // Invalid JSON keeps the last good table and reports why.
    fs::write(&live, "{ not json").unwrap();
    engine.reload_pricing();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    while std::time::Instant::now() < deadline && engine.pricing_info().error.is_none() {
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    assert!(engine.pricing_info().error.is_some());
    let kept = engine.dashboard().unwrap().month.cost.usd.unwrap();
    assert!((kept - after).abs() < 1e-12, "last good table stays in force");
    assert_eq!(engine.bytes_read(), bytes);
}
