//! Safe file writing.
//!
//! `atomic_write` is the primitive every later write goes through: bytes land in
//! a temp file beside the target (same folder, so the rename cannot cross a
//! volume), are flushed to disk, and then replace the target in one rename. A
//! crash leaves either the old file or the new one, never half of each. A
//! symlinked target is resolved first so the link survives.
//!
//! Phase 4 adds the backup snapshot and journal on top; this layer is only the
//! atomic step plus the guard below.
//!
//! **Guard.** In debug builds (`cargo test`, `cargo tauri dev`) any write that
//! lands inside the real `~/.claude`, `~/.claude.json*` or `$CLAUDE_CONFIG_DIR`
//! is refused. Tests and development use fixtures, `--config-dir` or Sandbox
//! Mode, so a bug cannot damage the real configuration. Release builds do not
//! apply it (Phase 4 writes the real config on purpose, through backups).

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread::sleep;
use std::time::Duration;

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// Write `bytes` to `path` atomically. Creates missing parent folders.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let target = resolve_link_target(path)?;
    check_write_allowed(&target)?;
    fail_fast_if_read_only(&target)?;

    let dir = target
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no parent folder"))?;
    fs::create_dir_all(dir)?;

    let name = target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp = dir.join(format!(
        ".{name}.atlas-tmp-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    ));

    let result = (|| {
        let mut f = OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        if let Ok(meta) = fs::metadata(&target) {
            // Keep the mode of the file we replace (no-op on a fresh file).
            let _ = fs::set_permissions(&tmp, meta.permissions());
        }
        rename_with_retry(&tmp, &target)?;
        sync_parent_dir(dir);
        Ok(())
    })();

    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// Windows refuses to replace a read-only file, and the rename retry below would
/// spend about a second finding that out. Say so at once, in plain words.
fn fail_fast_if_read_only(target: &Path) -> io::Result<()> {
    if cfg!(windows) {
        if let Ok(meta) = fs::metadata(target) {
            if meta.permissions().readonly() {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    format!("{} is read-only; clear its read-only flag to let Atlas change it", target.display()),
                ));
            }
        }
    }
    Ok(())
}

/// Make the rename itself durable: after a crash or power cut the directory entry
/// must point at the new file. Unix only (Windows cannot open a folder this way);
/// best effort, since the data is already safe on disk.
fn sync_parent_dir(dir: &Path) {
    #[cfg(unix)]
    {
        if let Ok(d) = fs::File::open(dir) {
            let _ = d.sync_all();
        }
    }
    #[cfg(not(unix))]
    {
        let _ = dir;
    }
}

/// Windows can refuse a rename while an antivirus scanner or another program
/// holds the target open. Retry briefly instead of failing the write.
fn rename_with_retry(from: &Path, to: &Path) -> io::Result<()> {
    let mut delay = 10;
    let mut last = None;
    for _ in 0..8 {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) => {
                let transient = matches!(
                    e.kind(),
                    io::ErrorKind::PermissionDenied | io::ErrorKind::ResourceBusy
                );
                if !transient {
                    return Err(e);
                }
                last = Some(e);
                sleep(Duration::from_millis(delay));
                delay = (delay * 2).min(200);
            }
        }
    }
    Err(last.unwrap_or_else(|| io::Error::other("rename failed")))
}

/// If `path` is a symlink, the file it points at; otherwise `path` itself.
pub fn resolve_link_target(path: &Path) -> io::Result<PathBuf> {
    match fs::symlink_metadata(path) {
        Ok(m) if m.file_type().is_symlink() => fs::canonicalize(path),
        _ => Ok(path.to_path_buf()),
    }
}

// ---------------------------------------------------------------------------
// Guard: never write the real Claude config from a debug/test build.
// ---------------------------------------------------------------------------

/// Err(PermissionDenied) when this is a debug build and `path` is inside the
/// real Claude config. Always Ok in release builds.
pub fn check_write_allowed(path: &Path) -> io::Result<()> {
    if !cfg!(debug_assertions) {
        return Ok(());
    }
    let home = crate::paths::home_dir();
    let env = std::env::var_os("CLAUDE_CONFIG_DIR");
    if let Some(home) = home {
        if is_real_claude_path(path, &home, env.as_deref().map(Path::new)) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!(
                    "refused: {} is part of the real Claude config; development and test builds never write it (use a fixture, --config-dir or Sandbox Mode)",
                    path.display()
                ),
            ));
        }
    }
    Ok(())
}

/// True when `path` is the real config folder, anything inside it, or one of the
/// `.claude.json*` files beside the home folder. Pure: callers pass the home and
/// the value of `CLAUDE_CONFIG_DIR`.
pub fn is_real_claude_path(path: &Path, home: &Path, env_config_dir: Option<&Path>) -> bool {
    let p = comparable(path);
    let mut roots = vec![comparable(&home.join(".claude"))];
    if let Some(e) = env_config_dir.filter(|e| !e.as_os_str().is_empty()) {
        roots.push(comparable(e));
    }
    if roots.iter().any(|r| p.starts_with(r)) {
        return true;
    }
    let home_c = comparable(home);
    if p.parent() == Some(home_c.as_path()) {
        if let Some(name) = p.file_name().and_then(|n| n.to_str()) {
            return name.starts_with(".claude.json");
        }
    }
    false
}

/// Absolute, with links resolved as far as the path exists, and lowercase on
/// Windows (case-insensitive file system). Works for paths that do not exist yet.
///
/// Components are walked left to right and the part that exists is canonicalized
/// *before* a `..` is applied, so `link/../x` follows the link first (as the OS
/// does) and junctions and 8.3 short names resolve to the real long path. Past
/// the first component that does not exist, `..` is applied lexically.
fn comparable(path: &Path) -> PathBuf {
    let abs: PathBuf = if path.is_absolute() {
        path.to_path_buf()
    } else if !path.has_root() && !matches!(path.components().next(), Some(Component::Prefix(_))) {
        // Plain relative path: keep any `..` for the walk below (`absolute` would
        // collapse it lexically on Windows).
        std::env::current_dir().map(|c| c.join(path)).unwrap_or_else(|_| path.to_path_buf())
    } else {
        std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf())
    };

    let mut cur = PathBuf::new();
    let mut exists = true;
    for c in abs.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                cur.pop();
                // Back in a folder that exists, if the walk had left the real tree.
                if !exists {
                    exists = fs::canonicalize(&cur).is_ok();
                }
            }
            other => {
                cur.push(other.as_os_str());
                // `C:` alone means "the current folder on C:", so wait for a real name.
                if exists && matches!(other, Component::Normal(_)) {
                    match fs::canonicalize(&cur) {
                        Ok(real) => cur = strip_verbatim(&real),
                        Err(_) => exists = false,
                    }
                }
            }
        }
    }
    if cfg!(windows) { PathBuf::from(cur.to_string_lossy().to_lowercase()) } else { cur }
}

/// Drop the verbatim prefix Windows `canonicalize` adds, so paths shown to people look normal.
pub fn strip_verbatim(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        p.to_path_buf()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn strip_verbatim_removes_windows_prefixes_and_leaves_others() {
        assert_eq!(strip_verbatim(Path::new(r"\\?\C:\Users\a")), PathBuf::from(r"C:\Users\a"));
        assert_eq!(strip_verbatim(Path::new(r"\\?\UNC\host\share")), PathBuf::from(r"\\host\share"));
        assert_eq!(strip_verbatim(Path::new("/home/a")), PathBuf::from("/home/a"));
    }

    #[test]
    fn writes_new_and_replaces_existing_without_leftovers() {
        let d = tempdir().unwrap();
        let f = d.path().join("sub").join("settings.json");
        atomic_write(&f, b"one").unwrap();
        assert_eq!(fs::read(&f).unwrap(), b"one");
        atomic_write(&f, b"two two").unwrap();
        assert_eq!(fs::read(&f).unwrap(), b"two two");
        let names: Vec<_> = fs::read_dir(f.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["settings.json".to_string()], "temp file left behind");
    }

    #[test]
    fn bytes_are_written_exactly_including_bom_and_crlf() {
        let d = tempdir().unwrap();
        let f = d.path().join("x.md");
        let data = b"\xEF\xBB\xBFline1\r\nline2\r\n";
        atomic_write(&f, data).unwrap();
        assert_eq!(fs::read(&f).unwrap(), data);
    }

    #[test]
    fn failed_write_keeps_the_old_file_and_cleans_up() {
        let d = tempdir().unwrap();
        let f = d.path().join("keep.json");
        atomic_write(&f, b"original").unwrap();
        // A directory in the way of the rename makes the replace fail.
        let blocked = d.path().join("blocked");
        fs::create_dir(&blocked).unwrap();
        assert!(atomic_write(&blocked, b"nope").is_err());
        assert_eq!(fs::read(&f).unwrap(), b"original");
        let leftovers: Vec<_> = fs::read_dir(d.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains("atlas-tmp"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn symlinked_target_is_written_through_and_the_link_survives() {
        let d = tempdir().unwrap();
        let real = d.path().join("real.json");
        fs::write(&real, b"old").unwrap();
        let link = d.path().join("link.json");
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(&real, &link).is_ok();
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_file(&real, &link).is_ok();
        if !made {
            eprintln!("skipped: this machine may not create symlinks");
            return;
        }
        atomic_write(&link, b"new").unwrap();
        assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        assert_eq!(fs::read(&real).unwrap(), b"new");
    }

    #[test]
    fn detects_the_real_config_without_touching_it() {
        let d = tempdir().unwrap();
        let home = d.path().join("home");
        let envdir = d.path().join("custom-claude");
        // Paths need not exist.
        assert!(is_real_claude_path(&home.join(".claude").join("settings.json"), &home, None));
        assert!(is_real_claude_path(&home.join(".claude"), &home, None));
        assert!(is_real_claude_path(&home.join(".claude.json"), &home, None));
        assert!(is_real_claude_path(&home.join(".claude.json.backup"), &home, None));
        assert!(is_real_claude_path(&envdir.join("skills").join("a").join("SKILL.md"), &home, Some(&envdir)));
        assert!(!is_real_claude_path(&envdir.join("skills"), &home, None));
        assert!(!is_real_claude_path(&home.join("Documents").join("notes.txt"), &home, None));
        assert!(!is_real_claude_path(&home.join(".claudette"), &home, None));
        assert!(!is_real_claude_path(&d.path().join("fixture").join(".claude.json"), &home, None));
        // `..` cannot sneak in.
        assert!(is_real_claude_path(&home.join("x").join("..").join(".claude").join("a"), &home, None));
    }

    /// A directory link: a symlink on Unix, a junction on Windows (needs no privilege).
    fn make_dir_link(target: &Path, link: &Path) -> bool {
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(target, link).is_ok()
        }
        #[cfg(windows)]
        {
            std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(link)
                .arg(target)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        }
    }

    #[test]
    fn a_junction_or_link_into_the_real_config_is_still_the_real_config() {
        let d = tempdir().unwrap();
        let home = d.path().join("home");
        fs::create_dir_all(home.join(".claude")).unwrap();
        let link = d.path().join("shortcut");
        if !make_dir_link(&home.join(".claude"), &link) {
            eprintln!("skipped: could not make a directory link");
            return;
        }
        assert!(is_real_claude_path(&link.join("settings.json"), &home, None));
        assert!(is_real_claude_path(&link.join("new").join("deeper.json"), &home, None));
        assert!(!is_real_claude_path(&d.path().join("elsewhere").join("settings.json"), &home, None));
    }

    #[cfg(unix)]
    #[test]
    fn dot_dot_after_a_link_follows_the_link_first() {
        let d = tempdir().unwrap();
        let home = d.path().join("home");
        fs::create_dir_all(home.join(".claude").join("sub")).unwrap();
        fs::create_dir_all(d.path().join("other")).unwrap();
        // other/link -> home/.claude/sub, so other/link/../a is home/.claude/a
        // (collapsing `..` as text would have said other/a).
        let link = d.path().join("other").join("link");
        std::os::unix::fs::symlink(home.join(".claude").join("sub"), &link).unwrap();
        assert!(is_real_claude_path(&link.join("..").join("a"), &home, None));
        // And the other way round: a link that leaves the real config.
        let out = home.join(".claude").join("out");
        fs::create_dir_all(d.path().join("far").join("deep")).unwrap();
        std::os::unix::fs::symlink(d.path().join("far").join("deep"), &out).unwrap();
        assert!(!is_real_claude_path(&out.join("..").join("x"), &home, None));
    }

    #[test]
    fn relative_paths_are_judged_from_the_current_folder() {
        let cwd = std::env::current_dir().unwrap();
        assert_eq!(comparable(Path::new("some/./new/../file.txt")), comparable(&cwd.join("some").join("file.txt")));
    }

    #[cfg(windows)]
    #[test]
    fn a_read_only_target_fails_at_once_with_a_clear_message() {
        let d = tempdir().unwrap();
        let f = d.path().join("locked.json");
        fs::write(&f, b"keep").unwrap();
        let mut perms = fs::metadata(&f).unwrap().permissions();
        perms.set_readonly(true);
        fs::set_permissions(&f, perms).unwrap();

        let started = std::time::Instant::now();
        let err = atomic_write(&f, b"new").unwrap_err();
        let took = started.elapsed();

        let mut perms = fs::metadata(&f).unwrap().permissions();
        #[allow(clippy::permissions_set_readonly_false)]
        perms.set_readonly(false);
        fs::set_permissions(&f, perms).unwrap();

        assert_eq!(err.kind(), io::ErrorKind::PermissionDenied);
        assert!(err.to_string().contains("read-only"), "{err}");
        assert!(took < Duration::from_millis(300), "should not retry: {took:?}");
        assert_eq!(fs::read(&f).unwrap(), b"keep");
        let names: Vec<_> = fs::read_dir(d.path()).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names.len(), 1, "temp file left behind: {names:?}");
    }

    #[test]
    #[cfg(debug_assertions)]
    fn debug_builds_refuse_the_real_home_config() {
        // Deliberately calls only the check, never a write: if the guard were
        // broken, a test that really wrote here would damage the real config.
        let Some(home) = crate::paths::home_dir() else { return };
        for target in [
            home.join(".claude").join("atlas-guard-test-never-written.json"),
            home.join(".claude.json"),
        ] {
            let err = check_write_allowed(&target).unwrap_err();
            assert_eq!(err.kind(), io::ErrorKind::PermissionDenied);
        }
    }
}
