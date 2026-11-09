#!/usr/bin/env python3
"""Leave a demo Claude folder with live helpers, for the Now tab's "Helpers at work" screenshots.

    python tools/make-demo-fixture.py OUT_DIR          (no --live)
    python tools/replay-helpers.py OUT_DIR [--keep SECONDS] [--grow]

Writes into OUT_DIR/home/.claude/projects only (never a real Claude folder; it refuses any path
that is not a make-demo-fixture folder). It adds:

  * a past chat with six finished code-reviewer runs (16 to 24 tool calls, median 20), so that kind
    of helper has a typical run to be compared with (the usage cache needs 5 finished runs);
  * two live chats with five helpers: a code-reviewer at 12 calls ("About 60% of a typical run"),
    a test-runner with its own plan moving ("Step 3 of 5"), an Explore with no past runs ("No past
    runs to compare"), a second code-reviewer at 26 calls ("Longer than a typical run"), and a
    general-purpose helper whose last line is 6 minutes old with nothing open ("No progress for 6 min").

Models and efforts differ per helper (Opus 5.5 high, Sonnet 5.5 medium, Haiku 5.5 with no effort
line, Opus 5.5 xhigh, Sonnet 5.5 with no effort line), to see the row's "model - effort" text.

--keep N keeps the live files fresh for N seconds (so Atlas, started after this, still finds them live);
--grow also gives the first code-reviewer a new tool call every 4 seconds, to watch its fill move.
Everything is fiction. Timestamps are relative to the moment you run it.
"""
import datetime
import json
import os
import sys
import time

UTC = datetime.timezone.utc


def stamp(t):
    return t.strftime("%Y-%m-%dT%H:%M:%S.000Z")


def usage():
    return {"input_tokens": 30, "output_tokens": 220, "cache_creation_input_tokens": 900, "cache_read_input_tokens": 12000}


def user_line(sid, t, cwd, text):
    return {"type": "user", "uuid": f"u-{sid[:8]}-{stamp(t)}", "sessionId": sid, "timestamp": stamp(t), "cwd": cwd,
            "isSidechain": False, "version": "2.1.296", "message": {"role": "user", "content": text}}


def call_line(sid, agent, n, t, cwd, model, name, inp, side=True, effort=None):
    rec = {"type": "assistant", "uuid": f"a-{sid[:8]}-{agent}-{n}", "sessionId": sid, "timestamp": stamp(t), "cwd": cwd,
           "isSidechain": side, "version": "2.1.296", "requestId": f"req_{agent}_{n}",
           "message": {"id": f"msg_{agent}_{n}", "type": "message", "role": "assistant", "model": model,
                       "stop_reason": "tool_use",
                       "content": [{"type": "tool_use", "id": f"toolu_{agent}_{n}", "name": name, "input": inp}],
                       "usage": usage()}}
    if agent:
        rec["agentId"] = agent
    if effort:
        rec["effort"] = effort
        rec["perTurnEffort"] = effort
    return rec


def result_line(sid, agent, n, t, cwd):
    return {"type": "user", "uuid": f"r-{sid[:8]}-{agent}-{n}", "sessionId": sid, "timestamp": stamp(t), "cwd": cwd,
            "isSidechain": True, "version": "2.1.296", "agentId": agent,
            "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": f"toolu_{agent}_{n}", "content": "ok"}]}}


def put(path, lines, mtime=None):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        for ln in lines:
            f.write(json.dumps(ln, separators=(",", ":")) + "\n")
    if mtime is not None:
        os.utime(path, (mtime.timestamp(), mtime.timestamp()))


def put_meta(base, agent_type, desc, agent):
    with open(base + ".meta.json", "w", encoding="utf-8", newline="\n") as f:
        json.dump({"agentType": agent_type, "description": desc, "toolUseId": f"toolu_spawn_{agent}", "spawnDepth": 1}, f, separators=(",", ":"))


def calls(sid, agent, cwd, model, start, n, step_s, tools=("Read", "Grep", "Read", "Read", "Glob"), effort=None):
    """n tool calls, each answered, spaced step_s apart from start."""
    out, t = [], start
    for i in range(n):
        t = start + datetime.timedelta(seconds=step_s * i)
        name = tools[i % len(tools)]
        inp = {"file_path": f"{cwd}/src/file{i}.ts"} if name in ("Read",) else {"pattern": "rounding"} if name == "Grep" else {"pattern": "**/*.ts"}
        out.append(call_line(sid, agent, i, t, cwd, model, name, inp, effort=effort))
        out.append(result_line(sid, agent, i, t + datetime.timedelta(seconds=1), cwd))
    return out


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        sys.exit(__doc__)
    out = os.path.abspath(args[0])
    projects = os.path.join(out, "home", ".claude", "projects")
    # Only a folder make-demo-fixture.py made: it always leaves home/.claude/projects.
    if not os.path.isdir(projects) or os.path.realpath(out) == os.path.realpath(os.path.expanduser("~")):
        sys.exit("not a make-demo-fixture folder: " + out)
    keep = int(sys.argv[sys.argv.index("--keep") + 1]) if "--keep" in sys.argv else 0
    grow = "--grow" in sys.argv
    now = datetime.datetime.now(UTC).replace(microsecond=0)
    model = "claude-sonnet-5-5"

    # ---- past: six finished code-reviewer runs ------------------------------------------------
    psid = "00000099-demo-4000-8000-000000000099"
    pcwd = "/demo/maple-api"
    pdir = os.path.join(projects, "-demo-maple-api")
    base_t = now - datetime.timedelta(days=2)
    put(os.path.join(pdir, psid + ".jsonl"),
        [{"type": "custom-title", "customTitle": "Review week", "sessionId": psid}, user_line(psid, base_t, pcwd, "Review week")],
        base_t)
    for i, n in enumerate((16, 18, 20, 20, 22, 24)):
        aid = f"past{i}"
        start = base_t + datetime.timedelta(minutes=10 * (i + 1))
        lines = calls(psid, aid, pcwd, model, start, n, 6)
        b = os.path.join(pdir, psid, "subagents", f"agent-{aid}")
        put(b + ".jsonl", lines, start + datetime.timedelta(minutes=5))
        put_meta(b, "code-reviewer", "Read the diff and flag anything risky", aid)

    # ---- live: two chats, five helpers ---------------------------------------------------------
    live_files, fresh_files = [], []

    def live_chat(sid, project, title, helpers):
        cwd = f"/demo/{project}"
        pdir = os.path.join(projects, "-demo-" + project)
        t_ask = now - datetime.timedelta(minutes=6)
        main_lines = [{"type": "custom-title", "customTitle": title, "sessionId": sid}, user_line(sid, t_ask, cwd, title)]
        content = [{"type": "tool_use", "id": f"toolu_task_{sid[:8]}_{i}", "name": "Task", "input": {"subagent_type": h[1], "description": h[2], "prompt": "[demo]"}}
                   for i, h in enumerate(helpers)]
        main_lines.append({"type": "assistant", "uuid": f"al-{sid[:8]}", "sessionId": sid, "timestamp": stamp(now - datetime.timedelta(minutes=5)), "cwd": cwd,
                           "isSidechain": False, "version": "2.1.296", "requestId": f"req_{sid[:8]}",
                           "message": {"id": f"msg_{sid[:8]}", "type": "message", "role": "assistant", "model": model, "stop_reason": "tool_use",
                                       "content": content, "usage": usage()}})
        mp = os.path.join(pdir, sid + ".jsonl")
        put(mp, main_lines)
        fresh_files.append(mp)
        for aid, atype, desc, lines, quiet_s in helpers:
            b = os.path.join(pdir, sid, "subagents", f"agent-{aid}")
            if quiet_s:
                last = now - datetime.timedelta(seconds=quiet_s)
                put(b + ".jsonl", lines, last)
            else:
                put(b + ".jsonl", lines)
                fresh_files.append(b + ".jsonl")
            put_meta(b, atype, desc, aid)
            live_files.append(b + ".jsonl")

    sid1 = "00000101-demo-4000-8000-000000000101"
    cwd1 = "/demo/maple-api"
    # Models and efforts differ per helper; the Explore and the stuck one say no effort at all.
    opus, haiku = "claude-opus-5-5", "claude-haiku-5-5"
    h1_lines = calls(sid1, "r1", cwd1, opus, now - datetime.timedelta(seconds=150), 12, 11, effort="high")
    todo = lambda states: {"todos": [{"content": f"step {i}", "status": s, "activeForm": f"step {i}"} for i, s in enumerate(states)]}
    t0 = now - datetime.timedelta(seconds=200)
    h2_lines = [call_line(sid1, "t1", 0, t0, cwd1, model, "TodoWrite", todo(["in_progress", "pending", "pending", "pending", "pending"]), effort="medium"),
                result_line(sid1, "t1", 0, t0 + datetime.timedelta(seconds=1), cwd1)]
    h2_lines += [call_line(sid1, "t1", 1, t0 + datetime.timedelta(seconds=30), cwd1, model, "Read", {"file_path": f"{cwd1}/src/a.ts"}, effort="medium"),
                 result_line(sid1, "t1", 1, t0 + datetime.timedelta(seconds=31), cwd1),
                 call_line(sid1, "t1", 2, t0 + datetime.timedelta(seconds=70), cwd1, model, "TodoWrite", todo(["completed", "completed", "in_progress", "pending", "pending"]), effort="medium"),
                 result_line(sid1, "t1", 2, t0 + datetime.timedelta(seconds=71), cwd1),
                 call_line(sid1, "t1", 3, now - datetime.timedelta(seconds=8), cwd1, model, "Bash", {"command": "cargo test --workspace"}, effort="medium")]
    h3_lines = calls(sid1, "x1", cwd1, haiku, now - datetime.timedelta(seconds=40), 4, 9)
    live_chat(sid1, "maple-api", "Fix flaky login test", [
        ("r1", "code-reviewer", "Read the diff and flag anything risky", h1_lines, 0),
        ("t1", "test-runner", "Run the suite and summarise failures", h2_lines, 0),
        ("x1", "Explore", "Look through the docs folder", h3_lines, 0),
    ])

    sid2 = "00000102-demo-4000-8000-000000000102"
    cwd2 = "/demo/pixel-garden"
    h4_lines = calls(sid2, "r2", cwd2, opus, now - datetime.timedelta(seconds=240), 26, 9, effort="xhigh")
    h5_lines = calls(sid2, "g1", cwd2, model, now - datetime.timedelta(minutes=9), 3, 40)
    live_chat(sid2, "pixel-garden", "Add dark mode to the garden map", [
        ("r2", "code-reviewer", "Review the sync code", h4_lines, 0),
        ("g1", "general-purpose", "Compare the two migration plans", h5_lines, 6 * 60),
    ])
    print(f"replay written under {projects} ({len(live_files)} live helpers)")

    # ---- keep it live ---------------------------------------------------------------------------
    deadline = time.time() + keep
    n = 12
    while time.time() < deadline:
        time.sleep(4)
        t = datetime.datetime.now(UTC)
        if grow:
            p = os.path.join(projects, "-demo-maple-api", sid1, "subagents", "agent-r1.jsonl")
            with open(p, "a", encoding="utf-8", newline="\n") as f:
                for ln in (call_line(sid1, "r1", n, t, cwd1, opus, "Read", {"file_path": f"{cwd1}/src/more{n}.ts"}, effort="high"), result_line(sid1, "r1", n, t, cwd1)):
                    f.write(json.dumps(ln, separators=(",", ":")) + "\n")
            n += 1
        for p in fresh_files:
            os.utime(p, (time.time(), time.time()))


if __name__ == "__main__":
    main()
