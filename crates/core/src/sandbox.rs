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
//! - folder symlinks, and file symlinks that point outside the source folder or
//!   at something the rules above would leave out (a link to `~/.ssh/id_rsa` or
//!   `.credentials.json` must not be followed into the temp folder).
//!
//! Secrets inside what *is* copied are blanked (`redact`): `env` values, headers,
//! `--token` arguments and OAuth/account records in `.claude.json`,
//! `settings*.json` and MCP config. A file that cannot be redacted (not valid
//! JSON) is left out rather than copied raw.
//!
//! The big `projects/` transcripts are handled by `ProjectsMode`: left out, or
//! linked read-only (the copy's `ConfigRoot::projects_dir` points at the real
//! folder and is flagged `projects_read_only`, so nothing can ever write there).
//!
//! Safety: nothing is ever written under the source. `create` refuses a
//! destination inside the source or inside the real Claude config, and
//! `discard` only deletes folders that carry Atlas's marker file. The marker is
//! written first (a copy killed half-way is still recognised and swept) and
//! deleted last (so is a delete killed half-way). It names the owning process,
//! and its modified time is refreshed while that process lives (`touch`), so the
//! sweep never removes a sandbox another running Atlas is using. On Unix the
//! sandbox folder is owner-only.

use std::fs::{self, File};
use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::json;

use crate::fsutil::check_write_allowed;
use crate::paths::{ConfigRoot, ConfigSource};
use crate::redact;

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
    /// A file symlink that leaves the source folder, or points at something that
    /// is itself left out.
    FileLink,
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
    #[error("the copy was cancelled")]
    Cancelled,
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
    cancel: &'a AtomicBool,
    /// Canonical source folder: a file symlink must resolve inside it.
    source_abs: &'a Path,
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
    create_cancellable(source, parent, opts, &AtomicBool::new(false))
}

/// Like `create`, but stops (and removes the half-built copy) soon after `cancel`
/// turns true: a superseded or shutting-down copy must not keep running.
pub fn create_cancellable(
    source: &ConfigRoot,
    parent: &Path,
    opts: &SandboxOptions,
    cancel: &AtomicBool,
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
    create_private_dir(&dest)?;
    // The marker goes in first: a copy that is killed half-way is still a
    // recognisable sandbox that the sweep can remove.
    if let Err(e) = write_marker(source, &dest, opts) {
        let _ = fs::remove_dir_all(&dest);
        return Err(e.into());
    }

    // Anything that goes wrong from here on removes the half-built copy.
    match copy_into(source, &source_abs, &dest, opts, cancel) {
        Ok(report) => {
            let mut root = ConfigRoot::rooted_at(dest, ConfigSource::Sandbox);
            if opts.projects == ProjectsMode::ReadOnlyLink {
                root.projects_dir = source.projects_dir.clone();
                root.projects_read_only = true;
            }
            Ok(Sandbox { root, report })
        }
        Err(e) => {
            // Leave the marker for last, like `discard`, in case this is cut short too.
            if discard_dir(&dest).is_err() {
                let _ = fs::remove_dir_all(&dest);
            }
            Err(e)
        }
    }
}

/// The sandbox folder: owner-only on Unix (it sits in a shared temp folder).
fn create_private_dir(dest: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new().mode(0o700).create(dest)
    }
    #[cfg(not(unix))]
    {
        fs::create_dir(dest)
    }
}

fn write_marker(source: &ConfigRoot, dest: &Path, opts: &SandboxOptions) -> io::Result<()> {
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
    fs::write(dest.join(MARKER), serde_json::to_vec_pretty(&marker).expect("marker json"))
}

fn copy_into(
    source: &ConfigRoot,
    source_abs: &Path,
    dest: &Path,
    opts: &SandboxOptions,
    cancel: &AtomicBool,
) -> Result<SandboxReport, SandboxError> {
    let mut ctx = Ctx { opts, cancel, source_abs, report: SandboxReport::default() };

    copy_dir(source_abs, dest, "", 0, &mut ctx)?;

    // The global state file: it may live beside the home folder, or inside the
    // config dir (in which case copy_dir already brought a stray copy; the real
    // one wins).
    let target = dest.join(".claude.json");
    if source.claude_json.is_file() {
        let len = fs::metadata(&source.claude_json).map(|m| m.len()).unwrap_or(0);
        if len <= 64 * 1024 * 1024 {
            // Same redaction as every other settings file. Not valid JSON: leave
            // it out rather than copy tokens raw.
            let redacted = fs::read(&source.claude_json)
                .ok()
                .and_then(|bytes| redact::redact_json_bytes(&bytes));
            match redacted {
                Some(bytes) => {
                    fs::write(&target, bytes)?;
                    ctx.report.claude_json_copied = true;
                }
                None => {
                    let _ = fs::remove_file(&target);
                    ctx.skip(".claude.json", SkipReason::Sensitive);
                }
            }
        }
    } else if target.exists() {
        // A stray one from the folder copy with no real counterpart: drop it so
        // the sandbox looks like the source does.
        let _ = fs::remove_file(&target);
    }

    check_cancel(ctx.cancel)?;
    Ok(ctx.report)
}

fn check_cancel(cancel: &AtomicBool) -> Result<(), SandboxError> {
    if cancel.load(Ordering::Relaxed) { Err(SandboxError::Cancelled) } else { Ok(()) }
}

/// Decide whether a file symlink may be copied. `target` is its canonical
/// destination; `source_abs` the canonical source folder. A link that leaves the
/// source, or lands on something the normal rules leave out (a secret, a bulk
/// folder, a `.git` tree), is skipped. Never follows a link blindly.
fn symlink_verdict(source_abs: &Path, target: &Path) -> Option<SkipReason> {
    let Ok(inside) = target.strip_prefix(source_abs) else {
        return Some(SkipReason::FileLink);
    };
    let parts: Vec<String> = inside
        .components()
        .filter_map(|c| match c {
            Component::Normal(n) => Some(n.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect();
    if parts.is_empty() {
        return Some(SkipReason::FileLink);
    }
    let last = parts.len() - 1;
    for (depth, part) in parts.iter().enumerate() {
        if let Some(reason) = skip_reason(part, depth, depth != last) {
            return Some(reason);
        }
    }
    // `projects/` is never copied, so a link into it must not smuggle it in.
    if parts[0].eq_ignore_ascii_case("projects") {
        return Some(SkipReason::Bulk);
    }
    None
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
        check_cancel(ctx.cancel)?;
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
            // A file symlink is only followed to something inside the source
            // that would have been copied anyway. Copy from the resolved path
            // (not the link) so the target cannot change between check and copy.
            let from = if is_link {
                let Ok(target) = fs::canonicalize(&path) else {
                    ctx.skip(&rel_path, SkipReason::Unreadable);
                    continue;
                };
                if symlink_verdict(ctx.source_abs, &target).is_some() {
                    ctx.skip(&rel_path, SkipReason::FileLink);
                    continue;
                }
                target
            } else {
                path.clone()
            };
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
            let copied = if redact::needs_redaction(&name) {
                match fs::read(&from) {
                    Ok(bytes) => match redact::redact_json_bytes(&bytes) {
                        Some(clean) => fs::write(&out, clean).map(|_| ()),
                        None => {
                            // Not valid JSON: cannot be redacted, so not copied.
                            ctx.skip(&rel_path, SkipReason::Sensitive);
                            continue;
                        }
                    },
                    Err(e) => Err(e),
                }
            } else {
                fs::copy(&from, &out).map(|_| ())
            };
            match copied {
                Ok(()) => {
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
    // Everything but the marker first, the marker last: a delete that is cut
    // short leaves a folder that is still recognised as a sandbox.
    for entry in fs::read_dir(dir)?.filter_map(Result::ok) {
        if entry.file_name() == MARKER {
            continue;
        }
        let p = entry.path();
        let is_dir = entry.file_type().map(|t| t.is_dir() && !t.is_symlink()).unwrap_or(false);
        let r = if is_dir { fs::remove_dir_all(&p) } else { remove_file_any(&p) };
        r?;
    }
    fs::remove_file(dir.join(MARKER))?;
    fs::remove_dir(dir)
}

/// `remove_file`, which also removes a directory symlink on Windows.
fn remove_file_any(p: &Path) -> io::Result<()> {
    fs::remove_file(p).or_else(|_| fs::remove_dir(p))
}

/// Refresh the marker's modified time. The running Atlas calls this every few
/// minutes for its live sandbox, which is what tells `cleanup_stale` the folder
/// is in use.
pub fn touch(dir: &Path) -> io::Result<()> {
    let marker = dir.join(MARKER);
    if !is_sandbox_dir(dir) {
        return Err(io::Error::new(io::ErrorKind::NotFound, "not an Atlas sandbox folder"));
    }
    File::options().write(true).open(marker)?.set_modified(SystemTime::now())
}

/// A dead owner's sandbox is garbage once this much time has passed (the grace
/// only guards against a marker still being written).
const DEAD_OWNER_GRACE: Duration = Duration::from_secs(5 * 60);
/// A live owner's sandbox is kept this long without a refresh; past it the pid
/// was most likely reused by an unrelated program.
const LIVE_OWNER_CAP: Duration = Duration::from_secs(14 * 24 * 3600);

/// Remove sandbox folders under `parent` left behind by a crash. Returns how
/// many were removed. Never removes the sandbox of a process that is still
/// running, however old it is.
pub fn cleanup_stale(parent: &Path, older_than: Duration) -> usize {
    cleanup_stale_with(parent, older_than, &pid_alive)
}

/// `cleanup_stale` with the "is this process running" check passed in.
///
/// - owner running: kept (up to `LIVE_OWNER_CAP` without a refresh);
/// - owner gone: removed after a short grace;
/// - marker without a readable pid (older format): removed once `older_than` old.
pub fn cleanup_stale_with(parent: &Path, older_than: Duration, alive: &dyn Fn(u32) -> bool) -> usize {
    let Ok(entries) = fs::read_dir(parent) else { return 0 };
    let mut removed = 0;
    for e in entries.filter_map(Result::ok) {
        let p = e.path();
        if !is_sandbox_dir(&p) {
            continue;
        }
        let marker = p.join(MARKER);
        let Some(age) = fs::metadata(&marker)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| SystemTime::now().duration_since(t).ok())
        else {
            continue;
        };
        let pid = fs::read(&marker)
            .ok()
            .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
            .and_then(|v| v.get("pid")?.as_u64())
            .and_then(|p| u32::try_from(p).ok());
        let stale = match pid {
            Some(pid) if alive(pid) => age >= LIVE_OWNER_CAP,
            Some(_) => age >= DEAD_OWNER_GRACE.min(older_than),
            None => age >= older_than,
        };
        if stale && discard_dir(&p).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// Is a process with this id running? When unsure, says yes: a sandbox is only
/// removed when its owner is certainly gone.
#[cfg(windows)]
pub fn pid_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, ERROR_ACCESS_DENIED, GetLastError, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    // SAFETY: plain Win32 calls; the handle is closed before returning.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return GetLastError() == ERROR_ACCESS_DENIED;
        }
        let mut code = 0u32;
        let ok = GetExitCodeProcess(handle, &mut code);
        CloseHandle(handle);
        ok == 0 || code == STILL_ACTIVE as u32
    }
}

#[cfg(unix)]
pub fn pid_alive(pid: u32) -> bool {
    if pid == 0 || pid > i32::MAX as u32 {
        return false;
    }
    // SAFETY: signal 0 only checks that the process exists.
    let r = unsafe { libc::kill(pid as i32, 0) };
    r == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(not(any(unix, windows)))]
pub fn pid_alive(_pid: u32) -> bool {
    true
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
        let copied: serde_json::Value = serde_json::from_slice(&fs::read(sb.root.claude_json).unwrap()).unwrap();
        assert_eq!(copied, json!({ "mcpServers": {} }));
        assert!(sb.report.claude_json_copied);
    }

    #[test]
    fn copies_carry_no_tokens_from_claude_json_settings_or_mcp_files() {
        let d = tempdir().unwrap();
        let src = make_source(d.path());
        write(
            d.path(),
            "global.json",
            br#"{"oauthAccount":{"emailAddress":"dad@example.com"},
                 "mcpServers":{"gh":{"command":"npx","env":{"GITHUB_TOKEN":"ghp_LIVE"}}},
                 "numStartups":3}"#,
        );
        write(&src.dir, "settings.json", br#"{"model":"opus","env":{"ANTHROPIC_API_KEY":"sk-LIVE"}}"#);
        write(&src.dir, "settings.local.json", br#"{"headers":{"Authorization":"Bearer LIVE"}}"#);
        write(&src.dir, "plugins/p/.mcp.json", br#"{"s":{"args":["--token=LIVE"]}}"#);
        let sb = create(&src, &d.path().join("tmp"), &SandboxOptions::default()).unwrap();
        for (_, body) in tree(&sb.root.dir) {
            let text = String::from_utf8_lossy(&body);
            for leaked in ["ghp_LIVE", "sk-LIVE", "Bearer LIVE", "--token=LIVE", "dad@example.com"] {
                assert!(!text.contains(leaked), "{leaked} leaked into the sandbox");
            }
        }
        // Structure and harmless values survive.
        let g: serde_json::Value = serde_json::from_slice(&fs::read(&sb.root.claude_json).unwrap()).unwrap();
        assert_eq!(g["numStartups"], 3);
        assert_eq!(g["mcpServers"]["gh"]["command"], "npx");
        assert!(g["mcpServers"]["gh"]["env"].get("GITHUB_TOKEN").is_some());
        let s: serde_json::Value =
            serde_json::from_slice(&fs::read(sb.root.dir.join("settings.json")).unwrap()).unwrap();
        assert_eq!(s["model"], "opus");
        // The real files were not touched.
        assert!(String::from_utf8(fs::read(src.dir.join("settings.json")).unwrap()).unwrap().contains("sk-LIVE"));
    }

    #[test]
    fn a_settings_file_that_cannot_be_redacted_is_left_out_not_copied_raw() {
        let d = tempdir().unwrap();
        let src = make_source(d.path());
        write(&src.dir, "settings.json", b"{ // not strict json\n \"env\": {\"T\": \"LIVE\"} }");
        write(d.path(), "global.json", b"not json at all LIVE");
        let sb = create(&src, &d.path().join("tmp"), &SandboxOptions::default()).unwrap();
        assert!(!sb.root.dir.join("settings.json").exists());
        assert!(!sb.root.claude_json.exists());
        assert!(!sb.report.claude_json_copied);
        assert!(sb.report.skipped.iter().any(|s| s.path == "settings.json" && s.reason == SkipReason::Sensitive));
        for (_, body) in tree(&sb.root.dir) {
            assert!(!String::from_utf8_lossy(&body).contains("LIVE"));
        }
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
    fn cleanup_removes_only_marked_folders_whose_owner_is_gone() {
        let d = tempdir().unwrap();
        let src = make_source(d.path());
        let tmp = d.path().join("tmp");
        let sb = create(&src, &tmp, &SandboxOptions::default()).unwrap();
        let other = tmp.join("something-else");
        fs::create_dir_all(&other).unwrap();
        let day = Duration::from_secs(24 * 3600);

        // Fresh, owner gone: inside the grace, so it stays.
        assert_eq!(cleanup_stale_with(&tmp, day, &|_| false), 0, "a fresh sandbox must stay");
        // Owner running: never removed, however eager the caller is.
        assert_eq!(cleanup_stale_with(&tmp, Duration::ZERO, &|_| true), 0);
        // Owner gone and the caller wants everything older than zero: removed.
        assert_eq!(cleanup_stale_with(&tmp, Duration::ZERO, &|_| false), 1);
        assert!(!sb.root.dir.exists());
        assert!(other.exists(), "folders without the marker are never touched");
    }

    fn age_marker(dir: &Path, by: Duration) {
        let f = File::options().write(true).open(dir.join(MARKER)).unwrap();
        f.set_modified(SystemTime::now() - by).unwrap();
    }

    #[test]
    fn a_sandbox_another_running_instance_has_open_for_days_is_not_swept() {
        let d = tempdir().unwrap();
        let src = make_source(d.path());
        let tmp = d.path().join("tmp");
        let live = create(&src, &tmp, &SandboxOptions::default()).unwrap();
        let day = Duration::from_secs(24 * 3600);
        age_marker(&live.root.dir, 3 * day);
        assert_eq!(cleanup_stale_with(&tmp, day, &|_| true), 0, "owner is still running");
        assert!(live.root.dir.exists());
        // The real process check agrees about this test process.
        assert!(pid_alive(std::process::id()));
        assert_eq!(cleanup_stale(&tmp, day), 0);
        assert!(live.root.dir.exists());
        // Once the owner is gone it goes.
        assert_eq!(cleanup_stale_with(&tmp, day, &|_| false), 1);
        assert!(!live.root.dir.exists());
    }

    #[test]
    fn a_pid_that_is_reused_by_something_else_does_not_pin_a_sandbox_forever() {
        let d = tempdir().unwrap();
        let src = make_source(d.path());
        let tmp = d.path().join("tmp");
        let sb = create(&src, &tmp, &SandboxOptions::default()).unwrap();
        age_marker(&sb.root.dir, Duration::from_secs(30 * 24 * 3600));
        assert_eq!(cleanup_stale_with(&tmp, Duration::from_secs(24 * 3600), &|_| true), 1);
    }

    #[test]
    fn touching_the_marker_keeps_a_sandbox_fresh() {
        let d = tempdir().unwrap();
        let src = make_source(d.path());
        let tmp = d.path().join("tmp");
        let sb = create(&src, &tmp, &SandboxOptions::default()).unwrap();
        age_marker(&sb.root.dir, Duration::from_secs(3 * 24 * 3600));
        // Owner gone but the folder was refreshed a moment ago: inside the grace.
        touch(&sb.root.dir).unwrap();
        assert_eq!(cleanup_stale_with(&tmp, Duration::from_secs(24 * 3600), &|_| false), 0);
        assert!(touch(&d.path().join("tmp")).is_err(), "only sandbox folders can be touched");
    }

    #[test]
    fn pid_alive_tells_a_running_process_from_a_finished_one() {
        assert!(pid_alive(std::process::id()));
        // This test binary lists its tests and exits at once.
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .arg("--list")
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let pid = child.id();
        child.wait().unwrap();
        assert!(!pid_alive(pid), "pid {pid} should be gone");
    }

    #[test]
    fn a_copy_that_dies_half_way_is_still_a_sandbox_the_sweep_can_remove() {
        // Simulate a crash part-way: no discard, and the copy is incomplete.
        let d = tempdir().unwrap();
        let src = make_source(d.path());
        let tmp = d.path().join("tmp");
        let sb = create(&src, &tmp, &SandboxOptions::default()).unwrap();
        let dir = sb.root.dir.clone();
        std::mem::forget(sb);
        fs::remove_dir_all(dir.join("skills")).unwrap();
        fs::remove_file(dir.join("CLAUDE.md")).unwrap();
        assert!(is_sandbox_dir(&dir));
        assert_eq!(cleanup_stale_with(&tmp, Duration::ZERO, &|_| false), 1);
        assert!(!dir.exists());
    }

    #[test]
    fn the_marker_exists_before_any_file_is_copied() {
        // A cancelled copy at the very start must have gone through the marker
        // step and cleaned up after itself; a copy that is *killed* there leaves
        // a folder holding only the marker, which the sweep can then identify.
        let d = tempdir().unwrap();
        let src = make_source(d.path());
        let tmp = d.path().join("tmp");
        let dest = tmp.join(format!("{DIR_PREFIX}1-1"));
        fs::create_dir_all(&dest).unwrap();
        write_marker(&src, &dest, &SandboxOptions::default()).unwrap();
        assert!(is_sandbox_dir(&dest));
        assert_eq!(cleanup_stale_with(&tmp, Duration::ZERO, &|_| false), 1);
    }

    #[test]
    fn discard_removes_the_marker_last() {
        let d = tempdir().unwrap();
        let src = make_source(d.path());
        let sb = create(&src, &d.path().join("tmp"), &SandboxOptions::default()).unwrap();
        let dir = sb.root.dir.clone();
        // An open handle blocks the delete of one file on Windows, which stops the
        // discard part-way. (Unix lets an open file go, so there is nothing to prove.)
        let blocked = dir.join("zz-held.txt");
        fs::write(&blocked, b"x").unwrap();
        #[cfg(windows)]
        let held = {
            use std::os::windows::fs::OpenOptionsExt;
            // Share read only: no FILE_SHARE_DELETE, so the delete is refused.
            File::options().read(true).share_mode(1).open(&blocked).unwrap()
        };
        #[cfg(not(windows))]
        let held = File::open(&blocked).unwrap();
        if cfg!(windows) {
            assert!(discard_dir(&dir).is_err(), "the held file should block the delete");
            assert!(is_sandbox_dir(&dir), "the marker must outlive a delete that stopped part-way");
        }
        drop(held);
        discard_dir(&dir).unwrap();
        assert!(!dir.exists());
    }

    #[test]
    fn a_cancelled_copy_leaves_nothing_behind() {
        let d = tempdir().unwrap();
        let src = make_source(d.path());
        let tmp = d.path().join("tmp");
        let cancel = AtomicBool::new(true);
        let r = create_cancellable(&src, &tmp, &SandboxOptions::default(), &cancel);
        assert!(matches!(r, Err(SandboxError::Cancelled)));
        let left: Vec<_> = fs::read_dir(&tmp).unwrap().filter_map(Result::ok).collect();
        assert!(left.is_empty(), "left behind: {left:?}");
    }

    #[cfg(unix)]
    #[test]
    fn the_sandbox_folder_is_owner_only_on_unix() {
        use std::os::unix::fs::PermissionsExt;
        let d = tempdir().unwrap();
        let src = make_source(d.path());
        let sb = create(&src, &d.path().join("tmp"), &SandboxOptions::default()).unwrap();
        let mode = fs::metadata(&sb.root.dir).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700);
    }

    #[test]
    fn symlink_rules_follow_only_what_would_have_been_copied() {
        let d = tempdir().unwrap();
        let src = d.path().join("src");
        let at = |rel: &str| src.join(rel);
        let elsewhere = d.path().join("home").join(".ssh").join("id_rsa");
        // Outside the source: never.
        assert_eq!(symlink_verdict(&src, &elsewhere), Some(SkipReason::FileLink));
        assert_eq!(symlink_verdict(&src, &d.path().join("srcother").join("x")), Some(SkipReason::FileLink));
        // The source folder itself is not a file.
        assert_eq!(symlink_verdict(&src, &src), Some(SkipReason::FileLink));
        // Inside, but something the normal rules leave out.
        assert_eq!(symlink_verdict(&src, &at(".credentials.json")), Some(SkipReason::Sensitive));
        assert_eq!(symlink_verdict(&src, &at("sessions/a.json")), Some(SkipReason::Sensitive));
        assert_eq!(symlink_verdict(&src, &at("plugins/p/server.key")), Some(SkipReason::Sensitive));
        assert_eq!(symlink_verdict(&src, &at("plugins/p/.git/config")), Some(SkipReason::Bulk));
        assert_eq!(symlink_verdict(&src, &at("backups/x.json")), Some(SkipReason::Bulk));
        assert_eq!(symlink_verdict(&src, &at("projects/-p/s.jsonl")), Some(SkipReason::Bulk));
        // Inside and ordinary: fine.
        assert_eq!(symlink_verdict(&src, &at("skills/a/SKILL.md")), None);
        assert_eq!(symlink_verdict(&src, &at("CLAUDE.md")), None);
    }

    #[cfg(any(unix, windows))]
    fn try_symlink_file(target: &Path, link: &Path) -> bool {
        #[cfg(unix)]
        let r = std::os::unix::fs::symlink(target, link);
        #[cfg(windows)]
        let r = std::os::windows::fs::symlink_file(target, link);
        r.is_ok()
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn file_symlinks_are_not_followed_out_of_the_source_or_into_secrets() {
        let d = tempdir().unwrap();
        let src = make_source(d.path());
        // Something private outside the config folder (stands in for ~/.ssh/id_rsa).
        let outside = d.path().join("id_rsa");
        fs::write(&outside, b"PRIVATE KEY MATERIAL").unwrap();
        let dotfile = d.path().join("dotfiles-CLAUDE.md");
        fs::write(&dotfile, b"# from dotfiles").unwrap();
        let creds = src.dir.join(".credentials.json");
        let key = src.dir.join("sessions/abc.key");
        let inside_ok = src.dir.join("skills/a/SKILL.md");
        let links: [(&Path, &str); 5] = [
            (&outside, "notes.txt"),
            (&dotfile, "linked-claude.md"),
            (&creds, "innocent-name.json"),
            (&key, "innocent-name2.json"),
            (&inside_ok, "skill-link.md"),
        ];
        for (target, name) in links {
            if !try_symlink_file(target, &src.dir.join(name)) {
                eprintln!("skipped: this machine may not create symlinks");
                return;
            }
        }
        let sb = create(&src, &d.path().join("tmp"), &SandboxOptions::default()).unwrap();

        for name in ["notes.txt", "linked-claude.md", "innocent-name.json", "innocent-name2.json"] {
            assert!(!sb.root.dir.join(name).exists(), "{name} must not be copied");
            assert!(
                sb.report.skipped.iter().any(|s| s.path == name && s.reason == SkipReason::FileLink),
                "{name} should be reported as a skipped link: {:?}",
                sb.report.skipped
            );
        }
        // Nothing from the private file or the credentials reached the copy.
        for (_, body) in tree(&sb.root.dir) {
            let text = String::from_utf8_lossy(&body);
            assert!(!text.contains("PRIVATE KEY MATERIAL"));
            assert!(!text.contains("\"secret\""));
        }
        // A link to an ordinary file inside the source is copied as a plain file.
        let copy = sb.root.dir.join("skill-link.md");
        assert!(!fs::symlink_metadata(&copy).unwrap().file_type().is_symlink());
        assert_eq!(fs::read(copy).unwrap(), b"---\nname: a\n---\n");
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn folder_links_are_skipped() {
        let d = tempdir().unwrap();
        let src = make_source(d.path());
        let realdir = d.path().join("dotfiles-dir");
        fs::create_dir(&realdir).unwrap();
        fs::write(realdir.join("x"), b"x").unwrap();
        #[cfg(unix)]
        let ok = std::os::unix::fs::symlink(&realdir, src.dir.join("linked-dir")).is_ok();
        #[cfg(windows)]
        let ok = std::os::windows::fs::symlink_dir(&realdir, src.dir.join("linked-dir")).is_ok();
        if !ok {
            eprintln!("skipped: this machine may not create symlinks");
            return;
        }
        let sb = create(&src, &d.path().join("tmp"), &SandboxOptions::default()).unwrap();
        assert!(!sb.root.dir.join("linked-dir").exists());
        assert!(sb.report.skipped.iter().any(|s| s.path == "linked-dir" && s.reason == SkipReason::FolderLink));
    }
}
