import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import { App } from "../App";
import { AtlasProvider } from "../state/AtlasProvider";
import { resetToasts } from "../state/toastStore";
import { setBackend } from "../lib/ipc";
import { MockBackend } from "../lib/mock";
import { ago, clock, groupChats } from "../lib/nowFormat";
import type { NowChat, NowHelper, NowLast, NowSnapshot, NowStep } from "../lib/nowTypes";

function step(id: string, verb: string, target: string | null, over: Partial<NowStep> = {}): NowStep {
  return { id, kind: "edit", verb, target, tsMs: Date.now(), done: true, count: 1, by: null, ...over };
}

function chat(over: Partial<NowChat> = {}): NowChat {
  return {
    sessionId: "s1",
    title: "Fix the build",
    project: "atlas",
    model: "claude-opus-4-5",
    state: "working",
    startedMs: Date.now() - 65_000,
    workedMs: null,
    lastWriteMs: Date.now(),
    doing: { kind: "edit", verb: "Editing", target: "src/App.tsx" },
    tokens: 1234,
    costUsd: 0.42,
    unpriced: false,
    helpers: [],
    files: [{ path: "src/App.tsx", edited: true }],
    steps: [step("a", "Reading", "Cargo.toml"), step("b", "Editing", "src/App.tsx", { done: false })],
    ...over,
  };
}

function waiting(over: Partial<NowChat> = {}): NowChat {
  return chat({
    sessionId: "w1",
    title: "Write the notes",
    state: "waiting",
    startedMs: null,
    workedMs: 134_000,
    lastWriteMs: Date.now() - 4 * 60_000,
    doing: { kind: "wait", verb: "Waiting for you", target: null },
    tokens: 48_200,
    ...over,
  });
}

function helper(over: Partial<NowHelper> = {}): NowHelper {
  return {
    id: "h1",
    name: "Find the callers",
    doing: { kind: "search", verb: "Searching", target: "run_loop" },
    tokens: 115,
    costUsd: 0.03,
    startedMs: Date.now() - 5_000,
    done: false,
    agentType: "Explore",
    goal: "Find the callers",
    toolCalls: 3,
    plan: null,
    typical: null,
    phase: "Reading",
    lastLineMs: Date.now(),
    openCall: null,
    model: "claude-opus-5-5",
    effort: "high",
    ...over,
  };
}

function done(over: Partial<NowLast> = {}): NowLast {
  return { sessionId: "d1", title: "Old chat", project: "site", model: null, endedMs: Date.now() - 3 * 60_000, tokens: null, ...over };
}

function snap(over: Partial<NowSnapshot> = {}): NowSnapshot {
  return { chats: [], last: null, recent: [], watching: true, ...over };
}

function mount(first?: NowSnapshot) {
  localStorage.setItem("atlas.mock.settings", JSON.stringify({ lastView: "now" }));
  const backend = new MockBackend();
  if (first) backend.now.push(first);
  setBackend(backend);
  render(
    <AtlasProvider>
      <App />
    </AtlasProvider>,
  );
  return backend;
}

beforeEach(() => {
  localStorage.clear();
  resetToasts();
  document.documentElement.removeAttribute("data-theme");
});
afterEach(() => setBackend(null));

describe("Now", () => {
  it("shows what the chat is doing, its tokens and its recent steps", async () => {
    mount(snap({ chats: [chat()] }));
    expect(await screen.findByText("Editing", { selector: ".nc-verb" })).toBeInTheDocument();
    expect(screen.getByText("src/App.tsx", { selector: ".nc-target" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "Fix the build" })).toBeInTheDocument();
    expect(screen.getByText("1.2k", { selector: ".nc-spend-fig" })).toBeInTheDocument();
    // Tokens, not dollars: money only lives in the hover, called an estimate.
    expect(screen.queryByText(/\$/)).toBeNull();
    expect(screen.getByTitle(/An estimate, not a bill/)).toBeInTheDocument();
    const trail = screen.getByRole("list", { name: "Recent steps" });
    expect(within(trail).getAllByRole("listitem")).toHaveLength(2);
  });

  it("adds a step to the trail when the engine pushes one", async () => {
    const backend = mount(snap({ chats: [chat()] }));
    await screen.findByRole("list", { name: "Recent steps" });
    act(() => {
      backend.now.push(
        snap({
          chats: [
            chat({
              doing: { kind: "run", verb: "Running", target: "cargo" },
              steps: [...chat().steps, step("c", "Running", "cargo", { kind: "run", done: false })],
            }),
          ],
        }),
      );
    });
    expect(await screen.findByText("Running", { selector: ".nc-verb" })).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Recent steps" })).getAllByRole("listitem")).toHaveLength(3);
  });

  it("lists a helper that is out under the chat, not inside its card", async () => {
    mount(snap({ chats: [chat({ helpers: [helper()] })] }));
    const list = await screen.findByRole("region", { name: "Helpers at work" });
    expect(within(list).getByText("Explore")).toBeInTheDocument();
    expect(within(list).getByText("Find the callers")).toBeInTheDocument();
    expect(within(list).getByText("115", { selector: ".ht-tokens" })).toBeInTheDocument();
    expect(within(list).getByText("No past runs to compare")).toBeInTheDocument();
    // The card keeps its chip and its files; the helper's row is not in it any more.
    const card = screen.getByRole("article", { name: "Fix the build" });
    expect(within(card).getByText("1 helper")).toBeInTheDocument();
    expect(card.querySelector(".ht-row")).toBeNull();
  });

  it("draws no list at all while no helper is running", async () => {
    mount(snap({ chats: [chat()] }));
    await screen.findByRole("article", { name: "Fix the build" });
    expect(screen.queryByRole("region", { name: "Helpers at work" })).toBeNull();
  });

  it("a chat whose own turn ended but whose helpers are working is running, with every helper listed", async () => {
    const six = Array.from({ length: 6 }, (_, i) => helper({ id: `h${i}`, goal: `Job ${i}`, startedMs: Date.now() - (6 - i) * 60_000 }));
    mount(snap({ chats: [chat({ doing: { kind: "helper", verb: "Waiting on 6 helpers", target: null }, helpers: six })] }));
    const running = await screen.findByRole("region", { name: "Running" });
    expect(within(running).getByText("Waiting on 6 helpers", { selector: ".nc-verb" })).toBeInTheDocument();
    const list = await screen.findByRole("region", { name: "Helpers at work" });
    expect(list.querySelectorAll(".ht-row")).toHaveLength(6);
    expect(screen.queryByRole("region", { name: "Waiting for you" })).toBeNull();
  });

  it("keeps running, waiting and finished chats in three separate groups", async () => {
    mount(
      snap({
        chats: [chat(), waiting({ model: "claude-opus-5-5", effort: "high" })],
        recent: [done({ tokens: 9_870 }), done({ sessionId: "d2", title: "Older chat", endedMs: Date.now() - 2 * 3_600_000 })],
      }),
    );
    const running = await screen.findByRole("region", { name: "Running" });
    expect(within(running).getByRole("heading", { level: 3, name: "Fix the build" })).toBeInTheDocument();
    expect(within(running).queryByText("Write the notes")).toBeNull();

    const wait = screen.getByRole("region", { name: "Waiting for you" });
    const waitRow = within(wait).getByRole("listitem");
    expect(within(waitRow).getByRole("heading", { level: 3, name: "Write the notes" })).toBeInTheDocument();
    expect(within(waitRow).getByText("Waiting for you")).toBeInTheDocument();
    expect(within(waitRow).getByText("48k")).toBeInTheDocument();
    expect(within(waitRow).getByText("4 min")).toBeInTheDocument();
    // Same model chip as the running and finished cards.
    expect(within(waitRow).getByText("Opus 5.5 · high")).toHaveClass("chip");

    const fin = screen.getByRole("region", { name: "Finished recently" });
    const rows = within(fin).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText("9.9k")).toBeInTheDocument();
    // A chat Atlas only read the tail of has no token total rather than a wrong one: a quiet dash holds
    // the slot so the rows line up, and the hover says why.
    const dash = within(rows[1]!).getByText("-");
    expect(dash.closest(".now-stat")).toHaveAttribute("title", expect.stringMatching(/not watching/));
    expect(dash.closest(".now-stat")).toHaveAttribute("data-dim");
    expect(within(rows[1]!).getByText("2 h")).toBeInTheDocument();
  });

  it("keeps the files being edited with the doing block, not alone at the far edge", async () => {
    mount(snap({ chats: [chat({ files: [{ path: "src/totals.ts", edited: true }] })] }));
    const card = await screen.findByRole("article", { name: "Fix the build" });
    const doing = within(card).getByRole("region", { name: "Doing now" });
    expect(within(doing).getByText("src/totals.ts")).toBeInTheDocument();
  });

  it("with only waiting chats, the waiting list is the page", async () => {
    mount(snap({ chats: [waiting()] }));
    await screen.findByRole("region", { name: "Waiting for you" });
    expect(screen.queryByRole("region", { name: "Running" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Nothing running" })).toBeNull();
  });

  it("rests on a calm empty state with the finished chats beneath", async () => {
    mount(snap({ last: done(), recent: [done()] }));
    expect(await screen.findByRole("heading", { level: 2, name: "Nothing running" })).toBeInTheDocument();
    expect(screen.getByText(/^Last chat ended 3 min ago$/)).toBeInTheDocument();
    const fin = screen.getByRole("region", { name: "Finished recently" });
    expect(within(fin).getByRole("heading", { level: 3, name: "Old chat" })).toBeInTheDocument();
    expect(screen.queryByText(/no chats are running|start a chat/i)).not.toBeInTheDocument();
  });

  it("says no chats yet when there is nothing at all", async () => {
    mount(snap());
    expect(await screen.findByRole("heading", { level: 2, name: "No chats yet" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Finished recently" })).toBeNull();
  });

  it("never says Live", async () => {
    mount(snap({ chats: [chat(), waiting()], recent: [done()] }));
    await screen.findByRole("list", { name: "Recent steps" });
    expect(document.body.textContent).not.toMatch(/\blive\b/i);
  });

  it("says so when there is no Claude folder", async () => {
    mount(snap({ watching: false }));
    expect(await screen.findByRole("heading", { level: 2, name: "No Claude folder found" })).toBeInTheDocument();
  });

  it("shows compact cards for more than three running chats", async () => {
    const many = ["a", "b", "c", "d"].map((id) => chat({ sessionId: id, title: `Chat ${id}` }));
    mount(snap({ chats: many }));
    await screen.findByRole("heading", { level: 3, name: "Chat d" });
    expect(document.querySelector(".now-grid")).not.toBeNull();
    expect(document.querySelector(".now-stack")).toBeNull();
  });

  it("toasts when a chat finishes, and says when it asks a question", async () => {
    const backend = mount(snap());
    await screen.findByRole("heading", { level: 2, name: "No chats yet" });
    act(() => backend.now.finish({ sessionId: "s1", name: "Fix the build", project: "atlas", kind: "done", workedMs: 90_000 }));
    expect(await screen.findByText("Fix the build finished")).toBeInTheDocument();
    act(() => backend.now.finish({ sessionId: "s2", name: "Write the notes", project: "atlas", kind: "ask", workedMs: null }));
    expect(await screen.findByText("Write the notes has a question for you")).toBeInTheDocument();
  });
});

describe("nowFormat", () => {
  it("formats a running clock", () => {
    expect(clock(0)).toBe("0:00");
    expect(clock(65_000)).toBe("1:05");
    expect(clock(3_725_000)).toBe("1:02:05");
    expect(clock(-5)).toBe("0:00");
  });
  it("says how long ago", () => {
    const now = 1_000_000_000;
    expect(ago(now - 10_000, now)).toBe("just now");
    expect(ago(now - 3 * 60_000, now)).toBe("3 min ago");
  });
  it("groups a snapshot and falls back to the single last chat", () => {
    const g = groupChats(snap({ chats: [chat(), waiting()], last: done(), recent: [] }));
    expect(g.running.map((c) => c.sessionId)).toEqual(["s1"]);
    expect(g.waiting.map((c) => c.sessionId)).toEqual(["w1"]);
    expect(g.finished.map((l) => l.sessionId)).toEqual(["d1"]);
    expect(groupChats(snap()).finished).toEqual([]);
  });
});

describe("useSteadyDoing", () => {
  it("does not blink or re-animate when the same call repeats many times a second", async () => {
    const { renderHook } = await import("@testing-library/react");
    const { vi } = await import("vitest");
    const { useSteadyDoing } = await import("./Now");
    vi.useFakeTimers();
    try {
      const tool = { kind: "tool", verb: "Using Browser", target: null };
      const think = { kind: "think", verb: "Thinking", target: null };
      const { result, rerender } = renderHook(({ d }) => useSteadyDoing(d), { initialProps: { d: tool } });
      const key0 = result.current.swapKey;
      for (let i = 0; i < 20; i++) {
        rerender({ d: { ...think } });
        act(() => void vi.advanceTimersByTime(50));
        rerender({ d: { ...tool } });
        act(() => void vi.advanceTimersByTime(50));
        expect(result.current.doing.verb).toBe("Using Browser");
      }
      expect(result.current.swapKey).toBe(key0);
      // A real pause does reach "Thinking".
      rerender({ d: think });
      act(() => void vi.advanceTimersByTime(1300));
      expect(result.current.doing.verb).toBe("Thinking");
    } finally {
      vi.useRealTimers();
    }
  });
});
