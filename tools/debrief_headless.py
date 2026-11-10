#!/usr/bin/env python3
"""Headless check of the atlas-debrief skill (docs/specs/agent-scorecard.md, criteria 34, 36, 37).

Real `claude -p`, plugin only (no atlas MCP server), under the person's normal Claude login with
no credentials copied or made, user settings and hooks skipped (--setting-sources project), the
session not saved (--no-session-persistence), run from a scratch cwd outside every repo. The same
method and guard as tools/repeats_headless.py (the guard records ~/.claude/settings.json,
~/.claude/plugins/*.json and the mcpServers / enabledPlugins of ~/.claude.json before and after).
The real chats are never read: a tiny wrapper named atlas-usage.exe on PATH points the plugin's
own program at fixtures/claude-ledger (CLAUDE_CONFIG_DIR for that child process only), and the
index goes to a scratch folder. The launcher and the program behind it are the shipped ones.

  python tools/debrief_headless.py [--model haiku] [--budget 0.5] [--tries 2] [--scenarios ...]

Scenarios:
  terse    asks for a two-line debrief of the fixture chat -> the launcher's `debrief` call goes
           through the skill's allowed-tools (no permission denial), the answer holds the facts
  high     asks for each helper listed                    -> `--detail high` call goes through
  quiet    an unrelated request with the plugin loaded     -> the skill is never used
  tokens   `Reply ok.` with no plugin / the plugin without atlas-debrief / the full plugin
           -> the first request's input tokens, so the skill's cost is the difference
Transcripts (user, assistant and result events; fixture text) go to docs/shots/debrief/.
"""

import argparse
import json
import os
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import repeats_headless as rh  # noqa: E402

ROOT = rh.ROOT
FIXTURE = ROOT / "fixtures" / "claude-ledger"
OUT = ROOT / "docs" / "shots" / "debrief"
S1 = "aaaa1001-0000-4000-8000-000000000001"
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)

# The wrapper also tells the program which chat is "this chat" (CLAUDE_CODE_SESSION_ID, which Claude
# Code sets for real in the Bash tool), so the skill runs `debrief --detail low` with no session id.
rh.WRAPPER_RS = rh.WRAPPER_RS.replace(
    'if let Some(d) = std::env::var_os("ATLAS_TEST_CONFIG")',
    'if let Some(d) = std::env::var_os("ATLAS_TEST_SESSION") { c.env("CLAUDE_CODE_SESSION_ID", d); }\n    if let Some(d) = std::env::var_os("ATLAS_TEST_CONFIG")',
)
assert "ATLAS_TEST_SESSION" in rh.WRAPPER_RS

PROMPTS = {
    "terse": "I just finished a run with helpers. Use the atlas-debrief skill and give me a quick two line debrief.",
    "high": "I just finished a run with helpers. Use the atlas-debrief skill and debrief it with every helper listed, one line each.",
    "quiet": "Read the README and give me a three bullet summary in plain words",
    "tokens": "Reply with the single word ok.",
}
README = rh.README


def claude_cmd(prompt, plugin, args, skills):
    cmd = [shutil.which("claude") or "claude", "-p", prompt, "--setting-sources", "project", "--max-budget-usd", str(args.budget), "--no-session-persistence"]
    if plugin:
        cmd += ["--plugin-dir", str(plugin)]
    allowed = list(skills) + ["Read"]
    cmd += ["--allowedTools", *allowed, "--output-format", "stream-json", "--verbose", "--max-turns", "8"]
    if args.model:
        cmd += ["--model", args.model]
    return cmd


def run(prompt, plugin, args, tmp, skills=("Skill(atlas-debrief)", "Skill(atlas:atlas-debrief)")):
    work = tmp / "work"
    work.mkdir(exist_ok=True)
    (work / "README.md").write_text(README, encoding="utf-8")
    (tmp / "empty-mcp.json").write_text('{"mcpServers":{}}', encoding="utf-8")
    cmd = claude_cmd(prompt, plugin, args, skills) + ["--mcp-config", str(tmp / "empty-mcp.json"), "--strict-mcp-config"]
    env = dict(os.environ)
    env.pop("CLAUDE_CONFIG_DIR", None)
    env.update(ATLAS_TEST_CONFIG=str(tmp / "claude"), ATLAS_TEST_SESSION=S1, ATLAS_DATA_DIR=str(tmp / "data"), ATLAS_USAGE_CACHE=str(tmp / "cache"), PATH=str(tmp / "bin") + os.pathsep + env.get("PATH", ""))
    r = subprocess.run(cmd, cwd=work, env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, encoding="utf-8", timeout=600, creationflags=NO_WINDOW)
    events = []
    for line in r.stdout.splitlines():
        try:
            events.append(json.loads(line))
        except ValueError:
            pass
    return r.returncode, events, r.stderr[-400:]


def scratch(args):
    tmp = Path(tempfile.mkdtemp(prefix="atlas-debrief-"))
    shutil.copytree(FIXTURE, tmp / "claude")
    (tmp / "data").mkdir()
    rh.make_wrapper(tmp, args.cli_exe)
    return tmp


def plugin_without_debrief(tmp):
    dst = tmp / "plugin-nodebrief"
    shutil.copytree(ROOT / "skill", dst)
    shutil.rmtree(dst / "skills" / "atlas-debrief")
    return dst


def result_event(events):
    for e in reversed(events):
        if e.get("type") == "result":
            return e
    return {}


def tool_uses(events):
    out = []
    for e in events:
        if e.get("type") == "assistant":
            for c in e.get("message", {}).get("content", []):
                if c.get("type") == "tool_use":
                    out.append((c.get("id"), c.get("name"), c.get("input", {})))
    return out


def tool_results(events):
    out = {}
    for e in events:
        if e.get("type") == "user":
            content = e.get("message", {}).get("content", [])
            if isinstance(content, list):
                for c in content:
                    if c.get("type") == "tool_result":
                        body = c.get("content")
                        if isinstance(body, list):
                            body = "".join(x.get("text", "") for x in body if isinstance(x, dict))
                        out[c.get("tool_use_id")] = (bool(c.get("is_error")), str(body))
    return out


def input_totals(events):
    """Input tokens (fresh + cache write + cache read) of each model request, in order."""
    seen, out = set(), []
    for e in events:
        if e.get("type") != "assistant":
            continue
        m = e.get("message", {})
        if m.get("id") in seen:
            continue
        seen.add(m.get("id"))
        u = m.get("usage", {})
        out.append(u.get("input_tokens", 0) + u.get("cache_creation_input_tokens", 0) + u.get("cache_read_input_tokens", 0))
    return out


def keep(events):
    return [e for e in events if e.get("type") in ("user", "assistant", "result")]


def debrief_calls(events):
    return [(i, n, inp) for i, n, inp in tool_uses(events) if n == "Bash" and "atlas-usage.sh" in str(inp.get("command", "")) and " debrief" in str(inp.get("command", ""))]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="haiku")
    ap.add_argument("--budget", type=float, default=0.5)
    ap.add_argument("--tries", type=int, default=2)
    ap.add_argument("--cli-exe", type=Path, default=ROOT / "target" / "debug" / "atlas-usage.exe")
    ap.add_argument("--scenarios", default="terse,high,quiet,tokens")
    args = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    before = rh.guard_snapshot()
    rows, lines = [], []
    for scenario in args.scenarios.split(","):
        for i in range(1, (1 if scenario == "tokens" else args.tries) + 1):
            tmp = scratch(args)
            try:
                if scenario == "tokens":
                    cfgs = {"no plugin": None, "plugin without atlas-debrief": plugin_without_debrief(tmp), "full plugin": ROOT / "skill"}
                    totals = {}
                    for name, plugin in cfgs.items():
                        code, events, err = run(PROMPTS["tokens"], plugin, args, tmp, skills=())
                        t = input_totals(events)
                        totals[name] = t[0] if t else None
                        (OUT / f"tokens-{name.replace(' ', '-')}.jsonl").write_text("\n".join(json.dumps(e, ensure_ascii=False) for e in keep(events)) + "\n", encoding="utf-8")
                        print(f"tokens [{name}]: first request input = {totals[name]} exit={code} {err if code else ''}")
                    a, b, c = totals["no plugin"], totals["plugin without atlas-debrief"], totals["full plugin"]
                    if None not in (a, b, c):
                        print(f"tokens: plugin adds {b - a}; atlas-debrief adds {c - b}")
                        lines.append(f"- input tokens of a first request: no plugin {a}, plugin without atlas-debrief {b}, full plugin {c} (atlas-debrief adds {c - b})")
                    rows.append((scenario, i, c is not None))
                    continue
                code, events, err = run(PROMPTS[scenario], ROOT / "skill", args, tmp)
                res = result_event(events)
                denials = res.get("permission_denials", [])
                text = str(res.get("result", ""))
                uses = tool_uses(events)
                results = tool_results(events)
                calls = debrief_calls(events)
                skills = [inp.get("skill") for _, n, inp in uses if n == "Skill"]
                if scenario == "quiet":
                    ok = not calls and not any("debrief" in str(s) for s in skills)
                    note = f"skills={skills} debrief calls={len(calls)}"
                else:
                    good = [(cid, inp) for cid, _, inp in calls if cid in results and not results[cid][0] and "Ran: " in results[cid][1]]
                    ok = bool(good) and not denials and "14" in text
                    want = "--detail high" if scenario == "high" else "--detail low"
                    ok = ok and any(want in str(inp.get("command", "")) for _, inp in good)
                    # Only the exact pre-approved form: no session id, no other option.
                    ok = ok and all("--session" not in str(inp.get("command", "")) and "-dir" not in str(inp.get("command", "")) for _, _, inp in calls)
                    # The program's own stderr notes (first-run indexing) come first; the debrief starts at "Ran: ".
                    size = len(results[good[0][0]][1].split("Ran: ", 1)[1]) + 5 if good else 0
                    tot = input_totals(events)
                    note = f"skills={skills} calls={[str(inp.get('command', ''))[-70:] for _, _, inp in calls]} denials={len(denials)} result chars={size} requests' input={tot}"
                    if good:
                        lines.append(f"- {scenario} try {i}: the debrief text is {size} characters (about {size // 4} tokens); input per request {tot}")
                rows.append((scenario, i, ok))
                (OUT / f"{scenario}-{i}.jsonl").write_text("\n".join(json.dumps(e, ensure_ascii=False) for e in keep(events)) + "\n", encoding="utf-8")
                print(f"{scenario} try {i}: {'PASS' if ok else 'FAIL'} exit={code} {note}\n   answer: {text[:400]!r} {err if code else ''}")
            finally:
                shutil.rmtree(tmp, ignore_errors=True)
    bad = rh.guard_compare(before, rh.guard_snapshot())
    print("config guard: " + ("UNCHANGED" if not bad else "CHANGED: " + "; ".join(bad)))
    summary = ["# Debrief headless run", "", f"model: {args.model}; real login, user settings skipped, session not saved", "", "| scenario | try | as expected |", "|---|---|---|"]
    summary += [f"| {s} | {n} | {'yes' if ok else 'NO'} |" for s, n, ok in rows]
    summary += ["", f"config guard: {'unchanged' if not bad else 'CHANGED'}", ""] + lines
    (OUT / "summary.md").write_text("\n".join(summary) + "\n", encoding="utf-8")
    print("\n".join(summary))
    return 0 if all(ok for _, _, ok in rows) and not bad else 1


if __name__ == "__main__":
    sys.exit(main())
