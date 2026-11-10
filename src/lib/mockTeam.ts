// An in-memory stand-in for the Team tab (a plain browser, tests, design work). Deterministic:
// the same arguments give the same cards. The real numbers come from crates/core/src/usage/scorecard.rs.

import type {
  MadeRule,
  ModelUse,
  ProjectRuns,
  ReviewTheme,
  RuleReply,
  RuleSave,
  RuleSheetData,
  RunRow,
  Scorecard,
  ScorecardArgs,
  ThemeArgs,
  Themes,
  TypeCard,
} from "./teamTypes";
import type { Cost, Tokens } from "./usageTypes";

const DAY = 86_400_000;

interface Spec {
  type: string;
  name: string;
  reviewer: boolean;
  runs: number;
  headless: number;
  /** Tied reviews of this worker's runs: passed, sent back. */
  passed: number;
  sentBack: number;
  /** A reviewer's verdicts, by run: pass, findings, other, none. */
  verdicts?: [number, number, number, number];
  model: ModelUse;
  tokensPerRun: number;
  minutes: number;
  calls: number;
  projects: string[];
}

const opus: ModelUse = { model: "claude-opus-5-5", modelName: "Opus 5.5", effort: "high", messages: 40, runs: 5 };
const sonnet: ModelUse = { model: "claude-sonnet-5-5", modelName: "Sonnet 5.5", effort: "high", messages: 60, runs: 8 };
const haiku: ModelUse = { model: "claude-haiku-5-5", modelName: "Haiku 5.5", effort: null, messages: 12, runs: 2 };

const SPECS: Spec[] = [
  { type: "general-purpose", name: "General purpose", reviewer: false, runs: 18, headless: 6, passed: 9, sentBack: 3, model: sonnet, tokensPerRun: 420_000, minutes: 9, calls: 38, projects: ["atlas", "willhenry"] },
  { type: "ui-builder", name: "UI builder", reviewer: false, runs: 8, headless: 0, passed: 3, sentBack: 1, model: sonnet, tokensPerRun: 910_000, minutes: 17, calls: 64, projects: ["atlas"] },
  { type: "code-reviewer", name: "Code reviewer", reviewer: true, runs: 11, headless: 2, passed: 0, sentBack: 0, verdicts: [6, 3, 1, 1], model: opus, tokensPerRun: 260_000, minutes: 6, calls: 22, projects: ["atlas", "deskify"] },
  { type: "verifier", name: "Verifier", reviewer: true, runs: 6, headless: 0, passed: 0, sentBack: 0, verdicts: [4, 1, 0, 1], model: sonnet, tokensPerRun: 180_000, minutes: 5, calls: 19, projects: ["atlas"] },
  { type: "Explore", name: "Explore", reviewer: false, runs: 4, headless: 0, passed: 0, sentBack: 0, model: haiku, tokensPerRun: 90_000, minutes: 2, calls: 12, projects: ["atlas"] },
  { type: "chore-runner", name: "Chore runner", reviewer: false, runs: 2, headless: 0, passed: 0, sentBack: 0, model: haiku, tokensPerRun: 40_000, minutes: 1, calls: 7, projects: ["deskify"] },
];

const cost = (usd: number): Cost => ({ usd, complete: true, unpricedTokens: 0 });
const tokens = (total: number): Tokens => ({
  input: Math.round(total * 0.2),
  output: Math.round(total * 0.3),
  cacheWrite5m: Math.round(total * 0.5),
  cacheWrite1h: 0,
  cacheRead: total * 4,
  total,
  webSearch: 0,
  webFetch: 0,
});

interface MockRun {
  spec: Spec;
  i: number;
  ageDays: number;
  headless: boolean;
  verdict: RunRow["verdict"];
  end: RunRow["endStatus"];
  review: "passed" | "sent" | null;
  project: string;
}

function buildRuns(): MockRun[] {
  const out: MockRun[] = [];
  for (const s of SPECS) {
    let verdicts: RunRow["verdict"][] = [];
    if (s.verdicts) {
      const [p, f, o, n] = s.verdicts;
      verdicts = [...Array(p).fill("pass"), ...Array(f).fill("findings"), ...Array(o).fill("other"), ...Array(n).fill(null)] as RunRow["verdict"][];
    }
    for (let i = 0; i < s.runs; i++) {
      const review: MockRun["review"] = i < s.passed ? "passed" : i < s.passed + s.sentBack ? "sent" : null;
      out.push({
        spec: s,
        i,
        // Spread over the last 80 days, newest first within a type.
        ageDays: Math.floor((i * 80) / Math.max(1, s.runs)) + (i % 3),
        headless: i < s.headless,
        verdict: s.verdicts ? (verdicts[i] ?? null) : null,
        end: i % 7 === 5 ? "errored" : i % 11 === 10 ? "stopped" : i === s.runs - 1 && s.runs > 3 ? null : "finished",
        review,
        project: s.projects[i % s.projects.length],
      });
    }
  }
  return out;
}

export class MockTeam {
  /** Test hook: the next rule save finds its file changed. */
  staleNext = false;
  /** Test hook: the next scorecard call fails. */
  failNext = false;
  readonly saved: RuleSave[] = [];
  readonly forgotten: string[] = [];
  calls: ScorecardArgs[] = [];
  private made: Record<string, MadeRule> = {};
  private readonly runs = buildRuns();

  async teamScorecard(args: ScorecardArgs): Promise<Scorecard> {
    this.calls.push(args);
    if (this.failNext) {
      this.failNext = false;
      throw new Error("The usage numbers could not be read.");
    }
    const now = Date.now();
    const days = args.days ?? null;
    const pick = this.runs.filter(
      (r) =>
        (days === null || r.ageDays < days) &&
        (args.startedFrom === "all" || (args.startedFrom === "headless" ? r.headless : !r.headless)) &&
        (!args.agentType || r.spec.type === args.agentType),
    );
    const types: TypeCard[] = [];
    for (const s of SPECS) {
      const mine = pick.filter((r) => r.spec === s);
      if (mine.length === 0) continue;
      types.push(card(s, mine, now));
    }
    types.sort((a, b) => b.runs - a.runs || b.tokens.total - a.tokens.total);
    return { fromTs: days === null ? null : now - days * DAY, toTs: now, historyDays: 82, totalRuns: pick.length, types };
  }

  async teamThemes(_args: ThemeArgs): Promise<Themes> {
    const now = Date.now();
    const themes = THEMES.map((t, i) => ({ ...t, lastSeen: now - (i + 1) * DAY }));
    return { fromTs: null, findings: 31, total: themes.length, themes, made: { ...this.made } };
  }

  async ruleSheet(label: string, projects: string[]): Promise<RuleSheetData> {
    const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "review-rule";
    const line = `- Check before handing work back: ${label.replace(/^./, (c) => c.toUpperCase()).replace(/[.;:,]+$/, "")}.`;
    const targets: RuleSheetData["targets"] = [
      { id: "global", kind: "line", title: "CLAUDE.md in your Claude folder", path: "~/.claude/CLAUDE.md", stamp: "s-global", exists: true, text: line, blocked: null },
    ];
    projects.slice(0, 3).forEach((p, n) =>
      targets.push({ id: `project:${n}`, kind: "line", title: `CLAUDE.md in ${p}`, path: `~/Projects/${p}/CLAUDE.md`, stamp: `s-${p}`, exists: true, text: line, blocked: null }),
    );
    targets.push({
      id: "file",
      kind: "file",
      title: `A rule file, rules/${slug}.md`,
      path: `~/.claude/rules/${slug}.md`,
      stamp: "missing",
      exists: false,
      text: `# ${label.split(/\s+/).slice(0, 6).join(" ")}\n\n${line}\n`,
      blocked: null,
    });
    return { targets };
  }

  async ruleSave(args: RuleSave): Promise<RuleReply> {
    if (this.staleNext) {
      this.staleNext = false;
      return { status: "conflict", backupId: null, path: null, message: "This file changed since you opened it." };
    }
    this.saved.push(args);
    const path = args.targetId === "file" ? "~/.claude/rules/new-rule.md" : "~/.claude/CLAUDE.md";
    this.made[args.themeId] = { path, madeMs: Date.now() };
    return { status: "saved", backupId: `backup-${this.saved.length}`, path, message: null };
  }

  /** Is this backup id one a rule save handed out? (The mock backend's Undo asks.) */
  owns(backupId: string): boolean {
    return /^backup-\d+$/.test(backupId) && Number(backupId.slice(7)) <= this.saved.length;
  }

  async ruleForget(themeId: string): Promise<void> {
    this.forgotten.push(themeId);
    delete this.made[themeId];
  }
}

function card(s: Spec, mine: MockRun[], now: number): TypeCard {
  const n = mine.length;
  const total = s.tokensPerRun * n;
  const ends = {
    finished: mine.filter((r) => r.end === "finished").length,
    errored: mine.filter((r) => r.end === "errored").length,
    stopped: mine.filter((r) => r.end === "stopped").length,
    unknown: mine.filter((r) => r.end === null).length,
  };
  const known = ends.finished + ends.errored + ends.stopped;
  const weekly = Array(12).fill(0) as number[];
  for (const r of mine) {
    const w = 11 - Math.floor(r.ageDays / 7);
    if (w >= 0) weekly[w] += 1;
  }
  const tied = mine.filter((r) => r.review).length;
  const passed = mine.filter((r) => r.review === "passed").length;
  const projects = new Map<string, ProjectRuns>();
  for (const r of mine) {
    const p = projects.get(r.project) ?? { projectKey: r.project, name: r.project, runs: 0, tokens: 0 };
    p.runs += 1;
    p.tokens += s.tokensPerRun;
    projects.set(r.project, p);
  }
  const verdicts = s.reviewer
    ? {
        pass: mine.filter((r) => r.verdict === "pass").length,
        findings: mine.filter((r) => r.verdict === "findings").length,
        partial: 0,
        other: mine.filter((r) => r.verdict === "other").length,
        none: mine.filter((r) => r.verdict === null).length,
      }
    : null;
  const recent: RunRow[] = [...mine]
    .sort((a, b) => a.ageDays - b.ageDays)
    .slice(0, 20)
    .map((r) => ({
      sessionId: `mock-session-${s.type}-${r.i}`,
      agentId: r.i % 5 === 4 ? "" : `agent-${s.type}-${r.i}`,
      started: now - r.ageDays * DAY - 3_600_000,
      durationMs: s.minutes * 60_000 + r.i * 7_000,
      resumes: r.i % 6 === 0 ? 1 : 0,
      toolCalls: s.calls + r.i,
      endStatus: r.end,
      endSource: r.end ? "notice" : null,
      verdict: r.verdict,
      verdictWord: r.verdict === "other" ? "NEEDS-INFO" : null,
      tokens: s.tokensPerRun,
      cost: cost((s.tokensPerRun / 1_000_000) * 9),
      entrypoint: r.headless ? "sdk-cli" : "cli",
      headless: r.headless,
      projectKey: r.project,
      project: r.project,
      worktreeBranch: null,
      model: s.model,
    }));
  return {
    agentType: s.type,
    displayName: s.name,
    reviewer: s.reviewer,
    runs: n,
    ends,
    finishRate: known ? ends.finished / known : null,
    tooFewRuns: n < 3,
    toolCallsMedian: n < 3 ? null : s.calls,
    durationMsMedian: n < 3 ? null : s.minutes * 60_000,
    resumedRuns: mine.filter((r) => r.i % 6 === 0).length,
    tokens: tokens(total),
    cost: cost((total / 1_000_000) * 9),
    weekly,
    started: { interactive: mine.filter((r) => !r.headless).length, headless: mine.filter((r) => r.headless).length },
    verdicts,
    reviews: s.reviewer
      ? null
      : { tied, passed, sentBack: tied - passed, other: 0, notTied: n - tied, rateOk: tied >= 5 },
    projects: [...projects.values()].sort((a, b) => b.runs - a.runs),
    topModel: s.model,
    mix: [s.model],
    recent,
  };
}

const THEMES: Omit<ReviewTheme, "lastSeen">[] = [
  {
    id: "t-null-check",
    label: "Missing null check on the response before it is used",
    count: 7,
    runs: 4,
    severities: [
      { severity: "high", count: 3 },
      { severity: "medium", count: 4 },
    ],
    foundInWorkBy: [
      { agentType: "general-purpose", count: 4 },
      { agentType: "ui-builder", count: 2 },
    ],
    notTied: 1,
    reviewers: [{ agentType: "code-reviewer", count: 7 }],
    projects: ["atlas", "deskify"],
    examples: [
      { text: "The response can be null here and the next line reads a field from it.", sessionId: "mock-session-code-reviewer-0", agentId: "agent-code-reviewer-0", ts: Date.now() - DAY },
      { text: "No check that the reply exists before use.", sessionId: "mock-session-code-reviewer-1", agentId: "agent-code-reviewer-1", ts: Date.now() - 2 * DAY },
    ],
  },
  {
    id: "t-empty-state",
    label: "No empty state when the list has no rows",
    count: 5,
    runs: 3,
    severities: [
      { severity: "medium", count: 3 },
      { severity: "low", count: 2 },
    ],
    foundInWorkBy: [{ agentType: "ui-builder", count: 5 }],
    notTied: 0,
    reviewers: [{ agentType: "code-reviewer", count: 3 }, { agentType: "verifier", count: 2 }],
    projects: ["atlas"],
    examples: [{ text: "An empty list shows a blank pane, not a sentence.", sessionId: "mock-session-verifier-0", agentId: "agent-verifier-0", ts: Date.now() - 3 * DAY }],
  },
  {
    id: "t-tests",
    label: "Tests do not cover the failing path, only the happy one",
    count: 3,
    runs: 2,
    severities: [{ severity: "none", count: 3 }],
    foundInWorkBy: [{ agentType: "general-purpose", count: 2 }],
    notTied: 1,
    reviewers: [{ agentType: "verifier", count: 3 }],
    projects: ["willhenry"],
    examples: [],
  },
];
