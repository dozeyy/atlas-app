// A believable made-up setup for the plain-browser build and for tests.
// Nothing here is a real person's file; secrets are the word "mock".

import type {
  CreateKind,
  DeleteOutcome,
  Draft,
  ItemKind,
  MaskedRange,
  Problem,
  RawEdit,
  SaveReply,
  ScopeKind,
  SetupItem,
  SetupProject,
  SetupSnapshot,
  SourceView,
  UndoOutcome,
} from "./setup-types";

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
    ...capabilities(kind, scope, extra.backup === true),
    ...extra,
  };
}

const LOCKED: Partial<Record<ScopeKind, string>> = {
  plugin: "Installed by a plugin. Change it by updating or removing the plugin.",
  synced: "Synced from your claude.ai account. Manage it there.",
  managed: "Set by your organization, so it can't be changed here.",
  connector: "A claude.ai connector. Manage it in your account.",
};

const DELETABLE: ItemKind[] = ["skill", "agent", "command", "rule", "outputStyle", "hook", "mcpServer"];
const EDITABLE: ItemKind[] = [...DELETABLE, "instructions", "settings", "keybindings", "autoMemory", "agentMemory", "other"];

/** The same rules as crates/core/src/setup/capability.rs, roughly. */
function capabilities(kind: ItemKind, scope: ScopeKind, backup: boolean): Pick<SetupItem, "editable" | "deletable" | "locked"> {
  const locked = LOCKED[scope] ?? null;
  if (locked) return { editable: false, deletable: false, locked };
  if (backup) return { editable: false, deletable: false, locked: null };
  return { editable: EDITABLE.includes(kind), deletable: DELETABLE.includes(kind), locked: null };
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

// ---- a small in-memory "disk" so changes can be tried in the browser and in tests ----

const SKILL_TEXT = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description || "A made-up skill."}\n---\n\n# ${name}\n\nSteps Claude follows.\n\n- Look at the request\n- Do the work\n- Say what changed\n`;
const AGENT_TEXT = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description || "A made-up agent."}\nmodel: sonnet\ntools: Read, Grep, Bash\n---\n\nYou are ${name}. Work carefully and report briefly.\n`;

function textFor(i: SetupItem): string {
  switch (i.kind) {
    case "skill":
      return SKILL_TEXT(i.name, i.description);
    case "agent":
      return AGENT_TEXT(i.name, i.description);
    case "command":
    case "rule":
    case "outputStyle":
      return `---\ndescription: ${i.description || "A made-up file."}\n---\n\nSome text to read.\n`;
    case "mcpServer":
      return `{\n  "command": "npx",\n  "args": ["-y", "some-server"],\n  "env": {\n    "GITHUB_TOKEN": "${SECRET}"\n  }\n}\n`;
    case "hook":
      return `{\n  "matcher": "Bash",\n  "hooks": [\n    { "type": "command", "command": "fmt.sh --check" }\n  ]\n}\n`;
    case "settings":
      return `{\n  "env": {\n    "API_TOKEN": "${SECRET}"\n  },\n  "model": "sonnet"\n}\n`;
    case "keybindings":
      return `{\n  "bindings": []\n}\n`;
    default:
      return `# ${i.name}\n\n${i.description || "Some notes."}\n`;
  }
}

function langFor(i: SetupItem): string {
  return i.kind === "mcpServer" || i.kind === "hook" || i.kind === "settings" || i.kind === "keybindings" ? "json" : "markdown";
}

function problemsFor(language: string, folder: string | null, text: string): Problem[] {
  if (language === "json") {
    try {
      JSON.parse(text);
      return [];
    } catch (e) {
      const m = e instanceof Error ? e.message : "Not valid JSON";
      return [{ message: `This is not valid JSON: ${m}`, line: null }];
    }
  }
  if (!text.startsWith("---")) return [];
  const rest = text.slice(3);
  const end = rest.search(/\r?\n---[ \t]*(\r?\n|$)/);
  if (end < 0) return [{ message: "The frontmatter is never closed. Add a line with --- after it.", line: 1 }];
  const name = /^name:\s*(.+)$/m.exec(rest.slice(0, end))?.[1]?.trim();
  if (folder && name && name !== folder) {
    return [{ message: `The name "${name}" has to match the folder name "${folder}".`, line: 2 }];
  }
  return [];
}

export class MockSetupWorld {
  private items: SetupItem[] = [];
  private texts = new Map<string, string>();
  private stamps = new Map<string, number>();
  private removed = new Map<string, { item: SetupItem; text: string }>();
  private serial = 0;
  private listeners = new Set<() => void>();

  constructor() {
    this.items = build(true).items;
    for (const i of this.items) {
      this.texts.set(i.id, textFor(i));
      this.stamps.set(i.id, 1);
    }
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private changed() {
    this.listeners.forEach((l) => l());
  }

  private find(id: string): SetupItem {
    const i = this.items.find((x) => x.id === id);
    if (!i) throw new Error("That item is not there any more.");
    return i;
  }

  snapshot(includeWorktrees: boolean): SetupSnapshot {
    const base = build(includeWorktrees);
    const wt = this.items.filter((i) => i.worktree).length;
    const items = this.items.filter((i) => includeWorktrees || !i.worktree).map((i) => ({ ...i }));
    return { ...base, items, hidden: { ...base.hidden, worktrees: includeWorktrees ? 0 : wt } };
  }

  raw(id: string, reveal: boolean): RawEdit {
    const i = this.find(id);
    const text = this.texts.get(id) ?? "";
    const hidden = i.hasSecrets && !reveal;
    return {
      id,
      text: hidden ? "" : text,
      language: langFor(i),
      stamp: String(this.stamps.get(id) ?? 1),
      lineEnding: "LF",
      bom: false,
      path: i.path ?? "",
      hasSecrets: i.hasSecrets,
      needsReveal: hidden,
      folderName: i.kind === "skill" ? i.name : null,
    };
  }

  validate(id: string, text: string): Problem[] {
    const i = this.find(id);
    return problemsFor(langFor(i), i.kind === "skill" ? i.name : null, text);
  }

  save(id: string, text: string, stamp: string, force: boolean): SaveReply {
    const i = this.find(id);
    if (!i.editable) throw new Error(i.locked ?? "Atlas will not change this.");
    if (!force && stamp !== String(this.stamps.get(id) ?? 1)) return { status: "conflict", stamp: null, backupId: null };
    const bad = this.validate(id, text);
    if (bad.length) throw new Error(bad[0]!.message);
    const next = (this.stamps.get(id) ?? 1) + 1;
    this.texts.set(id, text);
    this.stamps.set(id, next);
    i.modifiedMs = Date.now();
    i.size = text.length;
    this.changed();
    return { status: "saved", stamp: String(next), backupId: `mock-save-${++this.serial}` };
  }

  /** Tests: change the "file" without the editor knowing. */
  touch(id: string, text?: string) {
    this.stamps.set(id, (this.stamps.get(id) ?? 1) + 1);
    if (text !== undefined) this.texts.set(id, text);
  }

  delete(id: string): DeleteOutcome {
    const i = this.find(id);
    if (!i.deletable) throw new Error(i.locked ?? "Atlas will not delete this.");
    const backupId = `mock-del-${++this.serial}`;
    this.removed.set(backupId, { item: i, text: this.texts.get(id) ?? "" });
    this.items = this.items.filter((x) => x.id !== id);
    this.changed();
    return { backupId, name: i.name, kind: i.kind, note: null };
  }

  undo(backupId: string): UndoOutcome {
    const r = this.removed.get(backupId);
    if (!r) throw new Error("That backup is not there any more.");
    this.removed.delete(backupId);
    this.items.push(r.item);
    this.texts.set(r.item.id, r.text);
    this.changed();
    return { name: r.item.name, kind: r.item.kind };
  }

  draft(kind: CreateKind, name: string, event?: string): Draft {
    const nm = name.trim() || "new-item";
    const where: Record<CreateKind, string> = {
      instructions: "CLAUDE.md",
      skill: `skills/${nm}/SKILL.md`,
      agent: `agents/${nm}.md`,
      command: `commands/${nm}.md`,
      rule: `rules/${nm}.md`,
      outputStyle: `output-styles/${nm}.md`,
      hook: "settings.json (hooks)",
      mcpServer: ".claude.json (mcpServers)",
    };
    const text =
      kind === "skill"
        ? SKILL_TEXT(nm, "Say when Claude should use this.")
        : kind === "agent"
          ? AGENT_TEXT(nm, "Say what this agent is for.")
          : kind === "hook"
            ? `{\n  "matcher": "Bash",\n  "hooks": [\n    { "type": "command", "command": "echo ${event ?? "PreToolUse"}" }\n  ]\n}\n`
            : kind === "mcpServer"
              ? `{\n  "command": "npx",\n  "args": ["-y", "your-server"]\n}\n`
              : kind === "instructions"
                ? `# How I like to work\n\n- Keep answers short.\n- Show me the result, not the plan.\n`
                : `---\ndescription: Say what this is for.\n---\n\nWrite it here.\n`;
    return {
      kind,
      name: nm,
      title: nm,
      path: `C:/Users/you/.claude/${where[kind]}`,
      language: kind === "hook" || kind === "mcpServer" ? "json" : "markdown",
      text,
      folderName: kind === "skill" ? nm : null,
      whereNote: where[kind],
    };
  }

  validateDraft(kind: CreateKind, name: string, event: string | undefined, text: string): Problem[] {
    const d = this.draft(kind, name, event);
    return problemsFor(d.language, d.folderName, text);
  }

  create(kind: CreateKind, name: string, event: string | undefined, text: string): DeleteOutcome {
    const nm = name.trim();
    const d = this.draft(kind, nm, event);
    const problems = problemsFor(d.language, d.folderName, text);
    if (problems.length) throw new Error(problems[0]!.message);
    const exists = this.items.some((x) => x.kind === kind && x.scope === "user" && x.name === nm);
    if (exists && kind !== "instructions") throw new Error(`There is already a ${kind} called "${nm}". Atlas will not overwrite it.`);
    const saved = n;
    n = 1000 + this.serial + this.items.length;
    const created = item(kind, "user", kind === "instructions" ? "CLAUDE.md" : nm, {
      enabled: { state: "on", label: "On", raw: null },
      path: d.path,
    });
    n = saved;
    this.items = this.items.filter((x) => !(kind === "instructions" && x.kind === "instructions" && x.scope === "user"));
    this.items.push(created);
    this.texts.set(created.id, text);
    this.stamps.set(created.id, 1);
    this.changed();
    return { backupId: `mock-new-${++this.serial}`, name: nm, kind, note: null };
  }
}
