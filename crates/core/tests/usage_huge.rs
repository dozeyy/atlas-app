//! Acceptance 24 and 25: very long lines and very large files.

mod common;

use std::fs::File;
use std::io::Write;
use std::time::Instant;

use atlas_core::usage::time::Tz;
use common::synth::{self, Made};
use common::*;

const MIB: usize = 1 << 20;
const BASE: i64 = 1_793_700_000_000; // 2026-11-03

fn tree() -> (tempfile::TempDir, std::path::PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("projects").join("-p");
    std::fs::create_dir_all(&p).unwrap();
    (dir, p)
}

#[test]
fn a_16_mib_file_with_2_and_8_mib_lines_parses_correctly() {
    let (dir, p) = tree();
    let sid = synth::session_id(1);
    let mut f = File::create(p.join(format!("{sid}.jsonl"))).unwrap();
    let mut want = Made::default();
    let mut n = 0u64;
    let mut push = |f: &mut File, want: &mut Made, pad: usize| {
        let mut buf = Vec::new();
        synth::assistant(&mut buf, &sid, "/synth/huge", &format!("h{n}"), BASE + (n as i64) * 1000, "claude-sonnet-5-5", 10, 7, 0, 0, pad);
        f.write_all(&buf).unwrap();
        want.messages += 1;
        want.input += 10;
        want.output += 7;
        want.bytes += buf.len() as u64;
        n += 1;
    };
    push(&mut f, &mut want, 100);
    push(&mut f, &mut want, 2 * MIB);
    push(&mut f, &mut want, 100);
    push(&mut f, &mut want, 8 * MIB);
    while want.bytes < 16 * MIB as u64 {
        push(&mut f, &mut want, 600);
    }
    drop(f);
    assert!(want.bytes >= 16 * MIB as u64);

    let fx = start(dir.path(), Tz::Fixed(0));
    assert_eq!(fx.one("SELECT COUNT(*) FROM messages") as u64, want.messages);
    assert_eq!(fx.one("SELECT SUM(output) FROM messages") as u64, want.output);
    assert_eq!(fx.one("SELECT SUM(input) FROM messages") as u64, want.input);
    let s = fx.engine.status();
    assert_eq!((s.long_lines, s.malformed_lines), (0, 0));
    let peak = fx.engine.max_line_buffer();
    assert!(peak >= 8 * MIB as u64, "the 8 MiB line was held whole ({peak})");
    assert!(peak <= 64 * MIB as u64, "never past the cap ({peak})");
}

#[test]
fn a_line_over_64_mib_is_skipped_counted_and_the_file_resyncs() {
    let (dir, p) = tree();
    let sid = synth::session_id(2);
    let mut f = File::create(p.join(format!("{sid}.jsonl"))).unwrap();
    let mut buf = Vec::new();
    synth::assistant(&mut buf, &sid, "/synth/huge", "before", BASE, "claude-sonnet-5-5", 11, 5, 0, 0, 10);
    f.write_all(&buf).unwrap();
    // 64 MiB + 1 byte of one line (the newline is extra).
    let head = br#"{"type":"assistant","pad":""#;
    let tail = br#""}"#;
    let pad = 64 * MIB + 1 - head.len() - tail.len();
    f.write_all(head).unwrap();
    let chunk = vec![b'z'; MIB];
    let mut left = pad;
    while left > 0 {
        let n = left.min(MIB);
        f.write_all(&chunk[..n]).unwrap();
        left -= n;
    }
    f.write_all(tail).unwrap();
    f.write_all(b"\n").unwrap();
    buf.clear();
    synth::assistant(&mut buf, &sid, "/synth/huge", "after", BASE + 1000, "claude-sonnet-5-5", 13, 9, 0, 0, 10);
    f.write_all(&buf).unwrap();
    drop(f);

    let fx = start(dir.path(), Tz::Fixed(0));
    assert_eq!(fx.one("SELECT COUNT(*) FROM messages"), 2, "both neighbours are read");
    assert_eq!(fx.one("SELECT SUM(output) FROM messages"), 14);
    let s = fx.engine.status();
    assert_eq!(s.long_lines, 1);
    assert!(fx.engine.max_line_buffer() <= 64 * MIB as u64, "buffer {}", fx.engine.max_line_buffer());
    // The file counts as fully read: an unchanged rescan reads nothing.
    let read = fx.engine.bytes_read();
    fx.rescan();
    assert_eq!(fx.engine.bytes_read(), read);
}

/// `cargo test -p atlas-core --test usage_huge -- --ignored`
#[test]
#[ignore = "generates a 300 MB file; run on demand"]
fn a_300_mb_file_indexes_with_the_exact_message_count() {
    let (dir, p) = tree();
    let sid = synth::session_id(3);
    let t = Instant::now();
    let made = synth::big_file(&p.join(format!("{sid}.jsonl")), 300_000_000, &sid, "/synth/big", BASE).unwrap();
    eprintln!("generated {} bytes, {} messages in {:?}", made.bytes, made.messages, t.elapsed());
    let t = Instant::now();
    let fx = start(dir.path(), Tz::Fixed(0));
    let took = t.elapsed();
    eprintln!("indexed in {took:?}, peak line buffer {}", fx.engine.max_line_buffer());
    assert_eq!(fx.one("SELECT COUNT(*) FROM messages") as u64, made.messages);
    assert_eq!(fx.one("SELECT SUM(output) FROM messages") as u64, made.output);
    assert_eq!(fx.engine.status().malformed_lines, 0);
    // The temp dir (and the file) is removed when `dir` drops.
}
