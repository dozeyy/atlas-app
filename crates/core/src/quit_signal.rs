//! A way to ask a running Atlas to quit for real, from another program (the Atlas installer).
//!
//! Closing Atlas's window is not enough: with close-to-tray on, the window only hides and the
//! program lives on in the tray. So the running Atlas listens on a named Windows event that is
//! unique to its own program file (a different copy of Atlas never hears it), and whoever
//! needs it to leave sets that event. Setting an event can do nothing else to Atlas: it only
//! asks it to run its normal quit, the same as the tray's Quit.

use std::path::Path;

/// The event's name for the Atlas program at `exe`: stable, case-insensitive, per file path.
pub fn event_name(exe: &Path) -> String {
    let mut p = exe.to_string_lossy().replace('/', "\\").to_lowercase();
    if let Some(rest) = p.strip_prefix(r"\\?\") {
        p = rest.to_string();
    }
    // FNV-1a, 64 bit: a short, fixed-length name that cannot hold a path separator.
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in p.trim_end_matches('\\').bytes() {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("Local\\AtlasQuit-{h:016x}")
}

#[cfg(windows)]
mod imp {
    use super::event_name;
    use std::path::Path;
    use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Threading::{
        CreateEventW, EVENT_MODIFY_STATE, INFINITE, OpenEventW, SetEvent, WaitForSingleObject,
    };

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// Start listening for the quit request of the Atlas at `exe` (this program). `on_quit` runs
    /// once, on its own thread, when someone asks. False when the event could not be made; Atlas
    /// then simply cannot be asked this way, and the caller falls back to the window.
    pub fn listen(exe: &Path, on_quit: impl FnOnce() + Send + 'static) -> bool {
        let name = wide(&event_name(exe));
        // SAFETY: a NUL-terminated name that outlives the call; no security attributes (default).
        // Auto-reset, not signalled: one request wakes one listener, and the event stays alive
        // as long as this program holds the handle (it is never closed on purpose).
        let handle = unsafe { CreateEventW(std::ptr::null(), 0, 0, name.as_ptr()) };
        if handle.is_null() {
            return false;
        }
        let raw = handle as usize;
        std::thread::Builder::new()
            .name("quit-signal".into())
            .spawn(move || {
                // SAFETY: the handle stays open for the life of the program.
                let r = unsafe { WaitForSingleObject(raw as _, INFINITE) };
                if r == WAIT_OBJECT_0 {
                    on_quit();
                }
            })
            .is_ok()
    }

    /// Ask the Atlas at `exe` to quit. True when an Atlas that listens received the request;
    /// false when none is listening (an older Atlas, or none at all).
    pub fn request(exe: &Path) -> bool {
        let name = wide(&event_name(exe));
        // SAFETY: a NUL-terminated name; the handle is closed on every path.
        unsafe {
            let handle = OpenEventW(EVENT_MODIFY_STATE, 0, name.as_ptr());
            if handle.is_null() {
                return false;
            }
            let ok = SetEvent(handle) != 0;
            CloseHandle(handle);
            ok
        }
    }
}

#[cfg(windows)]
pub use imp::{listen, request};

/// Nobody listens off Windows (the installer that asks is Windows-only).
#[cfg(not(windows))]
pub fn listen(_exe: &Path, _on_quit: impl FnOnce() + Send + 'static) -> bool {
    false
}

#[cfg(not(windows))]
pub fn request(_exe: &Path) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn the_name_is_per_program_file_and_ignores_case_and_slashes() {
        let a = event_name(&PathBuf::from(r"C:\Users\Will\AppData\Local\Atlas\atlas.exe"));
        let b = event_name(&PathBuf::from(r"c:/users/will/appdata/local/atlas/ATLAS.EXE"));
        let c = event_name(&PathBuf::from(r"\\?\C:\Users\Will\AppData\Local\Atlas\atlas.exe"));
        assert_eq!(a, b);
        assert_eq!(a, c);
        assert_ne!(a, event_name(&PathBuf::from(r"C:\dev\atlas.exe")), "another copy does not hear it");
        assert!(a.starts_with("Local\\AtlasQuit-") && a.len() == "Local\\AtlasQuit-".len() + 16);
    }

    #[cfg(windows)]
    #[test]
    fn a_request_reaches_only_the_atlas_that_listens() {
        let exe = PathBuf::from(format!(r"C:\atlas-test\{}\atlas.exe", std::process::id()));
        assert!(!request(&exe), "nobody listens yet");
        let (tx, rx) = std::sync::mpsc::channel();
        assert!(listen(&exe, move || tx.send(()).unwrap()));
        assert!(!request(&PathBuf::from(r"C:\atlas-test\other\atlas.exe")), "a different copy is not asked");
        assert!(rx.try_recv().is_err());
        assert!(request(&exe));
        rx.recv_timeout(std::time::Duration::from_secs(5)).expect("the listener ran its quit");
    }
}
