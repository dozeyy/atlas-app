//! Finding transcripts and deciding what to read (D1, D3, D4).
//!
//! Only `<projects>/<proj>/<session>.jsonl` and
//! `<projects>/<proj>/<session>/subagents/*.jsonl` are ever listed. A rescan
//! compares each file with the `files` table: unchanged (same size and mtime) costs
//! one directory entry and no open; a changed file is opened once to check its
//! identity (file id + hash of the first 4 KiB) and then read from where it left off,
//! or from 0 when it is a new version of the path (shrunk, replaced, new identity).

use std::collections::HashMap;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use rusqlite::{params, Connection};
use sha2::{Digest, Sha256};

use super::reader::open_read_only;

pub const HEAD_BYTES: u64 = 4096;

#[derive(Debug, Clone)]
pub struct Found {
    pub path: PathBuf,
    pub size: u64,
    pub mtime_ns: i64,
    pub is_subagent: bool,
    /// The session folder/file name the path implies (D13 fallback).
    pub folder_session: String,
}

/// A transcript to read, with where to start.
#[derive(Debug, Clone)]
pub struct FileTask {
    pub file_id: i64,
    pub path: PathBuf,
    pub start: u64,
    pub size: u64,
    pub mtime_ns: i64,
    pub is_subagent: bool,
    pub folder_session: String,
    /// A new version of the path: read from 0.
    pub reset: bool,
}

#[derive(Debug, Default)]
pub struct Plan {
    pub tasks: Vec<FileTask>,
    /// Files seen on disk by this scan.
    pub seen: usize,
    /// Files whose `missing` flag flipped (either way), for the session roll-up.
    pub flipped: Vec<i64>,
    pub new_files: usize,
}

pub enum Mode {
    /// Walk the whole projects folder.
    All { force_reparse: bool },
    /// Just these paths (watcher events).
    Paths(Vec<PathBuf>),
}

fn mtime_ns(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_nanos() as i64)
        .unwrap_or(0)
}

fn is_jsonl(p: &Path) -> bool {
    p.extension().is_some_and(|e| e.eq_ignore_ascii_case("jsonl"))
}

/// Walk the projects folder. A missing folder is an empty result.
pub fn walk(projects_dir: &Path) -> io::Result<Vec<Found>> {
    let mut out = Vec::new();
    let rd = match std::fs::read_dir(projects_dir) {
        Ok(r) => r,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(out),
        Err(e) => return Err(e),
    };
    for proj in rd.flatten() {
        let Ok(ft) = proj.file_type() else { continue };
        let ppath = proj.path();
        let is_dir = ft.is_dir() || (ft.is_symlink() && ppath.is_dir());
        if !is_dir {
            continue;
        }
        let Ok(inner) = std::fs::read_dir(&ppath) else { continue };
        for e in inner.flatten() {
            let path = e.path();
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_file() || (ft.is_symlink() && path.is_file()) {
                if !is_jsonl(&path) {
                    continue;
                }
                let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else { continue };
                if let Ok(m) = e.metadata().or_else(|_| std::fs::metadata(&path)) {
                    out.push(Found {
                        size: m.len(),
                        mtime_ns: mtime_ns(&m),
                        is_subagent: false,
                        folder_session: stem.to_string(),
                        path,
                    });
                }
            } else if ft.is_dir() {
                let Some(session) = path.file_name().and_then(|s| s.to_str()).map(str::to_string)
                else {
                    continue;
                };
                let Ok(subs) = std::fs::read_dir(path.join("subagents")) else { continue };
                for s in subs.flatten() {
                    let sp = s.path();
                    if !is_jsonl(&sp) || !s.file_type().is_ok_and(|t| t.is_file()) {
                        continue;
                    }
                    if let Ok(m) = s.metadata() {
                        out.push(Found {
                            size: m.len(),
                            mtime_ns: mtime_ns(&m),
                            is_subagent: true,
                            folder_session: session.clone(),
                            path: sp,
                        });
                    }
                }
            }
        }
    }
    Ok(out)
}

/// Classify and stat one path (a watcher event). `None` when it is not a
/// transcript location or no longer exists.
pub fn stat_path(projects_dir: &Path, path: &Path) -> Option<Found> {
    let (is_subagent, session) = classify(projects_dir, path)?;
    let m = std::fs::metadata(path).ok()?;
    if !m.is_file() {
        return None;
    }
    Some(Found {
        path: path.to_path_buf(),
        size: m.len(),
        mtime_ns: mtime_ns(&m),
        is_subagent,
        folder_session: session,
    })
}

/// `(is_subagent, session)` for a path under the projects folder, if it is a transcript.
pub fn classify(projects_dir: &Path, path: &Path) -> Option<(bool, String)> {
    if !is_jsonl(path) {
        return None;
    }
    let rel = path.strip_prefix(projects_dir).ok()?;
    let parts: Vec<&str> = rel.components().filter_map(|c| c.as_os_str().to_str()).collect();
    match parts.as_slice() {
        [_proj, file] => {
            Some((false, Path::new(file).file_stem()?.to_str()?.to_string()))
        }
        [_proj, session, "subagents", _file] => Some((true, (*session).to_string())),
        _ => None,
    }
}

/// Windows volume serial + file index, Unix (dev, ino): survives renames.
pub fn fs_id(file: &std::fs::File) -> io::Result<String> {
    #[cfg(windows)]
    {
        let info = winapi_util::file::information(file)?;
        Ok(format!("{:x}:{:x}", info.volume_serial_number(), info.file_index()))
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let m = file.metadata()?;
        Ok(format!("{:x}:{:x}", m.dev(), m.ino()))
    }
}

/// SHA-256 of the first `len` bytes (or fewer if the file is shorter).
pub fn head_hash(file: &mut std::fs::File, len: u64) -> io::Result<Vec<u8>> {
    use std::io::Seek;
    file.seek(io::SeekFrom::Start(0))?;
    let mut buf = Vec::with_capacity(len.min(HEAD_BYTES) as usize);
    file.take(len.min(HEAD_BYTES)).read_to_end(&mut buf)?;
    Ok(Sha256::digest(&buf).to_vec())
}

struct Row {
    file_id: i64,
    fs_id: String,
    head_hash: Option<Vec<u8>>,
    size: u64,
    mtime_ns: i64,
    offset: u64,
    missing: bool,
}

fn load_rows(conn: &Connection, only: Option<&[String]>) -> rusqlite::Result<HashMap<String, Row>> {
    let mut out = HashMap::new();
    let mut stmt = conn.prepare(
        "SELECT file_id, path, fs_id, head_hash, size, mtime_ns, offset, missing FROM files",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(1)?,
            Row {
                file_id: r.get(0)?,
                fs_id: r.get(2)?,
                head_hash: r.get(3)?,
                size: r.get::<_, i64>(4)? as u64,
                mtime_ns: r.get(5)?,
                offset: r.get::<_, i64>(6)? as u64,
                missing: r.get::<_, i64>(7)? != 0,
            },
        ))
    })?;
    for r in rows {
        let (path, row) = r?;
        if only.is_none_or(|o| o.contains(&path)) {
            out.insert(path, row);
        }
    }
    Ok(out)
}

fn key(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// Decide what to read. Writes only to the cache database (identity, `missing`,
/// new file rows), never to a transcript.
pub fn plan(
    conn: &mut Connection,
    projects_dir: &Path,
    mode: &Mode,
    now_secs: i64,
) -> rusqlite::Result<Plan> {
    let (found, only, force): (Vec<Found>, Option<Vec<String>>, bool) = match mode {
        Mode::All { force_reparse } => {
            (walk(projects_dir).unwrap_or_default(), None, *force_reparse)
        }
        Mode::Paths(paths) => {
            let mut v = Vec::new();
            for p in paths {
                if let Some(f) = stat_path(projects_dir, p) {
                    v.push(f);
                }
            }
            let only = paths.iter().map(|p| key(p)).collect();
            (v, Some(only), false)
        }
    };
    let mut rows = load_rows(conn, only.as_deref())?;
    let mut plan = Plan { seen: found.len(), ..Default::default() };
    let tx = conn.transaction()?;
    {
        let mut touch = tx.prepare_cached(
            "UPDATE files SET last_seen_at=?2, missing=0 WHERE file_id=?1",
        )?;
        let mut ident = tx.prepare_cached(
            "UPDATE files SET fs_id=?2, head_hash=?3, offset=?4, last_seen_at=?5, missing=0 WHERE file_id=?1",
        )?;
        let mut insert = tx.prepare_cached(
            "INSERT INTO files(path, fs_id, head_hash, session_id, is_subagent, last_seen_at) VALUES(?1,?2,?3,?4,?5,?6)",
        )?;
        for f in &found {
            let k = key(&f.path);
            let existing = rows.remove(&k);
            if let Some(row) = &existing {
                if !force
                    && !row.missing
                    && row.size == f.size
                    && row.mtime_ns == f.mtime_ns
                {
                    continue; // unchanged: no open, no bytes
                }
            }
            // Changed or new: open once for the identity check.
            let Ok(mut file) = open_read_only(&f.path) else { continue }; // vanished or locked
            let id = fs_id(&file).unwrap_or_default();
            let cur_len = file.metadata().map(|m| m.len()).unwrap_or(f.size);
            match existing {
                Some(row) => {
                    // Compare the same stretch of bytes the old hash covered.
                    let old_len = row.size.min(HEAD_BYTES);
                    let same_head = match &row.head_hash {
                        Some(old) => head_hash(&mut file, old_len).is_ok_and(|h| &h == old),
                        None => row.offset == 0,
                    };
                    let reset = force || id != row.fs_id || !same_head || cur_len < row.offset;
                    let new_hash = head_hash(&mut file, cur_len).unwrap_or_default();
                    let start = if reset { 0 } else { row.offset };
                    ident.execute(params![row.file_id, id, new_hash, start as i64, now_secs])?;
                    if row.missing {
                        plan.flipped.push(row.file_id);
                    }
                    plan.tasks.push(FileTask {
                        file_id: row.file_id,
                        path: f.path.clone(),
                        start,
                        size: f.size.max(cur_len),
                        mtime_ns: f.mtime_ns,
                        is_subagent: f.is_subagent,
                        folder_session: f.folder_session.clone(),
                        reset,
                    });
                    let _ = &mut touch;
                }
                None => {
                    let hash = head_hash(&mut file, cur_len).unwrap_or_default();
                    insert.execute(params![
                        k,
                        id,
                        hash,
                        f.folder_session,
                        f.is_subagent as i64,
                        now_secs
                    ])?;
                    let file_id = tx.last_insert_rowid();
                    plan.new_files += 1;
                    plan.tasks.push(FileTask {
                        file_id,
                        path: f.path.clone(),
                        start: 0,
                        size: f.size.max(cur_len),
                        mtime_ns: f.mtime_ns,
                        is_subagent: f.is_subagent,
                        folder_session: f.folder_session.clone(),
                        reset: true,
                    });
                }
            }
        }
        // Rows we did not see: gone (D4). Their rows stay in the ledger (D31).
        let mut gone = tx.prepare_cached("UPDATE files SET missing=1 WHERE file_id=?1")?;
        for (_p, row) in rows {
            if !row.missing {
                gone.execute([row.file_id])?;
                plan.flipped.push(row.file_id);
            }
        }
    }
    tx.commit()?;
    // Biggest first: the longest job starts earliest (D39).
    plan.tasks.sort_by_key(|t| std::cmp::Reverse(t.size.saturating_sub(t.start)));
    Ok(plan)
}
