import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import { App } from "../App";
import { AtlasProvider } from "../state/AtlasProvider";
import { setBackend } from "../lib/ipc";
import { MockBackend } from "../lib/mock";
import { ago, clock } from "../lib/nowFormat";
import type { NowChat, NowSnapshot, NowStep } from "../lib/nowTypes";

function step(id: string, verb: string, target: string | null, over: Partial<NowStep> = {}): NowStep {
  return { id, kind: "edit", verb, target, tsMs: Date.now(), done: true, by: null, ...over };
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
  document.documentElement.removeAttribute("data-theme");
});
afterEach(() => setBackend(null));

describe("Now", () => {
  it("shows what the chat is doing, its spend and its recent steps", async () => {
    mount({ chats: [chat()], last: null, watching: true });
    expect(await screen.findByText("Editing", { selector: ".nc-verb" })).toBeInTheDocument();
    expect(screen.getByText("src/App.tsx", { selector: ".nc-target" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Fix the build" })).toBeInTheDocument();
    expect(screen.getByText("1.2k", { selector: ".nc-spend-fig" })).toBeInTheDocument();
    expect(screen.queryByText(/\$/)).toBeNull();
    const trail = screen.getByRole("list", { name: "Recent steps" });
    expect(within(trail).getAllByRole("listitem")).toHaveLength(2);
  });

  it("adds a step to the trail when the engine pushes one", async () => {
    const backend = mount({ chats: [chat()], last: null, watching: true });
    await screen.findByRole("list", { name: "Recent steps" });
    act(() => {
      backend.now.push({
        chats: [
          chat({
            doing: { kind: "run", verb: "Running", target: "cargo" },
            steps: [...chat().steps, step("c", "Running", "cargo", { kind: "run", done: false })],
          }),
        ],
        last: null,
        watching: true,
      });
    });
    expect(await screen.findByText("Running", { selector: ".nc-verb" })).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Recent steps" })).getAllByRole("listitem")).toHaveLength(3);
  });

  it("shows a helper that is out, with its own spend", async () => {
    mount({
      chats: [
        chat({
          helpers: [
            {
              id: "h1",
              name: "Find the callers",
              doing: { kind: "search", verb: "Searching", target: "run_loop" },
              tokens: 115,
              costUsd: 0.03,
              startedMs: Date.now() - 5_000,
              done: false,
            },
          ],
        }),
      ],
      last: null,
      watching: true,
    });
    expect(await screen.findByText("Find the callers")).toBeInTheDocument();
    expect(screen.getByText("115", { selector: ".nc-helper-spend" })).toBeInTheDocument();
  });

  it("rests on the last finished chat when nothing is running, with no explanation", async () => {
    mount({
      chats: [],
      last: { sessionId: "s0", title: "Fix the build", project: "atlas", model: null, endedMs: Date.now() - 3 * 60_000 },
      watching: true,
    });
    expect(await screen.findByRole("heading", { level: 2, name: "Fix the build" })).toBeInTheDocument();
    expect(screen.getByText(/^Ended 3 min ago$/)).toBeInTheDocument();
    expect(screen.queryByText(/no chats are running|nothing is running|start a chat/i)).not.toBeInTheDocument();
  });

  it("never says Live", async () => {
    mount({ chats: [chat()], last: null, watching: true });
    await screen.findByRole("list", { name: "Recent steps" });
    expect(document.body.textContent).not.toMatch(/\blive\b/i);
  });

  it("says so when there is no Claude folder", async () => {
    mount({ chats: [], last: null, watching: false });
    expect(await screen.findByRole("heading", { level: 2, name: "No Claude folder found" })).toBeInTheDocument();
  });

  it("shows compact cards for more than three chats", async () => {
    const many = ["a", "b", "c", "d"].map((id) => chat({ sessionId: id, title: `Chat ${id}` }));
    mount({ chats: many, last: null, watching: true });
    await screen.findByRole("heading", { level: 2, name: "Chat d" });
    expect(document.querySelector(".now-grid")).not.toBeNull();
    expect(document.querySelector(".now-stack")).toBeNull();
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
});
