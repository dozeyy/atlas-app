//! Schema versions (D29). `PRAGMA user_version` is the schema version; migrations
//! are forward-only functions, each in one transaction. A database from a newer
//! app is never migrated.

use rusqlite::Connection;

/// The newest schema this build knows.
pub const SCHEMA_VERSION: i64 = 5;

/// `PRAGMA user_version` of an open database.
pub fn user_version(conn: &Connection) -> rusqlite::Result<i64> {
    conn.query_row("PRAGMA user_version", [], |r| r.get(0))
}

/// Bring a database up to `SCHEMA_VERSION`. Call only when `user_version <= SCHEMA_VERSION`.
pub fn migrate(conn: &mut Connection) -> rusqlite::Result<()> {
    let mut v = user_version(conn)?;
    while v < SCHEMA_VERSION {
        let tx = conn.transaction()?;
        match v {
            0 => m0001(&tx)?,
            1 => m0002(&tx)?,
            2 => m0003(&tx)?,
            3 => m0004(&tx)?,
            4 => m0005_effort(&tx)?,
            _ => unreachable!("no migration from version {v}"),
        }
        v += 1;
        tx.execute_batch(&format!("PRAGMA user_version = {v}"))?;
        tx.commit()?;
    }
    Ok(())
}

/// Subagent registry: one row per `agent-<id>.jsonl` (its meta sidecar and a one-line prompt
/// summary), the per-file tool-call count and the session's prompt summary. Existing caches are
/// re-read once (PARSER_VERSION bump) so these fill in.
fn m0002(tx: &rusqlite::Transaction) -> rusqlite::Result<()> {
    tx.execute_batch(
        r#"
ALTER TABLE files ADD COLUMN tool_calls INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN prompt_summary TEXT;
CREATE TABLE IF NOT EXISTS agents (
  session_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  file_id INTEGER NOT NULL,
  agent_type TEXT,
  description TEXT,
  tool_use_id TEXT,
  parent_agent_id TEXT,
  spawn_depth INTEGER NOT NULL DEFAULT 1,
  prompt_summary TEXT,
  PRIMARY KEY (session_id, agent_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS agents_file ON agents(file_id);
"#,
    )
}

/// What the tool calls were: one row per file, session, UTC hour, kind (`tool`, `skill`, `agent`)
/// and item name, with how many times and the last time. `hour_local` follows the time zone
/// (rewritten when it changes). Existing caches are re-read once (PARSER_VERSION bump) to fill it.
fn m0003(tx: &rusqlite::Transaction) -> rusqlite::Result<()> {
    tx.execute_batch(
        r#"
CREATE TABLE IF NOT EXISTS item_use (
  file_id INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  hour_utc INTEGER NOT NULL,
  hour_local TEXT NOT NULL,
  kind TEXT NOT NULL,
  item TEXT NOT NULL,
  uses INTEGER NOT NULL,
  last_ts INTEGER NOT NULL,
  PRIMARY KEY (file_id, session_id, hour_utc, kind, item)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS item_use_kind ON item_use(kind, hour_local);
CREATE INDEX IF NOT EXISTS item_use_session ON item_use(session_id);
"#,
    )
}

/// What a chat's transcripts said about where the money went (the receipt scan): one small JSON
/// body per session, valid while `sig` (the session's file sizes and times) is unchanged. Holds
/// only tool names, file paths and counts, never message text. It is a cache: safe to drop.
fn m0004(tx: &rusqlite::Transaction) -> rusqlite::Result<()> {
    tx.execute_batch(
        r#"
CREATE TABLE IF NOT EXISTS receipt_scan (
  session_id TEXT PRIMARY KEY,
  sig TEXT NOT NULL,
  stored_at INTEGER NOT NULL,
  body TEXT NOT NULL
) WITHOUT ROWID;
"#,
    )
}

/// The reasoning effort of each reply (`perTurnEffort`, else `effort`; NULL when the transcript
/// has none). Additive: one nullable column. Existing caches are re-read once (PARSER_VERSION
/// bump) so it fills in.
fn m0005_effort(tx: &rusqlite::Transaction) -> rusqlite::Result<()> {
    tx.execute_batch("ALTER TABLE messages ADD COLUMN effort TEXT;")
}

fn m0001(tx: &rusqlite::Transaction) -> rusqlite::Result<()> {
    tx.execute_batch(
        r#"
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS files (
  file_id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  fs_id TEXT NOT NULL DEFAULT '',
  head_hash BLOB,
  size INTEGER NOT NULL DEFAULT 0,
  mtime_ns INTEGER NOT NULL DEFAULT 0,
  offset INTEGER NOT NULL DEFAULT 0,
  session_id TEXT,
  agent_id TEXT,
  is_subagent INTEGER NOT NULL DEFAULT 0,
  missing INTEGER NOT NULL DEFAULT 0,
  malformed_lines INTEGER NOT NULL DEFAULT 0,
  long_lines INTEGER NOT NULL DEFAULT 0,
  last_seen_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  project_key TEXT,
  project_path TEXT,
  project_src INTEGER NOT NULL DEFAULT 0,
  title TEXT,
  title_source TEXT,
  first_ts INTEGER,
  last_ts INTEGER,
  messages INTEGER NOT NULL DEFAULT 0,
  subagent_messages INTEGER NOT NULL DEFAULT 0,
  entrypoint TEXT,
  cc_version TEXT,
  cc_cost_usd REAL,
  is_atlas_assistant INTEGER NOT NULL DEFAULT 0,
  missing INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS sessions_last ON sessions(last_ts);
CREATE INDEX IF NOT EXISTS sessions_first ON sessions(first_ts);

CREATE TABLE IF NOT EXISTS messages (
  msg_key TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  file_id INTEGER NOT NULL,
  line_offset INTEGER NOT NULL DEFAULT 0,
  agent_id TEXT,
  is_sidechain INTEGER NOT NULL DEFAULT 0,
  model TEXT NOT NULL,
  ts_utc_ms INTEGER NOT NULL,
  hour_local TEXT NOT NULL,
  input INTEGER NOT NULL,
  output INTEGER NOT NULL,
  cw5m INTEGER NOT NULL,
  cw1h INTEGER NOT NULL,
  cr INTEGER NOT NULL,
  cw_assumed INTEGER NOT NULL DEFAULT 0,
  cw_mismatch INTEGER NOT NULL DEFAULT 0,
  web_search INTEGER NOT NULL DEFAULT 0,
  web_fetch INTEGER NOT NULL DEFAULT 0,
  thinking INTEGER NOT NULL DEFAULT 0,
  speed TEXT NOT NULL DEFAULT '',
  geo TEXT NOT NULL DEFAULT '',
  service_tier TEXT NOT NULL DEFAULT '',
  price_tier INTEGER NOT NULL DEFAULT 0,
  skill TEXT,
  mcp_server TEXT,
  mcp_tool TEXT
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id, ts_utc_ms);
CREATE INDEX IF NOT EXISTS messages_hour ON messages(hour_local);
CREATE INDEX IF NOT EXISTS messages_ts ON messages(ts_utc_ms);
CREATE INDEX IF NOT EXISTS messages_file ON messages(file_id);
CREATE INDEX IF NOT EXISTS messages_cwa ON messages(cw_assumed) WHERE cw_assumed = 1;

CREATE TABLE IF NOT EXISTS usage_hour (
  hour_local TEXT NOT NULL,
  project_key TEXT NOT NULL,
  model TEXT NOT NULL,
  speed TEXT NOT NULL,
  geo TEXT NOT NULL,
  service_tier TEXT NOT NULL,
  price_tier INTEGER NOT NULL,
  input INTEGER NOT NULL,
  output INTEGER NOT NULL,
  cw5m INTEGER NOT NULL,
  cw1h INTEGER NOT NULL,
  cr INTEGER NOT NULL,
  web_search INTEGER NOT NULL,
  web_fetch INTEGER NOT NULL,
  messages INTEGER NOT NULL,
  PRIMARY KEY (hour_local, project_key, model, speed, geo, service_tier, price_tier)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS session_model (
  session_id TEXT NOT NULL,
  model TEXT NOT NULL,
  speed TEXT NOT NULL,
  geo TEXT NOT NULL,
  service_tier TEXT NOT NULL,
  price_tier INTEGER NOT NULL,
  input INTEGER NOT NULL,
  output INTEGER NOT NULL,
  cw5m INTEGER NOT NULL,
  cw1h INTEGER NOT NULL,
  cr INTEGER NOT NULL,
  web_search INTEGER NOT NULL,
  web_fetch INTEGER NOT NULL,
  messages INTEGER NOT NULL,
  PRIMARY KEY (session_id, model, speed, geo, service_tier, price_tier)
) WITHOUT ROWID;

-- Message keys seen in more than one file (counted once however often they are re-read).
CREATE TABLE IF NOT EXISTS dupes (msg_key TEXT PRIMARY KEY) WITHOUT ROWID;
"#,
    )
}
