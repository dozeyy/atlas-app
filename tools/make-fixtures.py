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


def main():
    if os.path.isdir(ROOT):
        # Remove only files we generate, never a recursive delete of unknown content.
        for base, _dirs, files in os.walk(ROOT, topdown=False):
            for name in files:
                os.remove(os.path.join(base, name))
            for d in _dirs:
                p = os.path.join(base, d)
                if not os.listdir(p):
                    os.rmdir(p)
    basic()
    edge()
    usage_fx()
    n = sum(len(f) for _, _, f in os.walk(ROOT))
    print(f"wrote {n} fixture files under {os.path.normpath(ROOT)}")


if __name__ == "__main__":
    sys.exit(main())
