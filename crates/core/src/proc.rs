//! Starting other programs without a console window flashing on screen.
//!
//! Atlas is a windowed app, so a console program it starts (the `claude` command is often a
//! `.cmd` shim that runs through `cmd.exe`) would open a black window for a moment on Windows
//! unless told not to. Every child process Atlas starts goes through `quiet`.

use std::process::{Child, Command};
use std::time::{Duration, Instant};

/// Windows process flag: do not create a console window for this child.
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Make `cmd` start without a console window (no effect off Windows).
pub fn quiet(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

// ---------------------------------------------------------------------------
// A child and everything it starts
// ---------------------------------------------------------------------------

/// Prepare `cmd` so the child leads its own group of processes (Unix). On Windows the group is a
/// Job Object that `Tree::adopt` puts the child in right after it starts.
pub fn lead_a_group(cmd: &mut Command) -> &mut Command {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    cmd
}

/// The whole tree under one child: the `claude` command on Windows is a `.cmd` shim, so the
/// process Atlas starts is `cmd.exe` and the work is done by a `node` it starts. Killing only
/// the one Atlas started leaves the real work running. A `Tree` can end every process in it and
/// say when they are gone; dropping it ends whatever is left (a Job Object with
/// kill-on-close on Windows, the process group on Unix).
pub struct Tree {
    #[cfg(windows)]
    job: usize,
    #[cfg(unix)]
    pgid: i32,
}

impl Tree {
    /// Put the just-started `child` in a tree of its own. `None` when it could not be done (the
    /// caller then stops the child rather than run it where it can't be stopped).
    #[cfg(windows)]
    pub fn adopt(child: &Child) -> Option<Tree> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
        use windows_sys::Win32::System::JobObjects::*;
        // SAFETY: plain Win32 calls with valid, owned handles; the job handle is closed on every path.
        unsafe {
            let job: HANDLE = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return None;
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let set = SetInformationJobObject(job, JobObjectExtendedLimitInformation, &info as *const _ as *const std::ffi::c_void, std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32);
            if set == 0 || AssignProcessToJobObject(job, child.as_raw_handle() as HANDLE) == 0 {
                CloseHandle(job);
                return None;
            }
            Some(Tree { job: job as usize })
        }
    }

    #[cfg(unix)]
    pub fn adopt(child: &Child) -> Option<Tree> {
        // The child was started as the leader of its own group (`lead_a_group`): its pid is the group id.
        i32::try_from(child.id()).ok().map(|pgid| Tree { pgid })
    }

    #[cfg(not(any(windows, unix)))]
    pub fn adopt(_child: &Child) -> Option<Tree> {
        Some(Tree {})
    }

    /// End every process in the tree now.
    pub fn kill_all(&self) {
        #[cfg(windows)]
        // SAFETY: the job handle is owned by `self` and open until drop.
        unsafe {
            windows_sys::Win32::System::JobObjects::TerminateJobObject(self.job as windows_sys::Win32::Foundation::HANDLE, 1);
        }
        #[cfg(unix)]
        // SAFETY: killpg only signals the group this tree made.
        unsafe {
            libc::killpg(self.pgid, libc::SIGKILL);
        }
    }

    /// Processes still running in the tree.
    fn active(&self) -> u32 {
        #[cfg(windows)]
        // SAFETY: the job handle is owned by `self`; the out struct is the size the call is told.
        unsafe {
            use windows_sys::Win32::System::JobObjects::*;
            let mut acc: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = std::mem::zeroed();
            let ok = QueryInformationJobObject(
                self.job as windows_sys::Win32::Foundation::HANDLE,
                JobObjectBasicAccountingInformation,
                &mut acc as *mut _ as *mut std::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                std::ptr::null_mut(),
            );
            if ok == 0 { 1 } else { acc.ActiveProcesses }
        }
        #[cfg(unix)]
        // SAFETY: signal 0 only asks whether the group exists.
        unsafe {
            if libc::killpg(self.pgid, 0) == 0 { 1 } else { 0 }
        }
        #[cfg(not(any(windows, unix)))]
        0
    }

    /// Wait up to `max` for the tree to be empty. True when it is.
    pub fn wait_gone(&self, max: Duration) -> bool {
        let start = Instant::now();
        loop {
            if self.active() == 0 {
                return true;
            }
            if start.elapsed() >= max {
                return false;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

impl Drop for Tree {
    fn drop(&mut self) {
        #[cfg(windows)]
        // SAFETY: closing the job handle (owned) ends anything left in it (kill-on-close).
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.job as windows_sys::Win32::Foundation::HANDLE);
        }
        #[cfg(unix)]
        self.kill_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Stdio;

    /// A child that starts a grandchild which would run for 30 s.
    fn long_tree() -> Command {
        #[cfg(windows)]
        {
            let mut c = Command::new("cmd.exe");
            c.args(["/c", "ping -n 30 127.0.0.1 >nul"]);
            c
        }
        #[cfg(not(windows))]
        {
            let mut c = Command::new("sh");
            c.args(["-c", "sleep 30 & wait"]);
            c
        }
    }

    fn start() -> (Child, Tree) {
        let mut cmd = long_tree();
        cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        lead_a_group(&mut cmd);
        quiet(&mut cmd);
        let child = cmd.spawn().unwrap();
        let tree = Tree::adopt(&child).expect("tree");
        (child, tree)
    }

    #[test]
    fn killing_the_tree_ends_the_grandchild_too() {
        let (mut child, tree) = start();
        // Let the grandchild start.
        std::thread::sleep(Duration::from_millis(600));
        assert!(!tree.wait_gone(Duration::from_millis(50)), "the tree is running");
        tree.kill_all();
        let _ = child.wait();
        assert!(tree.wait_gone(Duration::from_secs(5)), "everything under the child is gone");
    }

    #[test]
    fn dropping_the_tree_ends_what_is_left() {
        let (mut child, tree) = start();
        std::thread::sleep(Duration::from_millis(300));
        drop(tree);
        let start = Instant::now();
        let _ = child.wait();
        assert!(start.elapsed() < Duration::from_secs(10), "the child ended with its tree");
    }
}
