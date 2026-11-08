// A believable made-up setup for the plain-browser build and for tests.
// Nothing here is a real person's file; secrets are the word "mock".

import type { ItemKind, MaskedRange, ScopeKind, SetupItem, SetupProject, SetupSnapshot, SourceView } from "./setup-types";

let n = 0;

function item(kind: ItemKind, scope: ScopeKind, name: string, extra: Partial<SetupItem> = {}): SetupItem {
  n += 1;
  const label =
    scope === "user" ? "Global" : scope === "project" ? "Project \u00b7 atlas" : scope === "local" ? "Local \u00b7 atlas" : scope === "plugin" ? "Plugin \u00b7 helpers" : scope === "managed" ? "Managed" : "claude.ai";
  return {
    id: `${kind}:${n.toString(16).padStart(16, "0")}`,
    kind,
    scope,
    scopeLabel: label,
    projectId: scope === "project" || scope === "local" ? "p-atlas" : null,
    plugin: scope === "plugin" ? "helpers@market" : null,
    name,
    description: "",
    path: `C:/Users/you/.claude/${kind}s/${name}.md`,
    linkTarget: null,
    size: 1800 + n * 37,
    modifiedMs: Date.now() - n * 3_600_000,
    enabled: { state: "none", label: "", raw: null },
    conflict: null,
    chips: [],
    warnings: [],
    detail: [],
    attachments: [],
    usedBy: null,
    mcp: null,
    backup: false,
    realProjectFile: false,
    hasSecrets: false,
    worktree: false,
    ...extra,
  };
}

const on = { state: "on", label: "On", raw: null } as const;

function build(includeWorktrees: boolean): SetupSnapshot {
  n = 0;
  const items: SetupItem[] = [
    item("skill", "user", "commit-helper", { description: "Write a commit message that matches the repo's style.", enabled: on, attachments: ["references/style.md"], detail: [{ label: "Allowed tools", value: "Bash(git:*)" }] }),
    item("skill", "user", "deep-research", { description: "Research a topic across sources and write it up.", enabled: on }),
    item("skill", "user", "shared-skill", { description: "User copy of a shared skill.", enabled: on, conflict: { status: "overrides", label: "Overrides Project \u00b7 atlas", definedIn: [] } }),
    item("skill", "project", "shared-skill", { description: "Project copy of a shared skill.", enabled: { state: "shadowed", label: "Shadowed", raw: null }, conflict: { status: "overridden", label: "Overridden by Global", definedIn: [] } }),
    item("skill", "synced", "anthropic-skills:docx", { description: "Create and edit Word documents.", enabled: on }),
    item("skill", "plugin", "helpers:triage", { description: "Sort incoming issues.", enabled: on }),
    item("agent", "user", "code-reviewer", { description: "Reads a diff for correctness bugs.", chips: ["sonnet"], enabled: on }),
    item("agent", "user", "bug-hunter", { description: "Finds root causes with evidence.", chips: ["opus"], enabled: on }),
    item("agent", "project", "lane-agent", { description: "Works one lane of the pipeline.", enabled: on, warnings: ["No name in the frontmatter; using the file name"] }),
    item("command", "user", "standup", { description: "Summarise yesterday and plan today.", enabled: on }),
    item("command", "user", "nested:deploy:prod", { description: "Ship the current build.", enabled: on }),
    item("mcpServer", "user", "github", {
      description: "stdio \u00b7 npx -y @modelcontextprotocol/server-github",
      enabled: { state: "on", label: "On in 3 of 4 projects", raw: null },
      chips: ["stdio"],
      hasSecrets: true,
      mcp: {
        transport: "stdio",
        summary: "npx -y @modelcontextprotocol/server-github",
        envKeys: ["GITHUB_TOKEN"],
        headerKeys: [],
        perProject: [
          { projectId: "p-atlas", projectName: "atlas", on: true },
          { projectId: "p-site", projectName: "site", on: true },
          { projectId: "p-bot", projectName: "bot", on: false },
        ],
        onCount: 3,
        totalProjects: 4,
      },
    }),
    item("mcpServer", "project", "docs", { description: "http \u00b7 https://example.test/mcp", enabled: { state: "approved", label: "Approved", raw: null }, chips: ["http"], hasSecrets: true, mcp: { transport: "http", summary: "https://example.test/mcp", envKeys: [], headerKeys: ["Authorization"], perProject: [], onCount: 0, totalProjects: 0 } }),
    item("mcpServer", "connector", "claude.ai Calendar", { description: "claude.ai connector (managed in your account)", enabled: { state: "none", label: "Account", raw: null }, path: null, chips: [], mcp: { transport: "connector", summary: "Needs sign-in", envKeys: [], headerKeys: [], perProject: [], onCount: 0, totalProjects: 0 } }),
    item("hook", "user", "PreToolUse \u00b7 Bash", { description: "command \u00b7 fmt.sh --check", chips: ["PreToolUse", "command"], enabled: on }),
    item("hookScript", "user", "fmt.sh", { description: "Used by 1 hook", usedBy: 1 }),
    item("hookScript", "user", "unused.sh", { description: "Not referenced", usedBy: 0 }),
    item("plugin", "user", "helpers@market", { description: "Issue triage helpers.", enabled: on, chips: ["v1.2.0", "1 skills", "2 hooks"] }),
    item("outputStyle", "user", "Calm Notes", { description: "Quiet and short.", enabled: { state: "active", label: "Active", raw: null } }),
    item("statusLine", "user", "Status line", { description: "command \u00b7 statusline.sh", enabled: { state: "active", label: "Active", raw: null }, chips: ["command"] }),
    item("instructions", "user", "CLAUDE.md", { description: "Global instructions" }),
    item("instructions", "project", "CLAUDE.md", { description: "Atlas project notes" }),
    item("rule", "user", "typescript", { description: "For TypeScript files.", chips: ["**/*.ts"] }),
    item("permission", "user", "Bash(git status:*)", { chips: ["allow", "Bash"] }),
    item("permission", "user", "Read(*)", { chips: ["allow", "Read"] }),
    item("permission", "user", "WebFetch", { chips: ["ask", "WebFetch"] }),
    item("permission", "project", "Bash(curl:*)", { chips: ["deny", "Bash"] }),
    item("settings", "user", "settings.json", { description: "Your main settings", hasSecrets: true }),
    item("settings", "project", "settings.local.json", { description: "Local overrides", chips: ["local"] }),
    item("autoMemory", "project", "MEMORY.md", { description: "Project memory" }),
    item("agentMemory", "user", "bug-hunter/notes.md", { description: "Agent notes" }),
    item("keybindings", "user", "Keybindings", { description: "Your shortcuts" }),
    item("other", "user", "reference/notes.md", { description: "Not managed by Atlas" }),
    item("other", "user", "agents/old.md.bak-20261001", { description: "Backup copy", backup: true, chips: ["backup copy"] }),
    item("mcpServer", "local", "gone-srv", { projectId: "p-gone", scopeLabel: "Local \u00b7 gone", description: "stdio \u00b7 node gone.js", chips: ["stdio"], enabled: on }),
  ];
  if (includeWorktrees) {
    items.push(item("skill", "project", "wt-skill", { projectId: "p-wt", worktree: true, description: "Inside an agent worktree." }));
  }
  const projects: SetupProject[] = [
    { id: "p-atlas", name: "atlas", path: "C:/Users/you/Documents/atlas", exists: true, isHome: false, isWorktree: false, parentId: null, worktreeCount: 1, itemCount: 9, localMcpCount: 0, lastActivityMs: Date.now() - 600_000 },
    { id: "p-site", name: "site", path: "C:/Users/you/Documents/site", exists: true, isHome: false, isWorktree: false, parentId: null, worktreeCount: 0, itemCount: 3, localMcpCount: 0, lastActivityMs: Date.now() - 86_400_000 },
    { id: "p-gone", name: "gone", path: "C:/Users/you/Documents/gone", exists: false, isHome: false, isWorktree: false, parentId: null, worktreeCount: 0, itemCount: 1, localMcpCount: 1, lastActivityMs: 0 },
  ];
  return {
    version: 1,
    root: { dir: "C:/Users/you/.claude", dirExists: true, claudeJson: "C:/Users/you/.claude.json", claudeJsonState: "ok" },
    items,
    projects,
    hidden: { worktrees: includeWorktrees ? 0 : 1, missingProjects: 0, emptyProjects: 2, backups: 1 },
    elapsedMs: 64,
  };
}

export function mockSetupSnapshot(includeWorktrees: boolean): Promise<SetupSnapshot> {
  return Promise.resolve(build(includeWorktrees));
}

const SECRET = "mock-secret-value-0000";

export function mockSetupSource(id: string): Promise<SourceView> {
  const secret = id.startsWith("settings") || id.startsWith("mcpServer");
  const text = secret
    ? `{\n  "env": {\n    "GITHUB_TOKEN": "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022"\n  },\n  "command": "npx"\n}\n`
    : `---\nname: example\ndescription: A made-up file.\n---\n\nSome text to read.\n`;
  const ranges: MaskedRange[] = [];
  if (secret) {
    const start = text.indexOf("\u2022");
    ranges.push({ start, end: start + 8, key: "GITHUB_TOKEN", index: 0 });
  }
  return Promise.resolve({
    id,
    text,
    language: secret ? "json" : "markdown",
    truncated: false,
    maskedRanges: ranges,
    size: text.length,
    lineEnding: "LF",
    bom: false,
  });
}

export function mockSetupReveal(_id: string, _index: number): Promise<string> {
  return Promise.resolve(SECRET);
}
