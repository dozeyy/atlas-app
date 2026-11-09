//! Build the chat-search index for a scratch Claude folder, the way the Atlas app does in the
//! background, so `atlas-mcp` has something to read (`tools/repeats_headless.py`).
//!
//!   cargo run -p atlas-core --example habits_index -- \
//!       --projects <claude dir>/projects --config <claude dir> --data <scratch data dir>
//!
//! The index goes to the file `atlas-mcp --config-dir <claude dir> --data-dir <data>` reads
//! (a `--config-dir` folder is never the real root). Prints counts only.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use atlas_core::search::{NullSearchSink, SearchConfig, SearchEngine, db};

fn arg(name: &str) -> Option<String> {
    let a: Vec<String> = std::env::args().collect();
    a.iter().position(|x| x == name).and_then(|i| a.get(i + 1)).cloned()
}

fn main() {
    let projects = PathBuf::from(arg("--projects").expect("--projects"));
    let config = PathBuf::from(arg("--config").expect("--config"));
    let data = PathBuf::from(arg("--data").expect("--data"));
    std::fs::create_dir_all(&data).expect("data dir");
    let file = db::search_file(&data, &projects, false);
    let mut cfg = SearchConfig::new(projects, config, file.clone());
    cfg.debounce = Duration::from_millis(20);
    let engine = SearchEngine::start(cfg, Arc::new(NullSearchSink));
    let n = engine.passes();
    engine.poke();
    assert!(engine.wait_pass(n, Duration::from_secs(120)), "the index pass did not finish");
    let messages = engine.status().messages;
    engine.stop();
    println!("indexed {messages} messages into {}", file.display());
}
