//! Synthetic transcripts for the huge-file tests and the bench. No real text: every
//! string is a counter or filler. Included by `tests/common/mod.rs` and, by path, by
//! the `usage_bench` example.
#![allow(dead_code)]

use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::Path;

/// Days since 1970-01-01 -> (year, month, day).
fn civil(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

pub fn iso(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let (y, m, d) = civil(secs.div_euclid(86_400));
    let t = secs.rem_euclid(86_400);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z", t / 3600, t % 3600 / 60, t % 60, ms.rem_euclid(1000))
}

pub fn session_id(n: u64) -> String {
    format!("{n:08x}-5eed-4eed-8eed-{n:012x}")
}

pub const MODELS: [&str; 3] = ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5"];

#[derive(Default, Debug, Clone, Copy)]
pub struct Made {
    pub messages: u64,
    pub input: u64,
    pub output: u64,
    pub bytes: u64,
}

impl Made {
    pub fn add(&mut self, o: Made) {
        self.messages += o.messages;
        self.input += o.input;
        self.output += o.output;
        self.bytes += o.bytes;
    }
}

pub struct Rng(pub u64);
impl Rng {
    pub fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
}

fn filler(out: &mut Vec<u8>, n: usize) {
    out.extend(std::iter::repeat_n(b'x', n));
}

/// One assistant line with `pad` bytes of filler text in its content.
#[allow(clippy::too_many_arguments)]
pub fn assistant(out: &mut Vec<u8>, session: &str, cwd: &str, key: &str, ts_ms: i64, model: &str, input: u64, output: u64, cw: u64, cr: u64, pad: usize) {
    write!(
        out,
        concat!(
            r#"{{"type":"assistant","uuid":"u-{key}","sessionId":"{sid}","timestamp":"{ts}","cwd":"{cwd}","#,
            r#""isSidechain":false,"requestId":"req_{key}","message":{{"id":"msg_{key}","type":"message","role":"assistant","#,
            r#""model":"{model}","content":[{{"type":"text","text":""#
        ),
        key = key,
        sid = session,
        ts = iso(ts_ms),
        cwd = cwd,
        model = model
    )
    .unwrap();
    filler(out, pad);
    write!(
        out,
        concat!(
            r#""}}],"usage":{{"input_tokens":{i},"output_tokens":{o},"cache_creation_input_tokens":{cw},"cache_read_input_tokens":{cr},"#,
            r#""cache_creation":{{"ephemeral_5m_input_tokens":{cw},"ephemeral_1h_input_tokens":0}},"#,
            r#""service_tier":"standard","speed":"standard","inference_geo":"global"}}}}}}"#,
            "\n"
        ),
        i = input,
        o = output,
        cw = cw,
        cr = cr
    )
    .unwrap();
}

/// A tool-result style line the parser never needs (it is skipped by the prefilter).
pub fn user_filler(out: &mut Vec<u8>, session: &str, key: &str, ts_ms: i64, size: usize) {
    write!(
        out,
        r#"{{"type":"user","uuid":"f-{key}","sessionId":"{sid}","timestamp":"{ts}","message":{{"role":"user","content":[{{"type":"tool_result","content":""#,
        key = key,
        sid = session,
        ts = iso(ts_ms)
    )
    .unwrap();
    filler(out, size);
    out.extend_from_slice(b"\"}]}}\n");
}

/// Write one file of about `target` bytes shaped like a real long session: one
/// assistant line to every few large tool-result lines.
pub fn big_file(path: &Path, target: u64, session: &str, cwd: &str, base_ms: i64) -> std::io::Result<Made> {
    let mut w = BufWriter::with_capacity(1 << 20, File::create(path)?);
    let mut made = Made::default();
    let mut buf = Vec::with_capacity(64 * 1024);
    let mut n = 0u64;
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    while made.bytes < target {
        buf.clear();
        let ts = base_ms + (n as i64) * 20_000;
        let (inp, outp) = (100 + rng.next() % 900, 50 + rng.next() % 500);
        assistant(&mut buf, session, cwd, &format!("big{n}"), ts, MODELS[(n % 3) as usize], inp, outp, rng.next() % 3000, rng.next() % 50_000, 1200);
        made.messages += 1;
        made.input += inp;
        made.output += outp;
        for k in 0..3 {
            user_filler(&mut buf, session, &format!("{n}-{k}"), ts + 1000 * (k + 1) as i64, 14_000);
        }
        made.bytes += buf.len() as u64;
        w.write_all(&buf)?;
        n += 1;
    }
    w.flush()?;
    Ok(made)
}

/// `messages` assistant lines spread over `sessions` files in `projects` project
/// folders, over the 365 days before `now_ms`. Small lines: this is the cache-size test.
pub fn many_files(projects_dir: &Path, messages: u64, sessions: u64, projects: u64, now_ms: i64, first_id: u64) -> std::io::Result<Made> {
    let per = messages / sessions;
    let mut made = Made::default();
    let mut rng = Rng(0xC0FF_EE00_1234_5678);
    for s in 0..sessions {
        let dir = projects_dir.join(format!("-synth-proj-{}", s % projects));
        std::fs::create_dir_all(&dir)?;
        let sid = session_id(first_id + s);
        let cwd = format!("/synth/proj-{}", s % projects);
        let mut w = BufWriter::with_capacity(1 << 20, File::create(dir.join(format!("{sid}.jsonl")))?);
        let start = now_ms - (((s * 7919) % 360) as i64 + 1) * 86_400_000;
        let mut buf = Vec::with_capacity(2048);
        for m in 0..per {
            buf.clear();
            let ts = start + (m as i64) * 45_000;
            let (inp, outp) = (50 + rng.next() % 2000, 20 + rng.next() % 800);
            assistant(&mut buf, &sid, &cwd, &format!("s{}m{m}", first_id + s), ts, MODELS[((s + m) % 3) as usize], inp, outp, rng.next() % 2000, rng.next() % 90_000, 40);
            made.messages += 1;
            made.input += inp;
            made.output += outp;
            made.bytes += buf.len() as u64;
            w.write_all(&buf)?;
        }
        w.flush()?;
    }
    Ok(made)
}
