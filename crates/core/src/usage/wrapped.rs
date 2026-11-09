//! What the Wrapped story needs that no other page asks for: how chats are shaped (short or
//! long), how much of the work helpers did, and the chat with the most helpers. Numbers only;
//! the one chat it returns is a normal `SessionRow` (the same name rule as every list).

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use super::query::{day_start_ms, session_rows_for, u, QueryCtx, SessionRow};
use super::time::add_days;

/// A chat whose first and last message are less than this far apart is "short".
pub const SHORT_CHAT_MS: i64 = 10 * 60 * 1000;
/// A chat that ran this long or longer is "long".
pub const LONG_CHAT_MS: i64 = 2 * 60 * 60 * 1000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WrappedHabits {
    /// Chats still on disk with a message in the range.
    pub chats: u64,
    /// Of those, chats whose messages inside the range span under `SHORT_CHAT_MS`.
    pub short_chats: u64,
    /// Of those, chats whose messages inside the range span `LONG_CHAT_MS` or more.
    pub long_chats: u64,
    /// Tokens (input + output + cache writes, the headline unit) in the range.
    pub all_tokens: u64,
    /// The part of `all_tokens` that helpers (subagents) spent.
    pub helper_tokens: u64,
    /// The chat that started the most helpers (older chat on a tie); `None` when no chat had one.
    pub most_helpers: Option<SessionRow>,
    /// The chat with the most tokens in all (its whole length, like the Sessions list); `None`
    /// when the range has no chat.
    pub biggest: Option<SessionRow>,
}

/// The biggest share card Atlas will write. The page draws 1200 x 675, about 100 KB.
pub const MAX_CARD_BYTES: usize = 8 * 1024 * 1024;

/// The file name the save picker starts with for the share card of this local day.
pub fn card_file_name(day: &str) -> String {
    let ok = day.len() == 10 && day.bytes().all(|b| b.is_ascii_digit() || b == b'-');
    if ok {
        format!("Atlas Wrapped {day}.png")
    } else {
        "Atlas Wrapped.png".to_string()
    }
}

/// Only a PNG of sane size is written: the page hands over bytes, so check them here.
pub fn check_card(bytes: &[u8]) -> Result<(), String> {
    const SIG: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    if bytes.len() < 33 || bytes[..8] != SIG {
        return Err("That is not a PNG image.".to_string());
    }
    if bytes.len() > MAX_CARD_BYTES {
        return Err("The image is too big to save.".to_string());
    }
    Ok(())
}

/// The first session id a one-row query returns, if any.
fn first_id(conn: &Connection, sql: &str, params: &[&dyn rusqlite::ToSql]) -> rusqlite::Result<Option<String>> {
    let mut st = conn.prepare_cached(sql)?;
    let mut rows = st.query(params)?;
    Ok(match rows.next()? {
        Some(r) => Some(r.get(0)?),
        None => None,
    })
}

/// `from`..=`to` are local days (`YYYY-MM-DD`), like every other range. Chats that are gone from
/// disk (`missing`) are left out of every count, the same as the lists leave them out.
pub fn wrapped_habits(conn: &Connection, ctx: &QueryCtx, from: &str, to: &str) -> rusqlite::Result<WrappedHabits> {
    let lo = day_start_ms(ctx.tz, from);
    let hi = day_start_ms(ctx.tz, &add_days(to, 1));

    // A chat wholly inside the range is judged by its stored first and last message. One that
    // straddles an edge is judged by the messages that fall inside the range, so a long chat with
    // one message in a narrow range is not counted as long there. (Only chats with a message in the
    // range are counted at all: the `f IS NOT NULL` below.) The correlated lookups run for the
    // handful of straddlers only, on the `messages_session` index.
    let (chats, short_chats, long_chats): (i64, i64, i64) = conn.query_row(
        "WITH r AS ( \
           SELECT CASE WHEN s.first_ts >= ?1 AND s.last_ts < ?2 THEN s.first_ts \
                       ELSE (SELECT MIN(m.ts_utc_ms) FROM messages m WHERE m.session_id = s.session_id AND m.ts_utc_ms >= ?1 AND m.ts_utc_ms < ?2) END AS f, \
                  CASE WHEN s.first_ts >= ?1 AND s.last_ts < ?2 THEN s.last_ts \
                       ELSE (SELECT MAX(m.ts_utc_ms) FROM messages m WHERE m.session_id = s.session_id AND m.ts_utc_ms >= ?1 AND m.ts_utc_ms < ?2) END AS l \
           FROM sessions s WHERE s.messages > 0 AND s.missing = 0 AND s.last_ts >= ?1 AND s.first_ts < ?2) \
         SELECT COUNT(*), \
                COALESCE(SUM(CASE WHEN l - f < ?3 THEN 1 ELSE 0 END), 0), \
                COALESCE(SUM(CASE WHEN l - f >= ?4 THEN 1 ELSE 0 END), 0) \
         FROM r WHERE f IS NOT NULL",
        rusqlite::params![lo, hi, SHORT_CHAT_MS, LONG_CHAT_MS],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;

    // The headline total comes from the hourly rollup the rest of the app sums, so it is the
    // story's total by construction and costs one index range, not a scan of every message.
    let all_tokens: i64 = conn.query_row(
        "SELECT COALESCE(SUM(input + output + cw5m + cw1h), 0) FROM usage_hour WHERE hour_local >= ?1 AND hour_local < ?2",
        rusqlite::params![format!("{from}T00"), format!("{}T00", add_days(to, 1))],
        |r| r.get(0),
    )?;
    // Only the helper split needs the raw rows. "Helper" is the rule the session counter uses
    // (a subagent transcript, or a message marked as a side chain). Measured on a 116k-message
    // cache: ~70 ms, and a covering partial index only got it to ~50 ms because most rows are
    // helper rows, so no migration.
    let helper_tokens: i64 = conn.query_row(
        "SELECT COALESCE(SUM(input + output + cw5m + cw1h), 0) FROM messages \
         WHERE hour_local >= ?1 AND hour_local < ?2 AND (agent_id IS NOT NULL OR is_sidechain = 1)",
        rusqlite::params![format!("{from}T00"), format!("{}T00", add_days(to, 1))],
        |r| r.get(0),
    )?;

    // The chat that started the most helpers, then the chat that spent the most tokens. `agents`
    // is keyed (session_id, agent_id), so grouping by session is an ordered key scan.
    let top = first_id(
        conn,
        "SELECT a.session_id FROM agents a JOIN sessions s ON s.session_id = a.session_id \
         WHERE s.messages > 0 AND s.missing = 0 AND s.last_ts >= ?1 AND s.first_ts < ?2 \
         GROUP BY a.session_id ORDER BY COUNT(*) DESC, s.first_ts ASC, a.session_id ASC LIMIT 1",
        &[&lo, &hi],
    )?;
    let most_helpers = match top {
        Some(id) => session_rows_for(conn, ctx, &[id])?.pop().filter(|r| r.agent_count > 0),
        None => None,
    };
    // Whole-chat tokens, as the Sessions list sorts them, but without pricing every model row of
    // every chat (the list does that to sort by dollars; this only needs tokens).
    let big = first_id(
        conn,
        "SELECT s.session_id FROM sessions s \
         WHERE s.messages > 0 AND s.missing = 0 AND s.last_ts >= ?1 AND s.first_ts < ?2 \
         ORDER BY (SELECT COALESCE(SUM(m.input + m.output + m.cw5m + m.cw1h), 0) FROM session_model m WHERE m.session_id = s.session_id) DESC, \
                  s.session_id DESC LIMIT 1",
        &[&lo, &hi],
    )?;
    let biggest = match big {
        Some(id) => session_rows_for(conn, ctx, &[id])?.pop(),
        None => None,
    };

    Ok(WrappedHabits {
        chats: u(chats),
        short_chats: u(short_chats),
        long_chats: u(long_chats),
        all_tokens: u(all_tokens),
        helper_tokens: u(helper_tokens),
        most_helpers,
        biggest,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(len: usize) -> Vec<u8> {
        let mut v = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        v.resize(len, 0);
        v
    }

    #[test]
    fn only_a_real_sized_png_is_written() {
        assert!(check_card(&png(100)).is_ok());
        assert!(check_card(&[]).is_err());
        assert!(check_card(b"<html>not an image, but long enough to pass a length check</html>").is_err());
        assert!(check_card(&png(20)).is_err(), "a bare signature is not an image");
        assert!(check_card(&png(MAX_CARD_BYTES + 1)).is_err());
        assert!(check_card(&png(MAX_CARD_BYTES)).is_ok());
    }

    #[test]
    fn the_file_name_comes_from_a_day_or_a_plain_default() {
        assert_eq!(card_file_name("2026-11-08"), "Atlas Wrapped 2026-11-08.png");
        assert_eq!(card_file_name("../../x"), "Atlas Wrapped.png");
        assert_eq!(card_file_name(""), "Atlas Wrapped.png");
    }
}
