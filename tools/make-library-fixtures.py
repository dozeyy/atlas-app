#!/usr/bin/env python3
"""Builds fixtures/library/*.tar.gz: tiny GitHub-style repo archives for the Library tests.

Each archive looks like what codeload.github.com sends: one top folder `<repo>-<sha>/` and a pax
global header `comment=<full commit sha>`. Output is deterministic (fixed mtimes, no names).
Run: python tools/make-library-fixtures.py
Every text in these files is fixture text; nothing here is a real plugin.
"""
import gzip
import hashlib
import io
import os
import tarfile

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "fixtures", "library")

HOOKS = """{
  "hooks": {
    "PreToolUse": [{"hooks": [{"type": "command", "command": "python3 \\"${CLAUDE_PLUGIN_ROOT}/hooks/pretooluse.py\\""}]}],
    "PostToolUse": [{"matcher": "*", "hooks": [{"type": "command", "command": "python3 \\"${CLAUDE_PLUGIN_ROOT}/hooks/posttooluse.py\\""}]}],
    "Stop": [{"hooks": [{"type": "command", "command": "python3 \\"${CLAUDE_PLUGIN_ROOT}/hooks/stop.py\\""}]}],
    "UserPromptSubmit": [{"hooks": [{"type": "command", "command": "python3 \\"${CLAUDE_PLUGIN_ROOT}/hooks/userpromptsubmit.py\\""}]}]
  }
}
"""

PY = "#!/usr/bin/env python3\n# fixture script\nimport sys\nprint('fixture')\nsys.exit(0)\n"


def skill(name, desc):
    return f"---\nname: {name}\ndescription: {desc}\n---\n\n# {name}\n\nFixture skill text. Nothing here runs.\n"


REPOS = {
    # owner/repo -> {path: text or bytes}
    "fixture/marketplace-demo": {
        ".claude-plugin/marketplace.json": '{\n  "name": "demo-market",\n  "owner": {"name": "Fixture"},\n  "plugins": [\n    {"name": "alpha-tools", "description": "Alpha tools for tests", "source": "./plugins/alpha"},\n    {"name": "beta-tools", "description": "Beta tools for tests", "source": "./plugins/beta"}\n  ]\n}\n',
        "plugins/alpha/.claude-plugin/plugin.json": '{"name": "alpha-tools", "description": "Alpha tools for tests"}\n',
        "plugins/alpha/skills/alpha/SKILL.md": skill("alpha", "Alpha fixture skill"),
        "plugins/beta/.claude-plugin/plugin.json": '{"name": "beta-tools", "description": "Beta tools for tests"}\n',
        "plugins/beta/skills/beta/SKILL.md": skill("beta", "Beta fixture skill"),
    },
    "fixture/hookify-like": {
        ".claude-plugin/plugin.json": '{"name": "hookify-like", "description": "Fixture plugin with hooks and scripts", "version": "0.0.1"}\n',
        "hooks/hooks.json": HOOKS,
        "hooks/pretooluse.py": PY,
        "hooks/posttooluse.py": PY,
        "hooks/stop.py": PY,
        "hooks/userpromptsubmit.py": PY,
        "skills/writing-rules/SKILL.md": skill("writing-rules", "Fixture skill for writing rules"),
        "commands/hookify.md": "---\ndescription: Fixture command\n---\n\nCreate a rule from this conversation.\n",
    },
    "fixture/plugin-json-only": {
        ".claude-plugin/plugin.json": '{\n  "name": "plugin-json-only",\n  "description": "Fixture plugin without a marketplace",\n  "hooks": {"Stop": [{"hooks": [{"type": "command", "command": "python3 hooks/stop.py"}]}]}\n}\n',
        "hooks/hooks.json": '{"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "python3 hooks/stop.py"}]}]}}\n',
        "hooks/stop.py": PY,
        "skills/pdf/SKILL.md": skill("pdf", "Fixture pdf skill"),
        "skills/xlsx/SKILL.md": skill("xlsx", "Fixture spreadsheet skill"),
    },
    "fixture/loose-skills": {
        "skills/alpha/SKILL.md": skill("alpha", "Fixture skill with a script"),
        "skills/alpha/scripts/run.py": PY,
        "skills/beta/SKILL.md": skill("beta", "Fixture skill with a helper"),
        "skills/beta/reference.md": "# Reference\n\nFixture reference text.\n",
        "skills/beta/bin/helper.sh": "#!/bin/sh\necho fixture\n",
        "agents/reviewer.md": "---\nname: reviewer\ndescription: Fixture reviewer agent\n---\n\nYou review fixture text.\n",
    },
    "fixture/http-mcp": {
        ".mcp.json": '{\n  "mcpServers": {\n    "docs": {"type": "http", "url": "https://mcp.example.com/mcp"}\n  }\n}\n',
        "README.md": "# http-mcp\n\nFixture: one remote MCP server.\n",
    },
    "fixture/bare-skills": {
        "README.md": "# bare-skills\n\nFixture: text-only skills.\n",
        "skills/plain/SKILL.md": skill("plain", "A text-only fixture skill"),
    },
    "fixture/nothing": {
        "README.md": "# nothing\n\nFixture: nothing installable.\n",
        "src/main.rs": "fn main() {}\n",
    },
}


def sha_for(slug):
    return hashlib.sha1(slug.encode()).hexdigest()


def build(slug, files):
    owner, repo = slug.split("/")
    sha = sha_for(slug)
    top = f"{repo}-{sha}"
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.PAX_FORMAT, pax_headers={"comment": sha}) as tf:
        d = tarfile.TarInfo(top + "/")
        d.type, d.mode, d.mtime = tarfile.DIRTYPE, 0o755, 0
        tf.addfile(d)
        for rel in sorted(files):
            data = files[rel]
            data = data.encode() if isinstance(data, str) else data
            ti = tarfile.TarInfo(f"{top}/{rel}")
            ti.size, ti.mode, ti.mtime = len(data), 0o644, 0
            tf.addfile(ti, io.BytesIO(data))
    name = f"{owner}-{repo}.tar.gz"
    with open(os.path.join(OUT, name), "wb") as f:
        with gzip.GzipFile(fileobj=f, mode="wb", mtime=0, compresslevel=9) as gz:
            gz.write(raw.getvalue())
    return name, sha


def main():
    os.makedirs(OUT, exist_ok=True)
    for slug, files in REPOS.items():
        name, sha = build(slug, files)
        print(f"{name}  {sha}")


if __name__ == "__main__":
    main()
