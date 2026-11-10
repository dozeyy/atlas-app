#!/usr/bin/env python3
"""Regenerate fixtures/ (fake Claude config folders used by tests and manual runs).

Shapes come from docs/phase0-recon.md (real Claude Code 2.1.x on disk). Nothing
here is copied from a real machine: every message text is a "[fixture ...]"
placeholder, every secret is an obvious placeholder, every id is made up.

    python tools/make-fixtures.py

Writes bytes exactly (CRLF and BOM where the edge fixture needs them);
.gitattributes marks fixtures/** as `-text` so git never converts them.
"""
import json
import os
import shutil
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "fixtures")


def put(base, rel, data, newline="\n", bom=False):
    """Write text with the given newline style, or raw bytes."""
    path = os.path.join(base, *rel.split("/"))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if isinstance(data, bytes):
        raw = data
    else:
        raw = data.replace("\r\n", "\n").replace("\n", newline).encode("utf-8")
        if bom:
            raw = b"\xef\xbb\xbf" + raw
    with open(path, "wb") as f:
        f.write(raw)


def jl(*objs):
    return "".join(json.dumps(o, separators=(",", ":")) + "\n" for o in objs)


def assistant(sid, uuid, parent, ts, msg_id, req_id, model, usage, cwd, **extra):
    line = {
        "type": "assistant",
        "uuid": uuid,
        "parentUuid": parent,
        "sessionId": sid,
        "timestamp": ts,
        "cwd": cwd,
        "isSidechain": False,
        "version": "2.1.296",
        "gitBranch": "main",
        "requestId": req_id,
        "message": {
            "id": msg_id,
            "type": "message",
            "role": "assistant",
            "model": model,
            "content": [{"type": "text", "text": "[fixture assistant text]"}],
            "usage": usage,
        },
    }
    line.update(extra)
    return line


def usage(i, o, cw=0, cr=0, w5=None, w1=None):
    u = {
        "input_tokens": i,
        "output_tokens": o,
        "cache_creation_input_tokens": cw,
        "cache_read_input_tokens": cr,
        "cache_creation": {
            "ephemeral_5m_input_tokens": cw if w5 is None else w5,
            "ephemeral_1h_input_tokens": 0 if w1 is None else w1,
        },
        "server_tool_use": {"web_search_requests": 0, "web_fetch_requests": 0},
        "service_tier": "standard",
        "speed": "standard",
        "inference_geo": "global",
    }
    return u


def user(sid, uuid, parent, ts, cwd, text="[fixture user message]"):
    return {
        "type": "user",
        "uuid": uuid,
        "parentUuid": parent,
        "sessionId": sid,
        "timestamp": ts,
        "cwd": cwd,
        "isSidechain": False,
        "version": "2.1.296",
        "message": {"role": "user", "content": text},
    }


def basic():
    b = os.path.join(ROOT, "claude-basic")
    S1 = "11111111-aaaa-4aaa-8aaa-000000000001"
    S2 = "22222222-bbbb-4bbb-8bbb-000000000002"
    S3 = "33333333-cccc-4ccc-8ccc-000000000003"
    APP, OTHER = "/fixture/app", "/fixture/other"

    put(b, ".claude.json", json.dumps({
        "numStartups": 3,
        "installMethod": "fixture",
        "userID": "fixture-user-0000",
        "oauthAccount": {"emailAddress": "fixture@example.invalid", "organizationName": "Fixture Org"},
        "mcpServers": {
            "fixture-notes": {"type": "stdio", "command": "node", "args": ["notes-server.js"], "env": {"NOTES_DIR": "/fixture/notes"}}
        },
        "projects": {
            APP: {
                "allowedTools": [], "mcpContextUris": [],
                "enabledMcpjsonServers": [], "disabledMcpjsonServers": ["fixture-extra"],
                "hasTrustDialogAccepted": True,
                "mcpServers": {"fixture-local": {"type": "stdio", "command": "echo", "args": ["hi"], "env": {}}},
                "disabledMcpServers": ["fixture-notes"],
                "lastCost": 0.12,
                "lastModelUsage": {"claude-sonnet-5-5": {"costUSD": 0.12}},
            },
            "/fixture/gone": {"allowedTools": [], "mcpServers": {}, "hasTrustDialogAccepted": False},
        },
        "skillUsage": {"commit-helper": {"usageCount": 4, "lastUsedAt": 1762560000000}},
        "pluginUsage": {},
    }, indent=2) + "\n")
    put(b, ".credentials.json", json.dumps({
        "claudeAiOauth": {"accessToken": "FIXTURE-PLACEHOLDER-NOT-A-TOKEN", "refreshToken": "FIXTURE-PLACEHOLDER-NOT-A-TOKEN"}
    }) + "\n")

    put(b, "CLAUDE.md", "# Fixture instructions\n\nPrefer small, reviewed changes.\n")
    put(b, "settings.json", json.dumps({
        "model": "claude-sonnet-5-5",
        "outputStyle": "terse",
        "env": {"FIXTURE_FLAG": "1"},
        "permissions": {"defaultMode": "default", "allow": ["Bash(git status)", "Read(./**)"], "deny": ["Read(./.env)"]},
        "hooks": {
            "PostToolUse": [{"matcher": "Edit|Write", "hooks": [{"type": "command", "command": "bash ~/.claude/hooks/format.sh"}]}]
        },
        "enabledPlugins": {"fixture-plugin@fixture-market": True},
    }, indent=2) + "\n")
    put(b, "settings.local.json", json.dumps({"permissions": {"allow": ["Bash(npm test)"]}}, indent=2) + "\n")

    put(b, "agents/code-reviewer.md",
        "---\nname: code-reviewer\ndescription: Reviews a diff for bugs. Read-only.\ntools: Read, Grep, Glob\nmodel: sonnet\n---\n\nYou review diffs. [fixture agent body]\n")
    put(b, "skills/commit-helper/SKILL.md",
        "---\nname: commit-helper\ndescription: Writes a clear commit message from the staged diff.\n---\n\n# Commit helper\n\n[fixture skill body]\n")
    put(b, "skills/commit-helper/references/style.md", "# Style\n\n[fixture reference file]\n")
    put(b, "commands/standup.md", "---\ndescription: Summarize yesterday's work\n---\n\nSummarize. [fixture command body]\n")
    put(b, "output-styles/terse.md", "---\nname: terse\ndescription: Short answers\n---\n\nBe brief.\n")
    put(b, "rules/testing.md", "---\npaths:\n  - \"**/*.test.ts\"\n---\n\nRun tests before committing.\n")
    put(b, "hooks/format.sh", "#!/usr/bin/env bash\n# fixture hook script\nexit 0\n")
    put(b, "plugins/installed_plugins.json", json.dumps({
        "version": 2,
        "plugins": {"fixture-plugin@fixture-market": [{"scope": "user", "installPath": "plugins/cache/fixture-plugin", "version": "1.0.0"}]},
    }, indent=2) + "\n")

    # Things Atlas must never copy or show (sandbox tests assert this).
    put(b, "history.jsonl", jl({"display": "[fixture prompt history]", "timestamp": 1762560000000}))
    put(b, "sessions/fixture-session.key", "FIXTURE-PLACEHOLDER-NOT-A-KEY\n")
    put(b, "backups/.claude.json.backup.1762560000000", "{}\n")
    put(b, "cache/cache.bin", b"\x00\x01\x02\x03")
    put(b, "daemon.lock", "1\n")

    # --- transcripts -------------------------------------------------------
    app = "projects/-fixture-app"
    # Session 1: duplicates (same message.id + requestId; only output_tokens
    # grows, the LAST line holds the max), a synthetic line, an api-request
    # blob, cost-state, a skill attribution, and a half-written last line.
    s1 = [
        {"type": "custom-title", "customTitle": "Fixture session one", "sessionId": S1},
        user(S1, "u-1", None, "2026-11-02T09:00:00.000Z", APP),
        {"type": "api-request", "sessionId": S1, "timestamp": "2026-11-02T09:00:00.500Z", "body": "[fixture api request omitted]"},
        assistant(S1, "a-1", "u-1", "2026-11-02T09:00:01.000Z", "msg_A", "req_A", "claude-sonnet-5-5", usage(100, 5, 2000, 0), APP),
        assistant(S1, "a-1", "u-1", "2026-11-02T09:00:02.000Z", "msg_A", "req_A", "claude-sonnet-5-5", usage(100, 40, 2000, 0), APP),
        assistant(S1, "a-1", "u-1", "2026-11-02T09:00:03.000Z", "msg_A", "req_A", "claude-sonnet-5-5", usage(100, 120, 2000, 0), APP),
        user(S1, "u-2", "a-1", "2026-11-02T09:01:00.000Z", APP),
        assistant(S1, "a-2", "u-2", "2026-11-02T09:01:05.000Z", "msg_B", "req_B", "claude-haiku-5-5", usage(30, 12, 0, 2000), APP),
        assistant(S1, "a-3", "a-2", "2026-11-02T09:01:09.000Z", "msg_S", "req_S", "<synthetic>", usage(0, 0), APP),
        assistant(S1, "a-4", "u-2", "2026-11-02T09:02:00.000Z", "msg_C", "req_C", "claude-opus-5-5", usage(500, 300, 0, 4000), APP, attributionSkill="commit-helper"),
        {"type": "cost-state", "sessionId": S1, "totalCostUSD": 0.12, "modelUsage": {"claude-sonnet-5-5": {"costUSD": 0.12}}},
    ]
    put(b, f"{app}/{S1}.jsonl", jl(*s1) + '{"type":"assistant","message":{"id":"msg_HALF","usage":{"input_tokens":')
    # Subagent transcript of session 1 (80 % of real files look like this).
    sub = [
        assistant(S1, "sa-1", None, "2026-11-02T09:00:30.000Z", "msg_SA1", "req_SA1", "claude-haiku-5-5", usage(50, 3, 0, 0), APP, isSidechain=True, agentId="fixture1"),
        assistant(S1, "sa-1", None, "2026-11-02T09:00:31.000Z", "msg_SA1", "req_SA1", "claude-haiku-5-5", usage(50, 77, 0, 0), APP, isSidechain=True, agentId="fixture1"),
    ]
    put(b, f"{app}/{S1}/subagents/agent-fixture1.jsonl", jl(*sub))
    put(b, f"{app}/{S1}/tool-results/result-1.txt", "[fixture tool result]\n")

    s2 = [
        {"type": "agent-name", "agentName": "fixture-agent", "sessionId": S2},
        user(S2, "u-1", None, "2026-11-03T22:30:00.000Z", APP),
        assistant(S2, "a-1", "u-1", "2026-11-03T22:30:04.000Z", "msg_D", "req_D", "claude-fable-5", usage(10, 20, 0, 0), APP),
    ]
    put(b, f"{app}/{S2}.jsonl", jl(*s2))

    s3 = [
        user(S3, "u-1", None, "2026-11-04T07:15:00.000Z", OTHER),
        assistant(S3, "a-1", "u-1", "2026-11-04T07:15:02.000Z", "msg_E", "req_E", "claude-opus-4-8", usage(7, 9, 0, 0), OTHER),
    ]
    put(b, f"projects/-fixture-other/{S3}.jsonl", jl(*s3))


def edge():
    e = os.path.join(ROOT, "claude-edge")
    # BOM + CRLF + 4-space indent + unknown keys + unusual key order.
    put(e, "settings.json",
        '{\n    "zzz-last-alphabetically": true,\n    "model": "claude-sonnet-5-5",\n    "futureSetting": {"nested": [1, 2, 3]}\n}\n',
        newline="\r\n", bom=True)
    put(e, "agents/lane-agent.md",
        "---\nname: lane-agent\ndescription: Has a custom key Atlas must keep.\nlane: implementation\nmodel: sonnet\n---\n\nBody. [fixture]\n",
        newline="\r\n")
    put(e, "agents/lane-agent.md.bak-20261001", "---\nname: old\n---\n", newline="\r\n")
    put(e, "skills/crlf-skill/SKILL.md", "---\nname: crlf-skill\ndescription: Windows line endings.\n---\n\n# CRLF skill\n", newline="\r\n")
    put(e, "CLAUDE.md", "# No trailing newline here")  # exact bytes: no final \n
    put(e, "commands/nested/deploy/prod.md", "---\ndescription: Nested command\n---\n\nShip. [fixture]\n")
    put(e, "unknown-dir/notes.txt", "A file Atlas does not understand: read-only until the user edits it.\n")
    put(e, "café ☃/readme.txt", "Unicode folder name.\n")
    put(e, "empty-dir/.gitkeep", "")
    # Transcripts that are nothing but trouble: all garbage, and an empty file.
    put(e, "projects/-edge/garbage.jsonl", "not json at all\n{\"type\":\n\u0000\u0000\n[1,2,3]\n\"just a string\"\n")
    put(e, "projects/-edge/empty.jsonl", b"")
    put(e, ".claude.json", '{\n    "mcpServers": {},\n    "projects": {}\n}\n', newline="\r\n")


def habits():
    """fixtures/claude-habits: real-looking typed requests for repeated-request grouping.

    The one fixture whose message text is NOT a "[fixture ...]" placeholder: grouping needs
    wording that reads like a person typed it. Every user and assistant text line carries
    `"fixtureText": true` so nothing here can be mistaken for a real chat. The one secret is
    an obvious placeholder. Dates are fixed (tests pass their own clock or shift them).
    """
    h = os.path.join(ROOT, "claude-habits")
    put(h, "settings.json", "{}\n")
    notes_cwd, site_cwd = "C:\\fx\\notes", "C:\\fx\\site"
    files = {}  # relative path -> [(ts, line dict)]

    def ts(day, hh, mm):
        return f"2026-10-{day:02d}T{hh:02d}:{mm:02d}:00.000Z"

    def line(path, sid, cwd, when, text, kind="user", **extra):
        n = len(files.setdefault(path, [])) + 1
        o = {"type": kind, "uuid": f"{sid}-{os.path.basename(path)[:6]}-{n}", "sessionId": sid, "timestamp": when,
             "cwd": cwd, "isSidechain": False, "version": "2.1.296", "fixtureText": True}
        if kind == "user":
            o["message"] = {"role": "user", "content": text}
        else:
            o["message"] = {"role": "assistant", "content": [{"type": "text", "text": text}]}
        o.update(extra)
        files[path].append((when, o))

    sessions = {"habit-s1": "notes", "habit-s2": "site", "habit-s3": "notes", "habit-s4": "site", "habit-s5": "notes"}
    day_of = {"habit-s1": 26, "habit-s2": 28, "habit-s3": 28, "habit-s4": 30, "habit-s5": 30}

    def user_at(sid, when, text, **extra):
        project = sessions[sid]
        line(f"projects/-fx-{project}/{sid}.jsonl", sid, notes_cwd if project == "notes" else site_cwd, when, text, **extra)

    # The planted request: 7 wordings, 4 chats, 3 days.
    human = {"origin": {"kind": "human"}}
    planted = [
        ("habit-s1", 26, 12, 0, "Read the README and give me a three bullet summary in plain words", human),
        ("habit-s1", 26, 12, 20, "can you read the readme and give me a 3 bullet summary in plain words please", human),
        ("habit-s2", 28, 12, 5, "Read the README and give me a three bullet summary in plain words, no jargon", human),
        ("habit-s3", 28, 13, 0, "Read the README again and give me a three bullet summary in plain words", {}),
        ("habit-s3", 28, 13, 10, "read the README and give me a 3 bullet summary in plain words", {}),
        ("habit-s4", 30, 12, 30, "Please read the README.md and give me a three bullet summary in plain words", {}),
        ("habit-s4", 30, 12, 45, "hey claude, read the readme and give me a three bullet summary in plain words like last time", {}),
    ]
    for sid, day, hh, mm, text, extra in planted:
        user_at(sid, ts(day, hh, mm), text, **extra)
        user_at(sid, ts(day, hh, mm + 1), "assistant-only zebra: here are the three bullets.", kind="assistant")

    # Not a group: the same request 20 times in ONE chat.
    for i in range(20):
        user_at("habit-s5", ts(30, 14, i), "run the linter and fix everything it complains about", **human)

    # Not a group: a helper's prompt 20 times (a helper file in each of 4 chats, 3 days).
    for sid in ("habit-s1", "habit-s2", "habit-s3", "habit-s4"):
        project = sessions[sid]
        cwd = notes_cwd if project == "notes" else site_cwd
        path = f"projects/-fx-{project}/{sid}/subagents/agent-a{sid[-1]}.jsonl"
        for i in range(5):
            line(path, sid, cwd, ts(day_of[sid], 15, i), "Search every file for the deprecated fetchLegacy helper and list each file and line",
                 agentId=f"a{sid[-1]}", isSidechain=True)

    spread = ["habit-s1", "habit-s2", "habit-s3", "habit-s4"]

    def spread_over(n, text, hh, **extra):
        for i in range(n):
            sid = spread[i % 4]
            user_at(sid, ts(day_of[sid], hh, i // 4 + 2), text, **extra)

    # Not a group: task notifications 30 times (plain text; only the origin marker says machine).
    spread_over(30, "Background task finished: the nightly export completed with exit code 0", 16, origin={"kind": "task-notification"})
    # Not a group: a slash command 10 times.
    spread_over(10, "/review-changes please check the diff for the login page", 17, **human)
    # Not a group: a pasted log 6 times (3 chats, 3 days).
    log = "\n".join(["Traceback (most recent call last):", '  File "export.py", line 88, in run', "    rows = load(path)",
                     '  File "export.py", line 31, in load', "    return json.loads(text)", "ValueError: Expecting value: line 1 column 1"])
    for i, sid in enumerate(["habit-s1", "habit-s2", "habit-s4"] * 2):
        user_at(sid, ts(day_of[sid], 18, i), log, **human)
    # Not a group: a 2-word prompt 15 times.
    spread_over(15, "continue please", 19, **human)
    # Not a group: a prompt with a (placeholder) secret 6 times.
    spread_over(6, "deploy to staging with the key xoxb-1234567890-FIXTUREFIXTUREFIXTURE please", 20, **human)
    # Machine prompts that would be a group if they counted: headless runs, scheduled prompts.
    spread_over(10, "generate the weekly report from the usage cache and save it", 21, entrypoint="sdk-cli")
    spread_over(6, "Check the build status and report anything that is failing", 22, promptSource="system")
    spread_over(3, "Peer asks: please share the latest design notes for the sidebar", 23, origin={"kind": "peer"})
    spread_over(2, "This session is being continued from a previous conversation that ran out of context", 23, isCompactSummary=True)

    # One-offs: nothing here repeats.
    once = [
        ("habit-s1", 26, "why does the sidebar flicker when I resize the window"),
        ("habit-s1", 26, "add a dark mode toggle to the settings page"),
        ("habit-s2", 28, "rename the export button to Save as image everywhere"),
        ("habit-s2", 28, "what is the difference between the cache and the index in this project"),
        ("habit-s3", 28, "write a changelog entry for the new tour screens"),
        ("habit-s3", 28, "the tooltip on the heat grid is cut off at the right edge, can you fix that"),
        ("habit-s4", 30, "check why the build is slower today than yesterday"),
        ("habit-s4", 30, "make the empty state on the history page friendlier"),
        ("habit-s5", 30, "list the TODO comments in the usage module"),
        ("habit-s5", 30, "explain how the settings file is saved without losing data"),
    ]
    for i, (sid, day, text) in enumerate(once):
        user_at(sid, ts(day, 23, 10 + i), text, **(human if i % 2 else {}))

    for rel, items in files.items():
        items.sort(key=lambda x: x[0])
        put(h, rel, jl(*[o for _, o in items]))


def usage_fx():
    """fixtures/claude-usage: the pricing, dedup and attribution edge cases (Phase 2)."""
    u = os.path.join(ROOT, "claude-usage")
    P = "projects"

    def uid(n):
        return f"{n:08d}-dddd-4ddd-8ddd-{n:012d}"

    def line(sid, n, ts, mid, model, usg, cwd, **extra):
        return assistant(sid, f"a-{n}", f"u-{n}", ts, mid, "req_" + mid[4:], model, usg, cwd, **extra)

    # Unknown models: a made-up id, and a date-suffixed id with no alias; one priced model beside them.
    s = uid(1)
    cwd = "/fixture/nova"
    put(u, f"{P}/-fx-nova/{s}.jsonl", jl(
        line(s, 1, "2026-11-03T10:00:00.000Z", "msg_N1", "claude-nova-9", usage(1000, 500), cwd),
        line(s, 2, "2026-11-03T10:01:00.000Z", "msg_N2", "claude-opus-5-5-20261001", usage(10, 20), cwd),
        line(s, 3, "2026-11-03T10:02:00.000Z", "msg_N3", "claude-sonnet-5-5", usage(1000, 1000), cwd),
    ))

    # Modifiers: fast mode, US-only inference, web tools, a service tier we cannot price.
    s = uid(2)
    cwd = "/fixture/mods"
    fast = usage(1000, 1000)
    fast["speed"] = "fast"
    geo = usage(1000, 1000)
    geo["inference_geo"] = "us"
    web = usage(1000, 1000)
    web["server_tool_use"] = {"web_search_requests": 3, "web_fetch_requests": 2}
    pri = usage(100, 100)
    pri["service_tier"] = "priority"
    put(u, f"{P}/-fx-mods/{s}.jsonl", jl(
        line(s, 1, "2026-11-03T11:00:00.000Z", "msg_FAST", "claude-opus-5-5", fast, cwd),
        line(s, 2, "2026-11-03T11:01:00.000Z", "msg_GEO", "claude-opus-5-5", geo, cwd),
        line(s, 3, "2026-11-03T11:02:00.000Z", "msg_WEB", "claude-opus-5-5", web, cwd),
        line(s, 4, "2026-11-03T11:03:00.000Z", "msg_PRI", "claude-opus-5-5", pri, cwd),
    ))

    # Haiku 5.5 long-context tier: above and exactly at 100,000 prompt tokens.
    s = uid(3)
    cwd = "/fixture/haiku"
    put(u, f"{P}/-fx-haiku/{s}.jsonl", jl(
        line(s, 1, "2026-11-03T12:00:00.000Z", "msg_HLONG", "claude-haiku-5-5", usage(90000, 1000, 0, 20000), cwd),
        line(s, 2, "2026-11-03T12:01:00.000Z", "msg_HEDGE", "claude-haiku-5-5", usage(80000, 1000, 0, 20000), cwd),
    ))

    # Cache writes: a 1h write, no breakdown at all, a breakdown that does not sum.
    s = uid(4)
    cwd = "/fixture/cache"
    one_h = usage(10, 10, 1000, 0, w5=0, w1=1000)
    nosplit = usage(10, 10, 500, 0)
    del nosplit["cache_creation"]
    mism = usage(10, 10, 1000, 0, w5=300, w1=200)
    put(u, f"{P}/-fx-cache/{s}.jsonl", jl(
        line(s, 1, "2026-11-03T13:00:00.000Z", "msg_1H", "claude-sonnet-5-5", one_h, cwd),
        line(s, 2, "2026-11-03T13:01:00.000Z", "msg_NOSPLIT", "claude-sonnet-5-5", nosplit, cwd),
        line(s, 3, "2026-11-03T13:02:00.000Z", "msg_MISMATCH", "claude-sonnet-5-5", mism, cwd),
    ))

    # The same key in two files, different output counts (order must not matter).
    s = uid(5)
    cwd = "/fixture/dup"
    put(u, f"{P}/-fx-dup/dup-low.jsonl", jl(
        line(s, 1, "2026-11-03T14:00:00.000Z", "msg_DUP", "claude-sonnet-5-5", usage(100, 10), cwd)))
    put(u, f"{P}/-fx-dup/dup-high.jsonl", jl(
        line(s, 1, "2026-11-03T14:00:00.000Z", "msg_DUP", "claude-sonnet-5-5", usage(100, 30), cwd)))

    # Project from cwd, moved by a relocated line; Windows paths that differ only by case.
    s = uid(6)
    put(u, f"{P}/-fx-reloc/{s}.jsonl", jl(
        line(s, 1, "2026-11-03T15:00:00.000Z", "msg_R1", "claude-sonnet-5-5", usage(10, 10), "/fixture/before"),
        {"type": "relocated", "sessionId": s, "relocatedCwd": "/fixture/after"},
        line(s, 2, "2026-11-03T15:01:00.000Z", "msg_R2", "claude-sonnet-5-5", usage(10, 10), "/fixture/before"),
    ))
    w1, w2 = uid(7), uid(8)
    put(u, f"{P}/-fx-win-a/{w1}.jsonl", jl(
        line(w1, 1, "2026-11-03T15:10:00.000Z", "msg_W1", "claude-sonnet-5-5", usage(10, 10), "C:\\X\\Proj")))
    put(u, f"{P}/-fx-win-b/{w2}.jsonl", jl(
        line(w2, 1, "2026-11-03T15:11:00.000Z", "msg_W2", "claude-sonnet-5-5", usage(10, 10), "c:\\x\\proj")))

    # Titles: custom beats agent name; agent name alone; neither.
    t1, t2, t3 = uid(9), uid(10), uid(11)
    put(u, f"{P}/-fx-titles/{t1}.jsonl", jl(
        {"type": "agent-name", "agentName": "Agent name one", "sessionId": t1},
        {"type": "custom-title", "customTitle": "Custom title one", "sessionId": t1},
        line(t1, 1, "2026-11-03T16:00:00.000Z", "msg_T1", "claude-sonnet-5-5", usage(10, 10), "/fixture/titles"),
        {"type": "cost-state", "sessionId": t1, "totalCostUSD": 0.5},
    ))
    put(u, f"{P}/-fx-titles/{t2}.jsonl", jl(
        {"type": "agent-name", "agentName": "Agent name two", "sessionId": t2},
        line(t2, 1, "2026-11-03T16:10:00.000Z", "msg_T2", "claude-sonnet-5-5", usage(10, 10), "/fixture/titles"),
    ))
    put(u, f"{P}/-fx-titles/{t3}.jsonl", jl(
        line(t3, 1, "2026-11-03T16:20:00.000Z", "msg_T3", "claude-sonnet-5-5", usage(10, 10), "/fixture/titles"),
    ))

    # An API error with zero usage; local-midnight neighbours (UTC-7: 06:59:59Z is 23:59:59 the day before).
    s = uid(12)
    cwd = "/fixture/midnight"
    err = line(s, 1, "2026-11-04T05:00:00.000Z", "msg_ERR", "claude-sonnet-5-5", usage(0, 0), cwd)
    err["isApiErrorMessage"] = True
    put(u, f"{P}/-fx-midnight/{s}.jsonl", jl(
        err,
        line(s, 2, "2026-11-04T06:59:59.000Z", "msg_M1", "claude-sonnet-5-5", usage(100, 100), cwd),
        line(s, 3, "2026-11-04T07:00:00.000Z", "msg_M2", "claude-sonnet-5-5", usage(200, 200), cwd),
    ))

    # CRLF file, BOM file, and a subagent whose lines have no sessionId.
    s, b = uid(13), uid(14)
    put(u, f"{P}/-fx-crlf/{s}.jsonl", jl(
        line(s, 1, "2026-11-05T09:00:00.000Z", "msg_CRLF", "claude-sonnet-5-5", usage(10, 10), "/fixture/crlf")),
        newline="\r\n")
    put(u, f"{P}/-fx-bom/{b}.jsonl", jl(
        line(b, 1, "2026-11-05T09:10:00.000Z", "msg_BOM", "claude-sonnet-5-5", usage(10, 10), "/fixture/bom")),
        bom=True)
    sa = uid(15)
    sub = line(sa, 1, "2026-11-05T09:20:30.000Z", "msg_SUB", "claude-sonnet-5-5", usage(10, 10), "/fixture/sub")
    del sub["sessionId"]
    sub["isSidechain"] = True
    sub["agentId"] = "fixturesub"
    put(u, f"{P}/-fx-sub/{sa}.jsonl", jl(
        line(sa, 2, "2026-11-05T09:20:00.000Z", "msg_PARENT", "claude-sonnet-5-5", usage(10, 10), "/fixture/sub")))
    put(u, f"{P}/-fx-sub/{sa}/subagents/agent-fixturesub.jsonl", jl(sub))


def accuracy_fx():
    """fixtures/claude-accuracy: the shapes the recount found on a real machine (2026-11-09).

    Streamed copies of one reply (output grows), a reply Claude Code rewrote later in the
    same file with zeroed top-level counts (its cache_creation breakdown is still filled in),
    reasoning effort as `perTurnEffort` (2.1.3xx), as `effort` only (older lines) and absent,
    a helper on a sidechain, and model ids that are new (Fable 5.2, Mythos 5.2) or unknown.

    Expected (tools/recount.py agrees): 7 replies; input 220, output 570, 5m writes 1000,
    cache reads 13000. Main thread effort: high 2, low 1, medium 1, xhigh 1; the helper: max 1.
    """
    a = os.path.join(ROOT, "claude-accuracy")
    s = "acc00001-eeee-4eee-8eee-000000000001"
    cwd = "/fixture/accuracy"
    P = f"projects/-fixture-accuracy"

    def line(n, ts, mid, model, usg, **extra):
        return assistant(s, f"acc-a-{n}", f"acc-u-{n}", ts, mid, "req_" + mid[4:], model, usg, cwd, **extra)

    def eff(per_turn=None, plain=None):
        e = {"version": "2.1.321"}
        if per_turn is not None:
            e["perTurnEffort"] = per_turn
        if plain is not None:
            e["effort"] = plain
        return e

    replay = usage(0, 0, 0, 0, w5=1000, w1=0)  # zeroed counts, breakdown left behind
    put(a, f"{P}/{s}.jsonl", jl(
        {"type": "custom-title", "customTitle": "Accuracy fixture", "sessionId": s},
        user(s, "acc-u-1", None, "2026-11-06T10:00:00.000Z", cwd),
        # Three streamed copies of one reply: only the last (fullest) one counts.
        line(1, "2026-11-06T10:00:01.000Z", "msg_ST", "claude-fable-5-2", usage(100, 5, 1000, 5000), **eff("high", "high")),
        line(2, "2026-11-06T10:00:02.000Z", "msg_ST", "claude-fable-5-2", usage(100, 40, 1000, 5000), **eff("high", "high")),
        line(3, "2026-11-06T10:00:03.000Z", "msg_ST", "claude-fable-5-2", usage(100, 120, 1000, 5000), **eff("high", "high")),
        line(4, "2026-11-06T10:01:00.000Z", "msg_ST2", "claude-fable-5-2", usage(10, 20), **eff("high", "high")),
        # Older line shape: `effort` only.
        line(5, "2026-11-06T10:02:00.000Z", "msg_Z", "claude-opus-5-5", usage(50, 300, 0, 8000), effort="xhigh"),
        line(6, "2026-11-06T10:03:00.000Z", "msg_NOEFF", "claude-sonnet-5-5", usage(10, 20)),
        line(7, "2026-11-06T10:04:00.000Z", "msg_MY", "claude-mythos-5-2", usage(10, 20), **eff("medium")),
        line(8, "2026-11-06T10:05:00.000Z", "msg_NV", "claude-nova-9-1", usage(10, 20), **eff("low")),
        # The rewrite of msg_Z, much later in the same file, with zeroed counts.
        line(9, "2026-11-06T10:30:00.000Z", "msg_Z", "claude-opus-5-5", replay, effort="xhigh"),
    ))
    sub = []
    for n, o in ((1, 7), (2, 70)):
        x = line(20 + n, f"2026-11-06T10:02:3{n}.000Z", "msg_SUBA", "claude-haiku-5-5", usage(30, o), **eff("max", "high"))
        x["isSidechain"] = True
        x["agentId"] = "accsub"
        sub.append(x)
    put(a, f"{P}/{s}/subagents/agent-accsub.jsonl", jl(*sub))
    put(a, f"{P}/{s}/subagents/agent-accsub.meta.json",
        json.dumps({"agentType": "Explore", "description": "Accuracy helper"}))


def md(front, body="[fixture body]\n"):
    """A markdown file: `front` is a dict (written as simple YAML), a raw string, or None."""
    if front is None:
        return body
    if isinstance(front, str):
        return f"---\n{front}---\n\n{body}"
    lines = "".join(f"{k}: {v}\n" for k, v in front.items())
    return f"---\n{lines}---\n\n{body}"


def setup():
    """fixtures/claude-setup: a whole fake machine for Setup (Phase 3).

    `@ROOT@` stands for the folder the tests copy this tree into; they replace it
    (JSON-escaped inside .json/.jsonl) before discovery. Every secret-looking
    value is FIXTURE-PLACEHOLDER. Shapes marked "assumed" are not seen on a real
    disk yet (keybindings, themes, workflows, agent-memory, managed files).
    """
    s = os.path.join(ROOT, "claude-setup")
    R = "@ROOT@"
    H = "home/.claude"
    P = "[fixture]"

    def js(o):
        return json.dumps(o, indent=2) + "\n"

    # ---- ~/.claude.json (beside the config folder) ------------------------
    put(s, "home/.claude.json", js({
        "numStartups": 5,
        "mcpServers": {
            "user-srv": {"type": "stdio", "command": "node", "args": ["user-srv.js", "--token=FIXTURE-PLACEHOLDER"],
                         "env": {"SECRET_TOKEN": "FIXTURE-PLACEHOLDER"}},
            "shared-srv": {"command": "node", "args": ["user-shared.js"]},
            "http-srv": {"type": "http", "url": "https://example.test/mcp",
                         "headers": {"Authorization": "Bearer FIXTURE-PLACEHOLDER"}},
        },
        "githubRepoPaths": {"fixture/github-only": [f"{R}/work/github-only"]},
        "projects": {
            f"{R}/home": {"mcpServers": {}},
            f"{R}/work/app": {
                "mcpServers": {
                    "shared-srv": {"command": "node", "args": ["local-shared.js"]},
                    "local-only": {"type": "http", "url": "https://example.test/local",
                                   "headers": {"X-Api-Key": "FIXTURE-PLACEHOLDER"}},
                },
                "disabledMcpServers": ["user-srv"],
                "enabledMcpjsonServers": ["proj-srv"],
                "disabledMcpjsonServers": ["rejected-srv"],
            },
            # The Windows spelling of the same folder: a second entry with its own server.
            f"{R}\\WORK\\app": {"mcpServers": {"twin-only": {"command": "node", "args": ["twin.js"]}}},
            f"{R}/work/empty-proj": {},
            f"{R}/work/gone": {"mcpServers": {"gone-srv": {"command": "node", "args": ["gone.js"]}}},
            f"{R}/work/dotclaude-only": {},
            f"{R}/work/app/.claude/worktrees/agent-x": {},
        },
    }))
    put(s, "home/CLAUDE.md", f"# Home folder notes\n\n{P}\n")

    # ---- user root --------------------------------------------------------
    put(s, f"{H}/CLAUDE.md", f"# Global instructions\n\n{P}\n")
    put(s, f"{H}/MEMORY.md", f"# Memory\n{P}\n")
    put(s, f"{H}/reference/notes.md", f"# Notes\n{P}\n")
    put(s, f"{H}/policy-limits.json", js({"limit": 1}))
    put(s, f"{H}/mcp-needs-auth-cache.json", js({"claude.ai Fixture Connector": {"timestamp": 1}}))
    put(s, f"{H}/.claude.json", js({"mcpServers": {"decoy-srv": {"command": "node", "args": ["decoy.js"]}}}))

    put(s, f"{H}/skills/shared-skill/SKILL.md", md({"name": "shared-skill", "description": "User copy of a shared skill."}))
    put(s, f"{H}/skills/shared-skill/scripts/run.py", "print('[fixture]')\n")
    put(s, f"{H}/skills/shared-skill/reference.md", f"{P}\n")
    put(s, f"{H}/skills/user-only/SKILL.md", md({"name": "user-only", "description": "Only at user scope."}))
    put(s, f"{H}/skills/no-name-skill/SKILL.md", md({"description": "Takes its folder name."}))
    put(s, f"{H}/skills/broken-yaml/SKILL.md", "---\nname: [unclosed\ndescription: x: y: z\n---\n\n[fixture body]\n")
    put(s, f"{H}/skills/same-as-skill/SKILL.md", md({"name": "same-as-skill", "description": "A skill with a command of the same name."}))
    put(s, f"{H}/skills/crlf-skill/SKILL.md", md({"name": "crlf-skill", "description": "Twin skill."}), newline="\r\n", bom=True)
    put(s, f"{H}/skills/lf-skill/SKILL.md", md({"name": "lf-skill", "description": "Twin skill."}))
    put(s, f"{H}/skills/synced/fixture-org_fixture-user/manifest.json", js({
        "lastUpdated": "2026-11-01T00:00:00Z",
        "skills": [{"skillId": "skill_fixture", "name": "synced-skill", "description": "A skill synced from the account.",
                    "source": "anthropic", "backingPluginId": None, "updatedAt": "2026-11-01T00:00:00Z"}],
    }))
    put(s, f"{H}/skills/synced/fixture-org_fixture-user/synced-skill/SKILL.md", md({"name": "synced-skill", "description": "Synced."}))
    put(s, f"{H}/skills/synced/.bucket-fixture/ignored/SKILL.md", md({"name": "ignored", "description": "Never listed."}))

    put(s, f"{H}/agents/shared-agent.md", md({"name": "shared-agent", "description": "User copy.", "model": "sonnet"}), newline="\r\n")
    put(s, f"{H}/agents/user-agent.md", md({"name": "user-agent", "description": "Only at user scope.", "lane": "implementation"}))
    put(s, f"{H}/agents/no-name-agent.md", md({"description": "No name key."}))
    put(s, f"{H}/agents/dup-a.md", md({"name": "dup", "description": "First of two with one name."}))
    put(s, f"{H}/agents/dup-b.md", md({"name": "dup", "description": "Second of two with one name."}))
    put(s, f"{H}/agents/user-agent.md.bak-20261001", md({"name": "user-agent", "description": "Old copy."}))

    put(s, f"{H}/commands/shared-cmd.md", md({"description": "User copy of a command."}))
    put(s, f"{H}/commands/same-as-skill.md", md({"description": "Loses to the skill of the same name."}))
    put(s, f"{H}/commands/nested/deploy/prod.md", md({"description": "Nested command."}))

    put(s, f"{H}/hooks/fmt.sh", "#!/bin/sh\n# Formats files. [fixture]\n")
    put(s, f"{H}/hooks/unused.sh", "#!/bin/sh\n# Nothing names this one.\n")
    put(s, f"{H}/statusline.sh", "#!/bin/sh\necho '[fixture]'\n")
    put(s, f"{H}/settings.json", js({
        "outputStyle": "Calm Notes",
        "env": {"SECRET_TOKEN": "FIXTURE-PLACEHOLDER", "PLAIN": "FIXTURE-PLACEHOLDER"},
        "skillOverrides": {"user-only": "user-invocable-only"},
        "enabledPlugins": {"fixture-plugin@fixture-market": True},
        "permissions": {
            "allow": ["Bash(git status:*)", "Read(*)"],
            "deny": ["Bash(rm -rf:*)"],
            "ask": ["WebFetch"],
            "defaultMode": "default",
        },
        "hooks": {
            "PreToolUse": [{"matcher": "Bash", "hooks": [
                {"type": "command", "command": f"\"{R}/home/.claude/hooks/fmt.sh\" --check", "timeout": 10}]}],
            "Stop": [{"hooks": [{"type": "command", "command": "echo done"}]}],
        },
        "statusLine": {"type": "command", "command": f"sh \"{R}/home/.claude/statusline.sh\""},
    }))
    put(s, f"{H}/settings.local.json", js({"permissions": {"allow": ["Bash(ls:*)"]}}))
    put(s, f"{H}/rules/always.md", f"{P} A rule with no frontmatter.\n")
    put(s, f"{H}/rules/ts-only.md", md({"paths": '["**/*.ts"]'}, f"{P} A rule for TypeScript.\n"))
    put(s, f"{H}/output-styles/calm.md", md({"name": "Calm Notes", "description": "Quiet and short."}))
    # Assumed shapes (verify against a real disk):
    put(s, f"{H}/workflows/nightly.js", f"// Nightly run. {P}\nexport default {{}};\n")
    put(s, f"{H}/agent-memory/user-agent/notes.md", f"# Notes\n{P}\n")
    put(s, f"{H}/keybindings.json", js([{"key": "ctrl+k", "command": "fixture.noop"}]))
    put(s, f"{H}/themes/warm.json", js({"name": "Warm Fixture", "colors": {}}))

    # Plugins.
    inst = f"{R}/home/.claude/plugins/cache/fixture-market/fixture-plugin/1.0.0"
    put(s, f"{H}/plugins/installed_plugins.json", js({"version": 2, "plugins": {"fixture-plugin@fixture-market": [
        {"scope": "user", "installPath": inst, "version": "1.0.0", "installedAt": "2026-10-01T00:00:00Z",
         "lastUpdated": "2026-10-01T00:00:00Z", "gitCommitSha": "0000000"}]}}))
    put(s, f"{H}/plugins/known_marketplaces.json", js({"fixture-market": {"source": {"source": "github", "repo": "fixture/market"}}}))
    pc = f"{H}/plugins/cache/fixture-market/fixture-plugin/1.0.0"
    put(s, f"{pc}/.claude-plugin/plugin.json", js({
        "name": "fixture-plugin", "description": "A plugin for tests.", "version": "1.0.0",
        "author": {"name": "Fixture"}, "mcpServers": {"plug-srv": {"command": "node", "args": ["plug.js"]}}}))
    put(s, f"{pc}/skills/plug-skill/SKILL.md", md({"name": "plug-skill", "description": "From the plugin."}))
    put(s, f"{pc}/agents/plug-agent.md", md({"name": "plug-agent", "description": "From the plugin."}))
    put(s, f"{pc}/commands/plug-cmd.md", md({"description": "From the plugin."}))
    put(s, f"{pc}/hooks/hooks.json", js({"hooks": {"SessionStart": [{"hooks": [{"type": "command", "command": "echo plug"}]}]}}))

    # Transcripts: the first line is an api-request with a wrong cwd (must be skipped).
    sid = "00000000-0000-0000-0000-000000000001"
    sid2 = "00000000-0000-0000-0000-000000000002"
    put(s, f"{H}/projects/-encoded-app/{sid}.jsonl", jl(
        {"type": "api-request", "cwd": "/not/this/one"},
        {"type": "user", "cwd": f"{R}/work/app", "message": {"role": "user", "content": "[fixture user message]"}}))
    put(s, f"{H}/projects/-encoded-transcript-only/{sid2}.jsonl", jl(
        {"type": "user", "cwd": f"{R}/work/transcript-only", "message": {"role": "user", "content": "[fixture user message]"}}))
    put(s, f"{H}/projects/-encoded-app/memory/MEMORY.md", f"# App memory\n{P}\n")

    # Never shown.
    put(s, f"{H}/.credentials.json", '{"token": "FIXTURE-PLACEHOLDER"}\n')
    put(s, f"{H}/sessions/x.key", "FIXTURE-PLACEHOLDER\n")
    put(s, f"{H}/history.jsonl", jl({"display": "[fixture]"}))
    put(s, f"{H}/backups/a.json", js({"a": 1}))
    put(s, f"{H}/cache/c.json", js({"c": 1}))
    put(s, f"{H}/daemon.lock", "0\n")

    # ---- projects ---------------------------------------------------------
    A = "work/app"
    put(s, f"{A}/CLAUDE.md", f"# App instructions\n{P}\n")
    put(s, f"{A}/CLAUDE.local.md", f"# Private app notes\n{P}\n")
    put(s, f"{A}/AGENTS.md", f"# Agents file\n{P}\n")
    put(s, f"{A}/.mcp.json", js({"mcpServers": {
        "shared-srv": {"command": "node", "args": ["project-shared.js"]},
        "proj-srv": {"command": "node", "args": ["--url", "${PROJ_URL:-http://localhost:1}"], "env": {"PROJ_TOKEN": "${PROJ_TOKEN}"}},
        "rejected-srv": {"command": "node", "args": ["rejected.js"]},
        "pending-srv": {"command": "node", "args": ["pending.js"]},
    }}))
    put(s, f"{A}/.claude/CLAUDE.md", f"# App dot-claude instructions\n{P}\n")
    put(s, f"{A}/.claude/settings.json", js({"outputStyle": "Proj Style", "permissions": {"deny": ["Bash(curl:*)"]}}))
    put(s, f"{A}/.claude/settings.local.json", js({"permissions": {"allow": ["Bash(npm test)"]}}))
    put(s, f"{A}/.claude/skills/shared-skill/SKILL.md", md({"name": "shared-skill", "description": "Project copy of a shared skill."}))
    put(s, f"{A}/.claude/agents/shared-agent.md", md({"name": "shared-agent", "description": "Project copy."}))
    put(s, f"{A}/.claude/commands/shared-cmd.md", md({"description": "Project copy of a command."}))
    put(s, f"{A}/.claude/rules/r.md", f"{P} A project rule.\n")
    put(s, f"{A}/.claude/output-styles/proj-style.md", md({"name": "Proj Style", "description": "Project style."}))
    put(s, f"{A}/.claude/agent-memory/shared-agent/m.md", f"# Agent memory\n{P}\n")
    put(s, f"{A}/.claude/launch.json", js({"version": "0.0.1", "configurations": []}))
    put(s, f"{A}/.claude/worktrees/agent-x/.claude/skills/wt-skill/SKILL.md", md({"name": "wt-skill", "description": "Inside a worktree."}))
    put(s, "work/dotclaude-only/.claude/CLAUDE.md", f"# Dot-claude only\n{P}\n")
    put(s, "work/transcript-only/.claude/agents/t.md", md({"name": "t", "description": "Project known only from a transcript."}))
    put(s, "work/empty-proj/.gitkeep", "")

    # ---- managed ----------------------------------------------------------
    put(s, "managed/managed-settings.json", js({"disableAllHooks": False, "permissions": {"deny": ["Bash(sudo:*)"]}}))
    put(s, "managed/managed-mcp.json", js({"mcpServers": {"managed-srv": {"command": "node", "args": ["managed.js"]}}}))


def ledger():
    """fixtures/claude-ledger: the helper-run ledger of docs/specs/agent-scorecard.md.

    One project, three chats. S1 is an interactive chat that dispatches 7 workers and 4 reviewers:
      W1 coder        ends by a task-notification (end source: notice)      review R1 names W1   (L1, pass)
      W2 coder        ends by its own end_turn (source: thread)             review R2 names none (L2, pass)
      W3 / W4 coder   run in parallel                                       review R3 names none, two ended
                                                                            (not tied); a SendMessage to W4
                                                                            after its findings sends W4 back
      R4 design-review names W4 by its worktree branch (L1, pass)
      W5 Explore      interrupted by the user (stopped)   W6 general-purpose  API error (errored)
      W7 coder        still going (no end)
      R1 ends by sidecar `finished: true` (source: sidecar).
    S2 is a headless chat (entrypoint sdk-cli) that ran as the code-reviewer agent (agent-setting).
    S3 is a plain interactive chat with no helpers. R3's dispatch prompt holds SENTINEL-PROMPT-7731
    and its report a line with a fake password: neither may reach the cache.
    """
    base = os.path.join(ROOT, "claude-ledger")
    P = "projects/-fx-ledger"
    cwd = "/fixture/ledger"
    S1 = "aaaa1001-0000-4000-8000-000000000001"
    S2 = "bbbb1002-0000-4000-8000-000000000002"
    S3 = "cccc1003-0000-4000-8000-000000000003"

    def hid(n):
        return "a" + format(n, "016x")

    W1, R1, W2, R2, W3, W4, R3, R4, W5, W6, W7, W8, R5, R6 = (hid(n) for n in range(1, 15))

    def t(h, m, s=0):
        return f"2026-11-06T{h:02d}:{m:02d}:{s:02d}.000Z"

    n = [0]

    def line(sid, ts, blocks, stop=None, model="claude-sonnet-5-5", inp=10, out=50, entry="cli", side=False, **extra):
        n[0] += 1
        mid = f"L{n[0]:04d}"
        o = {
            "type": "assistant", "uuid": f"u-{mid}", "sessionId": sid, "timestamp": ts, "cwd": cwd,
            "isSidechain": side, "version": "2.1.296", "entrypoint": entry, "requestId": f"req_{mid}",
            "message": {"id": f"msg_{mid}", "type": "message", "role": "assistant", "model": model,
                        "content": blocks, "stop_reason": stop, "usage": usage(inp, out)},
        }
        o.update(extra)
        return o

    def text(s):
        return {"type": "text", "text": s}

    def call(tid, name, inp):
        return {"type": "tool_use", "id": tid, "name": name, "input": inp}

    def prompt(sid, ts, s, entry="cli", side=False):
        o = user(sid, f"uu-{ts}", None, ts, cwd, s)
        o["entrypoint"] = entry
        o["isSidechain"] = side
        return o

    def notice(sid, ts, agent, status):
        body = f"<task-notification>\n<task-id>{agent}</task-id>\n<status>{status}</status>\n</task-notification>"
        o = prompt(sid, ts, body)
        o["fixtureText"] = True  # invented text, allowed by tests/fixtures.rs
        return o

    def helper(aid, ty, tool, start, ends, meta_extra=None, side_lines=None, no_sidecar=False):
        """A helper transcript (and its sidecar). `ends` = (h, m, s) of its last line."""
        rel = f"{P}/{S1}/subagents/agent-{aid}"
        put(base, rel + ".jsonl", jl(*side_lines))
        if not no_sidecar:
            meta = {"agentType": ty, "description": f"fixture {ty} {aid[-2:]}", "toolUseId": tool, "spawnDepth": 1}
            meta.update(meta_extra or {})
            put(base, rel + ".meta.json", json.dumps(meta, separators=(",", ":")))

    def work(aid, start, end, final, stop="end_turn", extra_user=None, model="claude-sonnet-5-5", eff="high"):
        """prompt, one tool call, then the last line (text or a tool call)."""
        ex = {"effort": eff, "perTurnEffort": eff} if eff else {}
        out = [prompt(S1, t(*start), "[fixture helper prompt]", side=True)]
        mid = (start[0], start[1], start[2] + 5)
        out.append(line(S1, t(*mid), [text("[fixture work]"), call(f"toolu_{aid}_0", "Read", {})], stop="tool_use", model=model, side=True, agentId=aid, **ex))
        if extra_user:
            out.append(extra_user)
        out.append(line(S1, t(*end), final, stop=stop, model=model, side=True, agentId=aid, **ex))
        return out

    final = lambda s: [text("[fixture report]\n" + s)]
    r3_report = (
        "**FINDINGS**\n"
        "- Retry loop in net.rs never backs off between attempts (src/net.rs:41)\n"
        "- Error text is swallowed in the request handler (src/handler.rs:88)\n\n"
        "High: the password=fixturepw12345 value is written to the debug log\n"
        "Low: stale TODO left in settings.rs after the refactor\n\n"
        "Verdict: FIX-REQUIRED"
    )

    # ---- S1 helpers
    helper(W1, "coder", "toolu_d_w1", (9, 1, 5), None,
           side_lines=work(W1, (9, 1, 5), (9, 3, 0), final("Built the parser. All done.")))
    helper(R1, "code-reviewer", "toolu_d_r1", (9, 3, 35), None, {"finished": True},
           work(R1, (9, 3, 35), (9, 5, 0), final("Looks right.\n\nVerdict: PASS")))
    helper(W2, "coder", "toolu_d_w2", (9, 6, 5), None,
           side_lines=work(W2, (9, 6, 5), (9, 8, 0), final("Wired the cache."), model="claude-opus-5-5", eff="medium"))
    helper(R2, "verifier", "toolu_d_r2", (9, 8, 35), None,
           side_lines=work(R2, (9, 8, 35), (9, 9, 30), final("Ran it.\n\n**Verdict:** MERGE")))
    helper(W3, "coder", "toolu_d_w3", (9, 10, 0), None,
           side_lines=work(W3, (9, 10, 0), (9, 12, 0), final("Did the settings page."), model="claude-fable-5-2", eff=None))
    helper(W4, "coder", "toolu_d_w4", (9, 10, 10), None, {"worktreeBranch": "worktree-agent-w4branch"},
           work(W4, (9, 10, 10), (9, 12, 30), final("Did the network layer.")))
    helper(R3, "code-reviewer", "toolu_d_r3", (9, 13, 5), None,
           side_lines=work(R3, (9, 13, 5), (9, 13, 50), final(r3_report)))
    helper(R4, "design-reviewer", "toolu_d_r4", (9, 16, 5), None,
           side_lines=work(R4, (9, 16, 5), (9, 17, 0), final("Matches the identity.\n\nVerdict: PASS")))
    interrupt = prompt(S1, t(9, 21, 0), "[Request interrupted by user]", side=True)
    interrupt["fixtureText"] = True  # the marker Claude Code writes, as a string; allowed by tests/fixtures.rs
    helper(W5, "Explore", "toolu_d_w5", (9, 20, 0), None,
           side_lines=work(W5, (9, 20, 0), (9, 20, 40), [call(f"toolu_{W5}_1", "Grep", {})], stop="tool_use", extra_user=interrupt))
    api_err = line(S1, t(9, 22, 40), [text("[fixture] API Error: 500 internal error")], stop="stop_sequence", side=True, agentId=W6, isApiErrorMessage=True)
    helper(W6, "general-purpose", "toolu_d_w6", (9, 22, 0), None, no_sidecar=True,
           side_lines=[prompt(S1, t(9, 22, 0), "[fixture helper prompt]", side=True),
                       line(S1, t(9, 22, 10), [call(f"toolu_{W6}_0", "Read", {})], stop="tool_use", side=True, agentId=W6),
                       api_err])
    helper(W7, "coder", "toolu_d_w7", (9, 25, 0), None,
           side_lines=work(W7, (9, 25, 0), (9, 25, 50), [call(f"toolu_{W7}_1", "Edit", {})], stop="tool_use"))
    # W8 finishes at 9:27, is woken by a message at 9:35 and finishes again at 9:36: one helper, two
    # stretches of a minute each, so its duration is 120 s (not the 10 minutes between first and last line).
    w8_ex = {"effort": "high", "perTurnEffort": "high"}
    w8 = work(W8, (9, 26, 0), (9, 27, 0), final("Built the exporter.\n\nSTATUS: done"))
    w8 += [
        prompt(S1, t(9, 35, 0), "[fixture resume message]", side=True),
        line(S1, t(9, 35, 10), [text("[fixture work]"), call(f"toolu_{W8}_2", "Edit", {})], stop="tool_use", side=True, agentId=W8, **w8_ex),
        line(S1, t(9, 36, 0), final("Fixed the exporter.\n\nSTATUS: partial"), stop="end_turn", side=True, agentId=W8, **w8_ex),
    ]
    helper(W8, "coder", "toolu_d_w8", (9, 26, 0), None, side_lines=w8)
    # Reviewers that name no one and follow several ended helpers: not tied, but their verdicts are real.
    helper(R5, "verifier", "toolu_d_r5", (9, 50, 0), None,
           side_lines=work(R5, (9, 50, 0), (9, 51, 0), final("Ran the app.\n\n**Overall: FAIL**")))
    helper(R6, "code-reviewer", "toolu_d_r6", (9, 50, 30), None,
           side_lines=work(R6, (9, 50, 30), (9, 51, 30), final("Read the diff.\n\nVERDICT: fix-required (FAIL)")))

    # ---- S1 main chat
    def dispatch(ts, tool, ty, desc, body):
        return line(S1, ts, [call(tool, "Agent", {"subagent_type": ty, "description": desc, "prompt": body})], stop="tool_use")

    main = [prompt(S1, t(9, 0, 0), "[fixture user message]")]
    main += [
        dispatch(t(9, 1, 0), "toolu_d_w1", "coder", "Build the parser", "Build the parser."),
        notice(S1, t(9, 3, 10), W1, "completed"),
        dispatch(t(9, 3, 30), "toolu_d_r1", "code-reviewer", "Review the parser", f"Review the parser built by agent {W1}."),
        dispatch(t(9, 6, 0), "toolu_d_w2", "coder", "Wire the cache", "Wire the cache."),
        dispatch(t(9, 8, 30), "toolu_d_r2", "verifier", "Verify the cache", "Verify the cache works."),
        dispatch(t(9, 10, 0), "toolu_d_w3", "coder", "Settings page", "Build the settings page."),
        dispatch(t(9, 10, 5), "toolu_d_w4", "coder", "Network layer", "Build the network layer."),
        dispatch(t(9, 13, 0), "toolu_d_r3", "code-reviewer", "Review both", "Review the recent work. SENTINEL-PROMPT-7731"),
        line(S1, t(9, 14, 0), [call("toolu_s_w4", "SendMessage", {"to": W4, "message": "fix the retry loop", "summary": "fix retries"})], stop="tool_use"),
        line(S1, t(9, 14, 5), [call("toolu_s_w4b", "SendMessage", {"to": W4, "message": "and the handler", "summary": "fix handler"})], stop="tool_use"),
        line(S1, t(9, 14, 8), [call("toolu_s_name", "SendMessage", {"to": "team-lead", "message": "status", "summary": "status"})], stop="tool_use"),
        dispatch(t(9, 16, 0), "toolu_d_r4", "design-reviewer", "Review the look", "Check the look of worktree-agent-w4branch against the identity."),
        dispatch(t(9, 20, 0), "toolu_d_w5", "Explore", "Look around", "Look around."),
        dispatch(t(9, 22, 0), "toolu_d_w6", "general-purpose", "A one-off", "A one-off job."),
        dispatch(t(9, 25, 0), "toolu_d_w7", "coder", "Keep going", "Keep going."),
        dispatch(t(9, 26, 0), "toolu_d_w8", "coder", "Export it", "Build the exporter."),
        line(S1, t(9, 34, 50), [call("toolu_s_w8", "SendMessage", {"to": W8, "message": "one more fix", "summary": "one more fix"})], stop="tool_use"),
        dispatch(t(9, 50, 0), "toolu_d_r5", "verifier", "Verify the app", "Run the app and check it."),
        dispatch(t(9, 50, 30), "toolu_d_r6", "code-reviewer", "Review it", "Review the latest changes."),
        line(S1, t(9, 55, 0), [text("[fixture main reply]")], stop="end_turn"),
    ]
    put(base, f"{P}/{S1}.jsonl", jl(*main))

    # ---- S2: headless, ran as an agent
    s2 = [
        {"type": "agent-setting", "agentSetting": "code-reviewer", "sessionId": S2},
        prompt(S2, t(10, 0, 0), "[fixture headless prompt]", entry="sdk-cli"),
        line(S2, t(10, 0, 20), [text("[fixture work]"), call("toolu_h_0", "Read", {})], stop="tool_use", entry="sdk-cli"),
        line(S2, t(10, 2, 0), [text("[fixture report]\nChecked the diff.\n\nVerdict: pass")], stop="end_turn", entry="sdk-cli"),
    ]
    put(base, f"{P}/{S2}.jsonl", jl(*s2))

    # ---- S3: interactive, no helpers
    s3 = [prompt(S3, t(11, 0, 0), "[fixture user message]"), line(S3, t(11, 0, 30), [text("[fixture reply]")], stop="end_turn")]
    put(base, f"{P}/{S3}.jsonl", jl(*s3))


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "ledger":
        ledger()  # only this fixture: never touches the others
        print(f"wrote {os.path.normpath(os.path.join(ROOT, 'claude-ledger'))}")
        return 0
    # Clear only the folders this script writes: claude-agents, claude-items and the
    # setup-*-wire-keys.json files beside them are hand-made and must survive a regenerate.
    for name in ("claude-basic", "claude-edge", "claude-usage", "claude-accuracy", "claude-habits", "claude-setup", "claude-ledger"):
        folder = os.path.join(ROOT, name)
        if not os.path.isdir(folder):
            continue
        for base, _dirs, files in os.walk(folder, topdown=False):
            for fname in files:
                os.remove(os.path.join(base, fname))
            for d in _dirs:
                p = os.path.join(base, d)
                if not os.listdir(p):
                    os.rmdir(p)
    basic()
    edge()
    usage_fx()
    accuracy_fx()
    habits()
    setup()
    ledger()
    n = sum(len(f) for _, _, f in os.walk(ROOT))
    print(f"wrote {n} fixture files under {os.path.normpath(ROOT)}")


if __name__ == "__main__":
    sys.exit(main())
