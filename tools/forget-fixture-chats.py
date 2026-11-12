#!/usr/bin/env python3
"""Remove Atlas's own test fixtures from a usage index (cache.sqlite) or a search index (search.sqlite).

Why: `atlas-usage --config-dir <fixture>` used to write the fixture's chats into the user's real
CLI index. The index keeps chats after their files vanish (by design), so they stayed in the
all-time numbers. The CLI now gives such a root a folder of its own (cli/roots/<id>); this repairs
an index that was polluted before that.

What counts as a fixture:
  files     path matches  ...\\Atlas\\fixtures\\...  or  ...\\Atlas\\.claude\\worktrees\\<name>\\fixtures\\...
  sessions  project_path LIKE '/fixture/%', or the session id of any fixture file or message in one
            (a session that also has a file outside the fixtures is left alone and reported)

Usage:
  python tools/forget-fixture-chats.py <path-to-cache.sqlite>            dry run: counts only, writes nothing
  python tools/forget-fixture-chats.py <path-to-cache.sqlite> --apply    back up, then delete in one transaction

--apply refuses while atlas.exe or atlas-usage.exe is running, copies the index (and -wal/-shm) to
<name>.bak-<YYYYMMDD> and refuses if that name already exists (an older .bak is never touched).
--ignore-running skips the process check, for a scratch copy only.
The per-hour sums (usage_hour) lose exactly the fixture messages' share; no other row is recomputed.
Exit codes: 0 done (or nothing to do), 1 failed, 2 refused.
"""
import argparse
import datetime
import os
import shutil
import sqlite3
import subprocess
import sys

BS = chr(92)
PATH_PATTERNS = [f"%{BS}Atlas{BS}fixtures{BS}%", f"%{BS}Atlas{BS}.claude{BS}worktrees{BS}%{BS}fixtures{BS}%"]
PATH_TEST = "(replace({col}, '/', char(92)) LIKE ?1 OR replace({col}, '/', char(92)) LIKE ?2)"
BLOCKING = ("atlas.exe", "atlas-usage.exe")
WATCH = ("atlas-mcp.exe",)

# table -> (session column, file column); either may be None.
USAGE_TABLES = [
    ("messages", "session_id", "file_id"),
    ("session_model", "session_id", None),
    ("agents", "session_id", "file_id"),
    ("agent_runs", "session_id", "file_id"),
    ("agent_links", "session_id", "file_id"),
    ("agent_notices", "session_id", "file_id"),
    ("agent_run_models", "session_id", "file_id"),
    ("agent_link_pending", "session_id", "file_id"),
    ("item_use", "session_id", "file_id"),
    ("receipt_scan", "session_id", None),
    ("review_findings", "session_id", None),
    ("sessions", "session_id", None),
    ("files", None, "file_id"),
]
TOKENS = "COALESCE(SUM(input),0), COALESCE(SUM(output),0), COALESCE(SUM(cw5m),0), COALESCE(SUM(cw1h),0), COALESCE(SUM(cr),0)"


def running(names):
    """Which of `names` (image names, any case) are running right now."""
    try:
        if os.name == "nt":
            out = subprocess.run(["tasklist", "/FO", "CSV", "/NH"], capture_output=True, text=True, check=True).stdout
            procs = [line.split('","')[0].strip('"').lower() for line in out.splitlines() if line.strip()]
        else:
            out = subprocess.run(["ps", "-A", "-o", "comm="], capture_output=True, text=True, check=True).stdout
            procs = [os.path.basename(line.strip()).lower() for line in out.splitlines()]
    except Exception as e:  # cannot tell: treat as running, never guess it is safe
        raise SystemExit(f"cannot list processes ({e}); refusing") from e
    return sorted({n for n in names if n in procs})


def tables(conn):
    return {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}


def columns(conn, table):
    return {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}


def one(conn, sql, *args):
    return conn.execute(sql, args).fetchone()[0]


def find_usage(conn):
    """Fill temp tables fx_files / fx_sessions / fx_hours / fx_skipped for a usage index."""
    conn.executescript(
        "CREATE TEMP TABLE fx_files(file_id INTEGER PRIMARY KEY);"
        "CREATE TEMP TABLE fx_sessions(session_id TEXT PRIMARY KEY);"
        "CREATE TEMP TABLE fx_skipped(session_id TEXT PRIMARY KEY);"
        "CREATE TEMP TABLE fx_hours(h TEXT PRIMARY KEY);"
        "CREATE TEMP TABLE fx_keys(msg_key TEXT PRIMARY KEY);"
    )
    p = tuple(PATH_PATTERNS)
    conn.execute("INSERT INTO fx_files SELECT file_id FROM files WHERE " + PATH_TEST.format(col="path"), p)
    conn.execute("INSERT OR IGNORE INTO fx_sessions SELECT session_id FROM sessions WHERE project_path LIKE '/fixture/%'")
    conn.execute("INSERT OR IGNORE INTO fx_sessions SELECT session_id FROM files WHERE file_id IN fx_files AND session_id IS NOT NULL")
    conn.execute("INSERT OR IGNORE INTO fx_sessions SELECT session_id FROM messages WHERE file_id IN fx_files")
    # A session that also lives in a file outside the fixtures is real data: keep it.
    conn.execute(
        "INSERT INTO fx_skipped SELECT session_id FROM fx_sessions WHERE session_id IN "
        "(SELECT session_id FROM files WHERE file_id NOT IN fx_files AND session_id IS NOT NULL)"
    )
    conn.execute("DELETE FROM fx_sessions WHERE session_id IN fx_skipped")
    conn.execute("INSERT INTO fx_keys SELECT msg_key FROM messages WHERE session_id IN fx_sessions OR file_id IN fx_files")
    conn.execute("INSERT INTO fx_hours SELECT DISTINCT hour_local FROM messages WHERE msg_key IN fx_keys")


def usage_counts(conn):
    """Rows the cleanup removes, per table."""
    out = {}
    for t, scol, fcol in USAGE_TABLES:
        if t not in tables(conn):
            continue
        cols = columns(conn, t)
        conds = []
        if scol and scol in cols:
            conds.append(f"{scol} IN fx_sessions")
        if fcol and fcol in cols:
            conds.append(f"{fcol} IN fx_files")
        out[t] = one(conn, f"SELECT COUNT(*) FROM {t} WHERE " + " OR ".join(conds)) if conds else 0
    out["dupes"] = one(conn, "SELECT COUNT(*) FROM dupes WHERE msg_key IN fx_keys") if "dupes" in tables(conn) else 0
    return out


def usage_totals(conn):
    n = lambda t: one(conn, f"SELECT COUNT(*) FROM {t}") if t in tables(conn) else 0  # noqa: E731
    row = conn.execute(f"SELECT {TOKENS} FROM messages").fetchone()
    return {
        "sessions": n("sessions"), "files": n("files"), "messages": n("messages"),
        "input": row[0], "output": row[1], "cache_write_5m": row[2], "cache_write_1h": row[3], "cache_read": row[4],
        "usage_hour_messages": one(conn, "SELECT COALESCE(SUM(messages),0) FROM usage_hour"),
        "usage_hour_tokens": one(conn, "SELECT COALESCE(SUM(input+output+cw5m+cw1h+cr),0) FROM usage_hour"),
    }


def delete_usage(conn):
    # usage_hour holds sums per hour/project/model. Take the fixture messages' share out of those
    # rows (before the sessions that give them their project are deleted) instead of rebuilding
    # whole hours: any drift already in other rows stays exactly as it was.
    # Plain execute() only: executescript() would commit the surrounding transaction.
    conn.execute(
        "CREATE TEMP TABLE fx_sub AS"
        " SELECT m.hour_local AS hour_local, COALESCE(s.project_key, '') AS project_key, m.model AS model, m.speed AS speed,"
        "        m.geo AS geo, m.service_tier AS service_tier, m.price_tier AS price_tier,"
        "        SUM(m.input) AS input, SUM(m.output) AS output, SUM(m.cw5m) AS cw5m, SUM(m.cw1h) AS cw1h, SUM(m.cr) AS cr,"
        "        SUM(m.web_search) AS web_search, SUM(m.web_fetch) AS web_fetch, COUNT(*) AS messages"
        " FROM messages m LEFT JOIN sessions s ON s.session_id = m.session_id"
        " WHERE m.msg_key IN fx_keys GROUP BY 1,2,3,4,5,6,7"
    )
    conn.execute(
        "UPDATE usage_hour SET input = usage_hour.input - x.input, output = usage_hour.output - x.output,"
        " cw5m = usage_hour.cw5m - x.cw5m, cw1h = usage_hour.cw1h - x.cw1h, cr = usage_hour.cr - x.cr,"
        " web_search = usage_hour.web_search - x.web_search, web_fetch = usage_hour.web_fetch - x.web_fetch,"
        " messages = usage_hour.messages - x.messages"
        " FROM fx_sub x WHERE usage_hour.hour_local = x.hour_local AND usage_hour.project_key = x.project_key"
        " AND usage_hour.model = x.model AND usage_hour.speed = x.speed AND usage_hour.geo = x.geo"
        " AND usage_hour.service_tier = x.service_tier AND usage_hour.price_tier = x.price_tier"
    )
    bad = one(
        conn,
        "SELECT COUNT(*) FROM usage_hour u JOIN fx_sub x ON u.hour_local = x.hour_local AND u.project_key = x.project_key"
        " AND u.model = x.model AND u.speed = x.speed AND u.geo = x.geo AND u.service_tier = x.service_tier AND u.price_tier = x.price_tier"
        " WHERE u.input < 0 OR u.output < 0 OR u.cw5m < 0 OR u.cw1h < 0 OR u.cr < 0 OR u.messages < 0",
    )
    if bad:
        raise RuntimeError(f"{bad} usage_hour rows would go negative: the hour rows do not hold these messages")
    conn.execute(
        "DELETE FROM usage_hour WHERE messages = 0 AND EXISTS (SELECT 1 FROM fx_sub x WHERE usage_hour.hour_local = x.hour_local"
        " AND usage_hour.project_key = x.project_key AND usage_hour.model = x.model AND usage_hour.speed = x.speed"
        " AND usage_hour.geo = x.geo AND usage_hour.service_tier = x.service_tier AND usage_hour.price_tier = x.price_tier)"
    )
    for t, scol, fcol in USAGE_TABLES:
        if t not in tables(conn):
            continue
        cols = columns(conn, t)
        conds = []
        if scol and scol in cols:
            conds.append(f"{scol} IN fx_sessions")
        if fcol and fcol in cols:
            conds.append(f"{fcol} IN fx_files")
        if conds:
            conn.execute(f"DELETE FROM {t} WHERE " + " OR ".join(conds))
    conn.execute("DELETE FROM dupes WHERE msg_key IN fx_keys")


def find_search(conn):
    conn.executescript("CREATE TEMP TABLE fx_files(file_id INTEGER PRIMARY KEY);")
    conn.execute("INSERT INTO fx_files SELECT file_id FROM sfiles WHERE " + PATH_TEST.format(col="path"), tuple(PATH_PATTERNS))


def search_counts(conn):
    return {
        "sfiles": one(conn, "SELECT COUNT(*) FROM sfiles WHERE file_id IN fx_files"),
        "msgs": one(conn, "SELECT COUNT(*) FROM msgs WHERE file_id IN fx_files"),
        "fts": one(conn, "SELECT COUNT(*) FROM fts WHERE rowid IN (SELECT id FROM msgs WHERE file_id IN fx_files)"),
    }


def delete_search(conn):
    conn.execute("DELETE FROM fts WHERE rowid IN (SELECT id FROM msgs WHERE file_id IN fx_files)")
    conn.execute("DELETE FROM msgs WHERE file_id IN fx_files")
    conn.execute("DELETE FROM sfiles WHERE file_id IN fx_files")


def show(title, rows):
    print(title)
    for k, v in rows.items():
        print(f"  {k:<22}{v:>12,}")


def backup(db):
    """Copy db (+ -wal/-shm) to <db>.bak-YYYYMMDD. Returns the path; raises if the name exists."""
    stamp = datetime.date.today().strftime("%Y%m%d")
    bak = f"{db}.bak-{stamp}"
    if any(os.path.exists(bak + s) for s in ("", "-wal", "-shm")):
        raise SystemExit(f"refusing: {bak} (or its -wal/-shm) already exists; move it away first")
    with sqlite3.connect(db, timeout=60) as c:
        busy, _log, _done = c.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
        if busy:
            print("note: another program had the index open, so the checkpoint was partial; the -wal is copied too")
    c.close()
    for suffix in ("", "-wal", "-shm"):
        if os.path.exists(db + suffix):
            shutil.copyfile(db + suffix, bak + suffix)
            if os.path.getsize(db + suffix) != os.path.getsize(bak + suffix):
                raise SystemExit(f"backup of {db + suffix} is a different size; stopping before any change")
    chk = sqlite3.connect(bak)
    try:
        verdict = chk.execute("PRAGMA integrity_check").fetchall()
    finally:
        chk.close()
    if verdict != [("ok",)]:
        raise SystemExit(f"the backup {bak} did not pass integrity_check ({verdict[:3]}); stopping before any change")
    return bak


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("db", help="path to cache.sqlite (usage index) or search.sqlite (search index)")
    ap.add_argument("--apply", action="store_true", help="write the change (default: dry run)")
    ap.add_argument("--ignore-running", action="store_true", help="skip the running-program check; only for a COPY of an index that no program has open")
    a = ap.parse_args()
    db = os.path.abspath(a.db)
    if not os.path.isfile(db):
        print(f"no such file: {db}")
        return 1

    if a.apply and not a.ignore_running:
        blocking = running(BLOCKING)
        if blocking:
            print(f"refusing: {', '.join(blocking)} is running. Close it and run again.")
            return 2
    for w in running(WATCH):
        print(f"note: {w} is running (an assistant session); it only reads this index and waits on the database lock")
        break

    conn = sqlite3.connect(f"file:{db.replace(BS, '/')}?mode=" + ("rw" if a.apply else "ro"), uri=True, timeout=60)
    try:
        tabs = tables(conn)
        kind = "usage" if "messages" in tabs and "usage_hour" in tabs else "search" if "sfiles" in tabs else None
        if kind is None:
            print("not an Atlas usage or search index")
            return 1
        print(f"{'APPLY' if a.apply else 'DRY RUN'} ({kind} index): {db}")
        if kind == "usage":
            find_usage(conn)
            before = usage_totals(conn)
            gone = usage_counts(conn)
            skipped = [r[0] for r in conn.execute("SELECT session_id FROM fx_skipped")]
            fx_tokens = conn.execute(f"SELECT COUNT(*), {TOKENS} FROM messages WHERE msg_key IN fx_keys").fetchone()
            show("before:", before)
            show("rows to delete:", gone)
            print(f"  fixture messages carry: input {fx_tokens[1]:,}, output {fx_tokens[2]:,}, cache write 5m {fx_tokens[3]:,}, 1h {fx_tokens[4]:,}, cache read {fx_tokens[5]:,}")
            print(f"  usage_hour: their share is subtracted from rows in {one(conn, 'SELECT COUNT(*) FROM fx_hours')} hours")
            if skipped:
                print(f"  left alone (also in a file outside the fixtures): {', '.join(skipped)}")
            if not any(gone.values()):
                print("nothing to remove")
                return 0
        else:
            find_search(conn)
            gone = search_counts(conn)
            show("rows to delete:", gone)
            if not any(gone.values()):
                print("nothing to remove")
                return 0
        if not a.apply:
            print("dry run: nothing written. Add --apply to delete.")
            return 0

        conn.close()
        bak = backup(db)
        print(f"backup: {bak}")
        conn = sqlite3.connect(db, timeout=60, isolation_level=None)
        (find_usage if kind == "usage" else find_search)(conn)
        conn.execute("BEGIN IMMEDIATE")
        try:
            (delete_usage if kind == "usage" else delete_search)(conn)
            left = (usage_counts if kind == "usage" else search_counts)(conn)
            if any(left.values()):
                raise RuntimeError(f"fixture rows still present after delete: {left}")
            conn.execute("COMMIT")
        except Exception:
            if conn.in_transaction:
                conn.execute("ROLLBACK")
            raise
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        verdict = conn.execute("PRAGMA integrity_check").fetchall()
        if kind == "usage":
            show("after:", usage_totals(conn))
        print("integrity_check:", ", ".join(r[0] for r in verdict[:3]))
        return 0 if verdict == [("ok",)] else 1
    except SystemExit:
        raise
    except Exception as e:
        print(f"failed, nothing was changed (the transaction rolled back): {e}")
        return 1
    finally:
        try:
            conn.close()
        except Exception:
            pass


if __name__ == "__main__":
    sys.exit(main())
