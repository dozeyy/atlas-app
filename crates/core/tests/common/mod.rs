//! Shared helpers for the usage integration tests.
#![allow(dead_code)]

pub mod synth;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use atlas_core::usage::query::{Timeline, TimelineArgs, TimelinePoint};
use atlas_core::usage::time::Tz;
use atlas_core::usage::{NullSink, UsageConfig, UsageEngine};
use rusqlite::Connection;

pub const WAIT: Duration = Duration::from_secs(180);
/// 2026-11-08T20:00:00Z: "today" for every test that does not care.
pub const NOW_MS: i64 = 1_794_168_000_000;

pub fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("fixtures")
}

pub fn fixture(name: &str) -> PathBuf {
    fixtures().join(name)
}

pub fn copy_tree(src: &Path, dst: &Path) {
    fs::create_dir_all(dst).unwrap();
    for e in fs::read_dir(src).unwrap() {
        let e = e.unwrap();
        let to = dst.join(e.file_name());
        if e.file_type().unwrap().is_dir() {
            copy_tree(&e.path(), &to);
        } else {
            fs::copy(e.path(), to).unwrap();
        }
    }
}

/// Every file under `root` as (relative path, size, mtime nanos, bytes).
pub fn snapshot(root: &Path) -> Vec<(String, u64, u128, Vec<u8>)> {
    fn walk(dir: &Path, base: &Path, out: &mut Vec<(String, u64, u128, Vec<u8>)>) {
        let mut es: Vec<_> = fs::read_dir(dir).unwrap().map(|e| e.unwrap()).collect();
        es.sort_by_key(|e| e.file_name());
        for e in es {
            let p = e.path();
            if e.file_type().unwrap().is_dir() {
                walk(&p, base, out);
            } else {
                let m = fs::metadata(&p).unwrap();
                let mt = m.modified().unwrap().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
                out.push((
                    p.strip_prefix(base).unwrap().to_string_lossy().replace('\\', "/"),
                    m.len(),
                    mt,
                    fs::read(&p).unwrap(),
                ));
            }
        }
    }
    let mut v = Vec::new();
    walk(root, root, &mut v);
    v
}

pub struct Fx {
    pub engine: Arc<UsageEngine>,
    pub data: tempfile::TempDir,
    pub config: PathBuf,
    pub cache: PathBuf,
}

pub fn config_for(config: &Path, data: &Path, tz: Tz) -> UsageConfig {
    let mut c = UsageConfig::new(config.join("projects"), config.to_path_buf(), data.to_path_buf(), data.join("cache.sqlite"));
    c.tz = tz;
    c.watch = false;
    c.now_override_ms = Some(NOW_MS);
    c.ingest.workers = 2;
    c
}

/// Start an engine over `config` (a Claude config folder) and wait for the first pass.
pub fn start(config: &Path, tz: Tz) -> Fx {
    let data = tempfile::tempdir().unwrap();
    start_in(config, data, tz)
}

pub fn start_in(config: &Path, data: tempfile::TempDir, tz: Tz) -> Fx {
    let cfg = config_for(config, data.path(), tz);
    let cache = cfg.cache_db.clone();
    let engine = UsageEngine::start(cfg, Arc::new(NullSink));
    assert!(engine.wait_pass(0, WAIT), "first pass did not finish: {:?}", engine.status());
    Fx { engine, data, config: config.to_path_buf(), cache }
}

impl Fx {
    pub fn rescan(&self) {
        let n = self.engine.passes();
        self.engine.reindex(false);
        assert!(self.engine.wait_pass(n, WAIT), "rescan did not finish");
    }

    pub fn full_reread(&self) {
        let n = self.engine.passes();
        self.engine.reindex(true);
        assert!(self.engine.wait_pass(n, WAIT), "re-read did not finish");
    }

    /// A direct read-only look at the cache, for assertions.
    pub fn db(&self) -> Connection {
        Connection::open_with_flags(&self.cache, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap()
    }

    pub fn one(&self, sql: &str) -> i64 {
        self.db().query_row(sql, [], |r| r.get(0)).unwrap()
    }

    /// Everything in the cache as one month bucket (the fixtures all sit in 2026-11).
    pub fn month(&self) -> TimelinePoint {
        let t = self.timeline("2026-11-01", "2026-11-30", "month", None);
        t.points.into_iter().next().unwrap()
    }

    pub fn timeline(&self, from: &str, to: &str, bucket: &str, group: Option<&str>) -> Timeline {
        self.engine
            .timeline(&TimelineArgs {
                from: from.into(),
                to: to.into(),
                bucket: bucket.into(),
                group_by: group.map(str::to_string),
            })
            .unwrap()
    }
}

pub fn jsonl_line(session: &str, msg: &str, ts: &str, model: &str, input: u64, output: u64) -> String {
    format!(
        concat!(
            r#"{{"type":"assistant","uuid":"x-{msg}","sessionId":"{sid}","timestamp":"{ts}","cwd":"/fixture/gen","#,
            r#""isSidechain":false,"requestId":"req_{msg}","message":{{"id":"msg_{msg}","type":"message","role":"assistant","#,
            r#""model":"{model}","content":[],"usage":{{"input_tokens":{i},"output_tokens":{o},"#,
            r#""cache_creation_input_tokens":0,"cache_read_input_tokens":0,"#,
            r#""cache_creation":{{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0}},"#,
            r#""service_tier":"standard","speed":"standard","inference_geo":"global"}}}}}}"#
        ),
        msg = msg,
        sid = session,
        ts = ts,
        model = model,
        i = input,
        o = output
    )
}
