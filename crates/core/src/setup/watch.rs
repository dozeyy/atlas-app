//! Live refresh: watch the config folder, the known project folders and
//! `.claude.json`, and rescan when something Setup shows has changed.
//!
//! Read only: the watcher observes, it never touches a file. Events are
//! debounced (250 ms); transcripts, caches and other bulk folders are ignored;
//! `.claude.json` (Claude rewrites it all the time) only counts when the parts
//! Setup reads changed.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use notify::RecursiveMode;
use notify_debouncer_mini::{new_debouncer, DebounceEventResult};

use super::projects::norm_key;
use super::{claude_json, discover, Cache, Discovery, DiscoveryInputs};
use crate::layout;

enum Msg {
    Fs(DebounceEventResult),
    Rescan,
    /// Rescan, then tell the sender (used right after Atlas changes a file).
    RescanAck(Sender<()>),
    Stop,
}

struct Shared {
    cur: Mutex<(u64, Arc<Discovery>)>,
}

/// A running scan + watcher. Dropping it stops the watcher.
pub struct LiveSetup {
    shared: Arc<Shared>,
    tx: Sender<Msg>,
}

/// True when a change at `path` can alter what Setup shows.
pub fn is_relevant(path: &Path, root: &Path) -> bool {
    let pk = norm_key(&path.to_string_lossy());
    let rk = norm_key(&root.to_string_lossy());
    let name = pk.rsplit('/').next().unwrap_or("");
    if name.ends_with(".tmp") || name.starts_with(".#") || name.ends_with(".swp") || name.ends_with(".swx") {
        return false;
    }
    if let Some(rel) = pk.strip_prefix(&format!("{rk}/")) {
        if layout::is_denied(rel) {
            return false;
        }
        if let Some(rest) = rel.strip_prefix("projects/") {
            return rest.contains("/memory/") && name.ends_with(".md");
        }
        if rel.contains("/.in_use/") || rel.starts_with("plugins/marketplaces/") {
            return false;
        }
        return true;
    }
    if pk.contains("/node_modules/") || pk.contains("/.git/") || pk.contains("/.claude/worktrees/") {
        return false;
    }
    // A project folder is watched one level deep (and its `.claude` folder fully), and
    // that folder can be the home folder or a temp folder that sees constant churn
    // (measured: 77 rescans in 25 s on a busy machine). Only what Setup reads counts.
    pk.ends_with("/.claude") || pk.contains("/.claude/") || PROJECT_FILES.iter().any(|f| name.eq_ignore_ascii_case(f))
}

/// Files a project keeps beside its `.claude` folder that Setup lists or reads.
const PROJECT_FILES: [&str; 4] = ["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md", ".mcp.json"];

/// What to watch for these inputs and the projects the last scan covered.
fn plan(inputs: &DiscoveryInputs, d: &Discovery) -> Vec<(PathBuf, RecursiveMode)> {
    let root = &inputs.root.dir;
    let mut out = vec![(root.clone(), RecursiveMode::Recursive)];
    let rk = norm_key(&root.to_string_lossy());
    if let Some(parent) = inputs.root.claude_json.parent() {
        let pk = norm_key(&parent.to_string_lossy());
        if !pk.starts_with(&rk) && parent.is_dir() {
            out.push((parent.to_path_buf(), RecursiveMode::NonRecursive));
        }
    }
    for p in d.watched_projects() {
        let dot = p.join(".claude");
        if p.is_dir() {
            out.push((p.clone(), RecursiveMode::NonRecursive));
        }
        if dot.is_dir() && norm_key(&dot.to_string_lossy()) != rk {
            out.push((dot, RecursiveMode::Recursive));
        }
    }
    out
}

fn key_of(p: &(PathBuf, RecursiveMode)) -> String {
    format!("{:?}|{}", p.1, p.0.to_string_lossy())
}

impl LiveSetup {
    /// Scan once (on the calling thread), then watch. `on_change(version)` runs
    /// on the worker thread after every refresh.
    pub fn start(inputs: DiscoveryInputs, on_change: impl Fn(u64) + Send + 'static) -> LiveSetup {
        let mut cache = Cache::default();
        let mut first = discover(&inputs, &mut cache);
        first.snapshot.version = 1;
        let shared = Arc::new(Shared { cur: Mutex::new((1, Arc::new(first))) });
        let (tx, rx) = channel::<Msg>();
        let txd = tx.clone();
        let sh = shared.clone();
        let spawn = std::thread::Builder::new().name("atlas-setup-watch".into()).spawn(move || {
            let mut deb = new_debouncer(Duration::from_millis(250), move |res: DebounceEventResult| {
                let _ = txd.send(Msg::Fs(res));
            })
            .ok();
            let mut watched: Vec<(PathBuf, RecursiveMode)> = Vec::new();
            let mut last_cj = claude_json::relevant_hash(&inputs.root.claude_json);
            let cj_key = norm_key(&inputs.root.claude_json.to_string_lossy());
            let sync = |deb: &mut Option<notify_debouncer_mini::Debouncer<notify::RecommendedWatcher>>, watched: &mut Vec<(PathBuf, RecursiveMode)>, d: &Discovery| {
                let Some(deb) = deb.as_mut() else { return };
                let want = plan(&inputs, d);
                let want_keys: HashSet<String> = want.iter().map(key_of).collect();
                let have_keys: HashSet<String> = watched.iter().map(key_of).collect();
                for w in watched.iter().filter(|w| !want_keys.contains(&key_of(w))) {
                    let _ = deb.watcher().unwatch(&w.0);
                }
                let mut now = Vec::new();
                for w in want {
                    if have_keys.contains(&key_of(&w)) || deb.watcher().watch(&w.0, w.1).is_ok() {
                        now.push(w);
                    }
                }
                *watched = now;
            };
            {
                let d = sh.cur.lock().unwrap().1.clone();
                sync(&mut deb, &mut watched, &d);
            }
            while let Ok(msg) = rx.recv() {
                let mut ack: Option<Sender<()>> = None;
                let rescan = match msg {
                    Msg::Stop => break,
                    Msg::Rescan => true,
                    Msg::RescanAck(a) => {
                        ack = Some(a);
                        true
                    }
                    Msg::Fs(Err(_)) => true,
                    Msg::Fs(Ok(events)) => events.iter().any(|e| {
                        if norm_key(&e.path.to_string_lossy()) == cj_key {
                            let h = claude_json::relevant_hash(&inputs.root.claude_json);
                            let changed = h != last_cj;
                            last_cj = h;
                            changed
                        } else {
                            is_relevant(&e.path, &inputs.root.dir)
                        }
                    }),
                };
                if !rescan {
                    continue;
                }
                let mut d = discover(&inputs, &mut cache);
                let version = {
                    let mut g = sh.cur.lock().unwrap();
                    let v = g.0 + 1;
                    d.snapshot.version = v;
                    *g = (v, Arc::new(d));
                    v
                };
                let d = sh.cur.lock().unwrap().1.clone();
                sync(&mut deb, &mut watched, &d);
                on_change(version);
                if let Some(a) = ack {
                    let _ = a.send(());
                }
            }
        });
        let _ = spawn;
        LiveSetup { shared, tx }
    }

    /// The current version and scan.
    pub fn current(&self) -> (u64, Arc<Discovery>) {
        self.shared.cur.lock().unwrap().clone()
    }

    /// Ask for a full rescan now (asynchronous; `on_change` fires when done).
    pub fn rescan(&self) {
        let _ = self.tx.send(Msg::Rescan);
    }

    /// Rescan and wait for it (at most `max`), so a caller that just changed a
    /// file can hand back a snapshot that already shows the change.
    pub fn rescan_wait(&self, max: Duration) -> bool {
        let (tx, rx) = channel::<()>();
        if self.tx.send(Msg::RescanAck(tx)).is_err() {
            return false;
        }
        rx.recv_timeout(max).is_ok()
    }
}

impl Drop for LiveSetup {
    fn drop(&mut self) {
        let _ = self.tx.send(Msg::Stop);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transcripts_and_bulk_folders_are_ignored() {
        let root = Path::new("/h/.claude");
        assert!(!is_relevant(Path::new("/h/.claude/projects/p1/abc.jsonl"), root));
        assert!(!is_relevant(Path::new("/h/.claude/file-history/x/y"), root));
        assert!(!is_relevant(Path::new("/h/.claude/history.jsonl"), root));
        assert!(!is_relevant(Path::new("/h/.claude/agents/x.md.tmp"), root));
    }

    #[test]
    fn config_files_and_memory_count() {
        let root = Path::new("/h/.claude");
        assert!(is_relevant(Path::new("/h/.claude/agents/x.md"), root));
        assert!(is_relevant(Path::new("/h/.claude/settings.json"), root));
        assert!(is_relevant(Path::new("/h/.claude/projects/p1/memory/a.md"), root));
        assert!(is_relevant(Path::new("/w/app/CLAUDE.md"), root));
        assert!(!is_relevant(Path::new("/w/app/node_modules/x/y.js"), root));
        assert!(is_relevant(Path::new("/w/app/.mcp.json"), root));
        assert!(is_relevant(Path::new("/w/app/.claude/skills/s/SKILL.md"), root));
        assert!(is_relevant(Path::new("/w/app/.claude"), root));
    }

    #[test]
    fn churn_in_a_watched_home_or_temp_folder_is_ignored() {
        // A project folder can be the home folder or Temp: the OS reports everything in it.
        let root = Path::new("/h/.claude");
        assert!(!is_relevant(Path::new("/h/ntuser.dat.LOG1"), root));
        assert!(!is_relevant(Path::new("/h/AppData/Local/Temp/claude"), root));
        assert!(!is_relevant(Path::new("/h/AppData/Local/Temp/host_sculpt_autosave.blend@"), root));
        assert!(!is_relevant(Path::new("/w/app/src/main.rs"), root));
        assert!(!is_relevant(Path::new("/w/app/.claude/worktrees/a/CLAUDE.md"), root));
    }
}
