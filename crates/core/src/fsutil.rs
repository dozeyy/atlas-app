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
    if cfg!(windows)
        && let Ok(meta) = fs::metadata(target)
            && meta.permissions().readonly() {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    format!("{} is read-only; clear its read-only flag to let Atlas change it", target.display()),
                ));
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
    if let Some(home) = home
        && is_real_claude_path(path, &home, env.as_deref().map(Path::new))
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!(
                "refused: {} is part of the real Claude config; development and test builds never write it (use a fixture, --config-dir or Sandbox Mode)",
                path.display()
            ),
        ));
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
    if p.parent() == Some(home_c.as_path())
        && let Some(name) = p.file_name().and_then(|n| n.to_str())
    {
        return name.starts_with(".claude.json");
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

/// A path that is about to be handed to the OS (Explorer, `open`, `xdg-open`), vetted: it must
/// be absolute, must not start with `\\` or `//` (a network share would make Windows send the
/// user's credentials to that host) or with `-` (an option), and must exist. The answer is the
/// canonical path with any `\\?\` prefix dropped; a link that leads to a network share is
/// refused too. Opening anything goes through here, so a bad path never reaches a command line.
pub fn vet_open_path(path: &Path) -> Result<PathBuf, String> {
    let bad = || "Atlas will not open that location.".to_string();
    let s = path.to_string_lossy();
    if s.is_empty() || s.contains('\0') || !path.is_absolute() {
        return Err(bad());
    }
    if s.starts_with(r"\\") || s.starts_with("//") || s.starts_with('-') {
        return Err(bad());
    }
    let real = strip_verbatim(&fs::canonicalize(path).map_err(|_| "The file is gone.".to_string())?);
    let r = real.to_string_lossy();
    if r.starts_with(r"\\") || r.starts_with("//") || r.starts_with('-') {
        return Err(bad());
    }
    Ok(real)
}

/// The file Atlas leaves in a data folder it owns. The uninstaller's "also remove Atlas's saved
/// data" only touches a folder that has it: the folder names (`atlas`) are generic and could be
/// another program's, or a shared folder chosen with `ATLAS_DATA_DIR`.
pub const DATA_MARKER: &str = ".atlas-data";

const DATA_MARKER_TEXT: &str = "This folder holds Atlas's saved data. Atlas's uninstaller removes it only when this file is here.\n";

/// Atlas's own files by a name no other program is likely to use: the pricing table's hash, the
/// search index, or a saved version under `history\<folder>\history.sqlite`.
fn has_atlas_files(dir: &Path) -> bool {
    if ["pricing.seed-hash", "search.sqlite"].iter().any(|n| dir.join(n).is_file()) {
        return true;
    }
    fs::read_dir(dir.join("history"))
        .map(|rd| rd.flatten().any(|e| e.path().join("history.sqlite").is_file()))
        .unwrap_or(false)
}

/// Claim `dir` as Atlas's data folder by writing the marker, when it is safe to say so: the folder
/// is new or empty (Atlas is about to fill it), or it already holds files only Atlas makes (an
/// install from before the marker existed). A folder that has other things in it and none of
/// Atlas's is never claimed, and a link is never followed. Returns whether the marker is there.
pub fn mark_data_dir(dir: &Path) -> bool {
    let marker = dir.join(DATA_MARKER);
    if fs::symlink_metadata(&marker).is_ok_and(|m| m.is_file()) {
        return true;
    }
    match fs::symlink_metadata(dir) {
        Ok(m) if m.is_dir() && !m.file_type().is_symlink() => {}
        Ok(_) => return false, // a file, or a link to somewhere else
        Err(_) => {
            if fs::create_dir_all(dir).is_err() {
                return false;
            }
        }
    }
    // Windows junctions are directories that report as links through file attributes.
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if fs::symlink_metadata(dir).is_ok_and(|m| m.file_attributes() & 0x400 != 0) {
            return false;
        }
    }
    let empty = fs::read_dir(dir).map(|mut rd| rd.next().is_none()).unwrap_or(false);
    if !(empty || has_atlas_files(dir)) {
        return false;
    }
    fs::write(&marker, DATA_MARKER_TEXT).is_ok()
}

/// True when `dir` carries the marker (and is not a link).
pub fn is_marked_data_dir(dir: &Path) -> bool {
    let plain_dir = |p: &Path| fs::symlink_metadata(p).is_ok_and(|m| m.is_dir() && !m.file_type().is_symlink());
    #[cfg(windows)]
    let linked = {
        use std::os::windows::fs::MetadataExt;
        fs::symlink_metadata(dir).is_ok_and(|m| m.file_attributes() & 0x400 != 0)
    };
    #[cfg(not(windows))]
    let linked = false;
    plain_dir(dir) && !linked && fs::symlink_metadata(dir.join(DATA_MARKER)).is_ok_and(|m| m.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn a_data_folder_is_marked_when_new_empty_or_clearly_atlas_and_never_otherwise() {
        let t = tempdir().unwrap();
        let fresh = t.path().join("new");
        assert!(mark_data_dir(&fresh) && is_marked_data_dir(&fresh), "a folder that did not exist");
        let empty = t.path().join("empty");
        fs::create_dir_all(&empty).unwrap();
        assert!(mark_data_dir(&empty));
        let old = t.path().join("old");
        fs::create_dir_all(&old).unwrap();
        fs::write(old.join("pricing.seed-hash"), "h").unwrap();
        fs::write(old.join("settings.json"), "{}").unwrap();
        assert!(mark_data_dir(&old), "an Atlas folder from before the marker");
        let hist = t.path().join("hist");
        fs::create_dir_all(hist.join("history").join("abc")).unwrap();
        fs::write(hist.join("history").join("abc").join("history.sqlite"), "h").unwrap();
        assert!(mark_data_dir(&hist));
        let other = t.path().join("other");
        fs::create_dir_all(other.join("history")).unwrap();
        fs::write(other.join("settings.json"), "{\"someone\":\"else\"}").unwrap();
        assert!(!mark_data_dir(&other) && !is_marked_data_dir(&other), "another program's folder");
        assert!(!other.join(DATA_MARKER).exists());
        let file = t.path().join("afile");
        fs::write(&file, "x").unwrap();
        assert!(!mark_data_dir(&file));
    }

    #[test]
    fn vet_open_path_refuses_relative_unc_verbatim_and_dash_paths() {
        for bad in [
            "",
            "relative/file.md",
            "-rf",
            r"\\evil-host\share\file.md",
            "//evil-host/share/file.md",
            r"\\?\C:\Windows\win.ini",
            r"\\?\UNC\evil-host\share\file.md",
            r"\\.\pipe\x",
        ] {
            assert!(vet_open_path(Path::new(bad)).is_err(), "{bad:?} should be refused");
        }
        assert!(vet_open_path(Path::new("a\0b")).is_err());
    }

    #[test]
    fn vet_open_path_gives_the_canonical_path_of_a_real_file_and_refuses_a_missing_one() {
        let d = tempdir().unwrap();
        let f = d.path().join("a.md");
        fs::write(&f, "x").unwrap();
        let got = vet_open_path(&f).unwrap();
        assert!(got.is_absolute() && got.is_file());
        assert!(!got.to_string_lossy().starts_with(r"\\?\"), "{got:?}");
        assert!(vet_open_path(&d.path().join("missing.md")).is_err());
        // A path that wanders through `..` is resolved, not trusted as written.
        let sub = d.path().join("sub");
        fs::create_dir(&sub).unwrap();
        let wander = sub.join("..").join("a.md");
        assert_eq!(vet_open_path(&wander).unwrap(), got);
    }

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
