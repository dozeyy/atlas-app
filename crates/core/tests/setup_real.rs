//! Discovery against the real `~/.claude` and `~/.claude.json`, read only.
//! Ignored by default: `cargo test -p atlas-core --release --test setup_real -- --ignored --nocapture`.
//! Prints counts and timings only, never a name, path or value.

use std::collections::BTreeMap;
use std::fs;
use std::time::Instant;

use atlas_core::paths::{self, ConfigInputs};
use atlas_core::setup::{default_managed_dir, discover, Cache, DiscoveryInputs};

/// Every string under an `env` or `headers` key (or a key that names a secret)
/// in a JSON file, so the test can prove none of them reaches the page.
fn secret_values(path: &std::path::Path, out: &mut Vec<String>) {
    fn walk(v: &serde_json::Value, in_secret: bool, out: &mut Vec<String>) {
        match v {
            serde_json::Value::Object(m) => {
                for (k, x) in m {
                    if k == "skillOverrides" {
                        continue;
                    }
                    let kl = k.to_ascii_lowercase();
                    let sec = in_secret
                        || kl == "env"
                        || kl == "headers"
                        || kl.contains("token")
                        || kl.contains("secret")
                        || kl.contains("password")
                        || kl.contains("apikey")
                        || kl.contains("api_key");
                    walk(x, sec, out);
                }
            }
            serde_json::Value::Array(a) => a.iter().for_each(|x| walk(x, in_secret, out)),
            serde_json::Value::String(s) if in_secret && s.len() >= 8 => out.push(s.clone()),
            _ => {}
        }
    }
    if let Ok(t) = fs::read_to_string(path) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(t.trim_start_matches('\u{feff}')) {
            walk(&v, false, out);
        }
    }
}

fn stamp(p: &str) -> Option<(u64, u128)> {
    let m = fs::metadata(p).ok()?;
    Some((m.len(), m.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_nanos()))
}

#[test]
#[ignore]
fn real_config_read_only_budget() {
    let home = paths::home_dir().expect("home");
    let cwd = std::env::current_dir().unwrap();
    let root = paths::resolve_config_root(&ConfigInputs { flag: None, settings_override: None, env: None, home: &home, cwd: &cwd });
    let inputs = DiscoveryInputs { root: root.clone(), home: home.clone(), managed_dir: default_managed_dir(), include_worktrees: false, sandboxed: false };

    let mut cache = Cache::default();
    let t = Instant::now();
    let first = discover(&inputs, &mut cache);
    let first_ms = t.elapsed().as_secs_f64() * 1000.0;

    // Everything the scan listed, before.
    let files: Vec<String> = first.snapshot.items.iter().filter_map(|i| i.path.clone()).collect::<std::collections::BTreeSet<_>>().into_iter().collect();
    let before: Vec<Option<(u64, u128)>> = files.iter().map(|f| stamp(f)).collect();
    let cj = root.claude_json.to_string_lossy().into_owned();
    let cj_before = stamp(&cj);

    let mut times = Vec::new();
    let mut last = None;
    for _ in 0..30 {
        let t = Instant::now();
        let d = discover(&inputs, &mut cache);
        times.push(t.elapsed().as_secs_f64() * 1000.0);
        last = Some(d);
    }
    times.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let p50 = times[times.len() / 2];
    let p95 = times[(times.len() as f64 * 0.95) as usize - 1];
    let d = last.unwrap();
    let bytes = serde_json::to_vec(&d.snapshot).unwrap().len();

    let after: Vec<Option<(u64, u128)>> = files.iter().map(|f| stamp(f)).collect();
    let changed = before.iter().zip(&after).filter(|(a, b)| a != b).count();
    let cj_changed = cj_before != stamp(&cj);

    let mut kinds: BTreeMap<&'static str, usize> = BTreeMap::new();
    for i in &d.snapshot.items {
        *kinds.entry(i.kind.as_str()).or_default() += 1;
    }
    println!(
        "SETUP_DISCOVERY first_ms={first_ms:.1} p50_ms={p50:.1} p95_ms={p95:.1} items={} projects={} bytes={bytes} root_state={}",
        d.snapshot.items.len(),
        d.snapshot.projects.len(),
        d.snapshot.root.claude_json_state
    );
    println!("SETUP_KINDS {kinds:?}");
    println!(
        "SETUP_HIDDEN worktrees={} missing={} empty={} backups={}",
        d.snapshot.hidden.worktrees, d.snapshot.hidden.missing_projects, d.snapshot.hidden.empty_projects, d.snapshot.hidden.backups
    );
    println!("SETUP_READONLY listed_files={} changed_during_run={changed} claude_json_changed={cj_changed}", files.len());
    // No secret value from the real files may appear in the snapshot or in any
    // masked source text. Only counts are printed.
    let mut secrets = Vec::new();
    secret_values(&root.claude_json, &mut secrets);
    for f in &files {
        if f.to_ascii_lowercase().ends_with(".json") {
            secret_values(std::path::Path::new(f), &mut secrets);
        }
    }
    secrets.sort();
    secrets.dedup();
    let wire = serde_json::to_string(&d.snapshot).unwrap();
    let leaked_snapshot = secrets.iter().filter(|s| wire.contains(s.as_str())).count();
    let mut leaked_source = 0;
    let mut source_errors = 0;
    let mut sources_read = 0;
    for it in &d.snapshot.items {
        match d.read_source(&it.id) {
            Ok(v) => {
                sources_read += 1;
                leaked_source += secrets.iter().filter(|s| v.text.contains(s.as_str())).count();
            }
            Err(_) => source_errors += 1,
        }
    }
    let conflicts = d.snapshot.items.iter().filter(|i| i.conflict.is_some()).count();
    let warned = d.snapshot.items.iter().filter(|i| !i.warnings.is_empty()).count();
    println!(
        "SETUP_SECRETS distinct_secret_values={} leaked_in_snapshot={leaked_snapshot} leaked_in_sources={leaked_source} sources_read={sources_read} source_errors={source_errors} conflicts={conflicts} items_with_warnings={warned}",
        secrets.len()
    );
    assert_eq!(leaked_snapshot, 0);
    assert_eq!(leaked_source, 0);
    assert_eq!(changed, 0, "a listed file changed while Setup ran");
}
