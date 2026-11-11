import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { HelperTracker } from "./HelperTracker";
import { FILL_CAP, modelEffort, progressOf, statusOf, STUCK_MS, typeName } from "../../lib/helperProgress";
import { PHASE_HOLD_MS } from "../../lib/useSteadyDoing";
import type { NowChat, NowHelper } from "../../lib/nowTypes";

const T0 = Date.parse("2026-11-09T12:00:00Z");

function helper(over: Partial<NowHelper> = {}): NowHelper {
  return {
    id: "h1",
    name: "Review the diff",
    doing: { kind: "read", verb: "Reading", target: "a.ts" },
    tokens: 1200,
    tokenKinds: { input: 1200, output: 0, cacheWrite: 0, cacheRead: 0 },
    costUsd: 0.1,
    startedMs: T0 - 60_000,
    done: false,
    agentType: "code-reviewer",
    goal: "Review the diff",
    toolCalls: 12,
    plan: null,
    typical: { calls: 20, ms: 210_000, runs: 6 },
    phase: "Reading",
    lastLineMs: T0,
    openCall: null,
    model: "claude-opus-5-5",
    effort: "high",
    ...over,
  };
}

function chat(helpers: NowHelper[], over: Partial<NowChat> = {}): NowChat {
  return {
    sessionId: "s1",
    title: "Fix the build",
    project: "atlas",
    model: null,
    state: "working",
    startedMs: T0 - 90_000,
    workedMs: null,
    lastWriteMs: T0,
    doing: { kind: "helper", verb: "Waiting on a helper", target: null },
    tokens: 1,
    tokenKinds: { input: 1, output: 0, cacheWrite: 0, cacheRead: 0 },
    costUsd: null,
    unpriced: false,
    helpers,
    files: [],
    steps: [],
    ...over,
  };
}

afterEach(() => {
  vi.useRealTimers();
  document.documentElement.classList.remove("reduced");
});

describe("progress words", () => {
  it("uses the helper's own plan once it has moved: Step N of M", () => {
    const p = progressOf(helper({ plan: { done: 2, total: 5 } }));
    expect(p).toMatchObject({ kind: "plan", text: "Step 3 of 5", fill: 0.4 });
  });

  it("never fills a plan to the end while the helper still runs: only finishing completes the trail", () => {
    // Every step ticked, helper not yet ended: still capped, and still "Step 5 of 5".
    const p = progressOf(helper({ plan: { done: 5, total: 5 } }));
    expect(p).toMatchObject({ kind: "plan", text: "Step 5 of 5", fill: FILL_CAP });
    expect(progressOf(helper({ plan: { done: 4, total: 5 } })).fill).toBeCloseTo(0.8);
    expect(progressOf(helper({ plan: { done: 1, total: 5 } })).fill).toBeCloseTo(0.2);
  });

  it("says just started, not a percentage, before a twentieth of a typical run", () => {
    // 0 calls against a median of 20 is nothing to report.
    expect(progressOf(helper({ toolCalls: 0 }))).toMatchObject({ kind: "typical", text: "Just started", fill: 0 });
    // 1 call of 40 is 2.5 %: still just started. 2 of 40 is 5 %: the first percentage, 10.
    const t = { calls: 40, ms: 100_000, runs: 9 };
    expect(progressOf(helper({ toolCalls: 1, typical: t })).text).toBe("Just started");
    expect(progressOf(helper({ toolCalls: 2, typical: t })).text).toBe("About 10% of a typical run");
  });

  it("compares tool calls with a typical run, in tens", () => {
    // 12 calls against a median of 20 is 60 %.
    const p = progressOf(helper());
    expect(p.text).toBe("About 60% of a typical run");
    expect(p.fill).toBeCloseTo(0.6);
    expect(p.hint).toBe("A typical code reviewer run: 20 tool calls, 4 min (median of 6 runs).");
    // Barely started still reads 10 %; nearly there still reads 90 %.
    expect(progressOf(helper({ toolCalls: 1 })).text).toBe("About 10% of a typical run");
    expect(progressOf(helper({ toolCalls: 19 })).text).toBe("About 90% of a typical run");
  });

  it("says longer than a typical run at and past the median, and caps the fill", () => {
    for (const calls of [20, 25]) {
      const p = progressOf(helper({ toolCalls: calls }));
      expect(p.text).toBe("Longer than a typical run");
      expect(p.fill).toBe(0.9);
    }
  });

  it("with too few past runs has nothing to compare and draws no fill", () => {
    const p = progressOf(helper({ typical: null }));
    expect(p).toMatchObject({ kind: "none", fill: null, text: "No past runs to compare" });
  });

  it("names a kind of helper in words", () => {
    expect(typeName("general-purpose")).toBe("General purpose");
    expect(typeName("Explore")).toBe("Explore");
    expect(typeName(null)).toBe("Helper");
  });
});

describe("model and effort", () => {
  it("reads as the exact model and the effort the transcript says", () => {
    expect(modelEffort({ model: "claude-opus-5-5", effort: "high" })).toBe("Opus 5.5, high effort");
    expect(modelEffort({ model: "claude-sonnet-5-5", effort: "medium" })).toBe("Sonnet 5.5, medium effort");
  });

  it("leaves out what the lines do not say, and shows nothing when they say neither", () => {
    expect(modelEffort({ model: "claude-opus-5-5", effort: null })).toBe("Opus 5.5");
    expect(modelEffort({ model: null, effort: "high" })).toBe("high effort");
    expect(modelEffort({ model: null, effort: null })).toBeNull();
  });

  it("never shows a family-only label", () => {
    for (const model of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"]) {
      const text = modelEffort({ model, effort: null })!;
      expect(text).toMatch(/^[A-Z][a-z]+ \d+(\.\d+)?$/);
    }
  });

  it("shows on the row, with the raw id on hover", () => {
    render(<HelperTracker chats={[chat([helper()])]} />);
    const m = screen.getByText("Opus 5.5, high effort", { selector: ".ht-model" });
    expect(m).toHaveAttribute("title", "claude-opus-5-5");
  });

  it("draws no model text at all when the helper's lines name neither", () => {
    const { container } = render(<HelperTracker chats={[chat([helper({ model: null, effort: null })])]} />);
    expect(container.querySelector(".ht-model")).toBeNull();
  });
});

describe("the stuck hint", () => {
  it("is the phase word until five quiet minutes", () => {
    expect(statusOf(helper({ lastLineMs: T0 - STUCK_MS + 1 }), T0)).toEqual({ text: "Reading", tone: "phase" });
  });

  it("says no progress after five minutes with nothing open, in the warning tone", () => {
    expect(statusOf(helper({ lastLineMs: T0 - STUCK_MS }), T0)).toEqual({ text: "No progress for 5 min", tone: "warning" });
    expect(statusOf(helper({ lastLineMs: T0 - 6.5 * 60_000 }), T0).text).toBe("No progress for 6 min");
  });

  it("says a long command is running, calmly, when a call is open", () => {
    const open = { kind: "run", word: "cargo" };
    expect(statusOf(helper({ lastLineMs: T0 - STUCK_MS, openCall: open }), T0)).toEqual({ text: "Running cargo for 5 min", tone: "calm" });
  });

  it("shows on the row, and the minutes follow the clock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    render(<HelperTracker chats={[chat([helper({ lastLineMs: T0 - STUCK_MS + 30_000 })])]} />);
    expect(screen.getByText("Reading", { selector: ".ht-status" })).toBeInTheDocument();
    act(() => void vi.advanceTimersByTime(30_000));
    expect(screen.getByText("No progress for 5 min", { selector: ".ht-status" })).toHaveAttribute("data-tone", "warning");
    act(() => void vi.advanceTimersByTime(60_000));
    expect(screen.getByText("No progress for 6 min")).toBeInTheDocument();
  });

  it("names the open call, never a command line", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const quiet = helper({ lastLineMs: T0 - STUCK_MS, openCall: { kind: "run", word: "cargo" } });
    render(<HelperTracker chats={[chat([quiet])]} />);
    expect(screen.getByText("Running cargo for 5 min")).toHaveAttribute("data-tone", "calm");
  });
});

describe("the list", () => {
  it("shows one row per helper, oldest first, named by chat only when two chats have helpers", () => {
    const a = helper({ id: "a", goal: "Second one", startedMs: T0 - 10_000 });
    const b = helper({ id: "b", goal: "First one", startedMs: T0 - 50_000 });
    const { rerender } = render(<HelperTracker chats={[chat([a, b])]} />);
    expect(Array.from(document.querySelectorAll(".ht-goal")).map((g) => g.textContent)).toEqual(["First one", "Second one"]);
    expect(document.querySelector(".ht-chat")).toBeNull();
    rerender(<HelperTracker chats={[chat([a]), chat([b], { sessionId: "s2", title: "Other chat" })]} />);
    expect(screen.getByText("Fix the build", { selector: ".ht-chat" })).toBeInTheDocument();
    expect(screen.getByText("Other chat", { selector: ".ht-chat" })).toBeInTheDocument();
  });

  it("lets a screen reader read the row: no label that replaces its progress, status and model", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    render(<HelperTracker chats={[chat([helper()])]} />);
    const li = screen.getByRole("listitem");
    expect(li).not.toHaveAttribute("aria-label");
    expect(li).not.toHaveAttribute("aria-labelledby");
    for (const text of ["About 60% of a typical run", "12 tool calls", "Reading", "Opus 5.5, high effort"]) {
      expect(li.textContent).toContain(text);
    }
    // The decorative trail stays out of the reading order.
    expect(li.querySelector(".ht-trail")).toHaveAttribute("aria-hidden", "true");
  });

  it("is not drawn without a helper, and starts no timer", () => {
    const spy = vi.spyOn(globalThis, "setInterval");
    const { container, rerender } = render(<HelperTracker chats={[chat([])]} />);
    expect(container.firstChild).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    // One clock while a row shows; it is cleared when the row goes.
    const clear = vi.spyOn(globalThis, "clearInterval");
    rerender(<HelperTracker chats={[chat([helper()])]} />);
    expect(spy).toHaveBeenCalledTimes(1);
    rerender(<HelperTracker chats={[chat([])]} />);
    expect(clear).toHaveBeenCalled();
    spy.mockRestore();
    clear.mockRestore();
  });

  it("marks a finished helper: the path is full and the row says so", () => {
    const { container } = render(<HelperTracker chats={[chat([helper({ done: true })])]} />);
    expect(container.querySelector(".ht-trail")).toHaveAttribute("data-done");
    expect(container.querySelector<HTMLElement>(".ht-fill")!.style.getPropertyValue("--fill")).toBe("100");
    expect(screen.getByText("Finished")).toBeInTheDocument();
    expect(screen.getByText("Done", { selector: ".ht-status" })).toBeInTheDocument();
  });

  it("draws no star at the end of a track: the spark is not a row decoration", () => {
    const { container } = render(<HelperTracker chats={[chat([helper(), helper({ id: "h2", done: true })])]} />);
    expect(container.querySelectorAll(".ht-trail")).toHaveLength(2);
    expect(container.querySelector(".ht-trail svg")).toBeNull();
  });

  it("keeps counts only: no step text, no command", () => {
    const { container } = render(<HelperTracker chats={[chat([helper({ plan: { done: 1, total: 3 }, openCall: { kind: "run", word: "cargo" } })])]} />);
    expect(container.textContent).not.toMatch(/--release|rm -rf|secret/i);
    expect(container.textContent).toContain("12 tool calls");
  });
});

describe("calm motion", () => {
  /** 20 snapshot updates inside one second: calls climb, the phase word flips every time. */
  function burst(chatsAt: (i: number) => NowChat[]) {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const { rerender } = render(<HelperTracker chats={chatsAt(0)} />);
    const fills: Array<{ anim: boolean; width: string }> = [];
    const statusNodes = new Set<Element>();
    statusNodes.add(document.querySelector(".ht-status")!);
    for (let i = 1; i <= 20; i++) {
      act(() => void vi.advanceTimersByTime(50));
      rerender(<HelperTracker chats={chatsAt(i)} />);
      const f = document.querySelector<HTMLElement>(".ht-fill")!;
      fills.push({ anim: f.hasAttribute("data-anim"), width: f.style.getPropertyValue("--fill") });
      statusNodes.add(document.querySelector(".ht-status")!);
    }
    return { fills, statusNodes };
  }

  const live = (i: number) => [
    chat([helper({ toolCalls: 2 + i, phase: i % 2 ? "Testing" : "Reading", typical: { calls: 40, ms: 100_000, runs: 9 }, lastLineMs: T0 + i * 50 })]),
  ];

  it("animates the fill at most once, and the phase word swaps in at most once, in a burst", () => {
    const { fills, statusNodes } = burst(live);
    // The fill itself did move on the way (it is set every time)...
    expect(new Set(fills.map((f) => f.width)).size).toBeGreaterThan(5);
    // ...but only one of those moves was animated.
    expect(fills.filter((f) => f.anim).length).toBeLessThanOrEqual(1);
    // The initial word plus at most one animated swap.
    expect(statusNodes.size).toBeLessThanOrEqual(2);
  });

  it("holds a phase word for its minimum time, then shows the newest one (never a queue)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const at = (phase: string) => <HelperTracker chats={[chat([helper({ phase })])]} />;
    const { rerender } = render(at("Reading"));
    const first = document.querySelector(".ht-status")!;
    // The word flips straight away on every call: it still reads Reading until the hold is up.
    act(() => void vi.advanceTimersByTime(300));
    rerender(at("Testing"));
    act(() => void vi.advanceTimersByTime(300));
    rerender(at("Changing files"));
    act(() => void vi.advanceTimersByTime(PHASE_HOLD_MS - 700));
    expect(document.querySelector(".ht-status")).toBe(first);
    expect(first.textContent).toBe("Reading");
    // Then the newest word replaces it once, skipping the one in between.
    act(() => void vi.advanceTimersByTime(200));
    const next = document.querySelector(".ht-status")!;
    expect(next.textContent).toBe("Changing files");
    expect(next).not.toBe(first);
    // And that word is held for the full time in turn.
    rerender(at("Reading"));
    act(() => void vi.advanceTimersByTime(PHASE_HOLD_MS - 400));
    expect(document.querySelector(".ht-status")!.textContent).toBe("Changing files");
    act(() => void vi.advanceTimersByTime(400));
    expect(document.querySelector(".ht-status")!.textContent).toBe("Reading");
  });

  it("a word that comes straight back before its hold ends never swaps at all", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const at = (phase: string) => <HelperTracker chats={[chat([helper({ phase })])]} />;
    const { rerender } = render(at("Reading"));
    const first = document.querySelector(".ht-status")!;
    act(() => void vi.advanceTimersByTime(500));
    rerender(at("Testing"));
    act(() => void vi.advanceTimersByTime(500));
    rerender(at("Reading"));
    act(() => void vi.advanceTimersByTime(PHASE_HOLD_MS * 2));
    expect(document.querySelector(".ht-status")).toBe(first);
  });

  it("the minute count of the quiet line changes in place: the line is never re-mounted by the clock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    render(<HelperTracker chats={[chat([helper({ lastLineMs: T0 - STUCK_MS - 1_000 })])]} />);
    const line = screen.getByText("No progress for 5 min", { selector: ".ht-status" });
    act(() => void vi.advanceTimersByTime(60_000));
    const same = screen.getByText("No progress for 6 min", { selector: ".ht-status" });
    expect(same).toBe(line);
    act(() => void vi.advanceTimersByTime(60_000));
    expect(screen.getByText("No progress for 7 min", { selector: ".ht-status" })).toBe(line);
  });

  it("never animates the fill under reduced motion", () => {
    document.documentElement.classList.add("reduced");
    const { fills } = burst(live);
    expect(fills.filter((f) => f.anim)).toHaveLength(0);
  });

  it("animates a later move once the second is up", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const { rerender } = render(<HelperTracker chats={[chat([helper({ toolCalls: 4 })])]} />);
    expect(document.querySelector(".ht-fill")).not.toHaveAttribute("data-anim");
    rerender(<HelperTracker chats={[chat([helper({ toolCalls: 6 })])]} />);
    expect(document.querySelector(".ht-fill")).toHaveAttribute("data-anim");
    act(() => void vi.advanceTimersByTime(1100));
    rerender(<HelperTracker chats={[chat([helper({ toolCalls: 8 })])]} />);
    expect(document.querySelector(".ht-fill")).toHaveAttribute("data-anim");
  });
});
