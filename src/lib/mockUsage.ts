// Stand-in usage data for a plain browser and for tests. Deterministic: the same
// numbers every run, spread over the 60 days before "now". Nothing here is real.

import type {
  AgentDetail,
  AgentSummary,
  Bucket,
  Cost,
  Dashboard,
  FilterOptions,
  IndexProgress,
  ItemQuery,
  ItemUse,
  MainThread,
  MessagePoint,
  ModelUse,
  Period,
  PricingInfo,
  ProjectUse,
  SessionDetail,
  SessionPage,
  SessionQuery,
  SessionRow,
  Timeline,
  TimelinePoint,
  Tokens,
  TranscriptPage,
  UsageChanged,
  UsageStatus,
} from "./types";
import { addDays, localDay } from "./usage";

export type Scenario = "data" | "empty" | "indexing" | "error";

const MODELS = ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5"];
// USD per million tokens: input, output (cache writes 1.25x input, reads 0.1x).
const RATES: Record<string, [number, number]> = {
  "claude-sonnet-5-5": [2, 10],
  "claude-opus-5-5": [5, 25],
  "claude-haiku-5-5": [0.5, 2.5],
};
const PROJECTS = [
  { key: "-mock-atlas", name: "atlas", path: "C:/work/atlas" },
  { key: "-mock-site", name: "site", path: "C:/work/site" },
  { key: "-mock-bot", name: "helper-bot", path: "C:/work/helper-bot" },
  { key: "-mock-notes", name: "notes", path: "C:/work/notes" },
];

const zero = (): Tokens => ({
  input: 0,
  output: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  cacheRead: 0,
  total: 0,
  webSearch: 0,
  webFetch: 0,
});

function add(a: Tokens, b: Tokens): Tokens {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheWrite5m: a.cacheWrite5m + b.cacheWrite5m,
    cacheWrite1h: a.cacheWrite1h + b.cacheWrite1h,
    cacheRead: a.cacheRead + b.cacheRead,
    total: a.total + b.total,
    webSearch: a.webSearch + b.webSearch,
    webFetch: a.webFetch + b.webFetch,
  };
}

function costOf(model: string, t: Tokens): Cost {
  const [i, o] = RATES[model] ?? [0, 0];
  const usd = (t.input * i + t.output * o + t.cacheWrite5m * i * 1.25 + t.cacheRead * i * 0.1) / 1e6;
  return { usd, complete: true, unpricedTokens: 0 };
}

function sumCost(list: Cost[]): Cost {
  return { usd: list.reduce((s, c) => s + (c.usd ?? 0), 0), complete: true, unpricedTokens: 0 };
}

interface MockSession extends SessionRow {
  day: string;
  model: string;
  agents: MockAgent[];
  main: MainThread;
}

interface MockAgent extends AgentSummary {
  prompt: string;
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const TITLES = [
  "Fix the sidebar focus ring",
  "Add the export button",
  "Tidy the build script",
  "Why is startup slow",
  "Write the release notes",
  "Rename the settings keys",
];
const FIRST_PROMPTS = ["Look into why the build takes so long", "Add a dark mode toggle to the settings page", "Clean up the unused imports"];

// What a helper might be asked: [description or null, agent type or null, prompt].
const HELPERS: [string | null, string | null, string][] = [
  ["Find usages of the export button", "Explore", "Search the repo for every place the export button is built or styled and report the files and line numbers."],
  ["Review the sidebar changes", "code-reviewer", "Read the diff of the sidebar work and list anything that could break keyboard focus. Do not change files."],
  ["Plan the settings migration", "Plan", "Write a short step by step plan for renaming the settings keys without losing anyone's saved values."],
  ["Run the test suite and report failures", "general-purpose", "Run the whole test suite once and tell me which tests fail and the first error of each."],
  [null, "Explore", "Check how the release notes were written last time and what they covered."],
  [null, null, "Count how many places read the old settings key and say whether it is safe to remove."],
];

/** The spawn order of helpers inside one session, with the nested ones marked. */
function helpersFor(rand: () => number, start: number, endCap: number, mainModel: string): MockAgent[] {
  const n = 1 + Math.floor(rand() * 6);
  const out: MockAgent[] = [];
  for (let i = 0; i < n; i++) {
    const [description, agentType, prompt] = HELPERS[(i + Math.floor(rand() * HELPERS.length)) % HELPERS.length];
    const model = rand() < 0.6 ? MODELS[2] : rand() < 0.5 ? MODELS[0] : mainModel;
    const messages = 2 + Math.floor(rand() * 14);
    const per = (x: number) => Math.round(x * messages);
    const t = zero();
    t.input = per(80 + rand() * 300);
    t.output = per(60 + rand() * 260);
    t.cacheWrite5m = per(300 + rand() * 1200);
    t.cacheRead = per(4000 + rand() * 20000);
    t.total = t.input + t.output + t.cacheWrite5m + t.cacheWrite1h;
    const startedAt = start + Math.round(((endCap - start) * i) / (n + 1)) + 30_000;
    const durationMs = (1 + Math.floor(rand() * 12)) * 60_000;
    const nested = i > 0 && i % 3 === 2;
    const name = description ?? (agentType ? humanType(agentType) : summarize(prompt));
    out.push({
      agentId: `a${i}${Math.floor(rand() * 0xfffff).toString(16).padStart(5, "0")}`,
      name,
      nameSource: description ? "description" : agentType ? "type" : "prompt",
      agentType,
      description,
      toolUseId: `toolu_${i}`,
      parentAgentId: nested ? out[i - 1].agentId : null,
      spawnDepth: nested ? 2 : 1,
      model,
      models: [model],
      messages,
      tokens: t,
      cost: costOf(model, t),
      startedAt,
      endedAt: startedAt + durationMs,
      durationMs,
      toolCalls: per(0.6 + rand() * 2),
      missing: false,
      prompt,
    });
  }
  return out;
}

function humanType(t: string): string {
  const spaced = t.replace(/[-_]+/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function summarize(prompt: string): string {
  return prompt.length <= 60 ? prompt : `${prompt.slice(0, 57).trimEnd()}...`;
}

function build(now: Date): MockSession[] {
  const rand = rng(20261108);
  const out: MockSession[] = [];
  const today = localDay(now);
  for (let back = 0; back < 60; back++) {
    const day = addDays(today, -back);
    const n = back % 7 === 5 || back % 7 === 6 ? (rand() < 0.4 ? 1 : 0) : 1 + Math.floor(rand() * 3);
    for (let k = 0; k < n; k++) {
      const pick = rand();
      const model = pick < 0.25 ? MODELS[1] : pick < 0.45 ? MODELS[2] : MODELS[0];
      const p = PROJECTS[Math.floor(rand() * PROJECTS.length)];
      const messages = 8 + Math.floor(rand() * 120);
      const per = (x: number) => Math.round(x * messages);
      const t = zero();
      t.input = per(300 + rand() * 900);
      t.output = per(150 + rand() * 500);
      t.cacheWrite5m = per(800 + rand() * 2200);
      t.cacheRead = per(9000 + rand() * 40000);
      t.total = t.input + t.output + t.cacheWrite5m + t.cacheWrite1h;
      const [y, m, d] = day.split("-").map(Number);
      const start = new Date(y, m - 1, d, 8 + Math.floor(rand() * 11), Math.floor(rand() * 60)).getTime();
      const dur = (10 + Math.floor(rand() * 170)) * 60_000;
      const titlePick = rand();
      const titleIdx = Math.floor(rand() * TITLES.length);
      const hasHelpers = rand() < 0.3;
      const agents = hasHelpers ? helpersFor(rand, start, start + dur, model) : [];
      if (start > now.getTime()) continue;
      const main: MainThread = { messages, tokens: t, cost: costOf(model, t), toolCalls: Math.round(messages * 0.8) };
      const all = agents.reduce((acc, a) => add(acc, a.tokens), t);
      const models = [...new Set([model, ...agents.map((a) => a.model)])];
      const title = titlePick < 0.2 ? null : TITLES[titleIdx];
      const none = !title && titleIdx === 5;
      out.push({
        sessionId: `${(back * 10 + k + 1).toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`,
        title,
        name: title ?? (none ? null : FIRST_PROMPTS[titleIdx % FIRST_PROMPTS.length]),
        nameSource: title ? "title" : none ? "none" : "prompt",
        agentCount: agents.length,
        projectName: p.name,
        projectPath: p.path,
        startedAt: start,
        endedAt: Math.min(start + dur, now.getTime()),
        durationMs: Math.min(dur, now.getTime() - start),
        models,
        messages: messages + agents.reduce((s, a) => s + a.messages, 0),
        subagentMessages: agents.reduce((s, a) => s + a.messages, 0),
        tokens: all,
        cost: sumCost([main.cost, ...agents.map((a) => a.cost)]),
        missing: false,
        day,
        model,
        agents,
        main,
      });
    }
  }
  return out.sort((a, b) => b.startedAt - a.startedAt);
}

function periodOf(list: MockSession[]): Period {
  return {
    tokens: list.reduce((t, s) => add(t, s.tokens), zero()),
    cost: sumCost(list.map((s) => s.cost)),
    sessions: list.length,
  };
}

function publicRow(s: MockSession): SessionRow {
  const { day: _d, model: _m, agents: _a, main: _n, ...row } = s;
  void _d;
  void _m;
  void _a;
  void _n;
  return row;
}

const STATUS_IDLE: UsageStatus = {
  state: "idle",
  firstIndexDone: true,
  lastIndexedAt: 0,
  filesTracked: 61,
  filesMissing: 0,
  malformedLines: 0,
  longLines: 0,
  unknownModels: [],
  cwAssumedRows: 0,
  crossFileDupes: 0,
  cachePath: "C:/Users/you/AppData/Local/atlas/cache.sqlite",
  cacheBytes: 2_400_000,
  error: null,
  note: null,
};

export class MockUsage {
  scenario: Scenario = "data";
  /** Set to make the next list call fail once (tests for the error state). */
  failNext = false;
  /** Rows the engine answers with; replaceable in tests. */
  now = new Date();
  private sessions = build(this.now);
  private statusL = new Set<(s: UsageStatus) => void>();
  private progressL = new Set<(p: IndexProgress) => void>();
  private changedL = new Set<(c: UsageChanged) => void>();

  setScenario(s: Scenario): void {
    this.scenario = s;
    const st = this.status();
    this.statusL.forEach((l) => l(st));
  }

  emitProgress(p: IndexProgress): void {
    this.progressL.forEach((l) => l(p));
  }

  emitChanged(): void {
    this.changedL.forEach((l) => l({ sessionIds: [], fromDay: null, toDay: null, reason: "mock" }));
  }

  private data(): MockSession[] {
    return this.scenario === "empty" || this.scenario === "indexing" ? [] : this.sessions;
  }

  private guard(): void {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("The usage cache could not be read.");
    }
    if (this.scenario === "error") throw new Error("The usage cache could not be opened.");
  }

  status(): UsageStatus {
    switch (this.scenario) {
      case "indexing":
        return { ...STATUS_IDLE, state: "indexing", firstIndexDone: false, filesTracked: 0, lastIndexedAt: null };
      case "error":
        return { ...STATUS_IDLE, state: "error", error: "The usage cache could not be opened." };
      case "empty":
        return { ...STATUS_IDLE, filesTracked: 0 };
      default:
        return { ...STATUS_IDLE, lastIndexedAt: this.now.getTime() };
    }
  }

  async usageStatus(): Promise<UsageStatus> {
    return this.status();
  }

  async usageDashboard(): Promise<Dashboard> {
    this.guard();
    const all = this.data();
    const today = localDay(this.now);
    const wk = addDays(today, -6);
    const mo = addDays(today, -29);
    const by = new Map<string, MockSession[]>();
    all.filter((s) => s.day >= mo).forEach((s) => by.set(s.model, [...(by.get(s.model) ?? []), s]));
    const byModel: ModelUse[] = [...by.entries()]
      .map(([model, list]) => ({ model, known: true, tokens: periodOf(list).tokens, cost: periodOf(list).cost }))
      .sort((a, b) => b.cost.usd! - a.cost.usd!);
    const pj = new Map<string, MockSession[]>();
    all.filter((s) => s.day >= mo).forEach((s) => pj.set(s.projectName, [...(pj.get(s.projectName) ?? []), s]));
    const topProjects: ProjectUse[] = [...pj.entries()]
      .map(([name, list]) => {
        const p = PROJECTS.find((x) => x.name === name)!;
        const per = periodOf(list);
        return { projectKey: p.key, name, path: p.path, tokens: per.tokens, cost: per.cost, sessions: list.length };
      })
      .sort((a, b) => b.cost.usd! - a.cost.usd!)
      .slice(0, 5);
    return {
      today: periodOf(all.filter((s) => s.day === today)),
      week: periodOf(all.filter((s) => s.day >= wk)),
      month: periodOf(all.filter((s) => s.day >= mo)),
      byModel,
      topProjects,
      recent: all.slice(0, 5).map(publicRow),
      warnings: { unknownModels: [], unpricedTokens: 0 },
      todayDate: today,
    };
  }

  async usageTimeline(a: { from: string; to: string; bucket: Bucket; groupBy?: "model" | "project" }): Promise<Timeline> {
    this.guard();
    const points: TimelinePoint[] = [];
    const all = this.data();
    const key = (day: string): string => {
      if (a.bucket === "week") {
        const d = new Date(`${day}T12:00:00`);
        const back = (d.getDay() + 6) % 7;
        return addDays(day, -back);
      }
      return day;
    };
    if (a.bucket === "hour") {
      for (let h = 0; h < 24; h++) {
        const start = `${a.from}T${String(h).padStart(2, "0")}`;
        const list = all.filter((s) => s.day === a.from && new Date(s.startedAt).getHours() === h);
        const per = periodOf(list);
        points.push({ start, tokens: per.tokens, cost: per.cost, sessions: list.length });
      }
    } else {
      const starts: string[] = [];
      for (let d = a.from; d <= a.to; d = addDays(d, 1)) {
        const k = key(d);
        if (starts[starts.length - 1] !== k) starts.push(k);
      }
      for (const start of starts) {
        const list = all.filter((s) => s.day >= a.from && s.day <= a.to && key(s.day) === start);
        const per = periodOf(list);
        points.push({ start, tokens: per.tokens, cost: per.cost, sessions: list.length });
      }
    }
    let series: Timeline["series"] = null;
    if (a.groupBy && a.bucket !== "hour") {
      const starts = points.map((p) => p.start);
      const inRange = all.filter((s) => s.day >= a.from && s.day <= a.to);
      const keyOf = (s: MockSession): string => (a.groupBy === "model" ? s.model : PROJECTS.find((p) => p.name === s.projectName)!.key);
      const labelOf = (s: MockSession): string => (a.groupBy === "model" ? s.model : s.projectName);
      const keys = new Map<string, string>();
      for (const s of inRange) keys.set(keyOf(s), labelOf(s));
      series = [...keys.entries()].map(([k, label]) => ({
        key: k,
        label,
        points: starts.map((start) => {
          const list = inRange.filter((s) => keyOf(s) === k && key(s.day) === start);
          const per = periodOf(list);
          return { start, tokens: per.tokens, cost: per.cost, sessions: list.length };
        }),
      }));
    }
    return { bucket: a.bucket, points, series };
  }

  async sessionsList(q: SessionQuery): Promise<SessionPage> {
    this.guard();
    let rows = this.data().slice();
    // Title / project match OR a chat a message search found (the Rust `also_ids`).
    const t = q.text?.trim().toLowerCase();
    const also = new Set(q.alsoIds ?? []);
    if (t || also.size > 0) {
      rows = rows.filter(
        (s) =>
          also.has(s.sessionId) ||
          (t ? (s.name ?? "").toLowerCase().includes(t) || s.projectName.toLowerCase().includes(t) : false),
      );
    }
    if (q.projects?.length) rows = rows.filter((s) => q.projects!.includes(PROJECTS.find((p) => p.name === s.projectName)!.key));
    if (q.models?.length) rows = rows.filter((s) => q.models!.includes(s.model));
    if (q.from) rows = rows.filter((s) => s.day >= q.from!);
    if (q.to) rows = rows.filter((s) => s.day <= q.to!);
    const dir = q.dir === "asc" ? 1 : -1;
    const val = (s: MockSession): number =>
      q.sort === "cost" ? (s.cost.usd ?? 0) : q.sort === "tokens" ? s.tokens.total : q.sort === "duration" ? s.durationMs : s.startedAt;
    rows.sort((a, b) => (val(a) - val(b)) * dir);
    const limit = q.limit ?? 50;
    const at = q.cursor ? Number(q.cursor) : 0;
    const page = rows.slice(at, at + limit);
    return {
      rows: page.map(publicRow),
      nextCursor: at + limit < rows.length ? String(at + limit) : null,
      total: rows.length,
    };
  }

  private points(t: Tokens, model: string, messages: number, startedAt: number, durationMs: number, agentId: string | null): MessagePoint[] {
    const n = Math.max(1, Math.min(messages, 40));
    return Array.from({ length: n }, (_, i) => {
      const part: Tokens = {
        ...zero(),
        input: Math.round(t.input / n),
        output: Math.round(t.output / n),
        cacheWrite5m: Math.round(t.cacheWrite5m / n),
        cacheRead: Math.round(t.cacheRead / n),
      };
      part.total = part.input + part.output + part.cacheWrite5m;
      return { ts: startedAt + Math.round((durationMs * i) / n), model, agentId, tokens: part, cost: costOf(model, part), skill: null };
    });
  }

  private summary(a: MockAgent): AgentSummary {
    const { prompt: _p, ...rest } = a;
    void _p;
    return rest;
  }

  async sessionDetail(id: string): Promise<SessionDetail | null> {
    this.guard();
    const s = this.sessions.find((x) => x.sessionId === id);
    if (!s) return null;
    const timeline = [
      ...this.points(s.main.tokens, s.model, s.main.messages, s.startedAt, s.durationMs, null),
      ...s.agents.flatMap((a) => this.points(a.tokens, a.model, a.messages, a.startedAt, a.durationMs, a.agentId)),
    ].sort((x, y) => x.ts - y.ts);
    const byModel = new Map<string, { tokens: Tokens; costs: Cost[] }>();
    for (const part of [{ model: s.model, tokens: s.main.tokens, cost: s.main.cost }, ...s.agents.map((a) => ({ model: a.model, tokens: a.tokens, cost: a.cost }))]) {
      const cur = byModel.get(part.model) ?? { tokens: zero(), costs: [] };
      byModel.set(part.model, { tokens: add(cur.tokens, part.tokens), costs: [...cur.costs, part.cost] });
    }
    const dir = PROJECTS.find((p) => p.name === s.projectName)!.key;
    return {
      row: publicRow(s),
      byModel: [...byModel.entries()].map(([model, v]) => ({ model, tokens: v.tokens, cost: sumCost(v.costs) })),
      byAgent: [
        { agentId: null, messages: s.main.messages, tokens: s.main.tokens, cost: s.main.cost },
        ...s.agents.map((a) => ({ agentId: a.agentId, messages: a.messages, tokens: a.tokens, cost: a.cost })),
      ],
      agents: s.agents.map((a) => this.summary(a)),
      main: s.main,
      timeline,
      files: [
        { path: `projects/${dir}/${s.sessionId}.jsonl`, isSubagent: false, missing: false },
        ...s.agents.map((a) => ({ path: `projects/${dir}/${s.sessionId}/subagents/agent-${a.agentId}.jsonl`, isSubagent: true, missing: false })),
      ],
      claudeCodeCostUsd: s.cost.usd === null ? null : s.cost.usd * 1.02,
    };
  }

  async agentDetail(sessionId: string, agentId: string): Promise<AgentDetail | null> {
    this.guard();
    const s = this.sessions.find((x) => x.sessionId === sessionId);
    const a = s?.agents.find((x) => x.agentId === agentId);
    if (!s || !a) return null;
    const dir = PROJECTS.find((p) => p.name === s.projectName)!.key;
    return {
      sessionId,
      sessionName: s.name,
      projectName: s.projectName,
      agent: this.summary(a),
      parentName: a.parentAgentId ? (s.agents.find((x) => x.agentId === a.parentAgentId)?.name ?? null) : null,
      byModel: [{ model: a.model, tokens: a.tokens, cost: a.cost }],
      timeline: this.points(a.tokens, a.model, a.messages, a.startedAt, a.durationMs, a.agentId),
      file: { path: `projects/${dir}/${sessionId}/subagents/agent-${a.agentId}.jsonl`, isSubagent: true, missing: false },
      prompt: a.prompt,
      promptTruncated: false,
      sessionTokens: s.tokens,
      sessionCost: s.cost,
    };
  }

  /**
   * Skills, helper types and tools by use. The helper types and tool-call totals come from the
   * mock sessions; the skills are a fixed few spread over them so the Setup page has a mix of
   * used and idle ones.
   */
  async usageByItem(q: ItemQuery): Promise<ItemUse[]> {
    this.guard();
    const inRange = (day: string) => (!q.from || day >= q.from) && (!q.to || day <= q.to);
    const sessions = this.data().filter((s) => !q.sessionId || s.sessionId === q.sessionId);
    const acc = new Map<string, { uses: number; sessions: Set<string>; last: number }>();
    const bump = (id: string, s: MockSession, n: number, ts: number) => {
      const cur = acc.get(id) ?? { uses: 0, sessions: new Set<string>(), last: 0 };
      if (inRange(s.day)) {
        cur.uses += n;
        cur.sessions.add(s.sessionId);
      }
      cur.last = Math.max(cur.last, ts);
      acc.set(id, cur);
    };
    const SKILLS = ["ui-ux-pro-max", "orchestrate", "code-review", "build-and-verify"];
    sessions.forEach((s, i) => {
      if (q.kind === "agent") s.agents.forEach((a) => bump(a.agentType ?? "general-purpose", s, 1, a.startedAt));
      else if (q.kind === "skill") {
        if (i % 3 === 0) bump(SKILLS[i % SKILLS.length], s, 1 + (i % 2), s.startedAt);
      } else {
        const calls = s.main.toolCalls + s.agents.reduce((n, a) => n + a.toolCalls, 0);
        bump("Bash", s, Math.round(calls * 0.5), s.startedAt);
        bump("Read", s, Math.round(calls * 0.3), s.startedAt);
        bump("Edit", s, Math.round(calls * 0.2), s.startedAt);
        if (s.agents.length > 0) bump("Agent", s, s.agents.length, s.startedAt);
      }
    });
    return [...acc.entries()]
      .map(([id, v]) => ({ id, kind: q.kind, uses: v.uses, sessions: v.sessions.size, lastUsed: v.last || null }))
      .sort((a, b) => b.uses - a.uses || (b.lastUsed ?? 0) - (a.lastUsed ?? 0) || a.id.localeCompare(b.id))
      .slice(0, q.limit ?? 500);
  }

  async sessionTranscript(id: string, cursor?: string | null, limit = 50): Promise<TranscriptPage> {
    this.guard();
    const s = this.sessions.find((x) => x.sessionId === id);
    if (!s) return { items: [], nextCursor: null, sourceMissing: true };
    const at = cursor ? Number(cursor) : 0;
    const total = 120;
    const items = Array.from({ length: Math.min(limit, total - at) }, (_, i) => {
      const k = at + i;
      return {
        ts: s.startedAt + k * 30_000,
        role: k % 2 === 0 ? "user" : "assistant",
        agentId: null,
        text: k % 2 === 0 ? `Mock request number ${k / 2 + 1}.` : `Mock answer number ${(k + 1) / 2}. This text is made up for the stand-in backend.`,
        truncated: false,
      };
    });
    return { items, nextCursor: at + limit < total ? String(at + limit) : null, sourceMissing: false };
  }

  async usageFilterOptions(): Promise<FilterOptions> {
    return {
      projects: PROJECTS.map((p) => ({ projectKey: p.key, name: p.name, path: p.path })),
      models: MODELS.map((m) => ({ model: m, known: true })),
    };
  }

  async usageReindex(): Promise<UsageStatus> {
    return this.status();
  }

  async pricingGet(): Promise<PricingInfo> {
    return {
      table: { updated: "2026-11-08", currency: "USD", unit: "per million tokens", source: "Anthropic published prices" },
      path: "C:/Users/you/AppData/Local/atlas/pricing.json",
      error: null,
      newerSeedAvailable: false,
    };
  }

  async pricingReveal(): Promise<void> {}

  async onUsageStatus(cb: (s: UsageStatus) => void): Promise<() => void> {
    this.statusL.add(cb);
    return () => this.statusL.delete(cb);
  }

  async onUsageProgress(cb: (p: IndexProgress) => void): Promise<() => void> {
    this.progressL.add(cb);
    return () => this.progressL.delete(cb);
  }

  async onUsageChanged(cb: (c: UsageChanged) => void): Promise<() => void> {
    this.changedL.add(cb);
    return () => this.changedL.delete(cb);
  }
}
