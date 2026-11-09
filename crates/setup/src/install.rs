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

use serde::Deserialize;

/// The installer file, carried inside this program. Empty unless built with `--features payload`.
#[cfg(feature = "payload")]
static PAYLOAD: &[u8] = include_bytes!(env!("ATLAS_PAYLOAD_PATH"));
#[cfg(not(feature = "payload"))]
static PAYLOAD: &[u8] = &[];

pub fn payload_present() -> bool {
    !PAYLOAD.is_empty()
}

/// The two choices on the Ready screen.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    pub desktop_shortcut: bool,
    pub open_when_done: bool,
}

impl Default for Options {
    fn default() -> Self {
        Options { desktop_shortcut: false, open_when_done: true }
    }
}

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

pub fn atlas_exe(dir: &Path) -> PathBuf {
    dir.join("atlas.exe")
}

/// The switches for the silent run. `/NS` is the installer's own "no desktop shortcut"; without
/// it a silent install makes one. The folder switch is separate (`folder_switch`) because the
/// installer wants it last and unquoted.
pub fn silent_args(opts: &Options) -> Vec<&'static str> {
    let mut a = vec!["/S"];
    if !opts.desktop_shortcut {
        a.push("/NS");
    }
    a
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
    dir: PathBuf,
    pub exe: PathBuf,
}

impl Drop for Unpacked {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

pub fn unpack() -> Result<Unpacked, InstallError> {
    if !payload_present() {
        return Err(InstallError::NoInstallerInside);
    }
    let dir = std::env::temp_dir().join(format!("AtlasSetup-{}", std::process::id()));
    std::fs::create_dir_all(&dir).map_err(|_| InstallError::CouldNotUnpack)?;
    let exe = dir.join("Atlas-installer.exe");
    let write = || -> std::io::Result<()> {
        let mut f = std::fs::File::create(&exe)?;
        f.write_all(PAYLOAD)?;
        f.sync_all()
    };
    if write().is_err() {
        let _ = std::fs::remove_dir_all(&dir);
        return Err(InstallError::CouldNotUnpack);
    }
    Ok(Unpacked { dir, exe })
}

/// Run the installer silently and wait for it, reporting `progress_on_disk` while it works.
/// The check at the end is the file itself, not just the exit code.
pub fn run_silent(exe: &Path, opts: &Options, mut on_progress: impl FnMut(f32)) -> Result<(), InstallError> {
    let dir = install_dir();
    let mut cmd = Command::new(exe);
    cmd.args(silent_args(opts)).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
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

/// The plain interactive installer (used when the styled window cannot run): wait for it.
/// Returns its exit code.
pub fn run_interactive(exe: &Path) -> Result<i32, InstallError> {
    let mut cmd = Command::new(exe);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        if let Some(d) = folder_switch() {
            cmd.raw_arg(d);
        }
    }
    let status = cmd.status().map_err(|_| InstallError::CouldNotStart)?;
    Ok(status.code().unwrap_or(-1))
}

/// Start Atlas on its own, so closing Setup does not close it.
pub fn launch(dir: &Path) -> std::io::Result<()> {
    let mut cmd = Command::new(atlas_exe(dir));
    cmd.current_dir(dir).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0000_0008 | 0x0000_0200); // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    }
    cmd.spawn().map(|_| ())
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
    fn the_desktop_shortcut_is_the_installers_own_switch() {
        assert_eq!(silent_args(&Options { desktop_shortcut: false, open_when_done: true }), vec!["/S", "/NS"]);
        assert_eq!(silent_args(&Options { desktop_shortcut: true, open_when_done: true }), vec!["/S"]);
    }

    #[test]
    fn defaults_are_no_shortcut_and_open_when_done() {
        let d = Options::default();
        assert!(!d.desktop_shortcut && d.open_when_done);
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
