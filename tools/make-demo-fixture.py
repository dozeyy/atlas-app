#!/usr/bin/env python3
"""Build a demo Claude folder with usage that is always "recent", for screenshots and perf runs.

    python tools/make-demo-fixture.py OUT_DIR

OUT_DIR gets a copy of fixtures/pc/home (so the Toolkit has skills, agents, hooks and so on)
plus about 90 days of made-up Claude Code transcripts that end today: a streak that reaches today,
five projects, three models, sessions with helpers (one nested), busy weekdays and quiet weekends.
Dates are relative to the moment you run it, so the Dashboard always has "Today" and a live streak.
Everything is fiction: no real prompts, paths or ids. Run Atlas with `--config-dir OUT_DIR/home/.claude`.
"""
import datetime
import json
import os
import random
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "fixtures", "pc", "home")
# The fixture installs its plugin outside the config folder (short paths); the demo puts it where
# Atlas looks when `installPath` does not exist: plugins/cache/<market>/<plugin>/<version>.
PLUGIN_SRC = os.path.join(HERE, "..", "fixtures", "pc", "plugin")
PLUGIN_DEST = ("plugins", "cache", "fixture-market", "fixture-plugin", "1.0.0")

PROJECTS = [
    ("maple-api", 0.34),
    ("pixel-garden", 0.24),
    ("field-notes", 0.18),
    ("budget-bot", 0.14),
    ("dotfiles", 0.10),
]
MODELS = [("claude-sonnet-5-5", 0.62), ("claude-opus-5-5", 0.25), ("claude-haiku-5-5", 0.13)]
TITLES = [
    "Tidy the invoice rounding", "Why is the build slow", "Add dark mode to the garden map", "Sort out the weekly digest",
    "Move settings into one file", "Write the import script", "Fix flaky login test", "Rename the sprout components",
    "Plan the next release", "Draft the changelog", "Clean up old branches", "Speed up the search page",
    "Wire the budget chart", "Check the cron schedule", "Port the shell aliases", "Review the sync code",
]
HELPERS = [
    ("Explore", "Find every caller of the rounding helper"),
    ("Explore", "Look through the docs folder"),
    ("general-purpose", "Compare the two migration plans"),
    ("code-reviewer", "Read the diff and flag anything risky"),
    ("test-runner", "Run the suite and summarise failures"),
]


def pick(rng, pairs):
    r, acc = rng.random(), 0.0
    for name, w in pairs:
        acc += w
        if r <= acc:
            return name
    return pairs[-1][0]


def usage(rng, big):
    k = 3 if big else 1
    cw = rng.randint(800, 6000) * k
    return {
        "input_tokens": rng.randint(20, 400),
        "output_tokens": rng.randint(150, 2600) * k,
        "cache_creation_input_tokens": cw,
        "cache_read_input_tokens": rng.randint(6000, 60000) * k,
        "cache_creation": {"ephemeral_5m_input_tokens": cw, "ephemeral_1h_input_tokens": 0},
        "server_tool_use": {"web_search_requests": 0, "web_fetch_requests": 0},
        "service_tier": "standard",
        "speed": "standard",
        "inference_geo": "global",
    }


def stamp(t):
    return t.strftime("%Y-%m-%dT%H:%M:%S.000Z")


def msg(sid, n, t, model, cwd, rng, big, side=False, agent=None):
    rec = {
        "type": "assistant",
        "uuid": f"u-{sid[:8]}-{n}",
        "sessionId": sid,
        "timestamp": stamp(t),
        "cwd": cwd,
        "isSidechain": side,
        "version": "2.1.296",
        "requestId": f"req_{sid[:8]}_{n}",
        "message": {
            "id": f"msg_{sid[:8]}_{n}",
            "type": "message",
            "role": "assistant",
            "model": model,
            "content": [{"type": "text", "text": "[demo assistant text]"}],
            "usage": usage(rng, big),
        },
    }
    if agent:
        rec["agentId"] = agent
    return rec


def write(path, lines):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        for ln in lines:
            f.write(json.dumps(ln, separators=(",", ":")) + "\n")


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    out = os.path.abspath(sys.argv[1])
    if os.path.exists(out):
        sys.exit(f"{out} already exists; pick a new folder")
    home = os.path.join(out, "home")
    shutil.copytree(SRC, home)
    shutil.copytree(PLUGIN_SRC, os.path.join(home, ".claude", *PLUGIN_DEST))
    # The setup fixture ships its own transcripts; the demo uses only its own so the numbers read cleanly.
    shutil.rmtree(os.path.join(home, ".claude", "projects"), ignore_errors=True)

    rng = random.Random(20261108)
    now = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0)
    n_sess = 0
    for back in range(0, 91):
        day = now - datetime.timedelta(days=back)
        weekend = day.astimezone().weekday() >= 5
        streak_zone = back <= 11  # an unbroken run of active days ending today
        if not streak_zone:
            if rng.random() < (0.62 if weekend else 0.14):
                continue
        count = 1 if weekend else rng.choice([1, 2, 2, 3])
        if back == 0:
            count = 2
        for s in range(count):
            n_sess += 1
            sid = f"{n_sess:08x}-demo-4000-8000-{n_sess:012x}"
            proj = pick(rng, PROJECTS)
            cwd = f"/demo/{proj}"
            model = pick(rng, MODELS)
            # Work hours, local-ish: spread over the day but never in the future.
            start = day.replace(hour=rng.randint(8, 20), minute=rng.randint(0, 59), second=0)
            if start > now - datetime.timedelta(minutes=30):
                start = now - datetime.timedelta(minutes=rng.randint(30, 200))
            title = rng.choice(TITLES)
            big = rng.random() < 0.3
            n_msgs = rng.randint(6, 26)
            lines = [{"type": "custom-title", "customTitle": title, "sessionId": sid}]
            lines.append({
                "type": "user", "uuid": f"uu-{sid[:8]}", "sessionId": sid, "timestamp": stamp(start), "cwd": cwd,
                "isSidechain": False, "version": "2.1.296", "message": {"role": "user", "content": title},
            })
            t = start
            for i in range(n_msgs):
                t = t + datetime.timedelta(minutes=rng.randint(1, 9), seconds=rng.randint(0, 50))
                lines.append(msg(sid, i, t, model if rng.random() < 0.85 else "claude-haiku-5-5", cwd, rng, big))
            pdir = os.path.join(home, ".claude", "projects", "-demo-" + proj)
            write(os.path.join(pdir, sid + ".jsonl"), lines)

            # Some sessions hand work to helpers; now and then one helper hands to another.
            if rng.random() < 0.38 or back in (0, 1):
                kinds = rng.randint(2, 4) if back in (0, 1) else rng.randint(1, 3)
                ids = []
                for h in range(kinds):
                    aid = f"h{n_sess}x{h}"
                    ids.append(aid)
                    agent_type, desc = rng.choice(HELPERS)
                    meta = {"agentType": agent_type, "description": desc, "toolUseId": f"toolu_{aid}", "spawnDepth": 1}
                    nested = h == kinds - 1 and kinds >= 3
                    if nested:
                        meta["spawnDepth"] = 2
                        meta["parentAgentId"] = ids[0]
                    hm = model if rng.random() < 0.5 else "claude-haiku-5-5"
                    ht = start + datetime.timedelta(minutes=rng.randint(2, 12))
                    hl = []
                    for j in range(rng.randint(3, 12)):
                        ht = ht + datetime.timedelta(seconds=rng.randint(20, 160))
                        hl.append(msg(sid, 100 * (h + 1) + j, ht, hm, cwd, rng, big, side=True, agent=aid))
                    base = os.path.join(pdir, sid, "subagents", f"agent-{aid}")
                    write(base + ".jsonl", hl)
                    with open(base + ".meta.json", "w", encoding="utf-8", newline="\n") as f:
                        json.dump(meta, f, separators=(",", ":"))
    print(f"demo folder: {os.path.join(home, '.claude')}  ({n_sess} sessions)")


if __name__ == "__main__":
    main()
