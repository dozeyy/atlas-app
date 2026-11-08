//! The only door to a transcript (D2, D5, D6, D9).
//!
//! `open_read_only` is the single place a transcript is opened, with read access
//! only. On Windows the default share mode (read | write | delete) stays, so Claude
//! Code can keep appending and its sweep can delete a file Atlas is reading.
//!
//! `read_lines` streams: a 1 MiB buffer and one reusable line buffer, never the
//! whole file. A trailing partial line (no `\n` yet) is never handed out; the
//! returned offset is the byte after the last `\n`. A line longer than the cap is
//! skipped without being buffered.

use std::fs::File;
use std::io::{self, BufRead, BufReader, Seek, SeekFrom};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

pub const LINE_CAP: usize = 64 * 1024 * 1024;
const BUF: usize = 1024 * 1024;
const BOM: [u8; 3] = [0xEF, 0xBB, 0xBF];

/// Open a transcript for reading. Nothing else in `usage/` opens files.
pub fn open_read_only(path: &Path) -> io::Result<File> {
    std::fs::OpenOptions::new().read(true).open(path)
}

/// Counters shared by all readers of one engine.
#[derive(Default)]
pub struct ReadStats {
    /// Bytes pulled from transcripts (acceptance 17).
    pub bytes_read: AtomicU64,
    /// Largest line buffer ever held (acceptance 24).
    pub max_buffer: AtomicU64,
}

impl ReadStats {
    pub fn bytes(&self) -> u64 {
        self.bytes_read.load(Ordering::Relaxed)
    }
    pub fn max_buffer(&self) -> u64 {
        self.max_buffer.load(Ordering::Relaxed)
    }
}

pub enum Item<'a> {
    /// One complete line, without its `\n`.
    Line(&'a [u8]),
    /// A complete line longer than the cap, skipped.
    LongLine,
}

/// Read complete lines from `start`. `f(item, offset_after_the_line)` returns
/// false to stop early. Returns the offset after the last complete line handed
/// out (or `start`).
pub fn read_lines(
    file: File,
    start: u64,
    cap: usize,
    stats: &ReadStats,
    mut f: impl FnMut(Item<'_>, u64) -> bool,
) -> io::Result<u64> {
    let mut r = BufReader::with_capacity(BUF, file);
    if start > 0 {
        r.seek(SeekFrom::Start(start))?;
    }
    let mut line: Vec<u8> = Vec::new();
    let mut skipping = false;
    let mut line_start = start; // offset where the current line began
    let mut consumed_in_line = 0u64;
    let mut committed = start;
    let mut at_start = start == 0;

    loop {
        let buf = r.fill_buf()?;
        if buf.is_empty() {
            break;
        }
        if at_start {
            at_start = false;
            if buf.starts_with(&BOM) {
                stats.bytes_read.fetch_add(3, Ordering::Relaxed);
                r.consume(3);
                line_start += 3;
                committed = line_start;
                continue;
            }
        }
        let n = buf.len();
        match memchr::memchr(b'\n', buf) {
            Some(i) => {
                let chunk = &buf[..i];
                let end = line_start + consumed_in_line + i as u64 + 1;
                let keep_going = if skipping || chunk.len() + line.len() > cap {
                    f(Item::LongLine, end)
                } else if line.is_empty() {
                    f(Item::Line(chunk), end)
                } else {
                    line.extend_from_slice(chunk);
                    stats.max_buffer.fetch_max(line.len() as u64, Ordering::Relaxed);
                    f(Item::Line(&line), end)
                };
                stats.bytes_read.fetch_add(i as u64 + 1, Ordering::Relaxed);
                r.consume(i + 1);
                committed = end;
                line_start = end;
                consumed_in_line = 0;
                skipping = false;
                line.clear();
                if line.capacity() > 4 * BUF {
                    line = Vec::new();
                }
                if !keep_going {
                    return Ok(committed);
                }
            }
            None => {
                if !skipping {
                    if line.len() + n > cap {
                        skipping = true;
                        line = Vec::new();
                    } else {
                        line.extend_from_slice(buf);
                        stats.max_buffer.fetch_max(line.len() as u64, Ordering::Relaxed);
                    }
                }
                consumed_in_line += n as u64;
                stats.bytes_read.fetch_add(n as u64, Ordering::Relaxed);
                r.consume(n);
            }
        }
    }
    Ok(committed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn collect(bytes: &[u8], start: u64, cap: usize) -> (Vec<String>, usize, u64, ReadStats) {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("t.jsonl");
        std::fs::write(&p, bytes).unwrap();
        let stats = ReadStats::default();
        let mut lines = Vec::new();
        let mut longs = 0;
        let off = read_lines(open_read_only(&p).unwrap(), start, cap, &stats, |it, _| {
            match it {
                Item::Line(l) => lines.push(String::from_utf8_lossy(l).into_owned()),
                Item::LongLine => longs += 1,
            }
            true
        })
        .unwrap();
        (lines, longs, off, stats)
    }

    #[test]
    fn holds_back_a_partial_last_line() {
        let (lines, _, off, _) = collect(b"a\nbb\nccc", 0, 100);
        assert_eq!(lines, ["a", "bb"]);
        assert_eq!(off, 5);
        let (lines, _, off, _) = collect(b"a\nbb\nccc\n", 5, 100);
        assert_eq!(lines, ["ccc"]);
        assert_eq!(off, 9);
    }

    #[test]
    fn bom_and_crlf() {
        let (lines, _, off, _) = collect(b"\xEF\xBB\xBFone\r\ntwo\r\n", 0, 100);
        assert_eq!(lines, ["one\r", "two\r"]);
        assert_eq!(off, 13);
    }

    #[test]
    fn long_lines_are_skipped_without_buffering() {
        let mut data = b"ok\n".to_vec();
        data.extend(std::iter::repeat_n(b'x', 5000));
        data.extend(b"\nafter\n");
        let (lines, longs, off, stats) = collect(&data, 0, 1000);
        assert_eq!(lines, ["ok", "after"]);
        assert_eq!(longs, 1);
        assert_eq!(off, data.len() as u64);
        assert!(stats.max_buffer() <= 1000);
    }

    #[test]
    fn an_unfinished_long_line_stays_uncommitted() {
        let mut data = b"ok\n".to_vec();
        data.extend(std::iter::repeat_n(b'x', 5000));
        let (lines, longs, off, _) = collect(&data, 0, 1000);
        assert_eq!(lines, ["ok"]);
        assert_eq!(longs, 0);
        assert_eq!(off, 3);
    }
}
