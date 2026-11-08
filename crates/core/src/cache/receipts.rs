//! The receipt scan cache: one JSON body per chat, valid while the chat's files are unchanged.
//! Reading is for any connection; writing is the usage coordinator's job only.

use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};

/// How many chats keep a stored scan; the least recently stored go first.
const KEEP: i64 = 300;

/// A fingerprint of a chat's transcript files as the ledger last saw them. Changes whenever a file
/// grows, is replaced, or a helper appears, so a stale scan is never served.
pub fn signature(conn: &Connection, session_id: &str, scan_version: u32) -> rusqlite::Result<String> {
    let mut st = conn.prepare_cached(
        "SELECT file_id, size, mtime_ns, missing FROM files WHERE session_id=?1 ORDER BY file_id",
    )?;
    let mut h = Sha256::new();
    h.update(scan_version.to_le_bytes());
    for r in st.query_map([session_id], |r| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?, r.get::<_, i64>(3)?))
    })? {
        let (a, b, c, d) = r?;
        h.update(format!("{a}:{b}:{c}:{d};").as_bytes());
    }
    Ok(h.finalize().iter().take(12).map(|b| format!("{b:02x}")).collect())
}

/// The stored body, when it was written for exactly this signature.
pub fn load(conn: &Connection, session_id: &str, sig: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT body FROM receipt_scan WHERE session_id=?1 AND sig=?2",
        params![session_id, sig],
        |r| r.get(0),
    )
    .optional()
}

/// Replace the chat's stored scan. Only the coordinator's writer connection calls this.
pub fn store(conn: &Connection, session_id: &str, sig: &str, body: &str, now_ms: i64) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO receipt_scan(session_id, sig, stored_at, body) VALUES(?1,?2,?3,?4)",
        params![session_id, sig, now_ms, body],
    )?;
    conn.execute(
        "DELETE FROM receipt_scan WHERE session_id IN \
         (SELECT session_id FROM receipt_scan ORDER BY stored_at DESC LIMIT -1 OFFSET ?1)",
        [KEEP],
    )?;
    Ok(())
}
