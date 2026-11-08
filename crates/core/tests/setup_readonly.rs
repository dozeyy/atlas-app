//! Setup is read only by construction: nothing under `src/setup/` may name a
//! way to write, move, delete or run anything. Scanned as text, so a new call
//! cannot slip in unnoticed; the only filesystem calls allowed are reads.

use std::fs;
use std::path::{Path, PathBuf};

const FORBIDDEN: &[&str] = &[
    "fs::write",
    "File::create",
    "OpenOptions",
    "rename(",
    "remove_file",
    "remove_dir",
    "create_dir",
    "fs::copy",
    "atomic_write",
    "set_permissions",
    "Command::new",
    "set_modified",
    "set_len",
    "hard_link",
    "::symlink(",
    "symlink_file",
    "symlink_dir",
];

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for e in fs::read_dir(dir).unwrap() {
        let p = e.unwrap().path();
        if p.is_dir() {
            rust_files(&p, out);
        } else if p.extension().is_some_and(|x| x == "rs") {
            out.push(p);
        }
    }
}

#[test]
fn nothing_under_setup_can_write() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("setup");
    let mut files = Vec::new();
    rust_files(&dir, &mut files);
    assert!(files.len() >= 10, "scan found {} files", files.len());
    let mut hits = Vec::new();
    for f in &files {
        let text = fs::read_to_string(f).unwrap();
        for (n, line) in text.lines().enumerate() {
            // The test modules below may build trees in temp folders.
            if line.contains("#[cfg(test)]") {
                break;
            }
            for bad in FORBIDDEN {
                if line.contains(bad) {
                    hits.push(format!("{}:{}: {bad}", f.file_name().unwrap().to_string_lossy(), n + 1));
                }
            }
        }
    }
    assert!(hits.is_empty(), "write APIs under setup/: {hits:?}");
}

#[test]
fn layout_denies_credentials_and_bulk() {
    use atlas_core::layout::is_denied;
    for p in [".credentials.json", "sessions/x.key", "history.jsonl", "backups/a.json", "cache/c.json", "projects/x/abc.jsonl.tmp"] {
        // The first four are denied outright; transcripts are handled by the scanner.
        if !p.starts_with("projects/") {
            assert!(is_denied(p), "{p}");
        }
    }
    assert!(is_denied("worktrees/agent-1/CLAUDE.md"));
    assert!(is_denied("something/.claude/worktrees/x/y.md"));
    assert!(!is_denied("skills/x/SKILL.md"));
    assert!(!is_denied("agents/a.md"));
}
