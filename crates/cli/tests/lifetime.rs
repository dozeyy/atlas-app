//! The app's "All time" row and the CLI's `all` scope are one number: the real `atlas-usage all
//! --json` program against `fixtures/claude-usage` (dedup, helpers, several models, midnight edges),
//! compared with the engine's `lifetime()` that the Dashboard asks for. Read-only, scratch caches.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;

use atlas_core::usage::{NullSink, UsageConfig, UsageEngine};
use serde_json::Value;

fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("fixtures").join("claude-usage")
}

fn cli_all(scratch: &Path) -> Value {
    let out = Command::new(env!("CARGO_BIN_EXE_atlas-usage"))
        .args(["all", "--json", "--config-dir", fixture().to_str().unwrap(), "--cache-dir", scratch.join("cli-cache").to_str().unwrap()])
        .env_remove("CLAUDE_CONFIG_DIR")
        .env_remove("ATLAS_USAGE_CACHE")
        .env_remove("CLAUDE_CODE_SESSION_ID")
        .env_remove("CLAUDE_PROJECT_DIR")
        // Count-cache setting: read from this empty data folder, so the default (off) applies.
        .env("ATLAS_DATA_DIR", scratch.join("data"))
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    serde_json::from_slice(&out.stdout).unwrap()
}

#[test]
fn the_apps_lifetime_equals_the_clis_all_scope() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(tmp.path().join("data")).unwrap();
    let cli = cli_all(tmp.path());
    let report = &cli["report"];

    // The app side: the same engine, started the way the app starts it (local time, own cache).
    let cache_dir = tmp.path().join("app-cache");
    std::fs::create_dir_all(&cache_dir).unwrap();
    let cfg = UsageConfig::new(fixture().join("projects"), fixture(), cache_dir.clone(), cache_dir.join("cache.sqlite"));
    let engine = UsageEngine::start({ let mut c = cfg; c.watch = false; c }, Arc::new(NullSink));
    assert!(engine.wait_pass(0, Duration::from_secs(180)), "first pass did not finish");
    let life = engine.lifetime().unwrap();
    engine.stop();

    assert!(life.total.tokens.total > 0 && life.total.sessions > 0, "the fixture has history");
    assert_eq!(cli["from"].as_str(), life.first_day.as_deref(), "same first day");

    let t = &report["total"]["tokens"];
    for (key, mine) in [
        ("input", life.total.tokens.input),
        ("output", life.total.tokens.output),
        ("cacheWrite5m", life.total.tokens.cache_write5m),
        ("cacheWrite1h", life.total.tokens.cache_write1h),
        ("cacheRead", life.total.tokens.cache_read),
        ("total", life.total.tokens.total),
    ] {
        assert_eq!(t[key].as_u64(), Some(mine), "tokens.{key}");
    }
    assert_eq!(report["total"]["sessions"].as_u64(), Some(life.total.sessions), "sessions");
    let usd = report["total"]["cost"]["usd"].as_f64().unwrap();
    assert!((usd - life.total.cost.usd.unwrap()).abs() < 1e-9, "estimated cost {usd} vs {:?}", life.total.cost.usd);

    let models = report["byModel"].as_array().unwrap();
    assert_eq!(models.len(), life.by_model.len());
    for (c, a) in models.iter().zip(&life.by_model) {
        assert_eq!(c["model"].as_str(), Some(a.model.as_str()));
        assert_eq!(c["tokens"]["total"].as_u64(), Some(a.tokens.total), "model {}", a.model);
    }
}
