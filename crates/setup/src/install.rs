//! Running the real Atlas installer that this program carries.
//!
//! The installer is the NSIS file Tauri builds for the app. Keeping it underneath means the
//! Start menu entry, the Apps and features uninstall entry and the later in-app updates are
//! exactly what a plain install gives. Setup unpacks it to a temp folder, runs it silently
//! (it installs for the current user only: no admin prompt), checks the result, and removes
//! the temp copy.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// The installer file, carried inside this program. Empty unless built with `--features payload`.
#[cfg(feature = "payload")]
static PAYLOAD: &[u8] = include_bytes!(env!("ATLAS_PAYLOAD_PATH"));
#[cfg(not(feature = "payload"))]
static PAYLOAD: &[u8] = &[];

pub fn payload_present() -> bool {
    !PAYLOAD.is_empty()
}

/// The remover that sits beside Atlas: Setup's own program in its remove mode. Apps and features
/// points at it, and so does Settings > About.
pub const REMOVER_NAME: &str = "Uninstall Atlas.exe";

/// Where Windows lists Atlas in Apps and features (the installer writes it; per-user).
pub const UNINSTALL_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\Atlas";

/// Test hook: install here instead of the default folder (so a test never touches a real install).
pub const INSTALL_DIR_ENV: &str = "ATLAS_SETUP_INSTALL_DIR";

/// Where the installer will put Atlas: the test hook, else where a previous install
/// recorded itself, else the per-user default the installer itself uses.
pub fn install_dir() -> PathBuf {
    if let Some(d) = std::env::var_os(INSTALL_DIR_ENV).filter(|d| !d.is_empty()) {
        return PathBuf::from(d);
    }
    #[cfg(windows)]
    if let Some(prev) = crate::winsys::reg_string(crate::winsys::Hive::CurrentUser, r"Software\willhenry\Atlas", "", false)
        .filter(|p| !p.trim().is_empty())
    {
        return PathBuf::from(prev);
    }
    std::env::var_os("LOCALAPPDATA")
        .map(|d| PathBuf::from(d).join("Atlas"))
        .unwrap_or_else(|| std::env::temp_dir().join("Atlas"))
}

/// The folder every program Setup starts gets as its working folder. A process keeps its working
/// folder open, so one that inherited the install folder would stop that folder from being
/// removed. The Windows folder is never one a removal could touch.
pub fn neutral_dir() -> PathBuf {
    std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
        .unwrap_or_else(std::env::temp_dir)
}

/// Leave the install folder (or anything under it) as this process's own working folder.
pub fn leave_folder(dir: &Path) {
    if let Ok(cwd) = std::env::current_dir()
        && (cwd.starts_with(dir) || cwd.to_string_lossy().to_lowercase().starts_with(&dir.to_string_lossy().to_lowercase()))
    {
        let _ = std::env::set_current_dir(neutral_dir());
    }
}

pub fn atlas_exe(dir: &Path) -> PathBuf {
    dir.join("atlas.exe")
}

/// The switches for the silent run. `/NS` is the installer's own "no desktop shortcut"; without
/// it a silent install makes one. The folder switch is separate (`folder_switch`) because the
/// installer wants it last and unquoted.
pub fn silent_args() -> [&'static str; 2] {
    ["/S", "/NS"]
}

/// `/D=<folder>` only when the folder is a test override; it must be the final argument and
/// is never quoted, even with spaces in the path.
pub fn folder_switch() -> Option<String> {
    std::env::var_os(INSTALL_DIR_ENV).filter(|d| !d.is_empty()).map(|d| format!("/D={}", d.to_string_lossy()))
}

/// How far the installer has got, read from what it has put on disk (it reports nothing itself).
/// 0.15 when it starts, 0.6 once Atlas is written, 0.85 once its uninstaller is.
pub fn progress_on_disk(dir: &Path) -> f32 {
    if dir.join("uninstall.exe").exists() {
        0.85
    } else if atlas_exe(dir).exists() {
        0.6
    } else {
        0.15
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum InstallError {
    NoInstallerInside,
    CouldNotUnpack,
    CouldNotStart,
    Stopped(i32),
    NotFound,
}

impl InstallError {
    /// Plain words for the window.
    pub fn message(&self) -> String {
        match self {
            InstallError::NoInstallerInside => "This copy of Setup has no installer inside. Download it again.".into(),
            InstallError::CouldNotUnpack => "Setup could not unpack its files. Check the disk has room, then try again.".into(),
            InstallError::CouldNotStart => "Windows would not start the installer. Try again.".into(),
            InstallError::Stopped(code) => {
                format!("The installer stopped before it finished (code {code}). Close other programs and try again.")
            }
            InstallError::NotFound => "The install finished, but Atlas is not where it should be. Try again.".into(),
        }
    }
}

/// The unpacked installer in its own temp folder; the folder is removed when this is dropped.
pub struct Unpacked {
    /// Removed, with the installer in it, when this is dropped.
    _dir: tempfile::TempDir,
    pub exe: PathBuf,
}

/// Write `bytes` as a new file called `name` in `dir`. The file must not exist yet.
fn write_new(dir: &Path, name: &str, bytes: &[u8]) -> std::io::Result<PathBuf> {
    let path = dir.join(name);
    let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(&path)?;
    f.write_all(bytes)?;
    f.sync_all()?;
    Ok(path)
}

/// The folder is new and its name unpredictable (random, made by the system, never one that
/// already exists), so nothing another program left in the temp folder can stand in for it.
pub fn unpack() -> Result<Unpacked, InstallError> {
    if !payload_present() {
        return Err(InstallError::NoInstallerInside);
    }
    // A virus scanner can hold a file it has only just seen for a moment (seen once, 12 ms into
    // a run, gone on the next try), so a failed write gets a few fresh folders before it is an error.
    for attempt in 0..4 {
        if attempt > 0 {
            std::thread::sleep(Duration::from_millis(200));
        }
        let Ok(dir) = tempfile::Builder::new().prefix("AtlasSetup-").tempdir() else { continue };
        if let Ok(exe) = write_new(dir.path(), "Atlas-installer.exe", PAYLOAD) {
            return Ok(Unpacked { _dir: dir, exe });
        }
    }
    Err(InstallError::CouldNotUnpack)
}

/// Run the installer silently and wait for it, reporting `progress_on_disk` while it works.
/// The check at the end is the file itself, not just the exit code.
pub fn run_silent(exe: &Path, mut on_progress: impl FnMut(f32)) -> Result<(), InstallError> {
    let dir = install_dir();
    let mut cmd = Command::new(exe);
    cmd.args(silent_args()).current_dir(neutral_dir()).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        if let Some(d) = folder_switch() {
            cmd.raw_arg(d);
        }
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd.spawn().map_err(|_| InstallError::CouldNotStart)?;
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) => {
                on_progress(progress_on_disk(&dir));
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(_) => return Err(InstallError::CouldNotStart),
        }
    };
    if !status.success() {
        return Err(InstallError::Stopped(status.code().unwrap_or(-1)));
    }
    if !atlas_exe(&dir).is_file() {
        return Err(InstallError::NotFound);
    }
    Ok(())
}

/// Copy a program's bytes to `to`, and only its bytes. A plain copy would also carry the
/// download's "came from the internet" mark, and Windows would then ask the person about the
/// remover the first time it runs.
pub fn copy_bytes(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut src = std::fs::File::open(from)?;
    let mut dst = std::fs::OpenOptions::new().write(true).create(true).truncate(true).open(to)?;
    std::io::copy(&mut src, &mut dst)?;
    dst.sync_all()
}

/// Put the remover beside Atlas and make Apps and features start it. The remover is this very
/// program (it picks its role from its own file name), written under a temporary name and
/// renamed into place so a half-written file is never what runs. Failure is not an install
/// failure: Windows then keeps the installer's plain uninstaller.
pub fn place_remover(dir: &Path) -> std::io::Result<PathBuf> {
    let me = std::env::current_exe()?;
    let to = dir.join(REMOVER_NAME);
    let tmp = dir.join(format!("{REMOVER_NAME}.part"));
    copy_bytes(&me, &tmp)?;
    if let Err(e) = std::fs::rename(&tmp, &to) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    #[cfg(windows)]
    crate::winsys::reg_set_string(crate::winsys::Hive::CurrentUser, UNINSTALL_KEY, "UninstallString", &format!("\"{}\"", to.display()));
    Ok(to)
}

/// What `launch` did.
#[derive(Debug, PartialEq, Eq)]
pub enum Launched {
    Started,
    /// Setup runs as administrator: Atlas would inherit that token, and a chat reader has no
    /// business running elevated. It is left for the person to open from the Start menu.
    SkippedElevated,
}

/// Start Atlas on its own, so closing Setup does not close it. Never from an elevated Setup.
pub fn launch(dir: &Path) -> std::io::Result<Launched> {
    #[cfg(windows)]
    if crate::winsys::is_elevated() {
        return Ok(Launched::SkippedElevated);
    }
    let mut cmd = Command::new(atlas_exe(dir));
    // Not the install folder: Atlas starts the remover later, and anything started from Atlas
    // would inherit this folder and hold it open past the removal.
    cmd.current_dir(neutral_dir()).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0000_0008 | 0x0000_0200); // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    }
    cmd.spawn().map(|_| Launched::Started)
}

/// Wait for a condition, polling; true when it held before the limit.
pub fn wait_for(limit: Duration, mut cond: impl FnMut() -> bool) -> bool {
    let end = Instant::now() + limit;
    loop {
        if cond() {
            return true;
        }
        if Instant::now() >= end {
            return false;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_install_is_silent_and_makes_no_desktop_shortcut() {
        assert_eq!(silent_args(), ["/S", "/NS"]);
    }

    #[test]
    fn the_remover_copy_carries_the_bytes_and_nothing_else() {
        let t = tempfile::tempdir().unwrap();
        let from = t.path().join("setup.exe");
        std::fs::write(&from, b"program bytes").unwrap();
        let to = t.path().join(REMOVER_NAME);
        std::fs::write(&to, b"an older, longer remover file").unwrap();
        copy_bytes(&from, &to).unwrap();
        assert_eq!(std::fs::read(&to).unwrap(), b"program bytes", "replaced whole, not overlaid");
    }

    #[test]
    fn progress_follows_what_the_installer_has_written() {
        let t = tempfile::tempdir().unwrap();
        assert_eq!(progress_on_disk(t.path()), 0.15);
        std::fs::write(atlas_exe(t.path()), b"x").unwrap();
        assert_eq!(progress_on_disk(t.path()), 0.6);
        std::fs::write(t.path().join("uninstall.exe"), b"x").unwrap();
        assert_eq!(progress_on_disk(t.path()), 0.85);
    }

    #[test]
    fn errors_are_plain_words_without_codes_where_a_code_does_not_help() {
        for e in [InstallError::NoInstallerInside, InstallError::CouldNotUnpack, InstallError::CouldNotStart, InstallError::NotFound] {
            let m = e.message();
            assert!(m.ends_with('.') && !m.contains('!'), "{m}");
        }
        assert!(InstallError::Stopped(2).message().contains("code 2"));
    }

    #[test]
    fn the_installer_is_written_to_a_new_file_never_over_an_existing_one() {
        let t = tempfile::tempdir().unwrap();
        let first = write_new(t.path(), "i.exe", b"payload").unwrap();
        assert_eq!(std::fs::read(&first).unwrap(), b"payload");
        let again = write_new(t.path(), "i.exe", b"planted");
        assert!(again.is_err(), "a file already there is refused, not reused");
        assert_eq!(std::fs::read(&first).unwrap(), b"payload");
    }

    #[test]
    fn each_unpack_folder_is_new_and_unpredictable() {
        let a = tempfile::Builder::new().prefix("AtlasSetup-").tempdir().unwrap();
        let b = tempfile::Builder::new().prefix("AtlasSetup-").tempdir().unwrap();
        assert_ne!(a.path(), b.path());
        let name = a.path().file_name().unwrap().to_string_lossy().into_owned();
        assert!(name.starts_with("AtlasSetup-") && name != format!("AtlasSetup-{}", std::process::id()));
    }

    #[cfg(not(feature = "payload"))]
    #[test]
    fn a_build_without_the_installer_says_so() {
        assert!(!payload_present());
        assert_eq!(unpack().err(), Some(InstallError::NoInstallerInside));
    }

    #[test]
    fn wait_for_returns_when_the_condition_holds_or_time_runs_out() {
        let mut n = 0;
        assert!(wait_for(Duration::from_secs(2), || {
            n += 1;
            n > 2
        }));
        assert!(!wait_for(Duration::from_millis(80), || false));
    }
}
