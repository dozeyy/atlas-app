#!/usr/bin/env python3
"""Headless check of the atlas-repeats skill (docs/specs/skill-library.md, criterion 31).

Runs real `claude -p` against a scratch Claude folder: the plugin is loaded with
--plugin-dir, the scratch `atlas-mcp` is the only MCP server, and the chat index is built from
fixtures/claude-habits (dates moved to a few days ago). Nothing here touches the real
~/.claude, ~/.claude.json or Atlas data.

Two modes. Default: the atlas MCP server is the only MCP server (the Atlas app is installed).
--no-app: NO atlas MCP server and no pre-built index, only the plugin: the skill runs the plugin's
launcher, which finds `atlas-usage` on PATH (a scratch bin folder holding the built
target/debug/atlas-usage.exe), and the program reads the scratch chats itself. Data folders are
passed by environment (ATLAS_DATA_DIR, ATLAS_USAGE_CACHE), never the real ones.

--real-login: run under the person's normal Claude login instead of a scratch config folder. No
credentials are copied or made, CLAUDE_CONFIG_DIR is not set, and user settings and hooks are
skipped (--setting-sources project, run from a scratch cwd outside every repo). Only the Atlas
plugin (--plugin-dir) and, in the default mode, the scratch atlas-mcp (--strict-mcp-config) are
added. A guard records the size, mtime and hash of ~/.claude/settings.json and
~/.claude/plugins/*.json, and the mcpServers and enabledPlugins of ~/.claude.json, before and
after, and fails the run if any changed (the .claude.json mtime is ignored: live sessions bump it).
In --no-app --real-login mode a tiny wrapper named atlas-usage.exe on PATH points the plugin's own
program at the habits fixture (CLAUDE_CONFIG_DIR for that child process only), because the real
chats must never be read in a test. The launcher and the program behind it are the shipped ones.

Auth (scratch mode): a scratch CLAUDE_CONFIG_DIR is logged out, and this script never copies credentials.
Give it a token for the run:   set CLAUDE_CODE_OAUTH_TOKEN=<from `claude setup-token`>
(or ANTHROPIC_API_KEY). It is passed to the child process only and never printed or saved.

  python tools/repeats_headless.py [--tries 3] [--model haiku] [--prep-only]
      [--real-login] [--no-app] [--cli-exe target/debug/atlas-usage.exe] [--mcp-exe target/debug/atlas-mcp.exe] [--index-exe target/debug/examples/habits_index.exe]

Scenarios (each run --tries times, a fresh scratch each time):
  fresh     a new wording of the planted request            -> exactly one offer; then "no thanks"
                                                              -> habits.json says declined, no new offer
  declined  the group already noted declined                -> no offer
  never     offersOff is on                                 -> no offer
  oneoff    a request nobody repeated                       -> no offer
Transcripts (user, assistant and result events only; fixture text) go to docs/shots/repeats/.
"""

import argparse
import hashlib
import shutil as _shutil
import datetime as dt
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / "fixtures" / "claude-habits"
OUT = ROOT / "docs" / "shots" / "repeats"
OFFER = re.compile(r"(into|as|make (this|it) a|turn (this|it) into a) skill|skill (out of|from) (this|it)", re.I)

PROMPTS = {
    "fresh": "Read the README for me and give a three bullet summary in plain words",
    "declined": "Read the README for me and give a three bullet summary in plain words",
    "never": "Read the README for me and give a three bullet summary in plain words",
    "oneoff": "Translate the title line of the README into French and keep the tone",
}
FORCE = " (When the work is done, follow the atlas:atlas-repeats skill before your final reply.)"
README = "# Fieldbook\n\nFieldbook keeps a small notebook of trail notes on your computer.\n\n- Notes are plain text files.\n- Search finds a note in under a second.\n- Nothing is ever sent anywhere.\n"


WRAPPER_RS = r'''
use std::process::{Command, exit};
fn main() {
    let me = std::env::current_exe().unwrap();
    let real = me.with_file_name("atlas-usage-real.exe");
    let mut c = Command::new(real);
    c.args(std::env::args_os().skip(1));
    if let Some(d) = std::env::var_os("ATLAS_TEST_CONFIG") { c.env("CLAUDE_CONFIG_DIR", d); }
    exit(c.status().map(|s| s.code().unwrap_or(1)).unwrap_or(3));
}
'''


def make_wrapper(tmp, cli_exe):
    bindir = tmp / "bin"
    bindir.mkdir(exist_ok=True)
    shutil.copy2(cli_exe, bindir / "atlas-usage-real.exe")
    src = tmp / "wrap.rs"
    src.write_text(WRAPPER_RS, encoding="utf-8")
    subprocess.run(["rustc", "-O", "--edition", "2021", str(src), "-o", str(bindir / "atlas-usage.exe")], check=True, capture_output=True)


HOME = Path(os.path.expanduser("~"))


def guard_snapshot():
    snap = {}
    files = [HOME / ".claude" / "settings.json"] + sorted((HOME / ".claude" / "plugins").glob("*.json"))
    for f in files:
        if f.is_file():
            st = f.stat()
            snap[str(f)] = {"size": st.st_size, "mtime": st.st_mtime_ns, "sha256": hashlib.sha256(f.read_bytes()).hexdigest()}
    cj = HOME / ".claude.json"
    if cj.is_file():
        st = cj.stat()
        try:
            v = json.loads(cj.read_text(encoding="utf-8"))
        except ValueError:
            v = {}
        keep = {"mcpServers": v.get("mcpServers"), "enabledPlugins": v.get("enabledPlugins")}
        snap[str(cj)] = {"size": st.st_size, "mtime": st.st_mtime_ns, "content_sha256": hashlib.sha256(json.dumps(keep, sort_keys=True).encode()).hexdigest()}
    return snap


def guard_compare(before, after):
    bad = []
    for k in sorted(set(before) | set(after)):
        b, a = before.get(k), after.get(k)
        if b is None or a is None:
            bad.append(f"{k}: appeared or disappeared")
        elif k.endswith(".claude.json"):
            if b["content_sha256"] != a["content_sha256"]:
                bad.append(f"{k}: mcpServers/enabledPlugins changed")
        elif (b["size"], b["mtime"], b["sha256"]) != (a["size"], a["mtime"], a["sha256"]):
            bad.append(f"{k}: size/mtime/content changed")
    return bad


def civil(days):
    return dt.date(1970, 1, 1) + dt.timedelta(days=days)


def shift_copy(src, dst, delta_days):
    for p in src.rglob("*"):
        rel = p.relative_to(src)
        t = dst / rel
        if p.is_dir():
            t.mkdir(parents=True, exist_ok=True)
        elif p.suffix == ".jsonl":
            t.parent.mkdir(parents=True, exist_ok=True)
            out = []
            for line in p.read_text(encoding="utf-8").splitlines():
                try:
                    v = json.loads(line)
                except ValueError:
                    out.append(line)
                    continue
                ts = v.get("timestamp")
                if isinstance(ts, str) and len(ts) >= 10:
                    d = dt.date.fromisoformat(ts[:10]) + dt.timedelta(days=delta_days)
                    v["timestamp"] = d.isoformat() + ts[10:]
                # Compact like Claude Code writes it; the indexer's line filter expects it.
                out.append(json.dumps(v, ensure_ascii=False, separators=(",", ":")))
            t.write_text("\n".join(out) + "\n", encoding="utf-8", newline="\n")
        else:
            t.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(p, t)


class Mcp:
    """A tiny stdio JSON-RPC client, only to prepare habits.json the way Claude would."""

    def __init__(self, exe, config, data):
        self.p = subprocess.Popen([str(exe), "--config-dir", str(config), "--data-dir", str(data)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        self.n = 0
        self.rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "prep", "version": "0"}})
        self.p.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n")
        self.p.stdin.flush()

    def rpc(self, method, params):
        self.n += 1
        self.p.stdin.write(json.dumps({"jsonrpc": "2.0", "id": self.n, "method": method, "params": params}) + "\n")
        self.p.stdin.flush()
        while True:
            v = json.loads(self.p.stdout.readline())
            if v.get("id") == self.n:
                return v

    def call(self, name, args):
        r = self.rpc("tools/call", {"name": name, "arguments": args})["result"]
        text = r["content"][0]["text"]
        if r.get("isError"):
            raise RuntimeError(text)
        return json.loads(text)

    def close(self):
        self.p.kill()
        self.p.wait()


def scratch(args, tmp):
    claude = tmp / "claude"
    data = tmp / "data"
    work = tmp / "work"
    work.mkdir(parents=True)
    (work / "README.md").write_text(README, encoding="utf-8")
    delta = ((dt.date.today() - dt.timedelta(days=3)) - dt.date(2026, 10, 30)).days
    shift_copy(FIXTURE, claude, delta)
    data.mkdir()
    if args.no_app:
        # Only the plugin: no MCP config, no pre-built index. The program is found on PATH.
        if args.real_login:
            make_wrapper(tmp, args.cli_exe)
        else:
            (tmp / "bin").mkdir()
            shutil.copy2(args.cli_exe, tmp / "bin" / args.cli_exe.name)
        return claude, data, work
    subprocess.run([str(args.index_exe), "--projects", str(claude / "projects"), "--config", str(claude), "--data", str(data)], check=True, stdout=subprocess.DEVNULL)
    cfg = {"mcpServers": {"atlas": {"command": str(args.mcp_exe), "args": ["--config-dir", str(claude), "--data-dir", str(data)]}}}
    (tmp / "mcp.json").write_text(json.dumps(cfg), encoding="utf-8")
    return claude, data, work


def cli(args, tmp, claude, data, *a):
    r = subprocess.run([str(args.cli_exe), *a, "--config-dir", str(claude), "--data-dir", str(data), "--cache-dir", str(tmp / "cache")], capture_output=True, text=True, check=True, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    return json.loads(r.stdout)


def prepare(scenario, mcp_exe, claude, data, args=None, tmp=None):
    if args is not None and args.no_app:
        if scenario == "declined":
            gid = cli(args, tmp, claude, data, "repeats")["groups"][0]["id"]
            cli(args, tmp, claude, data, "offer-note", gid, "declined")
        elif scenario == "never":
            cli(args, tmp, claude, data, "offer-note", "off")
        return
    if scenario in ("declined", "never"):
        m = Mcp(mcp_exe, claude, data)
        try:
            gid = m.call("find_repeated_requests", {})["groups"][0]["id"]
            if scenario == "declined":
                m.call("note_skill_offer", {"groupId": gid, "answer": "declined"})
            else:
                m.call("note_skill_offer", {"answer": "never"})
        finally:
            m.close()


def habits(data):
    f = data / "habits.json"
    return json.loads(f.read_text(encoding="utf-8")) if f.is_file() else {}


def run_claude(args, tmp, claude, work, prompt, resume=None):
    cmd = [_shutil.which("claude") or "claude", "-p", prompt, "--plugin-dir", str(ROOT / "skill")]
    skills = ["Skill(atlas-repeats)", "Skill(atlas:atlas-repeats)"]
    if args.real_login:
        cmd += ["--setting-sources", "project", "--max-budget-usd", str(args.budget)]
    if args.no_app:
        if args.real_login:
            (tmp / "empty-mcp.json").write_text('{"mcpServers":{}}', encoding="utf-8")
            cmd += ["--mcp-config", str(tmp / "empty-mcp.json"), "--strict-mcp-config"]
        extra = []
        if resume:
            # A resumed headless turn no longer has the skill's allowed-tools, so a real user would see one
            # permission prompt for the answer note. Pre-approve exactly that command, like clicking Allow.
            sk = (ROOT / "skill" / "skills" / "atlas-repeats").as_posix()
            extra = [f'Bash(sh "{sk}/../atlas/bin/atlas-usage.sh" offer-note *)']
        cmd += ["--allowedTools", *skills, "Read", *extra]  # first turn: launcher commands come from the skill's own allowed-tools
    else:
        cmd += ["--mcp-config", str(tmp / "mcp.json"), "--strict-mcp-config",
                "--allowedTools", *skills, "mcp__atlas__find_repeated_requests", "mcp__atlas__note_skill_offer", "mcp__atlas__list_items", "Read"]
    cmd += ["--output-format", "stream-json", "--verbose", "--max-turns", "12"]
    if args.model:
        cmd += ["--model", args.model]
    if resume:
        cmd += ["--resume", resume]
    env = dict(os.environ)
    if not args.real_login:
        env["CLAUDE_CONFIG_DIR"] = str(claude)
    else:
        env.pop("CLAUDE_CONFIG_DIR", None)
        env["ATLAS_TEST_CONFIG"] = str(claude)
    if args.no_app:
        env.update(ATLAS_DATA_DIR=str(tmp / "data"), ATLAS_USAGE_CACHE=str(tmp / "cache"), PATH=str(tmp / "bin") + os.pathsep + env.get("PATH", ""))
    r = subprocess.run(cmd, cwd=work, env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, encoding="utf-8", timeout=600, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    events = []
    for line in r.stdout.splitlines():
        try:
            events.append(json.loads(line))
        except ValueError:
            pass
    return r.returncode, events, r.stderr[-400:]


def final_text(events):
    for e in reversed(events):
        if e.get("type") == "result":
            return str(e.get("result", "")), e.get("session_id")
    return "", None


def tools_used(events):
    names = []
    for e in events:
        if e.get("type") == "assistant":
            for c in e.get("message", {}).get("content", []):
                if c.get("type") == "tool_use":
                    names.append(c.get("name"))
    return names


def commands(events):
    """Every shell command line the model ran."""
    out = []
    for e in events:
        if e.get("type") == "assistant":
            for c in e.get("message", {}).get("content", []):
                if c.get("type") == "tool_use" and c.get("name") in ("Bash", "PowerShell"):
                    out.append(str(c.get("input", {}).get("command", "")))
    return out


def keep(events):
    return [e for e in events if e.get("type") in ("user", "assistant", "result")]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tries", type=int, default=3)
    ap.add_argument("--model", default="")
    ap.add_argument("--prep-only", action="store_true")
    ap.add_argument("--mcp-exe", type=Path, default=ROOT / "target" / "debug" / "atlas-mcp.exe")
    ap.add_argument("--index-exe", type=Path, default=ROOT / "target" / "debug" / "examples" / "habits_index.exe")
    ap.add_argument("--real-login", action="store_true", help="use the normal Claude login; no scratch config dir, nothing copied or made")
    ap.add_argument("--budget", type=float, default=0.5, help="--max-budget-usd per run (real login)")
    ap.add_argument("--cue", action="store_true", help="make the fresh prompt say it is a repeat ('again, like last time'), the cue the skill's when_to_use listens for")
    ap.add_argument("--force-skill", action="store_true", help="append an instruction to run the atlas-repeats skill (tests the skill itself, not whether the model picks it by itself)")
    ap.add_argument("--no-app", action="store_true", help="plugin only: no atlas MCP server, the skill uses the launcher and the CLI")
    ap.add_argument("--cli-exe", type=Path, default=ROOT / "target" / "debug" / "atlas-usage.exe")
    ap.add_argument("--scenarios", default="fresh,declined,never,oneoff")
    args = ap.parse_args()
    if args.cue:
        PROMPTS["fresh"] = PROMPTS["declined"] = PROMPTS["never"] = "Read the README again like last time and give a three bullet summary in plain words"
    have_auth = bool(os.environ.get("CLAUDE_CODE_OAUTH_TOKEN") or os.environ.get("ANTHROPIC_API_KEY"))
    if not args.prep_only and not have_auth and not args.real_login:
        print("No CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY in the environment: a scratch Claude folder is logged out.\nSet one for this run (this script never copies credentials), or use --prep-only.", file=sys.stderr)
        return 2
    OUT.mkdir(parents=True, exist_ok=True)
    guard_before = guard_snapshot() if args.real_login and not args.prep_only else None
    prefix = ("forced-" if args.force_skill else "") + ("noapp-" if args.no_app else "")
    rows = []
    for scenario in args.scenarios.split(","):
        fired = 0
        for i in range(1, args.tries + 1):
            tmp = Path(tempfile.mkdtemp(prefix="atlas-repeats-"))
            try:
                claude, data, work = scratch(args, tmp)
                prepare(scenario, args.mcp_exe, claude, data, args, tmp)
                if args.prep_only and args.no_app:
                    g = cli(args, tmp, claude, data, "repeats", "--like", PROMPTS[scenario])
                    print(f"{scenario} try {i}: prepared (no app); likeMatch={'yes' if g['likeMatch'] else 'no'} offersOff={g['offersOff']} offer={g['groups'][0]['offer'] if g['groups'] else None}")
                    continue
                if args.prep_only:
                    m = Mcp(args.mcp_exe, claude, data)
                    try:
                        g = m.call("find_repeated_requests", {"like": PROMPTS[scenario]})
                    finally:
                        m.close()
                    print(f"{scenario} try {i}: prepared; likeMatch={'yes' if g['likeMatch'] else 'no'} offersOff={g['offersOff']} offer={g['groups'][0]['offer'] if g['groups'] else None}")
                    continue
                code, events, err = run_claude(args, tmp, claude, work, PROMPTS[scenario] + (FORCE if args.force_skill else ""))
                text, sid = final_text(events)
                offers = len(OFFER.findall(text))
                used = tools_used(events)
                note = ""
                if scenario == "fresh":
                    looked = any(n.endswith("find_repeated_requests") for n in used) or (args.no_app and any("atlas-usage" in c and "repeats" in c for c in commands(events)))
                    ok = offers == 1 and looked
                    state = habits(data)
                    if ok and sid:
                        code2, events2, _ = run_claude(args, tmp, claude, work, "no thanks", resume=sid)
                        text2, _ = final_text(events2)
                        groups = habits(data).get("groups", {})
                        declined = any(g.get("answer") == "declined" for g in groups.values())
                        no_more = len(OFFER.findall(text2)) == 0
                        ok = declined and no_more
                        note = f"after 'no thanks': declined recorded={declined}, no new offer={no_more}"
                        events += keep(events2)
                else:
                    ok = offers == 0
                fired += ok
                (OUT / f"{prefix}{scenario}-{i}.jsonl").write_text("\n".join(json.dumps(e, ensure_ascii=False) for e in keep(events)) + "\n", encoding="utf-8")
                print(f"{scenario} try {i}: {'PASS' if ok else 'FAIL'} offers={offers} tools={used} exit={code} {note} {err if code else ''}")
            finally:
                shutil.rmtree(tmp, ignore_errors=True)
        rows.append((scenario, args.tries, fired))
    if guard_before is not None:
        bad = guard_compare(guard_before, guard_snapshot())
        print("config guard: " + ("UNCHANGED (settings.json, plugins/*.json, .claude.json mcpServers+enabledPlugins)" if not bad else "CHANGED: " + "; ".join(bad)))
        rows.append(("config guard", 1, 0 if bad else 1))
    if not args.prep_only:
        lines = ["# Repeats headless run" + (" (plugin only, no app)" if args.no_app else ""), "", f"model: {args.model or 'default'}{'; real login, user settings skipped' if args.real_login else ''}; date: {dt.date.today().isoformat()}", "", "| scenario | tries | as expected |", "|---|---|---|"]
        lines += [f"| {s} | {n} | {m} |" for s, n, m in rows]
        (OUT / f"{prefix}summary.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
        print("\n".join(lines))
    return 0


if __name__ == "__main__":
    sys.exit(main())
