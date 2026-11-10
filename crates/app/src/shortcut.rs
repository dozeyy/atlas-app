//! "Shortcut on the desktop" (Settings, Windows only). The shortcut is a copy of the Start menu
//! entry the installer makes (same target, same app id), the same thing Atlas Setup's box makes, so
//! the uninstaller removes it as well. Nothing here touches the Claude folders.

use std::path::{Path, PathBuf};

/// The installer's own name for both entries.
const SHORTCUT: &str = "Atlas.lnk";

/// `None` when there is nothing to offer (not Windows, or no Start menu entry to copy, as in a
/// build run from the source tree); otherwise whether Atlas is on the desktop.
pub fn state_in(start_menu: &Path, desktop: &Path) -> Option<bool> {
    let on = desktop.join(SHORTCUT).exists();
    if !on && !start_menu.join(SHORTCUT).exists() {
        return None;
    }
    Some(on)
}

/// Make the desktop match `on`. Adding never replaces an `Atlas.lnk` already there; removing
/// takes away the one named `Atlas.lnk` (the installer's and Setup's name).
pub fn set_in(start_menu: &Path, desktop: &Path, on: bool) -> Result<bool, String> {
    let to = desktop.join(SHORTCUT);
    if on {
        if !to.exists() {
            std::fs::copy(start_menu.join(SHORTCUT), &to)
                .map_err(|_| "Atlas's Start menu entry is missing, so there is nothing to copy. Reinstall Atlas to add it.".to_string())?;
        }
    } else {
        match std::fs::remove_file(&to) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                return Err("Windows would not let Atlas remove the shortcut. Delete it from the desktop instead.".into());
            }
            _ => {}
        }
    }
    Ok(to.exists())
}

#[cfg(windows)]
fn folders() -> Option<(PathBuf, PathBuf)> {
    use windows::Win32::System::Com::CoTaskMemFree;
    use windows::Win32::UI::Shell::{FOLDERID_Desktop, FOLDERID_Programs, KF_FLAG_DEFAULT, SHGetKnownFolderPath};
    let get = |id| -> Option<PathBuf> {
        // SAFETY: on success the call hands back a CoTaskMem string, read once and freed here.
        unsafe {
            let p = SHGetKnownFolderPath(id, KF_FLAG_DEFAULT, None).ok()?;
            let out = p.to_string().ok().map(PathBuf::from);
            CoTaskMemFree(Some(p.0 as *const _));
            out
        }
    };
    // A Desktop moved into OneDrive is found where it really is.
    Some((get(&FOLDERID_Programs)?, get(&FOLDERID_Desktop)?))
}

#[cfg(not(windows))]
fn folders() -> Option<(PathBuf, PathBuf)> {
    None
}

#[tauri::command]
pub fn desktop_shortcut() -> Option<bool> {
    let (start, desktop) = folders()?;
    state_in(&start, &desktop)
}

#[tauri::command]
pub fn set_desktop_shortcut(on: bool) -> Result<bool, String> {
    let (start, desktop) = folders().ok_or("Shortcuts on the desktop are a Windows thing.")?;
    set_in(&start, &desktop, on)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copies_the_start_menu_entry_and_takes_it_away_again() {
        let t = tempfile::tempdir().unwrap();
        let (start, desk) = (t.path().join("Programs"), t.path().join("Desktop"));
        std::fs::create_dir_all(&start).unwrap();
        std::fs::create_dir_all(&desk).unwrap();
        assert_eq!(state_in(&start, &desk), None, "nothing to copy: not offered");

        std::fs::write(start.join(SHORTCUT), b"lnk").unwrap();
        assert_eq!(state_in(&start, &desk), Some(false));
        assert!(set_in(&start, &desk, true).unwrap());
        assert_eq!(std::fs::read(desk.join(SHORTCUT)).unwrap(), b"lnk");
        assert_eq!(state_in(&start, &desk), Some(true));

        // One already there is kept as it is.
        std::fs::write(desk.join(SHORTCUT), b"theirs").unwrap();
        assert!(set_in(&start, &desk, true).unwrap());
        assert_eq!(std::fs::read(desk.join(SHORTCUT)).unwrap(), b"theirs");

        assert!(!set_in(&start, &desk, false).unwrap());
        assert!(!set_in(&start, &desk, false).unwrap(), "already gone is fine");
        assert!(start.join(SHORTCUT).exists(), "the Start menu entry is never touched");

        std::fs::remove_file(start.join(SHORTCUT)).unwrap();
        assert!(set_in(&start, &desk, true).is_err());
    }
}
