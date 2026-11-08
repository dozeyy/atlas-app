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
    setup()
    n = sum(len(f) for _, _, f in os.walk(ROOT))
    print(f"wrote {n} fixture files under {os.path.normpath(ROOT)}")


if __name__ == "__main__":
    sys.exit(main())
