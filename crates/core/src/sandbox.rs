//! Sandbox Mode: work on a copy, never on the real config.
//!
//! `create` copies the Claude config folder (and its `.claude.json`) into a new
//! temp folder and returns a `ConfigRoot` that points at the copy, so every
//! experiment (edit, delete, restore) happens on files that can be thrown away.
//!
//! What is *not* copied:
//! - secrets: `.credentials.json`, `sessions/`, `*.key`, `*.pem`, `.env`;
//! - prompt history: `history.jsonl`;
//! - bulk Claude Code keeps for itself: `backups/ cache/ debug/ file-history/
//!   shell-snapshots/ session-env/ ...`, `.git`, `node_modules`, lock files;
//! - single files over `max_file_bytes` and anything past `max_total_bytes`;
//! - folder symlinks (file symlinks are copied as plain files).
//!
//! The big `projects/` transcripts are handled by `ProjectsMode`: left out, or
//! linked read-only (the copy's `ConfigRoot::projects_dir` points at the real
//! folder and is flagged `projects_read_only`, so nothing can ever write there).
//!
//! Safety: nothing is ever written under the source. `create` refuses a
//! destination inside the source or inside the real Claude config, and
//! `discard` only deletes folders that carry Atlas's marker file.

use std::fs::{self, File};
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::json;

use crate::fsutil::check_write_allowed;
use crate::paths::{ConfigRoot, ConfigSource};

/// Folder name prefix and marker file: `discard` and `cleanup_stale` only touch
/// folders that have both.
pub const DIR_PREFIX: &str = "atlas-sandbox-";
pub const MARKER: &str = "atlas-sandbox.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProjectsMode {
    /// Leave transcripts out entirely.
    Exclude,
    /// Read the real transcripts, read-only.
    ReadOnlyLink,
}

#[derive(Debug, Clone)]
pub struct SandboxOptions {
    pub projects: ProjectsMode,
    pub max_file_bytes: u64,
    pub max_total_bytes: u64,
}

impl Default for SandboxOptions {
    fn default() -> Self {
        SandboxOptions {
            projects: ProjectsMode::ReadOnlyLink,
            max_file_bytes: 8 * 1024 * 1024,
            max_total_bytes: 256 * 1024 * 1024,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SkipReason {
    Sensitive,
    Bulk,
    TooLarge,
    OverBudget,
    FolderLink,
    Unreadable,
}

#[derive(Debug, Clone, Serialize)]
pub struct Skipped {
    /// Relative to the config folder, with `/` separators.
    pub path: String,
    pub reason: SkipReason,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxReport {
    pub files_copied: u64,
    pub folders_copied: u64,
    pub bytes_copied: u64,
    pub skipped_total: u64,
    /// The first 200 skips, enough to explain what is missing.
    pub skipped: Vec<Skipped>,
    pub claude_json_copied: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum SandboxError {
    #[error("there is no Claude folder at {0}")]
    SourceMissing(PathBuf),
    #[error("the sandbox location {0} is inside the folder being copied")]
    InsideSource(PathBuf),
    #[error("{0}")]
    Io(#[from] io::Error),
}

#[derive(Debug)]
pub struct Sandbox {
    /// Points at the copy. `source` is `ConfigSource::Sandbox`.
    pub root: ConfigRoot,
    pub report: SandboxReport,
}

use crate::layout::{BULK_TOP, SENSITIVE_TOP};

fn skip_reason(name: &str, depth: usize, is_dir: bool) -> Option<SkipReason> {
    let lower = name.to_ascii_lowercase();
    if lower == ".credentials.json"
        || lower == ".env"
        || lower.starts_with(".env.")
        || lower.ends_with(".key")
        || lower.ends_with(".pem")
    {
        return Some(SkipReason::Sensitive);
    }
    if depth == 0 {
        if SENSITIVE_TOP.contains(&lower.as_str()) {
            return Some(SkipReason::Sensitive);
        }
        if BULK_TOP.contains(&lower.as_str()) {
            return Some(SkipReason::Bulk);
        }
        // Lock files and Atlas's own marker never travel.
        if lower.ends_with(".lock") || lower == MARKER {
            return Some(SkipReason::Bulk);
        }
    }
    if is_dir && (lower == ".git" || lower == "node_modules") {
        return Some(SkipReason::Bulk);
    }
    None
}

struct Ctx<'a> {
    opts: &'a SandboxOptions,
    report: SandboxReport,
}

impl Ctx<'_> {
    fn skip(&mut self, rel: &str, reason: SkipReason) {
        self.report.skipped_total += 1;
        if self.report.skipped.len() < 200 {
            self.report.skipped.push(Skipped { path: rel.to_string(), reason });
        }
    }
}

/// Copy `source` into a new folder under `parent` (normally the OS temp dir).
pub fn create(
    source: &ConfigRoot,
    parent: &Path,
    opts: &SandboxOptions,
) -> Result<Sandbox, SandboxError> {
    if !source.dir.is_dir() {
        return Err(SandboxError::SourceMissing(source.dir.clone()));
    }
    fs::create_dir_all(parent)?;
    let parent_abs = fs::canonicalize(parent)?;
    let source_abs = fs::canonicalize(&source.dir)?;
    if parent_abs.starts_with(&source_abs) {
        return Err(SandboxError::InsideSource(parent_abs));
    }
    check_write_allowed(&parent_abs)?;

    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let dest = crate::fsutil::strip_verbatim(&parent_abs).join(format!("{DIR_PREFIX}{stamp}-{}", std::process::id()));
    fs::create_dir(&dest)?;

    // Anything that goes wrong from here on removes the half-built copy.
    match copy_into(source, &source_abs, &dest, opts) {
        Ok(report) => {
            let mut root = ConfigRoot::rooted_at(dest, ConfigSource::Sandbox);
            if opts.projects == ProjectsMode::ReadOnlyLink {
                root.projects_dir = source.projects_dir.clone();
                root.projects_read_only = true;
            }
            Ok(Sandbox { root, report })
        }
        Err(e) => {
            let _ = fs::remove_dir_all(&dest);
            Err(e)
        }
    }
}

fn copy_into(
    source: &ConfigRoot,
    source_abs: &Path,
    dest: &Path,
    opts: &SandboxOptions,
) -> Result<SandboxReport, SandboxError> {
    let mut ctx = Ctx { opts, report: SandboxReport::default() };

    copy_dir(source_abs, dest, "", 0, &mut ctx)?;

    // The global state file: it may live beside the home folder, or inside the
    // config dir (in which case copy_dir already brought a stray copy; the real
    // one wins).
    let target = dest.join(".claude.json");
    if source.claude_json.is_file() {
        let len = fs::metadata(&source.claude_json).map(|m| m.len()).unwrap_or(0);
        if len <= 64 * 1024 * 1024 {
            fs::copy(&source.claude_json, &target)?;
            ctx.report.claude_json_copied = true;
        }
    } else if target.exists() {
        // A stray one from the folder copy with no real counterpart: drop it so
        // the sandbox looks like the source does.
        let _ = fs::remove_file(&target);
    }

    let marker = json!({
        "atlasSandbox": 1,
        "createdUnixMs": SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0),
        "pid": std::process::id(),
        "sourceDir": source.dir.to_string_lossy(),
        "projects": match opts.projects {
            ProjectsMode::Exclude => "excluded",
            ProjectsMode::ReadOnlyLink => "linked-read-only",
        },
    });
    fs::write(dest.join(MARKER), serde_json::to_vec_pretty(&marker).expect("marker json"))?;
    Ok(ctx.report)
}

fn copy_dir(
    src: &Path,
    dst: &Path,
    rel: &str,
    depth: usize,
    ctx: &mut Ctx,
) -> Result<(), SandboxError> {
    let entries = match fs::read_dir(src) {
        Ok(e) => e,
        Err(_) => {
            ctx.skip(if rel.is_empty() { "." } else { rel }, SkipReason::Unreadable);
            return Ok(());
        }
    };
    let mut entries: Vec<_> = entries.filter_map(Result::ok).collect();
    entries.sort_by_key(|e| e.file_name());

    for entry in entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        let rel_path = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
        let path = entry.path();
        let Ok(link_meta) = fs::symlink_metadata(&path) else {
            ctx.skip(&rel_path, SkipReason::Unreadable);
            continue;
        };
        let is_link = link_meta.file_type().is_symlink();
        // A symlink is judged by what it points at.
        let meta = if is_link {
            match fs::metadata(&path) {
                Ok(m) => m,
                Err(_) => {
                    ctx.skip(&rel_path, SkipReason::Unreadable);
                    continue;
                }
            }
        } else {
            link_meta
        };

        if meta.is_dir() {
            if depth == 0 && name.eq_ignore_ascii_case("projects") {
                // Decided by ProjectsMode (see ConfigRoot::projects_dir): never copied.
                ctx.skip(&rel_path, SkipReason::Bulk);
                continue;
            }
            if let Some(reason) = skip_reason(&name, depth, true) {
                ctx.skip(&rel_path, reason);
                continue;
            }
            if is_link {
                ctx.skip(&rel_path, SkipReason::FolderLink);
                continue;
            }
            let child = dst.join(&name);
            fs::create_dir(&child)?;
            ctx.report.folders_copied += 1;
            copy_dir(&path, &child, &rel_path, depth + 1, ctx)?;
        } else if meta.is_file() {
            if let Some(reason) = skip_reason(&name, depth, false) {
                ctx.skip(&rel_path, reason);
                continue;
            }
            let len = meta.len();
            if len > ctx.opts.max_file_bytes {
                ctx.skip(&rel_path, SkipReason::TooLarge);
                continue;
            }
            if ctx.report.bytes_copied + len > ctx.opts.max_total_bytes {
                ctx.skip(&rel_path, SkipReason::OverBudget);
                continue;
            }
            let out = dst.join(&name);
            match fs::copy(&path, &out) {
                Ok(_) => {
                    if let Ok(mtime) = meta.modified() {
                        if let Ok(f) = File::options().write(true).open(&out) {
                            let _ = f.set_modified(mtime);
                        }
                    }
                    ctx.report.files_copied += 1;
                    ctx.report.bytes_copied += len;
                }
                Err(_) => ctx.skip(&rel_path, SkipReason::Unreadable),
            }
        } else {
            ctx.skip(&rel_path, SkipReason::Unreadable);
        }
    }
    Ok(())
}

impl Sandbox {
    /// Delete the copy. Refuses anything that is not an Atlas sandbox folder.
    pub fn discard(self) -> io::Result<()> {
        discard_dir(&self.root.dir)
    }
}

pub fn is_sandbox_dir(dir: &Path) -> bool {
    dir.file_name().is_some_and(|n| n.to_string_lossy().starts_with(DIR_PREFIX))
        && dir.join(MARKER).is_file()
}

pub fn discard_dir(dir: &Path) -> io::Result<()> {
    if !is_sandbox_dir(dir) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{} is not an Atlas sandbox folder; not deleting it", dir.display()),
        ));
    }
    fs::remove_dir_all(dir)
}

/// Remove sandbox folders under `parent` older than `older_than` (left behind by
/// a crash). Returns how many were removed.
pub fn cleanup_stale(parent: &Path, older_than: Duration) -> usize {
    let Ok(entries) = fs::read_dir(parent) else { return 0 };
    let mut removed = 0;
    for e in entries.filter_map(Result::ok) {
        let p = e.path();
        if !is_sandbox_dir(&p) {
            continue;
        }
        let age = fs::metadata(p.join(MARKER))
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| SystemTime::now().duration_since(t).ok());
        if age.is_some_and(|a| a >= older_than) && discard_dir(&p).is_ok() {
            removed += 1;
        }
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn write(root: &Path, rel: &str, body: &[u8]) {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, body).unwrap();
    }

    /// A small config folder with every kind of file the rules care about.
    fn make_source(base: &Path) -> ConfigRoot {
        let dir = base.join("claude");
        write(&dir, "CLAUDE.md", b"# hello\r\n");
        write(&dir, "settings.json", b"{\"model\":\"x\"}");
        write(&dir, "skills/a/SKILL.md", b"---\nname: a\n---\n");
        write(&dir, "skills/a/helper.py", b"print(1)");
        write(&dir, "agents/r.md", b"agent");
        write(&dir, ".credentials.json", b"{\"secret\":\"S\"}");
        write(&dir, "sessions/abc.key", b"K");
        write(&dir, "history.jsonl", b"{}");
        write(&dir, "backups/old.json", b"b");
        write(&dir, "cache/c.bin", b"c");
        write(&dir, "plugins/p/node_modules/x.js", b"x");
        write(&dir, "plugins/p/.git/HEAD", b"ref");
        write(&dir, "plugins/p/server.key", b"K");
        write(&dir, "plugins/p/ok.json", b"{}");
        write(&dir, "daemon.lock", b"1");
        write(&dir, "projects/-p/s1.jsonl", b"{\"type\":\"user\"}\n");
        write(&dir, ".claude.json", b"{\"stray\":true}"); // stray one inside
        let mut root = ConfigRoot::rooted_at(dir.clone(), ConfigSource::Env);
        // The real global file lives beside the folder in this scenario.
        root.claude_json = base.join("global.json");
        write(base, "global.json", b"{\"mcpServers\":{}}");
        root
    }

    fn tree(root: &Path) -> Vec<(String, Vec<u8>)> {
        fn walk(dir: &Path, base: &Path, out: &mut Vec<(String, Vec<u8>)>) {
            let mut es: Vec<_> = fs::read_dir(dir).unwrap().map(|e| e.unwrap()).collect();
            es.sort_by_key(|e| e.file_name());
            for e in es {
                let p = e.path();
                if p.is_dir() {
                    walk(&p, base, out);
                } else {
                    let rel = p.strip_prefix(base).unwrap().to_string_lossy().replace('\\', "/");
                    out.push((rel, fs::read(&p).unwrap()));
                }
            }
        }
        let mut out = Vec::new();
        walk(root, root, &mut out);
        out
    }

    #[test]
    fn copies_config_and_leaves_out_secrets_and_bulk() {
        let d = tempdir().unwrap();
        let src = make_source(d.path());
        let sb = create(&src, &d.path().join("tmp"), &SandboxOptions::default()).unwrap();
        let copied: Vec<String> = tree(&sb.root.dir).into_iter().map(|(p, _)| p).collect();
        for want in [
            "CLAUDE.md",
            "settings.json",
            "skills/a/SKILL.md",
            "skills/a/helper.py",
            "agents/r.md",
            "plugins/p/ok.json",
            ".claude.json",
            MARKER,
        ] {
            assert!(copied.iter().any(|c| c == want), "missing {want} in {copied:?}");
        }
        for banned in [
            ".credentials.json",
            "sessions/abc.key",
            "history.jsonl",
            "backups/old.json",
            "cache/c.bin",
            "plugins/p/node_modules/x.js",
            "plugins/p/.git/HEAD",
            "plugins/p/server.key",
            "daemon.lock",
            "projects/-p/s1.jsonl",
        ] {
            assert!(!copied.iter().any(|c| c == banned), "{banned} must not be copied");
        }
        // Nothing secret anywhere in the copy, whatever the name.
        for (_, body) in tree(&sb.root.dir) {
            assert!(!String::from_utf8_lossy(&body).contains("\"secret\""));
        }
        assert_eq!(sb.root.source, ConfigSource::Sandbox);
        assert!(sb.report.skipped.iter().any(|s| s.path == ".credentials.json" && s.reason == SkipReason::Sensitive));
        assert!(sb.report.files_copied >= 7);
    }

    #[test]
    fn the_real_claude_json_replaces_a_stray_one_inside_the_folder() {
        let d = tempdir().unwrap();
        let src = make_source(d.path());
        let sb = create(&src, &d.path().join("tmp"), &SandboxOptions::default()).unwrap();
        assert_eq!(fs::read(sb.root.claude_json).unwrap(), b"{\"mcpServers\":{}}");
        assert!(sb.report.claude_json_copied);
    }

    #[test]
    fn source_is_never_modified() {
        let d = tempdir().unwrap();
        let src = make_source(d.path());
        let before = tree(d.path());
        let sb = create(&src, &d.path().join("tmp"), &SandboxOptions::default()).unwrap();
        // Work on the copy like the app would.
        fs::write(sb.root.dir.join("settings.json"), b"changed").unwrap();
        fs::remove_file(sb.root.dir.join("CLAUDE.md")).unwrap();
        fs::remove_dir_all(sb.root.dir.join("skills")).unwrap();
        let after: Vec<_> = tree(d.path())
            .into_iter()
            .filter(|(p, _)| !p.starts_with("tmp/"))
            .collect();
        assert_eq!(before, after, "the source tree changed");
        sb.discard().unwrap();
    }

    #[test]
    fn projects_are_linked_read_only_or_excluded() {
        let d = tempdir().unwrap();
        let src = make_source(d.path());
        let linked = create(&src, &d.path().join("tmp"), &SandboxOptions::default()).unwrap();
        assert!(linked.root.projects_read_only);
        assert_eq!(linked.root.projects_dir, src.projects_dir);
        assert!(!linked.root.dir.join("projects").exists());

        let opts = SandboxOptions { projects: ProjectsMode::Exclude, ..Default::default() };
        let excluded = create(&src, &d.path().join("tmp"), &opts).unwrap();
        assert!(!excluded.root.projects_read_only);
        assert_eq!(excluded.root.projects_dir, excluded.root.dir.join("projects"));
        assert!(!excluded.root.projects_dir.exists());
    }

    #[test]
    fn large_files_and_the_total_budget_are_skipped() {
        let d = tempdir().unwrap();
        let src = make_source(d.path());
        write(&src.dir, "big.bin", &vec![0u8; 5000]);
        let opts = SandboxOptions { max_file_bytes: 1000, ..Default::default() };
        let sb = create(&src, &d.path().join("tmp"), &opts).unwrap();
        assert!(!sb.root.dir.join("big.bin").exists());
        assert!(sb.report.skipped.iter().any(|s| s.path == "big.bin" && s.reason == SkipReason::TooLarge));

        let opts = SandboxOptions { max_total_bytes: 20, ..Default::default() };
        let sb = create(&src, &d.path().join("tmp"), &opts).unwrap();
        assert!(sb.report.bytes_copied <= 20);
        assert!(sb.report.skipped.iter().any(|s| s.reason == SkipReason::OverBudget));
    }

    #[test]
    fn missing_source_and_destination_inside_source_are_errors() {
        let d = tempdir().unwrap();
        let gone = ConfigRoot::rooted_at(d.path().join("nope"), ConfigSource::Flag);
        assert!(matches!(
            create(&gone, &d.path().join("tmp"), &SandboxOptions::default()),
            Err(SandboxError::SourceMissing(_))
        ));
        let src = make_source(d.path());
        let inside = src.dir.join("skills");
        assert!(matches!(
            create(&src, &inside, &SandboxOptions::default()),
            Err(SandboxError::InsideSource(_))
        ));
        // And nothing was created inside the source by the refused call.
        assert!(!fs::read_dir(&inside).unwrap().any(|e| {
            e.unwrap().file_name().to_string_lossy().starts_with(DIR_PREFIX)
        }));
    }

    #[test]
    fn discard_only_deletes_marked_sandbox_folders() {
        let d = tempdir().unwrap();
        let src = make_source(d.path());
        let sb = create(&src, &d.path().join("tmp"), &SandboxOptions::default()).unwrap();
        let dir = sb.root.dir.clone();
        assert!(is_sandbox_dir(&dir));
        sb.discard().unwrap();
        assert!(!dir.exists());

        // The source itself, and a look-alike without the marker, are refused.
        assert!(discard_dir(&src.dir).is_err());
        let fake = d.path().join(format!("{DIR_PREFIX}fake"));
        fs::create_dir(&fake).unwrap();
        assert!(discard_dir(&fake).is_err());
        assert!(fake.exists() && src.dir.exists());
    }

    #[test]
    fn cleanup_removes_only_old_marked_folders() {
        let d = tempdir().unwrap();
        let src = make_source(d.path());
        let tmp = d.path().join("tmp");
        let sb = create(&src, &tmp, &SandboxOptions::default()).unwrap();
        let other = tmp.join("something-else");
        fs::create_dir_all(&other).unwrap();
        assert_eq!(cleanup_stale(&tmp, Duration::from_secs(3600)), 0, "fresh sandbox must stay");
        assert_eq!(cleanup_stale(&tmp, Duration::ZERO), 1);
        assert!(!sb.root.dir.exists());
        assert!(other.exists());
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn file_symlinks_are_copied_as_files_and_folder_links_are_skipped() {
        let d = tempdir().unwrap();
        let src = make_source(d.path());
        let real = d.path().join("dotfiles-settings.json");
        fs::write(&real, b"{\"linked\":true}").unwrap();
        let realdir = d.path().join("dotfiles-dir");
        fs::create_dir(&realdir).unwrap();
        fs::write(realdir.join("x"), b"x").unwrap();
        #[cfg(unix)]
        let ok = std::os::unix::fs::symlink(&real, src.dir.join("settings.local.json")).is_ok()
            && std::os::unix::fs::symlink(&realdir, src.dir.join("linked-dir")).is_ok();
        #[cfg(windows)]
        let ok = std::os::windows::fs::symlink_file(&real, src.dir.join("settings.local.json")).is_ok()
            && std::os::windows::fs::symlink_dir(&realdir, src.dir.join("linked-dir")).is_ok();
        if !ok {
            eprintln!("skipped: this machine may not create symlinks");
            return;
        }
        let sb = create(&src, &d.path().join("tmp"), &SandboxOptions::default()).unwrap();
        let copy = sb.root.dir.join("settings.local.json");
        assert!(!fs::symlink_metadata(&copy).unwrap().file_type().is_symlink());
        assert_eq!(fs::read(copy).unwrap(), b"{\"linked\":true}");
        assert!(!sb.root.dir.join("linked-dir").exists());
        assert!(sb.report.skipped.iter().any(|s| s.path == "linked-dir" && s.reason == SkipReason::FolderLink));
    }
}
