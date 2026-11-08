// Stand-in usage data for a plain browser and for tests. Deterministic: the same
// numbers every run, spread over the 60 days before "now". Nothing here is real.

import type {
  Bucket,
  Cost,
  Dashboard,
  FilterOptions,
  IndexProgress,
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
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
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
      if (start > now.getTime()) continue;
      out.push({
        sessionId: `${(back * 10 + k + 1).toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`,
        title: rand() < 0.2 ? null : ["Fix the sidebar focus ring", "Add the export button", "Tidy the build script", "Why is startup slow", "Write the release notes", "Rename the settings keys"][Math.floor(rand() * 6)],
        projectName: p.name,
        projectPath: p.path,
        startedAt: start,
        endedAt: Math.min(start + dur, now.getTime()),
        durationMs: Math.min(dur, now.getTime() - start),
        models: [model],
        messages,
        subagentMessages: rand() < 0.3 ? Math.floor(messages / 4) : 0,
        tokens: t,
        cost: costOf(model, t),
        missing: false,
        day,
        model,
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
  const { day: _d, model: _m, ...row } = s;
  void _d;
  void _m;
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

  async usageTimeline(a: { from: string; to: string; bucket: Bucket }): Promise<Timeline> {
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
    return { bucket: a.bucket, points, series: null };
  }

  async sessionsList(q: SessionQuery): Promise<SessionPage> {
    this.guard();
    let rows = this.data().slice();
    if (q.text) {
      const t = q.text.toLowerCase();
      rows = rows.filter((s) => (s.title ?? "").toLowerCase().includes(t) || s.projectName.toLowerCase().includes(t));
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

  async sessionDetail(id: string): Promise<SessionDetail | null> {
    this.guard();
    const s = this.sessions.find((x) => x.sessionId === id);
    if (!s) return null;
    const n = Math.min(s.messages, 40);
    const timeline = Array.from({ length: n }, (_, i) => {
      const t: Tokens = {
        ...zero(),
        input: Math.round(s.tokens.input / n),
        output: Math.round(s.tokens.output / n),
        cacheWrite5m: Math.round(s.tokens.cacheWrite5m / n),
        cacheRead: Math.round(s.tokens.cacheRead / n),
      };
      t.total = t.input + t.output + t.cacheWrite5m;
      return {
        ts: s.startedAt + Math.round((s.durationMs * i) / n),
        model: s.model,
        agentId: null,
        tokens: t,
        cost: costOf(s.model, t),
        skill: null,
      };
    });
    return {
      row: publicRow(s),
      byModel: [{ model: s.model, tokens: s.tokens, cost: s.cost }],
      byAgent: [
        { agentId: null, messages: s.messages, tokens: s.tokens, cost: s.cost },
        ...(s.subagentMessages > 0
          ? [{ agentId: "agent-a1", messages: s.subagentMessages, tokens: { ...zero(), input: 1200, output: 800, total: 2000 }, cost: { usd: 0.01, complete: true, unpricedTokens: 0 } }]
          : []),
      ],
      timeline,
      files: [{ path: `projects/${PROJECTS.find((p) => p.name === s.projectName)!.key}/${s.sessionId}.jsonl`, isSubagent: false, missing: false }],
      claudeCodeCostUsd: s.cost.usd === null ? null : s.cost.usd * 1.02,
    };
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
