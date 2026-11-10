import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../App";
import { AtlasProvider } from "../state/AtlasProvider";
import { setBackend } from "../lib/ipc";
import { MockBackend } from "../lib/mock";
import type { SearchPage } from "../lib/searchTypes";

function mount(setup?: (b: MockBackend) => void) {
  localStorage.setItem("atlas.mock.settings", JSON.stringify({ lastView: "sessions" }));
  const backend = new MockBackend();
  setup?.(backend);
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

const searchbox = () => screen.getByRole("searchbox", { name: "Search chats" });

describe("Sessions toolbar", () => {
  it("has a Filter button and a Sort button, each with its own panel", async () => {
    mount();
    await screen.findAllByRole("button", { name: /tokens/ });
    const filter = screen.getByRole("button", { name: "Filter" });
    const sort = screen.getByRole("button", { name: "Sort, Newest first" });
    await userEvent.click(filter);
    const panel = screen.getByRole("dialog", { name: "Filter" });
    expect(within(panel).getByRole("combobox", { name: "Project" })).toBeInTheDocument();
    expect(within(panel).queryByText("Sort by")).not.toBeInTheDocument();
    // Opening the other one closes the first (a click outside is a click on the other button).
    await userEvent.click(sort);
    expect(screen.queryByRole("dialog", { name: "Filter" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Sort" })).toBeInTheDocument();
  });

  it("counts the filters that are on, on the Filter button", async () => {
    mount();
    await screen.findAllByRole("button", { name: /tokens/ });
    expect(screen.queryByRole("button", { name: /Filter, \d+ changed/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Filter" }));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Time span" }), "7");
    const on = await screen.findByRole("button", { name: "Filter, 1 changed" });
    expect(on).toHaveTextContent("1");
    await userEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(screen.getByRole("button", { name: "Filter" })).toBeInTheDocument();
  });

  it("picks a sort order from its own list and closes", async () => {
    mount();
    await screen.findAllByRole("button", { name: /tokens/ });
    await userEvent.click(screen.getByRole("button", { name: "Sort, Newest first" }));
    expect(screen.getByRole("radio", { name: "Newest first" })).toBeChecked();
    expect(screen.queryByRole("radio", { name: "Highest cost" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: "Most tokens" }));
    expect(screen.queryByRole("dialog", { name: "Sort" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sort, Most tokens" })).toBeInTheDocument();
  });

  it("says how many chats there are, and 'N of M' when narrowed", async () => {
    mount();
    await screen.findAllByRole("button", { name: /tokens/ });
    // The day bands say "N chats" too; the toolbar's count is the live one.
    const all = await screen.findByText(/^[\d,]+ chats$/, { selector: "[aria-live]" });
    const n = Number(all.textContent!.replace(/[^\d]/g, ""));
    expect(n).toBeGreaterThan(50);
    await userEvent.type(searchbox(), "zzzz-nothing");
    expect(await screen.findByText(`0 of ${n.toLocaleString("en-US")} chats`)).toBeInTheDocument();
  });
});

/** Hits for the given sessions, in the shape the engine returns. */
function pageFor(ids: string[], word: string): SearchPage {
  return {
    hits: ids.map((sessionId, i) => ({
      id: i + 1,
      sessionId,
      agentId: null,
      project: "C:/code/x",
      projectName: "x",
      ts: Date.now(),
      role: "user" as const,
      snippet: [
        { text: "Why does the ", hit: false },
        { text: word, hit: true },
        { text: " keep firing?", hit: false },
      ],
    })),
    hasMore: false,
    tookMs: 1,
    index: {
      state: "idle",
      ready: true,
      filesDone: 1,
      filesTotal: 1,
      bytesDone: 1,
      bytesTotal: 1,
      messages: 1,
      dbBytes: 1,
      lastIndexedAt: 1,
      error: null,
    },
  };
}

describe("Sessions: search inside chats", () => {
  it("lists a chat found by its message text with a snippet, and counts it", async () => {
    const backend = mount();
    const rows = (await backend.sessionsList({ limit: 20 })).rows;
    const target = rows[7];
    backend.searchChats = async (q) => (q.trim() === "zqword" ? pageFor([target.sessionId], "zqword") : pageFor([], ""));
    await screen.findAllByRole("button", { name: /tokens/ });
    await userEvent.type(searchbox(), "zqword");
    const hit = await screen.findByText("zqword");
    expect(hit.className).toMatch(/font-semibold/);
    const list = await screen.findAllByRole("button", { name: /tokens/ });
    await waitFor(() => expect(screen.getAllByRole("button", { name: /tokens/ })).toHaveLength(1));
    expect(list.length).toBeGreaterThan(0);
    expect(screen.getByText(/^1 of [\d,]+ chats$/)).toBeInTheDocument();
    // Clicking the row opens that session.
    await userEvent.click(screen.getByRole("button", { name: /tokens/ }));
    expect(await screen.findByRole("region", { name: "Who used it" })).toBeInTheDocument();
  });

  it("asks the engine only for 2+ characters and lets the newest query win", async () => {
    const backend = mount();
    const rows = (await backend.sessionsList({ limit: 20 })).rows;
    const asked: string[] = [];
    backend.searchChats = (q) => {
      asked.push(q.trim());
      // The first query answers late and with a different chat: it must be dropped.
      const late = q.trim() === "qz";
      return new Promise((res) => setTimeout(() => res(pageFor([rows[late ? 1 : 2].sessionId], "zqword")), late ? 400 : 5));
    };
    await screen.findAllByRole("button", { name: /tokens/ });
    await userEvent.type(searchbox(), "q");
    await new Promise((r) => setTimeout(r, 250));
    expect(asked).toEqual([]);
    await userEvent.type(searchbox(), "z");
    await new Promise((r) => setTimeout(r, 200));
    await userEvent.type(searchbox(), "x");
    await waitFor(() => expect(screen.getAllByRole("button", { name: /tokens/ })).toHaveLength(1), { timeout: 3000 });
    await new Promise((r) => setTimeout(r, 500));
    expect(screen.getAllByRole("button", { name: /tokens/ })).toHaveLength(1);
    expect(screen.getByText(/^1 of [\d,]+ chats$/)).toBeInTheDocument();
    expect(asked).toEqual(["qz", "qzx"]);
  });

  it("says quietly that the index is still being built", async () => {
    mount((b) => b.search.setStatus({ ready: false, state: "indexing", filesDone: 12, filesTotal: 40 }));
    await screen.findAllByRole("button", { name: /tokens/ });
    expect(screen.queryByText(/files/)).not.toBeInTheDocument();
    await userEvent.type(searchbox(), "retry");
    expect(await screen.findByText(/12 of 40 files/)).toBeInTheDocument();
  });

  it("keeps title search working when the message search fails", async () => {
    const backend = mount();
    backend.search.failNext = true;
    await screen.findAllByRole("button", { name: /tokens/ });
    await userEvent.type(searchbox(), "zzzz-nothing");
    expect(await screen.findByText(/did not work just now/)).toBeInTheDocument();
    expect(await screen.findByText("No chats match")).toBeInTheDocument();
  });
});

describe("Sessions: the first view", () => {
  it("opens with the newest chat as a card and the list under day bands", async () => {
    mount();
    const card = await screen.findByRole("region", { name: "Pick up where you left off" });
    expect(within(card).getByRole("button", { name: "Copy resume command" })).toBeInTheDocument();
    // At least one band, named for its day, holding rows.
    const bands = document.querySelectorAll(".day-section");
    expect(bands.length).toBeGreaterThan(0);
    expect(bands[0].querySelector(".day-name")?.textContent).toMatch(/^(Today|Yesterday|[A-Z][a-z]+( \d+)?(, \d{4})?)$/);
    expect(bands[0].querySelectorAll(".session-grid > li").length).toBeGreaterThan(0);
    // The band names the day once; its rows say the time only, with the whole date in the hover.
    // (The clock follows the computer: "16:42" or "4:42 PM". usage.test.ts pins both.)
    const row = bands[0].querySelector(".session-grid > li")!;
    expect(row.textContent).not.toMatch(/(Today|Yesterday|[A-Z][a-z]{2} \d+), \d{1,2}:\d\d( [AP]M)?/);
    const clock = [...row.querySelectorAll("[title]")].find((e) => /^\d{1,2}:\d\d( [AP]M)?$/.test(e.textContent ?? ""));
    expect(clock?.getAttribute("title")).toMatch(/^(Today|Yesterday|[A-Z][a-z]{2} \d+(, \d{4})?), \d{1,2}:\d\d( [AP]M)?$/);
  });

  it("leaves no stale rows behind when the order goes to Most tokens and back to Newest first", async () => {
    mount();
    await screen.findByRole("region", { name: "Pick up where you left off" });
    const rows = () => document.querySelectorAll(".session-grid > li").length;
    const before = rows();
    await userEvent.click(screen.getByRole("button", { name: "Sort, Newest first" }));
    await userEvent.click(screen.getByRole("radio", { name: "Most tokens" }));
    await waitFor(() => expect(document.querySelectorAll(".day-section").length).toBe(0));
    await userEvent.click(screen.getByRole("button", { name: "Sort, Most tokens" }));
    await userEvent.click(screen.getByRole("radio", { name: "Newest first" }));
    await screen.findByRole("region", { name: "Pick up where you left off" });
    // Every day has one band and every chat one row: the page on screen is always laid out in its own order.
    const days = [...document.querySelectorAll(".day-name")].map((d) => d.textContent);
    expect(new Set(days).size).toBe(days.length);
    expect(rows()).toBe(before);
  });

  it("lists search results as one flat list, and brings the day bands back when the search is cleared", async () => {
    mount();
    await screen.findByRole("region", { name: "Pick up where you left off" });
    expect(document.querySelectorAll(".day-section").length).toBeGreaterThan(0);
    await userEvent.type(searchbox(), "export");
    await waitFor(() => expect(document.querySelectorAll(".day-section").length).toBe(0));
    expect(document.querySelectorAll(".session-grid > li").length).toBeGreaterThan(0);
    // No band names the day any more, so each row says its own date.
    expect(document.querySelector(".session-grid > li")!.textContent).toMatch(/(Today|Yesterday|[A-Z][a-z]{2} \d+), \d{1,2}:\d\d( [AP]M)?/);
    await userEvent.clear(searchbox());
    await waitFor(() => expect(document.querySelectorAll(".day-section").length).toBeGreaterThan(0));
  });

  it("drops the card as soon as a search narrows the list", async () => {
    mount();
    await screen.findByRole("region", { name: "Pick up where you left off" });
    await userEvent.type(searchbox(), "zz");
    await waitFor(() => expect(screen.queryByRole("region", { name: "Pick up where you left off" })).not.toBeInTheDocument());
  });

  it("walks to the next chat with Alt+Down and copies the resume command", async () => {
    const written: string[] = [];
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async (t: string) => void written.push(t) }, configurable: true });
    mount();
    const card = await screen.findByRole("region", { name: "Pick up where you left off" });
    await userEvent.click(within(card).getByRole("button", { name: "Open" }));
    const title = await screen.findByRole("heading", { level: 2 });
    const first = title.textContent;
    await userEvent.keyboard("{Alt>}{ArrowDown}{/Alt}");
    await waitFor(() => expect(screen.getByRole("heading", { level: 2 }).textContent).not.toBe(first));
    await userEvent.click(screen.getByRole("button", { name: /Copy resume/ }));
    await waitFor(() => expect(written.length).toBe(1));
    expect(written[0]).toMatch(/claude --resume [A-Za-z0-9_-]+$/);
    expect(written[0]).not.toMatch(/[\r\n]/); // one line, safe to paste
    expect(await screen.findByText("Resume command copied")).toBeInTheDocument();
  });
});
