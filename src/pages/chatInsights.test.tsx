import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
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
  it("opens a chat on its receipt with every list, and says once that the figures are estimates", async () => {
    const backend = sessionsBackend();
    const { row } = await chatWithHelpers(backend);
    mountDetail(backend, row.sessionId);
    expect(await screen.findByRole("region", { name: "Who spent it" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "What it bought" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Biggest line items" })).toBeInTheDocument();
    expect(screen.getAllByText(/All figures are estimates/)).toHaveLength(1);
    // Each list ends in a total, so the sum is visible.
    expect(within(screen.getByRole("region", { name: "Who spent it" })).getByText("Total")).toBeInTheDocument();
  });

  it("offers the Helpers tab only when helpers ran", async () => {
    const backend = sessionsBackend();
    const page = await backend.sessionsList({ limit: 200 });
    const none = page.rows.find((r) => r.agentCount === 0)!;
    mountDetail(backend, none.sessionId);
    await screen.findByRole("region", { name: "Who spent it" });
    expect(screen.getByRole("radio", { name: "Receipt" })).toBeInTheDocument();
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
    const who = await screen.findByRole("region", { name: "Who spent it" });
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
    expect(await screen.findByRole("region", { name: "Who spent it" })).toBeInTheDocument();
  });

  it("folds a huge crowd of helpers into a +N node and still draws every dollar", async () => {
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
    // What the dots carry is what the chat spent in its threads.
    const shown = nodes.length - 1 - 1;
    const folded = Number(/^(\d+) more/.exec(more.getAttribute("aria-label") ?? "")?.[1]);
    expect(shown + folded).toBe(56);
  });
});
