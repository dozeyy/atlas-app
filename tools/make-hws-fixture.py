#!/usr/bin/env python3
"""Build a demo Claude folder for the History, Wrapped and Settings screens.

    python tools/make-hws-fixture.py OUT_DIR

Starts from tools/make-demo-fixture.py (OUT_DIR/home/.claude, usage that always ends today) and then:
  - keeps only the last 31 days of transcripts, like Claude Code's own 30 day cleanup, so Wrapped's
    "what this covers" line is true of the data;
  - adds Skill, Task and ordinary tool calls to the assistant lines (Wrapped's favorites);
  - adds three older `.claude.json` backups under backups/ (History imports them);
  - adds file-history copies of a few setup files plus the `file-history-snapshot` lines that name
    them (History imports them as older versions).
Edit settings.json / CLAUDE.md in the scratch copy while Atlas runs to make live "changed" events.
Everything is fiction. Run Atlas with `--config-dir OUT_DIR/home/.claude --data-dir <scratch>`.
"""
import datetime
import importlib.util
import json
import os
import random
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
KEEP_DAYS = 31

SKILLS = [("frontend-design", 0.34), ("code-review", 0.22), ("simplify", 0.16), ("run", 0.14), ("ui-ux-pro-max", 0.14)]
AGENTS = [("code-reviewer", 0.36), ("Explore", 0.34), ("test-runner", 0.18), ("general-purpose", 0.12)]
TOOLS = [("Edit", 0.34), ("Bash", 0.26), ("Read", 0.2), ("Grep", 0.12), ("Write", 0.08)]


def load_demo():
    spec = importlib.util.spec_from_file_location("demo_fixture", os.path.join(HERE, "make-demo-fixture.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def pick(rng, pairs):
    r, acc = rng.random(), 0.0
    for name, w in pairs:
        acc += w
        if r <= acc:
            return name
    return pairs[-1][0]


def read_lines(path):
    with open(path, encoding="utf-8") as f:
        return [json.loads(x) for x in f if x.strip()]


def write_lines(path, lines):
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        for ln in lines:
            f.write(json.dumps(ln, separators=(",", ":")) + "\n")


def parse_ts(s):
    return datetime.datetime.strptime(s, "%Y-%m-%dT%H:%M:%S.000Z").replace(tzinfo=datetime.timezone.utc)


def stamp(t):
    return t.strftime("%Y-%m-%dT%H:%M:%S.000Z")


def trim_old(projects, now):
    """Drop sessions that started before the cleanup window; set mtimes to the last record."""
    kept = []
    for proj in sorted(os.listdir(projects)):
        pdir = os.path.join(projects, proj)
        for name in sorted(os.listdir(pdir)):
            if not name.endswith(".jsonl"):
                continue
            path = os.path.join(pdir, name)
            lines = read_lines(path)
            first = next((parse_ts(x["timestamp"]) for x in lines if "timestamp" in x), None)
            last = next((parse_ts(x["timestamp"]) for x in reversed(lines) if "timestamp" in x), None)
            if first is None or first < now - datetime.timedelta(days=KEEP_DAYS):
                os.remove(path)
                shutil.rmtree(os.path.join(pdir, name[:-6]), ignore_errors=True)
                continue
            os.utime(path, (last.timestamp(), last.timestamp()))
            kept.append((first, path, name[:-6]))
    kept.sort()
    return kept


def add_tool_calls(projects, rng):
    n = 0
    for root, _dirs, files in os.walk(projects):
        for name in files:
            if not name.endswith(".jsonl"):
                continue
            path = os.path.join(root, name)
            mtime = os.path.getmtime(path)
            lines = read_lines(path)
            for rec in lines:
                if rec.get("type") != "assistant" or rng.random() > 0.55:
                    continue
                blocks = rec["message"]["content"]
                tool = pick(rng, TOOLS)
                blocks.append({"type": "tool_use", "id": f"toolu_{n:06d}", "name": tool, "input": {}})
                n += 1
                if rng.random() < 0.12:
                    blocks.append({"type": "tool_use", "id": f"toolu_{n:06d}", "name": "Skill", "input": {"skill": pick(rng, SKILLS)}})
                    n += 1
                if rng.random() < 0.08:
                    blocks.append({"type": "tool_use", "id": f"toolu_{n:06d}", "name": "Task", "input": {"subagent_type": pick(rng, AGENTS), "description": "Look into it", "prompt": "[demo]"}})
                    n += 1
            write_lines(path, lines)
            os.utime(path, (mtime, mtime))
    return n


def older_settings(text, step):
    """Two plausible earlier versions of a JSON settings file."""
    try:
        data = json.loads(text)
    except ValueError:
        return text
    keys = [k for k, v in data.items() if isinstance(v, (str, bool, int))]
    if not keys:
        data["model"] = "sonnet" if step == 1 else "opus"
    elif step == 1:
        del data[keys[0]]
    else:
        v = data[keys[0]]
        data[keys[0]] = (not v) if isinstance(v, bool) else (v + 1 if isinstance(v, int) else f"{v}-old")
    return json.dumps(data, indent=2) + "\n"


def older_text(text, step):
    lines = text.splitlines()
    if len(lines) < 3:
        return text + ("An older line.\n" if step == 1 else "")
    if step == 1:
        return "\n".join(lines[:-1]) + "\n"
    lines[1] = lines[1] + " (earlier wording)"
    return "\n".join(lines[:-1]) + "\n"


def add_file_history(claude, sessions, now):
    """file-history/<sid>/<hash>@vN copies and the snapshot lines that name them."""
    history = os.path.join(claude, "file-history")
    targets = [("settings.json", True), ("CLAUDE.md", False), (os.path.join("agents", "user-agent.md"), False)]
    made = 0
    for i, (rel, is_json) in enumerate(targets):
        path = os.path.join(claude, rel)
        if not os.path.isfile(path):
            continue
        with open(path, encoding="utf-8") as f:
            text = f.read()
        for step in (1, 2):
            # Older sessions first: step 1 is the oldest copy.
            idx = max(0, len(sessions) // (6 if step == 1 else 3) + i)
            first, spath, sid = sessions[min(idx, len(sessions) - 1)]
            at = first + datetime.timedelta(minutes=20 + 7 * i)
            name = f"{abs(hash((rel, sid))) % (16 ** 16):016x}@v{step}"
            body = older_settings(text, step) if is_json else older_text(text, step)
            dest = os.path.join(history, sid)
            os.makedirs(dest, exist_ok=True)
            with open(os.path.join(dest, name), "w", encoding="utf-8", newline="\n") as f:
                f.write(body)
            snap = {
                "type": "file-history-snapshot",
                "messageId": f"snap-{sid[:8]}-{i}{step}",
                "snapshot": {
                    "messageId": f"snap-{sid[:8]}-{i}{step}",
                    "trackedFileBackups": {
                        os.path.basename(rel): {
                            "backupFileName": name,
                            "version": step,
                            "backupTime": stamp(at),
                            "realParentDir": os.path.dirname(path),
                        }
                    },
                    "timestamp": stamp(at),
                },
                "isSnapshotUpdate": False,
            }
            with open(spath, "a", encoding="utf-8", newline="\n") as f:
                f.write(json.dumps(snap, separators=(",", ":")) + "\n")
            made += 1
    return made


def add_backups(claude, home_json, now):
    """Three older copies of .claude.json with a different set of MCP servers each."""
    with open(home_json, encoding="utf-8") as f:
        base = json.load(f)
    out = os.path.join(claude, "backups")
    os.makedirs(out, exist_ok=True)
    servers = base.get("mcpServers", {})
    variants = [
        (9, {"notes-srv": {"command": "node", "args": ["notes.js"]}}),
        (4, {"notes-srv": {"command": "node", "args": ["notes.js"]}, "docs-srv": {"command": "npx", "args": ["docs-mcp"]}}),
        (1, {"docs-srv": {"command": "npx", "args": ["docs-mcp"]}, **servers}),
    ]
    for days, extra in variants:
        t = now - datetime.timedelta(days=days, hours=3)
        data = dict(base)
        data["mcpServers"] = extra
        ms = int(t.timestamp() * 1000)
        with open(os.path.join(out, f".claude.json.backup.{ms}"), "w", encoding="utf-8", newline="\n") as f:
            json.dump(data, f, indent=2)
    return len(variants)


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    out = os.path.abspath(sys.argv[1])
    demo = load_demo()
    sys.argv = [sys.argv[0], out]
    demo.main()

    claude = os.path.join(out, "home", ".claude")
    projects = os.path.join(claude, "projects")
    now = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0)
    rng = random.Random(20261109)

    sessions = trim_old(projects, now)
    calls = add_tool_calls(projects, rng)
    backups = add_backups(claude, os.path.join(claude, ".claude.json"), now)
    copies = add_file_history(claude, sessions, now)
    print(f"kept {len(sessions)} sessions, {calls} tool calls, {backups} json backups, {copies} file-history copies")
    print(f"config dir: {claude}")


if __name__ == "__main__":
    main()
