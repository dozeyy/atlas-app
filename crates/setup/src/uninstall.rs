//! Taking Atlas off the computer: the parts of the remover that touch the disk. (The window and
//! the order of the steps are in `state.rs`.)
//!
//! The remover is this same program under the name `Uninstall Atlas.exe`, kept beside Atlas.
//! It does the real work with the installer's own uninstaller (`uninstall.exe`, run silently),
//! which removes exactly the files, shortcuts and Apps and features entry the installer made.
//! What it adds is the window, closing a running Atlas first, and, only when asked, Atlas's
//! saved data, deleted by name.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use atlas_core::paths;

use crate::indexer::Env;
use crate::install::{self, REMOVER_NAME};

/// The installer's own uninstaller, beside Atlas.
pub fn nsis_uninstaller(dir: &Path) -> PathBuf {
    dir.join("uninstall.exe")
}

/// Whether `dir` holds an Atlas this remover can take off: the installer's uninstaller is there.
pub fn looks_installed(dir: &Path) -> bool {
    nsis_uninstaller(dir).is_file()
}

/// Whether `dir` is an Atlas install folder: the installer's uninstaller beside Atlas's program
/// (or, after a half-finished removal, beside the remover's own file).
pub fn is_install_dir(dir: &Path) -> bool {
    looks_installed(dir) && (install::atlas_exe(dir).is_file() || dir.join(REMOVER_NAME).is_file())
}

/// Which folder a remover started as `exe` takes off. Never "wherever this file happens to be":
/// a Setup (or a copy) run from Downloads with `--uninstall` must not aim at Downloads. The
/// installed remover beside Atlas is trusted for its own folder; anything else goes by where the
/// installer recorded Atlas (`install::install_dir`). `None` when neither is an Atlas install.
pub fn remove_target(exe: &Path) -> Option<PathBuf> {
    if let (Some(dir), Some(name)) = (exe.parent(), exe.file_name())
        && name.eq_ignore_ascii_case(REMOVER_NAME)
        && is_install_dir(dir)
    {
        return Some(dir.to_path_buf());
    }
    Some(install::install_dir()).filter(|d| is_install_dir(d))
}

// ----------------------------------------------------------------- which role this run has

/// What this run of the program is for, decided from its own file name and arguments.
#[derive(Debug, PartialEq, Eq)]
pub enum Launch {
    /// Atlas Setup: install.
    Install,
    /// Started from Atlas's folder: copy itself to a temporary folder and run from there (a
    /// program cannot delete the file it is running from).
    RemoverFirstStep,
    /// The copy in the temporary folder, told which Atlas folder to remove.
    RemoverWindow(PathBuf),
    /// The installer calls the remover with its own switches (an update does, before it
    /// replaces the files): hand them straight to the installer's uninstaller, no window.
    PassOn,
}

/// The argument the first step gives the copy: the folder to remove.
pub const REMOVE_FROM: &str = "--remove-from";

/// The switches an installer passes to an uninstaller.
pub fn is_installer_switch(arg: &str) -> bool {
    let a = arg.to_ascii_lowercase();
    matches!(a.as_str(), "/s" | "/p" | "/update" | "/r") || a.starts_with("_?=") || a.starts_with("/d=")
}

pub fn launch_for(exe: &Path, args: &[OsString]) -> Launch {
    let named_remover = exe.file_stem().is_some_and(|s| s.to_string_lossy().to_ascii_lowercase().starts_with("uninstall"));
    if !named_remover && !args.iter().any(|a| a == "--uninstall") {
        return Launch::Install;
    }
    if args.iter().any(|a| is_installer_switch(&a.to_string_lossy())) {
        return Launch::PassOn;
    }
    if let Some(i) = args.iter().position(|a| a == REMOVE_FROM)
        && let Some(dir) = args.get(i + 1)
    {
        return Launch::RemoverWindow(PathBuf::from(dir));
    }
    Launch::RemoverFirstStep
}

/// Everything after the program's own name in a raw command line, exactly as it was typed.
pub fn raw_tail(cmdline: &str) -> &str {
    let s = cmdline.trim_start();
    let rest = if let Some(quoted) = s.strip_prefix('"') {
        quoted.split_once('"').map_or("", |(_, tail)| tail)
    } else {
        s.split_once(char::is_whitespace).map_or("", |(_, tail)| tail)
    };
    rest.trim_start()
}

/// Run the installer's uninstaller with the same switches this program got, and return its code.
pub fn pass_on(exe: &Path, cmdline: &str) -> i32 {
    let Some(dir) = exe.parent() else { return 1 };
    let mut cmd = Command::new(nsis_uninstaller(dir));
    cmd.current_dir(install::neutral_dir());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Raw, because the installer wants `_?=<folder>` last and unquoted, spaces and all.
        cmd.raw_arg(raw_tail(cmdline)).creation_flags(CREATE_NO_WINDOW);
    }
    let code = cmd.status().ok().and_then(|s| s.code()).unwrap_or(1);
    if code == 0 && is_plain_silent_uninstall(raw_tail(cmdline)) {
        erase_installed_remover(exe);
    }
    code
}

/// `/S` alone: someone removing Atlas without a window. An update passes more (`/UPDATE`,
/// `/P`, `/R`, `_?=`) and keeps this file, which the new installer replaces.
pub fn is_plain_silent_uninstall(tail: &str) -> bool {
    let words: Vec<String> = tail.split_whitespace().map(str::to_ascii_lowercase).collect();
    words.iter().any(|w| w == "/s") && words.iter().all(|w| w == "/s")
}

/// The installer's uninstaller cannot delete this file while it runs, so a plain silent
/// uninstall would leave it (and its folder) behind. A hidden shell waits for this program to
/// exit and the installer's own cleanup to finish, deletes only this one file, then removes
/// the folder if it is empty.
fn erase_installed_remover(exe: &Path) {
    let (Some(dir), Some(name)) = (exe.parent(), exe.file_name()) else { return };
    if !name.eq_ignore_ascii_case(REMOVER_NAME) {
        return;
    }
    let (f, d) = (exe.display().to_string(), dir.display().to_string());
    if !cmd_safe(&f) || !cmd_safe(&d) {
        return;
    }
    spawn_cleanup(9, &f, &[&d]);
}

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// The hidden shell that finishes a removal after this program has exited: wait `wait` seconds,
/// delete the one file, then try each folder (empty folders only: `rmdir` refuses anything else)
/// three times a few seconds apart, since the last process that held one may still be leaving.
/// Its own working folder is the Windows folder, so it never holds what it removes. The caller has
/// already checked every path with `cmd_safe`.
fn spawn_cleanup(wait: u32, file: &str, folders: &[&str]) {
    let script = cleanup_script(wait, file, folders);
    let mut cmd = Command::new("cmd.exe");
    cmd.current_dir(install::neutral_dir()).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.raw_arg(format!("/D /V:OFF /C \"{script}\"")).creation_flags(CREATE_NO_WINDOW | 0x0000_0008); // no window, detached
    }
    let _ = cmd.spawn();
}

fn cleanup_script(wait: u32, file: &str, folders: &[&str]) -> String {
    let mut script = format!("ping -n {wait} 127.0.0.1 >nul & del /f /q \"{file}\"");
    for round in 0..3 {
        for d in folders {
            script.push_str(&format!(" & rmdir \"{d}\" 2>nul"));
        }
        if round < 2 {
            script.push_str(" & ping -n 4 127.0.0.1 >nul");
        }
    }
    script
}

/// A path that can sit inside a quoted `cmd` command line without being read as anything but
/// itself: none of the characters `cmd` treats specially, `!` included (delayed expansion is
/// also switched off with `/V:OFF`), and no control characters.
fn cmd_safe(path: &str) -> bool {
    !path.chars().any(|c| matches!(c, '"' | '%' | '&' | '^' | '!') || c.is_control())
}

/// Copy this program to a new temporary folder and start the copy to remove `dir`.
pub fn hand_on(exe: &Path, dir: &Path) -> std::io::Result<()> {
    let tmp = tempfile::Builder::new().prefix("AtlasRemove-").tempdir()?.keep();
    let copy = tmp.join(REMOVER_NAME);
    // The copy starts in the Windows folder, not in whatever folder started this program (Atlas
    // starts the remover from inside the install folder, and a working folder is held open).
    let start = |c: &Path| Command::new(c).arg(REMOVE_FROM).arg(dir).current_dir(install::neutral_dir()).spawn().map(|_| ());
    if let Err(e) = install::copy_bytes(exe, &copy).and_then(|()| start(&copy)) {
        let _ = std::fs::remove_file(&copy);
        let _ = std::fs::remove_dir(&tmp);
        return Err(e);
    }
    Ok(())
}

/// When this run is the copy in a temporary `AtlasRemove-` folder, erase it once it has exited
/// (a program cannot delete itself while it runs): a hidden shell waits a few seconds, then
/// deletes that one file and its now empty folder. When the removal finished, `removed_from` is
/// the Atlas folder: it is tried again once this program is gone (an empty folder only; the
/// shell's `rmdir` refuses one that still holds anything, such as kept saved data).
pub fn erase_my_copy_later(exe: &Path, removed_from: Option<&Path>) {
    let Some(dir) = exe.parent() else { return };
    let in_temp_copy = dir.file_name().is_some_and(|n| n.to_string_lossy().starts_with("AtlasRemove-"))
        && exe.file_name().is_some_and(|n| n.eq_ignore_ascii_case(REMOVER_NAME));
    if !in_temp_copy {
        return;
    }
    // Paths made by this program under the temp folder: none of cmd's special characters in them.
    let (f, d) = (exe.display().to_string(), dir.display().to_string());
    if !cmd_safe(&f) || !cmd_safe(&d) {
        return;
    }
    let mut folders = vec![d.as_str()];
    let install_dir = removed_from.map(|p| p.display().to_string()).filter(|p| cmd_safe(p));
    if let Some(p) = &install_dir {
        folders.push(p.as_str());
    }
    spawn_cleanup(4, &f, &folders);
}

// ----------------------------------------------------------------- removing Atlas

#[derive(Debug, PartialEq, Eq)]
pub enum RemoveError {
    NotInstalledHere,
    CouldNotStart,
    Stopped(i32),
    StillThere,
}

impl RemoveError {
    pub fn message(&self) -> String {
        match self {
            RemoveError::NotInstalledHere => "Atlas is not installed in this folder, so there is nothing to remove here.".into(),
            RemoveError::CouldNotStart => "Windows would not start the remover. Try again.".into(),
            RemoveError::Stopped(code) => format!("The remover stopped before it finished (code {code}). Close other programs and try again."),
            RemoveError::StillThere => "Atlas is still there after the remover finished. Try again.".into(),
        }
    }
}

/// How far the installer's uninstaller has got, from what is left on disk: 0.35 until Atlas's
/// program file is gone, 0.8 after.
pub fn progress_on_disk(dir: &Path) -> f32 {
    if install::atlas_exe(dir).exists() { 0.35 } else { 0.8 }
}

/// Run the installer's uninstaller silently in place (`_?=` keeps it from copying itself away)
/// and wait for it, reporting progress while it works.
pub fn run_installer_uninstaller(dir: &Path, mut on_progress: impl FnMut(f32)) -> Result<(), RemoveError> {
    if !looks_installed(dir) {
        return Err(RemoveError::NotInstalledHere);
    }
    let mut cmd = Command::new(nsis_uninstaller(dir));
    cmd.arg("/S").current_dir(install::neutral_dir()).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Last and unquoted, as the installer reads it.
        cmd.raw_arg(format!("_?={}", dir.display())).creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().map_err(|_| RemoveError::CouldNotStart)?;
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) => {
                on_progress(progress_on_disk(dir));
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(_) => return Err(RemoveError::CouldNotStart),
        }
    };
    if !status.success() {
        return Err(RemoveError::Stopped(status.code().unwrap_or(-1)));
    }
    if install::atlas_exe(dir).exists() {
        return Err(RemoveError::StillThere);
    }
    Ok(())
}

/// After the installer's uninstaller: it could not delete itself (it ran in place), and the
/// remover's own file in this folder is not the running copy. Those two, by name, then the
/// folder only if nothing at all is left in it (a plain `remove_dir`, which fails otherwise).
pub fn tidy(dir: &Path) {
    for name in ["uninstall.exe", REMOVER_NAME, "Uninstall Atlas.exe.part"] {
        let p = dir.join(name);
        if is_plain_file(&p) {
            let _ = std::fs::remove_file(&p);
        }
    }
    let _ = std::fs::remove_dir(dir);
}

// ----------------------------------------------------------------- saved data

/// Files Atlas keeps in its data folders, by name. Nothing else in those folders is touched.
pub const DATA_FILES: &[&str] = &[
    "settings.json",
    "cache.sqlite",
    "cache.sqlite-wal",
    "cache.sqlite-shm",
    "cache.sqlite.bak",
    "search.sqlite",
    "search.sqlite-wal",
    "search.sqlite-shm",
    "pricing.json",
    "pricing.seed-hash",
];

/// Folders Atlas keeps in its data folders, by name (the saved versions, the per-folder caches,
/// the Setup page's backups).
pub const DATA_DIRS: &[&str] = &["history", "caches", "setup-backups"];

/// The bundle id the window's own browser profile is filed under, in the same two places the
/// installer's "delete app data" box would look.
const BUNDLE_ID: &str = "me.willhenry.atlas";

#[derive(Debug, PartialEq, Eq)]
pub struct DataPlan {
    /// Atlas's data folders (settings in one, the usage cache in the other; often the same folder).
    pub atlas_dirs: Vec<PathBuf>,
    /// The window's browser profile folders. Only on a normal install: a test or dev run that
    /// moves Atlas's data with `ATLAS_DATA_DIR` leaves the machine's real ones alone.
    pub profile_dirs: Vec<PathBuf>,
}

fn lower(p: &Path) -> String {
    p.to_string_lossy().replace('/', "\\").trim_end_matches('\\').to_lowercase()
}

fn same_path(a: &Path, b: &Path) -> bool {
    lower(a) == lower(b)
}

/// `inner` is `outer` or somewhere under it (case-insensitive, whole folder names).
fn inside(inner: &Path, outer: &Path) -> bool {
    let (i, o) = (lower(inner), lower(outer));
    i == o || i.starts_with(&format!("{o}\\"))
}

/// A reparse point (junction or symbolic link): never followed, never treated as a folder to empty.
pub fn is_link(p: &Path) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        std::fs::symlink_metadata(p).is_ok_and(|m| m.file_attributes() & 0x400 != 0)
    }
    #[cfg(not(windows))]
    {
        std::fs::symlink_metadata(p).is_ok_and(|m| m.file_type().is_symlink())
    }
}

fn is_plain_file(p: &Path) -> bool {
    !is_link(p) && std::fs::symlink_metadata(p).is_ok_and(|m| m.is_file())
}

/// A folder it is safe to take Atlas's named files out of: a real, deep-enough folder that is not
/// a link, not the home folder or any folder above it, and not the Claude folder or inside it.
fn safe_data_dir(dir: &Path, env: &Env) -> bool {
    dir.is_absolute()
        && dir.components().count() >= 3
        && !is_link(dir)
        && !inside(&env.home, dir)
        && !env.claude_config.as_deref().is_some_and(|c| !c.is_empty() && inside(Path::new(c), dir))
        && !atlas_core::fsutil::is_real_claude_path(&dir.join("x"), &env.home, env.claude_config.as_deref().map(Path::new))
}

/// Where Atlas keeps its data on this machine, from the same rules the app uses.
pub fn data_plan(env: &Env, appdata: Option<&OsStr>, local_appdata: Option<&OsStr>) -> DataPlan {
    let atlas_env = env.atlas_data.as_deref();
    let mut atlas_dirs: Vec<PathBuf> = Vec::new();
    let found = [paths::data_dir(None, atlas_env, &env.home, &env.cwd), paths::local_data_dir(None, atlas_env, &env.home, &env.cwd)];
    for dir in found.into_iter().flatten() {
        if safe_data_dir(&dir, env) && !atlas_dirs.iter().any(|d| same_path(d, &dir)) {
            atlas_dirs.push(dir);
        }
    }
    let mut profile_dirs: Vec<PathBuf> = Vec::new();
    if atlas_env.is_none_or(OsStr::is_empty) {
        for base in [appdata, local_appdata].into_iter().flatten().filter(|b| !b.is_empty()) {
            let dir = Path::new(base).join(BUNDLE_ID);
            if safe_data_dir(&dir, env) && !profile_dirs.iter().any(|d| same_path(d, &dir)) {
                profile_dirs.push(dir);
            }
        }
    }
    DataPlan { atlas_dirs, profile_dirs }
}

/// Remove a folder tree without following links: a link inside it is removed as a link, never
/// entered (`remove_dir_all` does exactly that on Windows).
fn remove_tree(p: &Path) {
    if is_link(p) {
        // A junction or folder link: take the link itself away, leave what it points at.
        let _ = std::fs::remove_dir(p).or_else(|_| std::fs::remove_file(p));
    } else if std::fs::symlink_metadata(p).is_ok_and(|m| m.is_dir()) {
        let _ = std::fs::remove_dir_all(p);
    }
}

/// Whether any of Atlas's named files or folders is in `dir` (a link counts: it is there).
fn has_named_data(dir: &Path) -> bool {
    DATA_FILES.iter().chain(DATA_DIRS).any(|n| std::fs::symlink_metadata(dir.join(n)).is_ok())
}

/// What a removal did.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct DataResult {
    /// How many entries were removed.
    pub removed: usize,
    /// A folder held Atlas-looking data but carries no marker from Atlas, so it was left whole
    /// (an install from before the marker, or a folder some other program shares).
    pub kept: bool,
}

/// Take Atlas's named files and folders out of `dir`, then the folder itself if that left it empty.
/// Only where Atlas has put its marker: an unmarked folder is never entered, and the result says
/// something was kept. The marker goes last, so an interrupted pass can be run again.
pub fn remove_named_data(dir: &Path) -> DataResult {
    if !atlas_core::fsutil::is_marked_data_dir(dir) {
        return DataResult { removed: 0, kept: has_named_data(dir) };
    }
    let mut removed = 0;
    for name in DATA_FILES {
        let p = dir.join(name);
        if is_plain_file(&p) && std::fs::remove_file(&p).is_ok() {
            removed += 1;
        }
    }
    for name in DATA_DIRS {
        let p = dir.join(name);
        if std::fs::symlink_metadata(&p).is_ok() {
            remove_tree(&p);
            if std::fs::symlink_metadata(&p).is_err() {
                removed += 1;
            }
        }
    }
    let marker = dir.join(atlas_core::fsutil::DATA_MARKER);
    if is_plain_file(&marker) {
        let _ = std::fs::remove_file(&marker);
    }
    let _ = std::fs::remove_dir(dir);
    DataResult { removed, kept: false }
}

/// Remove the saved data a plan names. The browser profile folders go whole (they hold nothing
/// but the window's own browser files, under a name only Atlas's bundle id makes); Atlas's data
/// folders only by name and only where marked.
pub fn remove_data(plan: &DataPlan) -> DataResult {
    let mut total = DataResult::default();
    for dir in &plan.atlas_dirs {
        let r = remove_named_data(dir);
        total.removed += r.removed;
        total.kept |= r.kept;
    }
    for dir in &plan.profile_dirs {
        if std::fs::symlink_metadata(dir).is_ok() {
            remove_tree(dir);
            total.removed += 1;
        }
    }
    total
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<OsString> {
        list.iter().map(OsString::from).collect()
    }

    #[test]
    fn the_programs_name_and_arguments_pick_its_role() {
        let setup = Path::new(r"C:\Users\x\Downloads\Atlas-Setup-Windows-x64.exe");
        let remover = Path::new(r"C:\Users\x\AppData\Local\Atlas\Uninstall Atlas.exe");
        assert_eq!(launch_for(setup, &args(&[])), Launch::Install);
        assert_eq!(launch_for(remover, &args(&[])), Launch::RemoverFirstStep);
        assert_eq!(launch_for(setup, &args(&["--uninstall"])), Launch::RemoverFirstStep);
        assert_eq!(
            launch_for(remover, &args(&["--remove-from", r"C:\Program Files\A B"])),
            Launch::RemoverWindow(PathBuf::from(r"C:\Program Files\A B"))
        );
    }

    #[test]
    fn the_installers_own_switches_are_passed_on_never_shown_as_a_window() {
        let remover = Path::new(r"C:\Atlas\Uninstall Atlas.exe");
        for sw in ["/UPDATE", "/update", "/P", "/S", "_?=C:\\Atlas"] {
            assert_eq!(launch_for(remover, &args(&[sw])), Launch::PassOn, "{sw}");
        }
        // Setup itself never mistakes a switch for a remover request.
        assert_eq!(launch_for(Path::new(r"C:\x\Atlas-Setup.exe"), &args(&["/S"])), Launch::Install);
    }

    #[test]
    fn only_a_bare_silent_uninstall_erases_the_remover_an_update_keeps_it() {
        assert!(is_plain_silent_uninstall("/S"));
        assert!(is_plain_silent_uninstall("/s"));
        for t in ["", "/S _?=C:\\Atlas", "/S /UPDATE", "/P", "/S /P /R", "/UPDATE"] {
            assert!(!is_plain_silent_uninstall(t), "{t}");
        }
    }

    #[test]
    fn the_command_tail_is_kept_exactly_as_typed() {
        assert_eq!(raw_tail(r#""C:\a b\Uninstall Atlas.exe" /UPDATE _?=C:\x y"#), r"/UPDATE _?=C:\x y");
        assert_eq!(raw_tail(r"C:\Atlas\Uninstall.exe /S"), "/S");
        assert_eq!(raw_tail(r#""C:\a\u.exe""#), "");
        assert_eq!(raw_tail(""), "");
    }

    #[test]
    fn only_the_known_data_goes_and_a_folder_with_other_things_stays() {
        let t = tempfile::tempdir().unwrap();
        let dir = t.path().join("atlas-data");
        std::fs::create_dir_all(dir.join("history").join("abc")).unwrap();
        std::fs::write(dir.join("history").join("abc").join("history.sqlite"), "h").unwrap();
        std::fs::write(dir.join("cache.sqlite"), "c").unwrap();
        std::fs::write(dir.join("cache.sqlite-wal"), "w").unwrap();
        std::fs::write(dir.join("settings.json"), "{}").unwrap();
        std::fs::write(dir.join("mine.txt"), "not Atlas's").unwrap();
        std::fs::create_dir_all(dir.join("my-folder")).unwrap();
        mark(&dir);
        let r = remove_named_data(&dir);
        assert_eq!(r, DataResult { removed: 4, kept: false }, "three files and the history folder");
        assert!(dir.join("mine.txt").is_file(), "a file Atlas does not know is never touched");
        assert!(dir.join("my-folder").is_dir());
        assert!(!dir.join("cache.sqlite").exists() && !dir.join("history").exists());
        assert!(!dir.join(atlas_core::fsutil::DATA_MARKER).exists(), "the marker goes with the data");
        assert!(dir.is_dir(), "the folder stays while anything else is in it");
        std::fs::remove_file(dir.join("mine.txt")).unwrap();
        std::fs::remove_dir(dir.join("my-folder")).unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        mark(&dir);
        assert_eq!(remove_named_data(&dir).removed, 0);
        assert!(!dir.exists(), "an emptied folder goes");
    }

    fn mark(dir: &Path) {
        std::fs::write(dir.join(atlas_core::fsutil::DATA_MARKER), "x").unwrap();
    }

    /// The fix for a shared folder (`%APPDATA%\atlas` could be another program's): without
    /// Atlas's marker nothing in it is touched, however much it looks like Atlas's.
    #[test]
    fn a_folder_without_the_marker_is_never_entered_and_the_result_says_so() {
        let t = tempfile::tempdir().unwrap();
        let dir = t.path().join("shared");
        std::fs::create_dir_all(dir.join("history").join("deep")).unwrap();
        std::fs::write(dir.join("history").join("deep").join("note.txt"), "theirs").unwrap();
        std::fs::write(dir.join("settings.json"), "{\"theirs\":1}").unwrap();
        std::fs::write(dir.join("cache.sqlite"), "c").unwrap();
        let r = remove_named_data(&dir);
        assert_eq!(r, DataResult { removed: 0, kept: true });
        assert!(dir.join("settings.json").is_file() && dir.join("cache.sqlite").is_file());
        assert!(dir.join("history").join("deep").join("note.txt").is_file());
        // An unmarked folder with nothing of Atlas's name in it has nothing to keep.
        let empty = t.path().join("other");
        std::fs::create_dir_all(&empty).unwrap();
        std::fs::write(empty.join("readme.txt"), "x").unwrap();
        assert_eq!(remove_named_data(&empty), DataResult { removed: 0, kept: false });
        assert!(empty.join("readme.txt").is_file());
        // A missing folder is fine too.
        assert_eq!(remove_named_data(&t.path().join("gone")), DataResult::default());
    }

    #[test]
    fn remove_data_keeps_an_unmarked_folder_while_taking_a_marked_one() {
        let t = tempfile::tempdir().unwrap();
        let (a, b) = (t.path().join("a"), t.path().join("b"));
        for d in [&a, &b] {
            std::fs::create_dir_all(d).unwrap();
            std::fs::write(d.join("settings.json"), "{}").unwrap();
        }
        mark(&a);
        let plan = DataPlan { atlas_dirs: vec![a.clone(), b.clone()], profile_dirs: vec![] };
        let r = remove_data(&plan);
        assert_eq!(r, DataResult { removed: 1, kept: true });
        assert!(!a.exists() && b.join("settings.json").is_file());
    }

    /// A link inside the data folder is taken away as a link: what it points at is never entered.
    #[cfg(windows)]
    #[test]
    fn a_link_in_the_data_folder_is_removed_not_followed() {
        let t = tempfile::tempdir().unwrap();
        let precious = t.path().join("precious");
        std::fs::create_dir_all(&precious).unwrap();
        std::fs::write(precious.join("keep.txt"), "mine").unwrap();
        let dir = t.path().join("atlas-data");
        std::fs::create_dir_all(&dir).unwrap();
        // A junction named like one of Atlas's folders, pointing at somebody's real folder.
        let made = Command::new("cmd").args(["/C", "mklink", "/J"]).arg(dir.join("history")).arg(&precious).output().unwrap();
        assert!(made.status.success(), "{}", String::from_utf8_lossy(&made.stdout));
        assert!(is_link(&dir.join("history")));
        mark(&dir);
        remove_named_data(&dir);
        assert!(!dir.join("history").exists(), "the link is gone");
        assert_eq!(std::fs::read_to_string(precious.join("keep.txt")).unwrap(), "mine", "what it pointed at is untouched");
    }

    fn env_in(root: &Path) -> Env {
        Env { home: root.join("home"), cwd: root.to_path_buf(), claude_config: None, atlas_data: None }
    }

    #[test]
    fn a_normal_install_names_atlas_folders_and_the_browser_profile_folders() {
        let t = tempfile::tempdir().unwrap();
        let env = env_in(t.path());
        let roam = t.path().join("Roaming");
        let local = t.path().join("Local");
        let plan = data_plan(&env, Some(roam.as_os_str()), Some(local.as_os_str()));
        assert_eq!(plan.profile_dirs, vec![roam.join(BUNDLE_ID), local.join(BUNDLE_ID)]);
        assert!(!plan.atlas_dirs.is_empty());
    }

    #[test]
    fn a_moved_data_folder_leaves_the_real_browser_profile_alone() {
        let t = tempfile::tempdir().unwrap();
        let mut env = env_in(t.path());
        env.atlas_data = Some(t.path().join("data").into_os_string());
        let roam = t.path().join("Roaming");
        let plan = data_plan(&env, Some(roam.as_os_str()), Some(roam.as_os_str()));
        assert!(plan.profile_dirs.is_empty());
        assert_eq!(plan.atlas_dirs, vec![t.path().join("data")]);
    }

    #[test]
    fn never_the_home_folder_a_parent_of_it_or_the_claude_folder() {
        let t = tempfile::tempdir().unwrap();
        let mut env = env_in(t.path());
        for bad in [env.home.clone(), t.path().to_path_buf(), env.home.join(".claude"), env.home.join(".claude").join("projects")] {
            env.atlas_data = Some(bad.clone().into_os_string());
            assert!(data_plan(&env, None, None).atlas_dirs.is_empty(), "{}", bad.display());
        }
        // A custom Claude folder is protected the same way.
        env.claude_config = Some(t.path().join("my-claude").into_os_string());
        env.atlas_data = Some(t.path().join("my-claude").into_os_string());
        assert!(data_plan(&env, None, None).atlas_dirs.is_empty());
    }

    #[test]
    fn tidy_takes_the_two_leftover_programs_and_an_empty_folder_but_not_data() {
        let t = tempfile::tempdir().unwrap();
        let dir = t.path().join("Atlas");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("uninstall.exe"), "u").unwrap();
        std::fs::write(dir.join(REMOVER_NAME), "r").unwrap();
        std::fs::write(dir.join("cache.sqlite"), "c").unwrap();
        tidy(&dir);
        assert!(!dir.join("uninstall.exe").exists() && !dir.join(REMOVER_NAME).exists());
        assert!(dir.join("cache.sqlite").is_file() && dir.is_dir(), "saved data stays when it was not asked to go");
        std::fs::remove_file(dir.join("cache.sqlite")).unwrap();
        tidy(&dir);
        assert!(!dir.exists());
    }

    #[test]
    fn the_cleanup_deletes_one_file_then_tries_each_folder_three_times() {
        let s = cleanup_script(4, r"C:\T\AtlasRemove-x\Uninstall Atlas.exe", &[r"C:\T\AtlasRemove-x", r"C:\Apps\Atlas"]);
        assert!(s.starts_with("ping -n 4 127.0.0.1 >nul & del /f /q \"C:\\T\\AtlasRemove-x\\Uninstall Atlas.exe\""));
        assert_eq!(s.matches("rmdir \"C:\\Apps\\Atlas\" 2>nul").count(), 3);
        assert_eq!(s.matches("rmdir \"C:\\T\\AtlasRemove-x\" 2>nul").count(), 3);
        assert_eq!(s.matches("del ").count(), 1, "one file only, never a wildcard");
        assert!(!s.contains("/s"), "rmdir never recurses");
    }

    #[test]
    fn a_path_with_a_cmd_special_character_is_never_put_in_a_command_line() {
        for bad in ["C:\\a!b\\x.exe", "C:\\100%\\x.exe", "C:\\a&b", "C:\\a^b", "C:\\a\"b", "C:\\a\nb"] {
            assert!(!cmd_safe(bad), "{bad:?}");
        }
        assert!(cmd_safe(r"C:\Users\Will\AppData\Local\Temp\AtlasRemove-x1\Uninstall Atlas.exe"));
        assert!(cmd_safe(r"C:\Program Files (x86)\Atlas"));
    }

    #[test]
    fn the_folder_to_remove_comes_from_the_install_not_from_where_the_file_runs() {
        let t = tempfile::tempdir().unwrap();
        let installed = t.path().join("Atlas");
        let downloads = t.path().join("Downloads");
        std::fs::create_dir_all(&installed).unwrap();
        std::fs::create_dir_all(&downloads).unwrap();
        std::fs::write(installed.join("uninstall.exe"), "u").unwrap();
        std::fs::write(installed.join("atlas.exe"), "a").unwrap();
        assert!(is_install_dir(&installed) && !is_install_dir(&downloads));
        // The remover beside Atlas names its own folder.
        assert_eq!(remove_target(&installed.join(REMOVER_NAME)), Some(installed.clone()));
        // A Setup in Downloads (even with an uninstaller-looking file) never aims at Downloads.
        std::fs::write(downloads.join("uninstall.exe"), "u").unwrap();
        std::fs::write(downloads.join("atlas.exe"), "a").unwrap();
        let target = remove_target(&downloads.join("Atlas-Setup-Windows-x64.exe"));
        assert_ne!(target.as_deref(), Some(downloads.as_path()));
        assert_ne!(remove_target(&downloads.join("Uninstall Atlas copy.exe")).as_deref(), Some(downloads.as_path()));
    }

    #[test]
    fn a_folder_without_the_installers_uninstaller_is_refused() {
        let t = tempfile::tempdir().unwrap();
        assert_eq!(run_installer_uninstaller(t.path(), |_| {}), Err(RemoveError::NotInstalledHere));
    }
}
