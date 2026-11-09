//! Measures the ledger over a real Claude folder, READ-ONLY (never writes it; the cache goes to a
//! scratch data dir). Ignored by default; run with
//! `ATLAS_REAL_CONFIG=<claude dir> cargo test -p atlas-core --release --test usage_ledger_real -- --ignored --nocapture`.
//! Prints counts and timings only, never transcript text beyond a few truncated finding lines
//! shown on the console for the false-positive check.

mod common;

use std::sync::atomic::Ordering;
use std::time::Instant;

use atlas_core::usage::reviews::MASK_DROPPED;
use atlas_core::usage::scorecard::*;
use atlas_core::usage::time::Tz;
use common::*;

fn q(fx: &Fx, sql: &str) -> i64 {
    fx.one(sql)
}

#[test]
#[ignore]
fn measure_the_real_corpus() {
    let Ok(dir) = std::env::var("ATLAS_REAL_CONFIG") else { return };
    let t = Instant::now();
    // The app's own worker count (the shared test config pins 2).
    let data = tempfile::tempdir().unwrap();
    let mut cfg = config_for(std::path::Path::new(&dir), data.path(), Tz::Fixed(0));
    cfg.ingest = atlas_core::usage::ingest::IngestOptions::default();
    println!("workers: {}", cfg.ingest.workers);
    let cache = cfg.cache_db.clone();
    let engine = atlas_core::usage::UsageEngine::start(cfg, std::sync::Arc::new(atlas_core::usage::NullSink));
    assert!(engine.wait_pass(0, WAIT));
    let fx = Fx { engine, data, config: std::path::PathBuf::from(&dir), cache };
    println!("first pass: {:.1} s", t.elapsed().as_secs_f64());
    println!("findings dropped by the secret mask: {}", MASK_DROPPED.load(Ordering::Relaxed));

    println!("agent_runs: {}", q(&fx, "SELECT COUNT(*) FROM agent_runs"));
    for (what, sql) in [
        ("helper runs (not the chat itself)", "SELECT COUNT(*) FROM agent_runs WHERE agent_id <> ''"),
        ("main-chat agent runs", "SELECT COUNT(*) FROM agent_runs WHERE agent_id = ''"),
        ("ended by notice", "SELECT COUNT(*) FROM agent_runs WHERE end_source='notice'"),
        ("ended by sidecar", "SELECT COUNT(*) FROM agent_runs WHERE end_source='sidecar'"),
        ("ended by thread", "SELECT COUNT(*) FROM agent_runs WHERE end_source='thread'"),
        ("no end known", "SELECT COUNT(*) FROM agent_runs WHERE end_status IS NULL"),
        ("finished", "SELECT COUNT(*) FROM agent_runs WHERE end_status='finished'"),
        ("errored", "SELECT COUNT(*) FROM agent_runs WHERE end_status='errored'"),
        ("stopped", "SELECT COUNT(*) FROM agent_runs WHERE end_status='stopped'"),
        ("runs with a verdict", "SELECT COUNT(*) FROM agent_runs WHERE verdict IS NOT NULL"),
        ("verdict pass", "SELECT COUNT(*) FROM agent_runs WHERE verdict='pass'"),
        ("verdict findings", "SELECT COUNT(*) FROM agent_runs WHERE verdict='findings'"),
        ("verdict other", "SELECT COUNT(*) FROM agent_runs WHERE verdict='other'"),
        ("findings stored", "SELECT COUNT(*) FROM review_findings"),
        ("findings with a severity", "SELECT COUNT(*) FROM review_findings WHERE severity IS NOT NULL"),
        ("runs with findings", "SELECT COUNT(DISTINCT session_id||agent_id) FROM review_findings"),
        ("links", "SELECT COUNT(*) FROM agent_links"),
        ("dispatch links naming a helper", "SELECT COUNT(*) FROM agent_links WHERE kind='dispatch' AND target <> ''"),
        ("send links", "SELECT COUNT(*) FROM agent_links WHERE kind='send'"),
        ("notices", "SELECT COUNT(*) FROM agent_notices"),
        ("chats with an agent setting", "SELECT COUNT(*) FROM sessions WHERE agent_setting IS NOT NULL"),
    ] {
        println!("{what}: {}", q(&fx, sql));
    }
    {
        let c = fx.db();
        let mut st = c
            .prepare("SELECT agent_type, COUNT(*), SUM(verdict IS NOT NULL) FROM agent_runs GROUP BY 1 ORDER BY 2 DESC LIMIT 14")
            .unwrap();
        for r in st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?))).unwrap() {
            let (ty, n, v) = r.unwrap();
            println!("  type {ty}: {n} runs, {v} with a verdict");
        }
        let mut st = c
            .prepare("SELECT verdict_word, verdict, COUNT(*) FROM agent_runs WHERE verdict_word IS NOT NULL GROUP BY 1,2 ORDER BY 3 DESC LIMIT 25")
            .unwrap();
        for r in st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?))).unwrap() {
            let (w, c, n) = r.unwrap();
            println!("  verdict word {:?} -> {c}: {n}", w.chars().take(30).collect::<String>());
        }
        let mut st = c.prepare("SELECT severity, COUNT(*) FROM review_findings GROUP BY 1 ORDER BY 2 DESC").unwrap();
        for r in st.query_map([], |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, i64>(1)?))).unwrap() {
            let (s, n) = r.unwrap();
            println!("  severity {s:?}: {n}");
        }
        // A small spread of finding lines (truncated), to eyeball false positives on the console.
        let mut st = c.prepare("SELECT severity, substr(text,1,90) FROM review_findings ORDER BY substr(agent_id, -2), ord LIMIT 25").unwrap();
        for r in st.query_map([], |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, String>(1)?))).unwrap() {
            let (s, t) = r.unwrap();
            println!("  sample {s:?}: {t}");
        }
    }

    let t = Instant::now();
    let sc = fx.engine.agent_scorecard(&ScorecardArgs::default()).unwrap();
    println!("scorecard: {:.0} ms, {} runs, {} types", t.elapsed().as_secs_f64() * 1000.0, sc.total_runs, sc.types.len());
    for c in sc.types.iter().take(12) {
        let rv = c.reviews.map(|r| format!("tied {} passed {} sent_back {} not_tied {}", r.tied, r.passed, r.sent_back, r.not_tied));
        let vd = c.verdicts.map(|v| format!("pass {} findings {} other {} none {}", v.pass, v.findings, v.other, v.none));
        println!(
            "  {} [{}] runs {} ends {:?} rate {:?} tools~{:?} dur~{:?}s tokens {} cost {:?} reviews {:?} verdicts {:?}",
            c.agent_type,
            if c.reviewer { "reviewer" } else { "worker" },
            c.runs,
            c.ends,
            c.finish_rate.map(|r| (r * 100.0).round()),
            c.tool_calls_median,
            c.duration_ms_median.map(|d| d / 1000),
            c.tokens.total,
            c.cost.usd.map(|u| (u * 100.0).round() / 100.0),
            rv,
            vd
        );
    }
    for c in sc.types.iter().take(6) {
        let mix: Vec<String> = c.mix.iter().take(4).map(|m| format!("{} {} x{}", m.model_name, m.effort.as_deref().unwrap_or("no effort"), m.messages)).collect();
        println!("  mix {}: {}", c.agent_type, mix.join(" | "));
    }
    println!("runs with a model row: {}", q(&fx, "SELECT COUNT(DISTINCT session_id||agent_id) FROM agent_run_models"));
    println!("model rows with no effort: {} of {}", q(&fx, "SELECT COALESCE(SUM(n),0) FROM agent_run_models WHERE effort=''"), q(&fx, "SELECT COALESCE(SUM(n),0) FROM agent_run_models"));
    {
        let c = fx.db();
        let mut st = c.prepare("SELECT model, effort, SUM(n) FROM agent_run_models GROUP BY 1,2 ORDER BY 3 DESC LIMIT 12").unwrap();
        for r in st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?))).unwrap() {
            let (m, e, n) = r.unwrap();
            println!("  model {m} ({}) effort {e:?}: {n}", model_name(&m));
        }
    }
    let t = Instant::now();
    let th =fx.engine.review_themes(&ThemeArgs::default()).unwrap();
    println!("themes: {:.0} ms, {} findings, {} themes", t.elapsed().as_secs_f64() * 1000.0, th.findings, th.total);
    for x in th.themes.iter().take(5) {
        println!("  theme x{} from {} runs: {}", x.count, x.runs, x.label.chars().take(80).collect::<String>());
    }
    let t = Instant::now();
    let _ = fx.engine.agent_scorecard(&ScorecardArgs { days: Some(30), ..Default::default() }).unwrap();
    println!("scorecard 30 days: {:.0} ms", t.elapsed().as_secs_f64() * 1000.0);
}
