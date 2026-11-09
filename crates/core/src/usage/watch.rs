//! File watching (D41). `notify` reports raw events; the engine's coordinator does
//! the debouncing, so this module only translates events into small messages.

use std::path::{Path, PathBuf};

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};

/// What the watcher noticed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Seen {
    /// A transcript path changed (created, grown, removed, renamed).
    Transcript(PathBuf),
    /// A directory (or anything else) vanished or the backend lost track: sweep.
    Sweep,
    /// `pricing.json` changed.
    Pricing,
}

pub struct Watch {
    // Held only to keep the OS watches alive.
    _watcher: RecommendedWatcher,
}

fn is_jsonl(p: &Path) -> bool {
    p.extension().is_some_and(|e| e.eq_ignore_ascii_case("jsonl"))
}

/// Map an event path back onto the root as it was configured. macOS FSEvents reports
/// the resolved path (`/private/var/...` for a watched `/var/...`, or the target of a
/// symlinked `~/.claude`), which would never match the configured prefix.
pub fn rebase(root: &Path, canon_root: &Path, p: PathBuf) -> PathBuf {
    if p.starts_with(root) {
        return p;
    }
    match p.strip_prefix(canon_root) {
        Ok(rest) => root.join(rest),
        Err(_) => p,
    }
}

/// The resolved form of a watched root, for [`rebase`].
pub fn canon_root(root: &Path) -> PathBuf {
    root.canonicalize().unwrap_or_else(|_| root.to_path_buf())
}

/// Translate one raw event (pure, so it is unit-testable).
pub fn translate(ev: &Event, pricing_name: &str) -> Vec<Seen> {
    if matches!(ev.kind, EventKind::Access(_)) {
        return Vec::new();
    }
    let mut out = Vec::new();
    for p in &ev.paths {
        if is_jsonl(p) {
            out.push(Seen::Transcript(p.clone()));
        } else if p.file_name().is_some_and(|n| n == pricing_name) {
            out.push(Seen::Pricing);
        } else if matches!(ev.kind, EventKind::Remove(_))
            || matches!(ev.kind, EventKind::Modify(notify::event::ModifyKind::Name(_)))
        {
            // A folder (or session) disappeared: its files are gone with it.
            if p.extension().is_none() {
                out.push(Seen::Sweep);
            }
        }
    }
    if matches!(ev.kind, EventKind::Other) && ev.need_rescan() {
        out.push(Seen::Sweep);
    }
    out
}

/// Watch `projects_dir` recursively and `data_dir` (for the price file).
/// Failure to watch is not fatal: the periodic sweep still keeps the ledger fresh.
pub fn start(
    projects_dir: &Path,
    data_dir: &Path,
    pricing_name: &'static str,
    emit: impl Fn(Seen) + Send + 'static,
) -> Result<Watch, notify::Error> {
    let (root, canon) = (projects_dir.to_path_buf(), canon_root(projects_dir));
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<Event>| match res {
        Ok(mut ev) => {
            ev.paths = ev.paths.into_iter().map(|p| rebase(&root, &canon, p)).collect();
            for s in translate(&ev, pricing_name) {
                emit(s);
            }
        }
        Err(_) => {
            emit(Seen::Sweep);
        }
    })?;
    let mut any = false;
    if projects_dir.is_dir() && watcher.watch(projects_dir, RecursiveMode::Recursive).is_ok() {
        any = true;
    }
    if data_dir.is_dir() && watcher.watch(data_dir, RecursiveMode::NonRecursive).is_ok() {
        any = true;
    }
    if !any {
        return Err(notify::Error::generic("nothing to watch"));
    }
    Ok(Watch { _watcher: watcher })
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{CreateKind, ModifyKind, RemoveKind};

    fn ev(kind: EventKind, p: &str) -> Event {
        Event::new(kind).add_path(PathBuf::from(p))
    }

    #[test]
    fn resolved_event_paths_map_back_onto_the_configured_root() {
        let (root, canon) = (Path::new("/var/t/projects"), Path::new("/private/var/t/projects"));
        let p = rebase(root, canon, PathBuf::from("/private/var/t/projects/a/s.jsonl"));
        assert_eq!(p, PathBuf::from("/var/t/projects/a/s.jsonl"));
        assert_eq!(rebase(root, canon, PathBuf::from("/var/t/projects/a/s.jsonl")), p);
        assert_eq!(rebase(root, canon, PathBuf::from("/elsewhere/x.jsonl")), PathBuf::from("/elsewhere/x.jsonl"));
    }

    #[test]
    fn only_jsonl_and_the_price_file_matter() {
        let m = EventKind::Modify(ModifyKind::Any);
        assert_eq!(translate(&ev(m, "/p/a/s.jsonl"), "pricing.json").len(), 1);
        assert!(translate(&ev(m, "/p/a/notes.txt"), "pricing.json").is_empty());
        assert_eq!(translate(&ev(m, "/d/pricing.json"), "pricing.json"), vec![Seen::Pricing]);
        assert!(translate(&ev(m, "/d/cache.sqlite-wal"), "pricing.json").is_empty());
    }

    #[test]
    fn a_vanished_folder_asks_for_a_sweep() {
        let e = ev(EventKind::Remove(RemoveKind::Folder), "/p/old-project");
        assert_eq!(translate(&e, "pricing.json"), vec![Seen::Sweep]);
        let c = ev(EventKind::Create(CreateKind::File), "/p/a/new.jsonl");
        assert_eq!(translate(&c, "pricing.json").len(), 1);
    }
}
