// Stand-in chat search for a plain browser and for tests. Same behaviour as the Rust
// engine in the ways a screen can see: every word must match, the last word counts as a
// prefix while it is being typed (3+ letters), "quoted phrases" stay together, hits are
// ranked (shorter, denser messages first) then newest first, and a snippet is a short
// window with the matched words marked. All text below is invented (fixtureText).

import type { SearchHit, SearchPage, SearchStatus, SnippetPart } from "./searchTypes";

interface Doc {
  id: number;
  sessionId: string;
  agentId: string | null;
  project: string;
  ts: number;
  role: "user" | "assistant";
  text: string;
}

const DAY = 86_400_000;

function docs(now: number): Doc[] {
  const d = (
    id: number,
    sessionId: string,
    project: string,
    ageDays: number,
    role: "user" | "assistant",
    text: string,
    agentId: string | null = null,
  ): Doc => ({ id, sessionId, agentId, project, ts: now - ageDays * DAY, role, text });
  const P = "C:/Users/you/code/";
  return [
    d(1, "s-orchard", P + "orchard-api", 0.1, "user", "The retry loop in the sync worker keeps firing after a timeout. Can you find out why?"),
    d(2, "s-orchard", P + "orchard-api", 0.1, "assistant", "The retry loop never resets its backoff counter once a timeout is handled, so every later call starts at the longest delay. I would reset it on success."),
    d(3, "s-orchard", P + "orchard-api", 0.09, "user", "Reset it on success and add a test for the backoff."),
    d(4, "s-orchard", P + "orchard-api", 0.09, "assistant", "Done: the backoff resets after a good response, and the new test covers three timeouts in a row.", "agent-test"),
    d(5, "s-ledger", P + "ledger-web", 2, "user", "Dark mode flickers on first paint. The theme is applied after the page loads."),
    d(6, "s-ledger", P + "ledger-web", 2, "assistant", "Apply the theme in a script that runs before the first paint, from the saved setting, so the page never shows the wrong colors."),
    d(7, "s-ledger", P + "ledger-web", 1.9, "user", "Set the config key to ***, then restart the preview."),
    d(8, "s-harbor", P + "harbor-cli", 9, "user", "Write a flaky test detector: run the failing test ten times and report how many passed."),
    d(9, "s-harbor", P + "harbor-cli", 9, "assistant", "The detector runs the test ten times, counts passes, and prints a short report. A test that passes some of the ten runs is flagged as flaky."),
    d(10, "s-harbor", P + "harbor-cli", 8, "user", "Make the report show the slowest run too."),
    d(11, "s-quay", P + "quay-desktop", 30, "user", "Explain how the install step finds the config folder on Windows."),
    d(12, "s-quay", P + "quay-desktop", 30, "assistant", "It checks the command-line flag first, then the environment variable, then the default folder in the home directory."),
  ];
}

const fold = (s: string): string => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const words = (s: string): string[] => fold(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const MIN_PREFIX = 3;

interface Term {
  words: string[];
  prefix: boolean;
}

/** The same rules as `parse_terms` in query.rs. */
export function parseQuery(input: string): Term[] {
  const raw: { text: string; phrase: boolean }[] = [];
  let cur = "";
  let inPhrase = false;
  const flush = (phrase: boolean) => {
    if (/[\p{L}\p{N}]/u.test(cur) && raw.length < 16) raw.push({ text: cur, phrase });
    cur = "";
  };
  for (const c of input) {
    if (c === '"') {
      flush(inPhrase);
      inPhrase = !inPhrase;
    } else if (/\s/.test(c) && !inPhrase) {
      flush(false);
    } else {
      cur += c;
    }
  }
  flush(inPhrase);
  const typing = !/\s$/.test(input) && !input.trimEnd().endsWith('"');
  return raw.map((r, i) => ({
    words: words(r.text),
    prefix: i === raw.length - 1 && !r.phrase && typing && [...r.text].length >= MIN_PREFIX,
  }));
}

function phraseAt(tokens: string[], t: Term, at: number): boolean {
  return t.words.every((w, k) => {
    const tok = tokens[at + k];
    if (tok === undefined) return false;
    return t.prefix && k === t.words.length - 1 ? tok.startsWith(w) : tok === w;
  });
}

function snippetOf(text: string, terms: Term[]): SnippetPart[] {
  const wanted = terms.flatMap((t) => t.words.map((w, k) => ({ w, prefix: t.prefix && k === t.words.length - 1 })));
  const re = /[\p{L}\p{N}]+/gu;
  const spans: { a: number; b: number; hit: boolean }[] = [];
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const w = fold(m[0]);
    spans.push({ a: m.index, b: m.index + m[0].length, hit: wanted.some((x) => (x.prefix ? w.startsWith(x.w) : w === x.w)) });
  }
  const first = spans.find((s) => s.hit);
  const from = Math.max(0, (first?.a ?? 0) - 70);
  const to = Math.min(text.length, from + 190);
  const out: SnippetPart[] = [];
  const push = (t: string, hit: boolean) => {
    if (!t) return;
    const last = out[out.length - 1];
    if (last && last.hit === hit) last.text += t;
    else out.push({ text: t, hit });
  };
  if (from > 0) push("...", false);
  let at = from;
  for (const s of spans.filter((x) => x.hit && x.a >= from && x.b <= to)) {
    push(text.slice(at, s.a), false);
    push(text.slice(s.a, s.b), true);
    at = s.b;
  }
  push(text.slice(at, to), false);
  if (to < text.length) push("...", false);
  return out;
}

const baseName = (p: string): string => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";

export class MockSearch {
  /** Set to make the next search fail once (for an error state). */
  failNext = false;
  private all = docs(Date.now());
  private statusL = new Set<(s: SearchStatus) => void>();
  private state: SearchStatus = {
    state: "idle",
    ready: true,
    filesDone: 4,
    filesTotal: 4,
    bytesDone: 1_200_000,
    bytesTotal: 1_200_000,
    messages: 12,
    dbBytes: 90_000,
    lastIndexedAt: Date.now(),
    error: null,
  };

  setStatus(s: Partial<SearchStatus>): void {
    this.state = { ...this.state, ...s };
    this.statusL.forEach((l) => l(this.state));
  }

  async searchStatus(): Promise<SearchStatus> {
    return this.state;
  }

  async onSearchStatus(cb: (s: SearchStatus) => void): Promise<() => void> {
    this.statusL.add(cb);
    return () => this.statusL.delete(cb);
  }

  async searchChats(query: string, limit = 20, offset = 0): Promise<SearchPage> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("Chat search failed.");
    }
    const started = performance.now();
    const terms = parseQuery(query);
    const ranked = terms.length === 0 ? [] : this.all
      .map((d) => {
        const tokens = words(d.text);
        let score = 0;
        for (const t of terms) {
          let n = 0;
          for (let i = 0; i < tokens.length; i++) if (phraseAt(tokens, t, i)) n++;
          if (n === 0) return null;
          score += n / Math.sqrt(tokens.length);
        }
        return { d, score };
      })
      .filter((x): x is { d: Doc; score: number } => x !== null)
      .sort((a, b) => b.score - a.score || b.d.ts - a.d.ts);
    const n = Math.min(Math.max(limit, 1), 50);
    const page = ranked.slice(offset, offset + n);
    const hits: SearchHit[] = page.map(({ d }) => ({
      id: d.id,
      sessionId: d.sessionId,
      agentId: d.agentId,
      project: d.project,
      projectName: baseName(d.project),
      ts: d.ts,
      role: d.role,
      snippet: snippetOf(d.text, terms),
    }));
    return { hits, hasMore: ranked.length > offset + n, tookMs: Math.round(performance.now() - started), index: this.state };
  }
}
