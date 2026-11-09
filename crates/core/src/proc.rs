//! Starting other programs without a console window flashing on screen.
//!
//! Atlas is a windowed app, so a console program it starts (the `claude` command is often a
//! `.cmd` shim that runs through `cmd.exe`) would open a black window for a moment on Windows
//! unless told not to. Every child process Atlas starts goes through `quiet`.

use std::process::Command;

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
