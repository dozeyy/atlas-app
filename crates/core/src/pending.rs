//! The propose-mode queue: changes Claude asked for that wait for the user to approve them.
//!
//! In propose mode (`atlas-mcp --propose <dir>`) every write tool records a `PendingChange`
//! here instead of changing anything. The app lists the queue, shows each before/after as a
//! diff, and on approval applies the stored request through the same `Ops::apply` (so the
//! backup, the atomic write and the History tag all still happen). One JSON file per change,
//! named by its id; the format is described in `docs/specs/mcp-server.md`.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::fsutil::atomic_write;
use crate::ops::{Applied, Ops, Preview, Write};

pub const SCHEMA: u32 = 1;
static COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingChange {
    pub schema: u32,
    /// `<13-digit ms>-<4-digit counter>-<tool>`, also the file name without `.json`.
    pub id: String,
    pub created_ms: u64,
    /// pending | applied | rejected | failed
    pub status: String,
    pub tool: String,
    /// One plain line, shown on the card.
    pub summary: String,
    pub kind: String,
    pub name: String,
    /// The file or folder it touches.
    pub target_path: String,
    /// The text before (absent for something new) and after (absent for a delete).
    pub before: Option<String>,
    pub after: Option<String>,
    pub note: Option<String>,
    /// What to run on approval: the same value `Ops::apply` takes.
    pub request: Write,
    /// Who proposed it (`assistant`).
    pub source: String,
    pub resolved_ms: Option<u64>,
    /// After resolving: what happened (the applied summary, or the reason it failed).
    pub result: Option<String>,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn file_of(queue: &Path, id: &str) -> io::Result<PathBuf> {
    if id.is_empty() || id.contains(['/', '\\']) || id.contains("..") {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "That is not a change id."));
    }
    Ok(queue.join(format!("{id}.json")))
}

fn save(queue: &Path, c: &PendingChange) -> io::Result<()> {
    fs::create_dir_all(queue)?;
    atomic_write(&file_of(queue, &c.id)?, serde_json::to_string_pretty(c).expect("pending change serialises").as_bytes())
}

/// Record a change for approval. Writes only inside `queue`.
pub fn propose(queue: &Path, request: Write, preview: Preview, source: &str) -> io::Result<PendingChange> {
    let id = format!("{:013}-{:04}-{}", now_ms(), COUNTER.fetch_add(1, Ordering::Relaxed) % 10_000, preview.tool);
    let c = PendingChange {
        schema: SCHEMA,
        id,
        created_ms: now_ms(),
        status: "pending".into(),
        tool: preview.tool,
        summary: preview.summary,
        kind: preview.kind,
        name: preview.name,
        target_path: preview.target_path,
        before: preview.before,
        after: preview.after,
        note: preview.note,
        request,
        source: source.into(),
        resolved_ms: None,
        result: None,
    };
    save(queue, &c)?;
    Ok(c)
}

/// Every change in the queue, oldest first. A file that can't be read is skipped.
pub fn list(queue: &Path) -> Vec<PendingChange> {
    let mut out: Vec<PendingChange> = Vec::new();
    let Ok(rd) = fs::read_dir(queue) else { return out };
    for e in rd.flatten() {
        let p = e.path();
        if p.extension().is_none_or(|x| x != "json") {
            continue;
        }
        if let Ok(bytes) = fs::read(&p)
            && let Ok(c) = serde_json::from_slice::<PendingChange>(&bytes)
        {
            out.push(c);
        }
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

pub fn get(queue: &Path, id: &str) -> Result<PendingChange, String> {
    let p = file_of(queue, id).map_err(|e| e.to_string())?;
    let bytes = fs::read(&p).map_err(|_| "That change is no longer in the queue.".to_string())?;
    serde_json::from_slice(&bytes).map_err(|_| "That change can't be read.".to_string())
}

fn resolve(queue: &Path, mut c: PendingChange, status: &str, result: String) -> io::Result<()> {
    c.status = status.into();
    c.resolved_ms = Some(now_ms());
    c.result = Some(result);
    save(queue, &c)
}

/// Apply a waiting change through `ops` (tagged as whoever `ops` is). It is marked applied, or
/// failed with the reason, and stays in the queue as a record.
pub fn apply(ops: &Ops, queue: &Path, id: &str) -> Result<Applied, String> {
    let c = get(queue, id)?;
    if c.status != "pending" {
        return Err("That change was already dealt with.".into());
    }
    // What runs is the stored request, so what was shown must be what that request does.
    if let Err(e) = verify(ops, &c) {
        let _ = resolve(queue, c, "failed", e.clone());
        return Err(e);
    }
    match ops.apply(&c.request) {
        Ok(a) => {
            let _ = resolve(queue, c, "applied", a.summary.clone());
            Ok(a)
        }
        Err(e) => {
            let _ = resolve(queue, c, "failed", e.clone());
            Err(e)
        }
    }
}

/// What `c.request` would do right now, worked out again from the request itself (never from
/// the stored `before`/`after`/`summary`, which anyone who can write the queue folder could
/// have set to something harmless). Show this to the user, not the stored text.
pub fn fresh(ops: &Ops, c: &PendingChange) -> Result<Preview, String> {
    ops.preview(&c.request)
}

/// Err when the stored card does not describe what the stored request does: the user would be
/// approving one thing and getting another. (`before` is not compared: it follows the file on
/// disk, and an edit is pinned to the text it was made from by its stamp.)
pub fn verify(ops: &Ops, c: &PendingChange) -> Result<Preview, String> {
    const MISMATCH: &str = "This change does not match what was shown for it, so Atlas did not apply it. Ask for it again.";
    let p = fresh(ops, c).map_err(|e| format!("This change can't be applied as it stands: {e}"))?;
    let same = p.tool == c.tool && p.summary == c.summary && p.kind == c.kind && p.name == c.name && p.target_path == c.target_path && p.after == c.after;
    if same { Ok(p) } else { Err(MISMATCH.into()) }
}

/// The change as the user should see it: the stored card with its summary, text and target
/// replaced by what the request really does, plus whether the stored card was honest.
pub fn display(ops: &Ops, c: &PendingChange) -> (PendingChange, Result<(), String>) {
    match fresh(ops, c) {
        Ok(p) => {
            let honest = verify(ops, c).map(|_| ());
            let mut v = c.clone();
            v.tool = p.tool;
            v.summary = p.summary;
            v.kind = p.kind;
            v.name = p.name;
            v.target_path = p.target_path;
            v.before = p.before;
            v.after = p.after;
            v.note = p.note;
            (v, honest)
        }
        Err(e) => (c.clone(), Err(format!("This change can't be applied as it stands: {e}"))),
    }
}

/// Turn a waiting change down. Nothing on disk but the queue file changes.
pub fn reject(queue: &Path, id: &str) -> Result<(), String> {
    let c = get(queue, id)?;
    if c.status != "pending" {
        return Err("That change was already dealt with.".into());
    }
    resolve(queue, c, "rejected", "Rejected.".into()).map_err(|e| e.to_string())
}

/// Delete resolved changes older than `keep_ms` (the queue is a short record, not a history).
pub fn prune(queue: &Path, keep_ms: u64) -> usize {
    let cut = now_ms().saturating_sub(keep_ms);
    let mut n = 0;
    for c in list(queue) {
        if c.status != "pending" && c.resolved_ms.is_some_and(|t| t < cut) && file_of(queue, &c.id).is_ok_and(|p| fs::remove_file(p).is_ok()) {
            n += 1;
        }
    }
    n
}
