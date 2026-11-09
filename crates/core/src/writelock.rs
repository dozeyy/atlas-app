//! One writer at a time across processes.
//!
//! The Atlas app and the Atlas MCP server (a separate process Claude starts) both change the
//! Claude setup through `setup_write`. Each change is "look, back up, write, read back", so two
//! of them racing could back up a file one of them is about to replace. A change takes this
//! lock first; it is an OS file lock in Atlas's own data folder, so a crashed holder never
//! leaves it stuck.

use std::fs::{self, File, OpenOptions, TryLockError};
use std::io;
use std::path::Path;
use std::time::{Duration, Instant};

/// Held while a change is made; the lock is released when it is dropped.
pub struct WriteGuard {
    _file: File,
}

/// Wait up to `wait` for the write lock in `dir` (Atlas's data folder).
pub fn acquire(dir: &Path, wait: Duration) -> io::Result<WriteGuard> {
    fs::create_dir_all(dir)?;
    let file = OpenOptions::new().create(true).truncate(false).write(true).open(dir.join("write.lock"))?;
    let start = Instant::now();
    loop {
        match file.try_lock() {
            Ok(()) => return Ok(WriteGuard { _file: file }),
            Err(TryLockError::WouldBlock) => {
                if start.elapsed() >= wait {
                    return Err(io::Error::new(io::ErrorKind::TimedOut, "Another Atlas change is in progress. Try again in a moment."));
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(TryLockError::Error(e)) => return Err(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_second_writer_waits_then_times_out_while_the_first_holds_it() {
        let dir = tempfile::tempdir().unwrap();
        let first = acquire(dir.path(), Duration::from_secs(1)).unwrap();
        let second = acquire(dir.path(), Duration::from_millis(100));
        assert_eq!(second.err().map(|e| e.kind()), Some(io::ErrorKind::TimedOut));
        drop(first);
        assert!(acquire(dir.path(), Duration::from_secs(1)).is_ok());
    }
}
