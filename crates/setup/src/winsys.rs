//! The few Windows calls setup needs, behind small safe functions: the registry (is the
//! WebView2 runtime there, where is Atlas installed) and processes (is Atlas running, ask
//! it to close).

use std::path::{Path, PathBuf};

use windows_sys::Win32::Foundation::{CloseHandle, ERROR_SUCCESS, HWND, INVALID_HANDLE_VALUE, LPARAM};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::Environment::GetCommandLineW;
use windows_sys::Win32::System::Registry::{
    HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_SET_VALUE, KEY_WOW64_32KEY, REG_SZ, RRF_RT_REG_SZ,
    RegCloseKey, RegGetValueW, RegOpenKeyExW, RegSetValueExW,
};
use windows_sys::Win32::System::Threading::{
    OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindowTextLengthW, GetWindowThreadProcessId, IsWindowVisible, PostMessageW, WM_CLOSE,
};

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Whether this process runs with an elevated (administrator) token. When the answer cannot be
/// read it is "yes": the safe side for the caller, which then declines to start Atlas.
pub fn is_elevated() -> bool {
    use windows_sys::Win32::Security::{GetTokenInformation, TOKEN_ELEVATION, TOKEN_QUERY, TokenElevation};
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
    // SAFETY: the token handle is closed on every path; the out buffer is a TOKEN_ELEVATION of
    // exactly the size passed.
    unsafe {
        let mut token = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return true;
        }
        let mut info = TOKEN_ELEVATION { TokenIsElevated: 0 };
        let mut got = 0u32;
        let ok = GetTokenInformation(
            token,
            TokenElevation,
            (&mut info as *mut TOKEN_ELEVATION).cast(),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut got,
        );
        CloseHandle(token);
        ok == 0 || info.TokenIsElevated != 0
    }
}

/// From now on a library loaded by name is searched for only in this program's own folder,
/// System32 and folders added on purpose (WebView2's loader needs its neighbours found), never
/// the current folder or PATH. Call it first thing in `main`. Failure is harmless: the link-time
/// `/DEPENDENTLOADFLAG` already restricts the DLLs the program imports to System32.
pub fn search_safe_dirs_only() {
    use windows_sys::Win32::System::LibraryLoader::{LOAD_LIBRARY_SEARCH_DEFAULT_DIRS, SetDefaultDllDirectories};
    // SAFETY: a plain flag call with no pointers.
    unsafe {
        SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);
    }
}

/// A plain message box (only when the styled window cannot be shown at all).
pub fn message(title: &str, text: &str) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MB_ICONERROR, MB_OK, MessageBoxW};
    // SAFETY: both strings are NUL-terminated buffers that outlive the call.
    unsafe {
        MessageBoxW(std::ptr::null_mut(), wide(text).as_ptr(), wide(title).as_ptr(), MB_OK | MB_ICONERROR);
    }
}

#[derive(Clone, Copy)]
pub enum Hive {
    CurrentUser,
    LocalMachine,
}

/// A text value from the registry, `None` when the key or value is missing.
/// `wow32` reads the 32-bit view (where WebView2 registers itself on 64-bit Windows).
pub fn reg_string(hive: Hive, key: &str, value: &str, wow32: bool) -> Option<String> {
    let root: HKEY = match hive {
        Hive::CurrentUser => HKEY_CURRENT_USER,
        Hive::LocalMachine => HKEY_LOCAL_MACHINE,
    };
    let mut opened: HKEY = std::ptr::null_mut();
    let access = KEY_READ | if wow32 { KEY_WOW64_32KEY } else { 0 };
    // SAFETY: plain registry reads into buffers this function owns; the key is closed on every path.
    unsafe {
        if RegOpenKeyExW(root, wide(key).as_ptr(), 0, access, &mut opened) != ERROR_SUCCESS {
            return None;
        }
        let name = wide(value);
        let mut bytes: u32 = 0;
        let probe = RegGetValueW(opened, std::ptr::null(), name.as_ptr(), RRF_RT_REG_SZ, std::ptr::null_mut(), std::ptr::null_mut(), &mut bytes);
        let out = if probe == ERROR_SUCCESS && bytes >= 2 {
            let mut buf = vec![0u16; (bytes as usize).div_ceil(2)];
            let got = RegGetValueW(opened, std::ptr::null(), name.as_ptr(), RRF_RT_REG_SZ, std::ptr::null_mut(), buf.as_mut_ptr().cast(), &mut bytes);
            (got == ERROR_SUCCESS).then(|| {
                let end = buf.iter().position(|c| *c == 0).unwrap_or(buf.len());
                String::from_utf16_lossy(&buf[..end])
            })
        } else {
            None
        };
        RegCloseKey(opened);
        out
    }
}

/// Change one existing text value of a key in the current user's registry. Never creates the
/// key: if it is not there (Windows does not list Atlas), nothing is written. True when written.
pub fn reg_set_string(hive: Hive, key: &str, value: &str, data: &str) -> bool {
    let root: HKEY = match hive {
        Hive::CurrentUser => HKEY_CURRENT_USER,
        Hive::LocalMachine => return false, // Setup installs for the current user only
    };
    let mut opened: HKEY = std::ptr::null_mut();
    let text = wide(data);
    // SAFETY: a key opened for writing values and closed on every path; the data is a
    // NUL-terminated UTF-16 buffer whose byte length is passed.
    unsafe {
        if RegOpenKeyExW(root, wide(key).as_ptr(), 0, KEY_SET_VALUE, &mut opened) != ERROR_SUCCESS {
            return false;
        }
        let ok = RegSetValueExW(opened, wide(value).as_ptr(), 0, REG_SZ, text.as_ptr().cast(), (text.len() * 2) as u32) == ERROR_SUCCESS;
        RegCloseKey(opened);
        ok
    }
}

/// This program's own command line, as Windows received it (nothing re-quoted).
pub fn command_line() -> String {
    // SAFETY: the pointer is the process's own NUL-terminated command line, valid for the
    // life of the process; it is only read, up to its terminator.
    unsafe {
        let p = GetCommandLineW();
        if p.is_null() {
            return String::new();
        }
        let mut n = 0;
        while *p.add(n) != 0 {
            n += 1;
        }
        String::from_utf16_lossy(std::slice::from_raw_parts(p, n))
    }
}

/// The processes called `exe_name` (case-insensitive) whose file is `exe_path`.
/// Returns their ids.
pub fn processes_running(exe_path: &Path) -> Vec<u32> {
    let Some(name) = exe_path.file_name().map(|n| n.to_string_lossy().to_lowercase()) else {
        return Vec::new();
    };
    let want = norm(exe_path);
    let mut found = Vec::new();
    // SAFETY: a ToolHelp snapshot walked with the documented first/next pair; handles are closed.
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE {
            return found;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut ok = Process32FirstW(snap, &mut entry) != 0;
        while ok {
            let end = entry.szExeFile.iter().position(|c| *c == 0).unwrap_or(entry.szExeFile.len());
            let exe = String::from_utf16_lossy(&entry.szExeFile[..end]).to_lowercase();
            if exe == name && image_path(entry.th32ProcessID).is_some_and(|p| norm(&p) == want) {
                found.push(entry.th32ProcessID);
            }
            ok = Process32NextW(snap, &mut entry) != 0;
        }
        CloseHandle(snap);
    }
    found
}

fn image_path(pid: u32) -> Option<PathBuf> {
    // SAFETY: a limited-rights handle, read once, closed.
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return None;
        }
        let mut buf = vec![0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(h, 0, buf.as_mut_ptr(), &mut len) != 0;
        CloseHandle(h);
        ok.then(|| PathBuf::from(String::from_utf16_lossy(&buf[..len as usize])))
    }
}

fn norm(p: &Path) -> String {
    p.to_string_lossy().replace('/', "\\").trim_end_matches('\\').to_lowercase()
}

/// Ask these Atlas processes to quit through the program's own quit signal (`atlas_core::
/// quit_signal`), which works with close-to-tray on. True when at least one running Atlas
/// received it; false when none listens (an older Atlas) or no process could be read.
pub fn request_quit(pids: &[u32]) -> bool {
    let mut any = false;
    for path in pids.iter().filter_map(|pid| image_path(*pid)) {
        // Every one is asked (no early exit): two copies of the same program share one event name.
        any |= atlas_core::quit_signal::request(&path);
    }
    any
}

/// Ask the windows of these processes to close, the same as the X button. Nothing is
/// ended by force: Atlas decides (it may keep an unsaved edit open and say so).
///
/// Only windows a person can see get the request. A program also owns hidden windows (the
/// event loop's own, the tray's); closing those breaks it without ending it, which leaves a
/// process that never exits (proven: posting WM_CLOSE to every window of Atlas left an idle
/// Atlas running forever). Returns how many windows were asked: 0 means Atlas has no
/// window up (it is in the tray), so waiting for it to leave would be pointless.
pub fn ask_to_close(pids: &[u32]) -> usize {
    struct Ctx<'a> {
        pids: &'a [u32],
        asked: usize,
    }
    unsafe extern "system" fn each(hwnd: HWND, lparam: LPARAM) -> i32 {
        // SAFETY: `lparam` is the `Ctx` pointer passed below and outlives the EnumWindows call.
        unsafe {
            let ctx = &mut *(lparam as *mut Ctx);
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, &mut pid);
            // A window a person can see is visible and has a title; the event loop's own
            // "Tao Thread Event Target" is flagged visible too but has none.
            if ctx.pids.contains(&pid) && IsWindowVisible(hwnd) != 0 && GetWindowTextLengthW(hwnd) > 0 {
                PostMessageW(hwnd, WM_CLOSE, 0, 0);
                ctx.asked += 1;
            }
        }
        1
    }
    let mut ctx = Ctx { pids, asked: 0 };
    // SAFETY: the callback only touches `ctx`, which lives until EnumWindows returns.
    unsafe {
        EnumWindows(Some(each), &mut ctx as *mut Ctx as LPARAM);
    }
    ctx.asked
}
