import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../App";
import { AtlasProvider } from "../state/AtlasProvider";
import { setBackend } from "../lib/ipc";
import { openSessionNext } from "../lib/nav";
import { MockBackend } from "../lib/mock";
import { resetPlayed } from "../lib/motion";
import { buildMockReceipt, type MockThread } from "../lib/mockReceipt";
import { MAP_LIMIT } from "../lib/helperMap";
import type { Tokens } from "../lib/types";

function sessionsBackend(): MockBackend {
  localStorage.setItem("atlas.mock.settings", JSON.stringify({ lastView: "sessions" }));
  return new MockBackend();
}

function mountDetail(backend: MockBackend, sessionId: string) {
  openSessionNext(sessionId);
  setBackend(backend);
  render(
    <AtlasProvider>
      <App />
    </AtlasProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  resetPlayed();
  document.documentElement.removeAttribute("data-theme");
});
afterEach(() => setBackend(null));

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function chatWithHelpers(backend: MockBackend) {
  const page = await backend.sessionsList({ limit: 200 });
  const row = page.rows.find((r) => r.agentCount > 1)!;
  const detail = (await backend.sessionDetail(row.sessionId))!;
  return { row, detail };
}

describe("Chat receipt and helper map", () => {
  it("opens a chat on its receipt with every list; dollars sit in hovers and are called an estimate there", async () => {
    const backend = sessionsBackend();
    const { row } = await chatWithHelpers(backend);
    mountDetail(backend, row.sessionId);
    expect(await screen.findByRole("region", { name: "Who used it" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "What it used" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Biggest line items" })).toBeInTheDocument();
    expect(screen.queryAllByText(/All figures are estimates/)).toHaveLength(0);
    // A list of shares ends in a total, so the sum is visible; each of its lines wears the avatar the map gives that thread.
    const who = screen.getByRole("region", { name: "Who used it" });
    expect(within(who).getByText("Total")).toBeInTheDocument();
    expect(within(who).getByRole("img", { name: "Main chat" })).toBeInTheDocument();
    expect(within(who).getAllByRole("img", { name: /helper$/i }).length).toBeGreaterThan(0);
    // The line items are rough sizes, not shares: no total under them, one note that says what "~" is.
    const big = screen.getByRole("region", { name: "Biggest line items" });
    expect(within(big).queryByText("Total")).toBeNull();
    expect(within(big).queryByText("Everything else")).toBeNull();
    expect(within(big).getByText(/^~ is a rough size/)).toBeInTheDocument();
    // Tokens are the figure everywhere; dollars live only in hover text.
    for (const name of ["Who used it", "What it used", "Biggest line items"]) {
      const region = screen.getByRole("region", { name });
      expect(region.textContent).not.toMatch(/\$/);
      expect(region.textContent).toMatch(/\d(k|M|B)?\b/);
    }
    expect(within(screen.getByRole("region", { name: "Who used it" })).getByText(/tokens$/)).toBeInTheDocument();
    const titled = Array.from(document.querySelectorAll("[title]")).map((e) => e.getAttribute("title") ?? "");
    expect(titled.some((t) => /an estimate of about \$/.test(t))).toBe(true);
  });

  it("offers the Helpers tab only when helpers ran", async () => {
    const backend = sessionsBackend();
    const page = await backend.sessionsList({ limit: 200 });
    const none = page.rows.find((r) => r.agentCount === 0)!;
    mountDetail(backend, none.sessionId);
    await screen.findByRole("region", { name: "Who used it" });
    expect(screen.getByRole("radio", { name: "Tokens" })).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "Helpers" })).not.toBeInTheDocument();
  });

  it("draws one node per thread, parent to child, and selecting one shows its slice", async () => {
    const backend = sessionsBackend();
    const { row, detail } = await chatWithHelpers(backend);
    mountDetail(backend, row.sessionId);
    await userEvent.click(await screen.findByRole("radio", { name: "Helpers" }));
    const map = await screen.findByRole("group", { name: /^Helper map: the main chat and \d+ helpers?$/ });
    const nodes = within(map).getAllByRole("button");
    expect(nodes).toHaveLength(detail.agents.length + 1);

    // The main chat is selected to begin with.
    expect(screen.getByRole("complementary", { name: "Slice: Main chat" })).toBeInTheDocument();
    const target = detail.agents[0];
    await userEvent.click(within(map).getByRole("button", { name: new RegExp(`^${esc(target.name)}, `) }));
    const slice = screen.getByRole("complementary", { name: `Slice: ${target.name}` });
    expect(within(slice).getByRole("button", { name: /Open helper/ })).toBeInTheDocument();
    expect(within(slice).getByText(/of the chat/)).toBeInTheDocument();
    // The slice wears the helper's own avatar, and where the tokens went waits behind one row.
    expect(within(slice).getByRole("img", { name: /helper$/i })).toBeInTheDocument();
    expect(within(slice).queryByRole("region", { name: "What it used" })).toBeNull();
    const more = within(slice).getByRole("button", { name: "Where it went" });
    expect(more).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(more);
    expect(more).toHaveAttribute("aria-expanded", "true");
    expect(within(slice).getByRole("region", { name: "What it used" })).toBeInTheDocument();
  });

  it("names the biggest helpers beside them in a few words, never inside a node; the whole name is on the plate", async () => {
    const backend = sessionsBackend();
    const { row, detail } = await chatWithHelpers(backend);
    mountDetail(backend, row.sessionId);
    await userEvent.click(await screen.findByRole("radio", { name: "Helpers" }));
    const map = await screen.findByRole("group", { name: /^Helper map/ });
    // At rest: the main chat's caption and, beside a helper, one short name over its tokens. No plate yet.
    expect(map.querySelector(".map-plate")).toBeNull();
    expect(Array.from(map.querySelectorAll(".map-body text")).every((t) => /^\+\d+$/.test(t.textContent ?? ""))).toBe(true);
    const rest = Array.from(map.querySelectorAll(".map-rest"));
    expect(rest.length).toBeGreaterThan(0);
    expect(rest.length).toBeLessThanOrEqual(8);
    for (const r of rest) {
      const [name, tokens] = Array.from(r.querySelectorAll("text")).map((t) => t.textContent ?? "");
      expect(name.length).toBeLessThanOrEqual(22);
      expect(tokens).toMatch(/^\S+ tokens$/);
    }
    const writing = Array.from(map.querySelectorAll("text")).filter((t) => !t.closest(".map-rest") && !t.closest(".map-body"));
    expect(writing.map((t) => t.textContent)).toEqual(["Main chat"]);

    const a = detail.agents[0];
    const node = within(map).getByRole("button", { name: new RegExp(`^${esc(a.name)}, `) });
    expect(node.getAttribute("aria-label")).toMatch(/ tokens/);
    expect(node.getAttribute("aria-label")).not.toMatch(/\$/);
    await userEvent.hover(node);
    const plate = map.querySelector(".map-plate");
    expect(plate).not.toBeNull();
    expect((plate?.textContent ?? "").replace(/\s+/g, "")).toContain(a.name.replace(/\s+/g, ""));
    expect(plate?.querySelector(".map-plate-detail")?.textContent).toMatch(/ tokens/);
    // The plate replaces that node's short name: the two never sit on top of each other.
    expect(node.querySelector(".map-rest")).toBeNull();
    await userEvent.unhover(node);
    expect(map.querySelector(".map-plate")).toBeNull();
    expect(map.querySelectorAll(".map-rest").length).toBe(rest.length);
    // The keyboard gets the same plate.
    act(() => node.focus());
    expect(map.querySelector(".map-plate")).not.toBeNull();
    act(() => node.blur());
    expect(map.querySelector(".map-plate")).toBeNull();
  });

  it("selects a node from the keyboard and opens the helper from its slice", async () => {
    const backend = sessionsBackend();
    const { row, detail } = await chatWithHelpers(backend);
    mountDetail(backend, row.sessionId);
    await userEvent.click(await screen.findByRole("radio", { name: "Helpers" }));
    const map = await screen.findByRole("group", { name: /^Helper map/ });
    const a = detail.agents[1];
    const node = within(map).getByRole("button", { name: new RegExp(`^${esc(a.name)}, `) });
    node.focus();
    await userEvent.keyboard("{Enter}");
    expect(node).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(within(screen.getByRole("complementary", { name: `Slice: ${a.name}` })).getByRole("button", { name: /Open helper/ }));
    expect(await screen.findByRole("heading", { level: 2, name: a.name })).toBeInTheDocument();
  });

  it("a helper line on the receipt opens the map on that helper", async () => {
    const backend = sessionsBackend();
    const { row } = await chatWithHelpers(backend);
    const receipt = (await backend.sessionReceipt(row.sessionId))!;
    const top = receipt.threads.filter((t) => t.agentId).sort((a, b) => b.usd - a.usd)[0];
    mountDetail(backend, row.sessionId);
    const who = await screen.findByRole("region", { name: "Who used it" });
    await userEvent.click(within(who).getByRole("button", { name: new RegExp(`^${esc(top.name)}, `) }));
    expect(await screen.findByRole("group", { name: /^Helper map/ })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: `Slice: ${top.name}` })).toBeInTheDocument();
  });

  it("keeps the old helper cards behind a List view", async () => {
    const backend = sessionsBackend();
    const { row, detail } = await chatWithHelpers(backend);
    mountDetail(backend, row.sessionId);
    await userEvent.click(await screen.findByRole("radio", { name: "Helpers" }));
    await userEvent.click(await screen.findByRole("radio", { name: "List" }));
    expect(screen.queryByRole("group", { name: /^Helper map/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: new RegExp(esc(detail.agents[0].name)) }).length).toBeGreaterThan(0);
  });

  it("says so, with a retry, when the receipt cannot be read", async () => {
    const backend = sessionsBackend();
    const { row } = await chatWithHelpers(backend);
    const real = backend.sessionReceipt;
    let calls = 0;
    backend.sessionReceipt = (id) => (++calls === 1 ? Promise.reject(new Error("The chat file could not be read")) : real(id));
    mountDetail(backend, row.sessionId);
    expect(await screen.findByText("The chat file could not be read")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("region", { name: "Who used it" })).toBeInTheDocument();
  });

  it("folds a huge crowd of helpers into a +N node and still draws every helper", async () => {
    const backend = sessionsBackend();
    const { row } = await chatWithHelpers(backend);
    const tokens = (n: number): Tokens => ({ input: n, output: n, cacheWrite5m: n, cacheWrite1h: 0, cacheRead: n * 4, webSearch: 0, webFetch: 0, total: n * 3 });
    const thread = (agentId: string | null, n: number): MockThread => ({
      agentId,
      name: agentId ?? "Main chat",
      parentAgentId: null,
      spawnDepth: agentId ? 1 : 0,
      model: "claude-sonnet-5-5",
      tokens: tokens(n),
      messages: 4,
      toolCalls: 2,
      durationMs: 1000,
    });
    const helpers = Array.from({ length: 56 }, (_, i) => thread(`h${i}`, 1000 + i * 100));
    const rates = { "claude-sonnet-5-5": [3, 15] as [number, number] };
    const big = buildMockReceipt(row.sessionId, 5, thread(null, 50_000), helpers, rates);
    backend.sessionReceipt = async () => big;
    mountDetail(backend, row.sessionId);
    await userEvent.click(await screen.findByRole("radio", { name: "Helpers" }));
    const map = await screen.findByRole("group", { name: /^Helper map/ });
    const nodes = within(map).getAllByRole("button");
    const more = within(map).getByRole("button", { name: /^\d+ more helpers, / });
    expect(nodes.length).toBeLessThanOrEqual(MAP_LIMIT + 1);
    await userEvent.click(more);
    const slice = screen.getByRole("complementary", { name: /^Slice: \d+ more helpers$/ });
    expect(within(slice).getByText("Folded in")).toBeInTheDocument();
    // Every helper is a node or sits inside the +N node.
    const shown = nodes.length - 1 - 1;
    const folded = Number(/^(\d+) more/.exec(more.getAttribute("aria-label") ?? "")?.[1]);
    expect(shown + folded).toBe(56);
  });
});
