import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../App";
import { AtlasProvider } from "../state/AtlasProvider";
import { setBackend } from "../lib/ipc";
import { openSessionNext } from "../lib/nav";
import { MockBackend } from "../lib/mock";
import { addDays, compact, headline, localDay } from "../lib/usage";
import type { Scenario } from "../lib/mockUsage";

function mount(scenario: Scenario = "data", view: "dashboard" | "sessions" = "dashboard") {
  localStorage.setItem("atlas.mock.settings", JSON.stringify({ lastView: view }));
  const backend = new MockBackend();
  backend.usage.scenario = scenario;
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

describe("Dashboard", () => {
  it("shows real numbers from the engine, not placeholders", async () => {
    const backend = mount();
    const dash = await backend.usageDashboard();
    await screen.findByText("Last 7 days");
    const week = screen.getByRole("region", { name: "Last 7 days" });
    expect(within(week).getByText(compact(headline(dash.week.tokens)))).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Today" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Activity" })).toBeInTheDocument();
    expect(screen.getAllByText(/estimated/).length).toBeGreaterThanOrEqual(2);
    // Every screen opens on its content: no page title, no greeting, no sentence under one.
    expect(screen.queryByText(/Good (morning|afternoon|evening)/)).not.toBeInTheDocument();
    expect(screen.queryByText("Coming soon")).not.toBeInTheDocument();
  });

  it("labels costs as estimates and keeps cache reads apart", async () => {
    mount();
    await screen.findByText("Last 7 days");
    expect(screen.getByText(/Dollar figures in hovers are estimates from a price list/)).toBeInTheDocument();
    expect(screen.getAllByText(/cache reads/).length).toBeGreaterThan(0);
  });

  it("charts tokens only, with a table behind the chart options", async () => {
    mount();
    await screen.findByRole("group", { name: /Tokens, last 30 days/ });
    // Time range stays in the open; the table lives behind the chart options button.
    expect(screen.getByRole("radio", { name: "30 days" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Chart options" }));
    expect(screen.queryByRole("radio", { name: "Cost" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: "Table" }));
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getAllByRole("row").length).toBeGreaterThan(20);
  });

  it("keeps what tokens count in the Activity total's hover, not in a sentence", async () => {
    mount();
    await screen.findByRole("group", { name: /Tokens, last 30 days/ });
    const readout = screen.getByTestId("chart-readout");
    expect(readout.getAttribute("title")).toMatch(/cache writes\.\nCache reads are listed apart\./);
    const card = screen.getByRole("region", { name: "Activity" });
    expect(within(card).queryByText(/Tokens count what you sent/)).not.toBeInTheDocument();
  });

  it("moves the chart readout with the arrow keys", async () => {
    mount();
    const chart = await screen.findByRole("group", { name: /Tokens, last 30 days/ });
    const readout = screen.getByTestId("chart-readout");
    const live = chart.querySelector("[aria-live]") as HTMLElement;
    expect(readout).toHaveTextContent("Last 30 days");
    expect(live).toBeEmptyDOMElement();
    chart.focus();
    await userEvent.keyboard("{End}");
    expect(live).toHaveTextContent(/(Sun|Mon|Tue|Wed|Thu|Fri|Sat),/);
    await userEvent.keyboard("{Escape}");
    expect(live).toBeEmptyDOMElement();
  });

  it("shows a designed empty state when there is no usage, without implying a failure", async () => {
    mount("empty");
    expect(await screen.findByText("No Claude Code usage found yet")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows skeleton cards and the progress bar during the very first read", async () => {
    const backend = mount("indexing");
    expect(await screen.findByRole("progressbar")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Loading your usage" })).toBeInTheDocument();
    expect(screen.queryByText("No Claude Code usage found yet")).not.toBeInTheDocument();
    act(() =>
      backend.usage.emitProgress({ phase: "reading", filesDone: 5, filesTotal: 10, bytesDone: 5, bytesTotal: 10, startedAt: 0 }),
    );
    await waitFor(() => expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "50"));
  });

  it("does not show an error when the cache simply is not ready during the first read", async () => {
    const backend = new MockBackend();
    backend.usage.scenario = "indexing";
    backend.usage.failNext = true; // the real engine answers "not ready yet" before its file exists
    localStorage.setItem("atlas.mock.settings", JSON.stringify({ lastView: "dashboard" }));
    setBackend(backend);
    render(
      <AtlasProvider>
        <App />
      </AtlasProvider>,
    );
    expect(await screen.findByRole("progressbar")).toBeInTheDocument();
    expect(await screen.findByRole("status", { name: "Loading your usage" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText("Could not load your usage")).not.toBeInTheDocument();
  });

  it("explains an engine error and recovers on retry", async () => {
    const backend = mount("error");
    const alerts = await screen.findAllByRole("alert");
    expect(alerts.length).toBeGreaterThan(0);
    expect(screen.getAllByText(/could not be opened/).length).toBeGreaterThan(0);
    backend.usage.setScenario("data");
    await userEvent.click(screen.getAllByRole("button", { name: "Try again" })[0]);
    await screen.findByText("Last 7 days");
  });

  it("keeps the numbers on screen when a quiet refresh fails", async () => {
    const backend = mount();
    await screen.findByText("Last 7 days");
    backend.usage.failNext = true;
    act(() => backend.usage.emitChanged());
    await new Promise((r) => setTimeout(r, 400));
    expect(screen.getByText("Last 7 days")).toBeInTheDocument();
    expect(screen.queryByText("Could not load your usage")).not.toBeInTheDocument();
  });

  it("opens a recent session in the Sessions page", async () => {
    mount();
    const list = await screen.findByRole("region", { name: "Recent sessions" });
    const first = within(list).getAllByRole("button", { name: /tokens/ })[0];
    await userEvent.click(first);
    expect(await screen.findByRole("heading", { level: 1, name: "Sessions" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "All sessions" })).toBeInTheDocument();
    expect(await screen.findByText("Token breakdown")).toBeInTheDocument();
  });
});

describe("Sessions", () => {
  it("lists sessions with cost estimates and loads more on request", async () => {
    mount("data", "sessions");
    const rows = await screen.findAllByRole("button", { name: /tokens/ });
    expect(rows.length).toBe(50);
    expect(screen.getByText(/Showing 50 of/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Show more" }));
    await waitFor(() => expect(screen.getAllByRole("button", { name: /tokens/ }).length).toBeGreaterThan(50));
  });

  it("filters by search text and says so when nothing matches", async () => {
    mount("data", "sessions");
    await screen.findAllByRole("button", { name: /tokens/ });
    await userEvent.type(screen.getByRole("searchbox", { name: "Search chats" }), "zzzz-nothing");
    expect(await screen.findByText("No chats match")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(screen.getAllByRole("button", { name: /tokens/ }).length).toBeGreaterThan(0));
  });

  it("shows an empty state when there are no sessions at all", async () => {
    mount("empty", "sessions");
    expect(await screen.findByText("No sessions yet")).toBeInTheDocument();
  });

  it("opens a session, shows its breakdown, and reads the conversation only on request", async () => {
    mount("data", "sessions");
    const rows = await screen.findAllByRole("button", { name: /tokens/ });
    await userEvent.click(rows[0]);
    expect(await screen.findByText("Token breakdown")).toBeInTheDocument();
    expect(screen.getByText("Cache reads")).toBeInTheDocument();
    expect(screen.queryByText(/Mock request number 1\./)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Show conversation/ }));
    expect(await screen.findByText(/Mock request number 1\./)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "All sessions" }));
    expect(await screen.findByRole("searchbox", { name: "Search chats" })).toBeVisible();
  });

  it("reports a load failure with a retry", async () => {
    const backend = mount("error", "sessions");
    expect(await screen.findByText("Could not load your sessions")).toBeInTheDocument();
    backend.usage.setScenario("data");
    await userEvent.click(screen.getAllByRole("button", { name: "Try again" }).at(-1)!);
    await screen.findAllByRole("button", { name: /tokens/ });
  });
});

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The mock backend reads the saved settings when it is made, so the view is chosen first. */
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

describe("Helpers (subagents) inside a session", () => {
  async function withHelpers(backend: MockBackend) {
    const page = await backend.sessionsList({ limit: 200 });
    const row = page.rows.find((r) => r.agentCount > 1)!;
    expect(row).toBeDefined();
    const detail = (await backend.sessionDetail(row.sessionId))!;
    return { row, detail };
  }

  it("never makes a helper a row of its own, and counts it once under its session", async () => {
    const backend = new MockBackend();
    const page = await backend.sessionsList({ limit: 200 });
    const helperNames = new Set<string>();
    for (const r of page.rows.filter((x) => x.agentCount > 0)) {
      const d = (await backend.sessionDetail(r.sessionId))!;
      expect(d.agents).toHaveLength(r.agentCount);
      d.agents.forEach((a) => helperNames.add(a.name));
      // Main plus helpers is the session: tokens, messages and dollars, with no double count.
      const helperTokens = d.agents.reduce((s, a) => s + a.tokens.total, 0);
      expect(d.main.tokens.total + helperTokens).toBe(r.tokens.total);
      expect(d.main.messages + d.agents.reduce((s, a) => s + a.messages, 0)).toBe(r.messages);
      const usd = d.main.cost.usd! + d.agents.reduce((s, a) => s + a.cost.usd!, 0);
      expect(usd).toBeCloseTo(r.cost.usd!, 9);
    }
    expect(helperNames.size).toBeGreaterThan(2);
    const rowNames = page.rows.map((r) => r.name);
    for (const h of helperNames) expect(rowNames).not.toContain(h);
  });

  it("names every helper and session by what it did, never by an id", async () => {
    const backend = new MockBackend();
    const page = await backend.sessionsList({ limit: 200 });
    const hex = /^[0-9a-f]{8}(-[0-9a-f]{4}){0,4}/i;
    for (const r of page.rows) {
      if (r.name !== null) expect(r.name).not.toMatch(hex);
      const d = (await backend.sessionDetail(r.sessionId))!;
      for (const a of d.agents) {
        expect(a.name.trim().length).toBeGreaterThan(0);
        expect(a.name).not.toMatch(hex);
        // The fallback order: description, then type, then the prompt.
        if (a.description) expect(a.name).toBe(a.description);
        else if (a.agentType) expect(a.nameSource).toBe("type");
        else expect(a.nameSource).toBe("prompt");
      }
    }
  });

  it("shows a session by its name with the helper count as plain colored text in the list", async () => {
    const backend = mount("data", "sessions");
    const page = await backend.sessionsList({ limit: 50 });
    const row = page.rows.find((r) => r.agentCount > 0)!;
    const list = await screen.findAllByRole("button", { name: /tokens/ });
    const chip = `${row.agentCount} ${row.agentCount === 1 ? "helper" : "helpers"}`;
    const line = list.find((b) => within(b).queryByText(chip) !== null)!;
    expect(line).toBeDefined();
    expect(within(line).getByText(row.name ?? `Session in ${row.projectName}`)).toBeInTheDocument();
    // Text only: no chip, pill or box around the count.
    const count = within(line).getByText(chip);
    expect(count.className).toContain("text-accent-text");
    expect(count.className).not.toMatch(/chip|rounded|border|bg-/);
  });

  it("opens a session with its main-versus-total split and one card per helper", async () => {
    const backend = sessionsBackend();
    const { row, detail } = await withHelpers(backend);
    mountDetail(backend, row.sessionId);
    const helpers = await screen.findByRole("region", { name: "Helpers" });
    expect(within(helpers).getByRole("heading", { name: `${row.agentCount} helpers ran in this session` })).toBeInTheDocument();
    expect(screen.getByText("You and Claude")).toBeInTheDocument();
    for (const a of detail.agents) {
      expect(within(helpers).getAllByRole("button", { name: new RegExp(esc(a.name)) }).length).toBeGreaterThan(0);
    }
  });

  it("opens one helper to show what it was asked and what it spent, and goes back", async () => {
    const backend = sessionsBackend();
    const { row, detail } = await withHelpers(backend);
    const a = detail.agents[0];
    const full = (await backend.agentDetail(row.sessionId, a.agentId))!;
    mountDetail(backend, row.sessionId);
    const helpers = await screen.findByRole("region", { name: "Helpers" });
    await userEvent.click(within(helpers).getAllByRole("button", { name: new RegExp(esc(a.name)) })[0]);
    expect(await screen.findByRole("heading", { level: 2, name: a.name })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "What it was asked" })).toHaveTextContent(full.prompt!);
    expect(screen.getByText("Tool calls")).toBeInTheDocument();
    expect(screen.getByText("Ran for")).toBeInTheDocument();
    const breakdown = screen.getByRole("region", { name: "Token breakdown" });
    expect(within(breakdown).getByText("Cache reads")).toBeInTheDocument();
    expect(within(breakdown).getByText(a.tokens.input.toLocaleString("en-US"))).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^Back to / }));
    expect(await screen.findByRole("region", { name: "Helpers" })).toBeInTheDocument();
  });

  it("switches the token breakdown between the main conversation and everything", async () => {
    const backend = sessionsBackend();
    const { row, detail } = await withHelpers(backend);
    mountDetail(backend, row.sessionId);
    const section = await screen.findByRole("region", { name: "Token breakdown" });
    expect(within(section).getByText(row.tokens.input.toLocaleString("en-US"))).toBeInTheDocument();
    await userEvent.click(within(section).getByRole("radio", { name: "Main only" }));
    expect(within(section).getByText(detail.main.tokens.input.toLocaleString("en-US"))).toBeInTheDocument();
  });
});

describe("Usage by skill, helper type and tool", () => {
  it("counts a period and keeps the last time ever", async () => {
    const backend = new MockBackend();
    const all = await backend.usageByItem({ kind: "agent" });
    const week = await backend.usageByItem({ kind: "agent", from: addDays(localDay(new Date()), -6) });
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((i) => i.kind === "agent" && i.id.length > 0)).toBe(true);
    const total = (v: typeof all) => v.reduce((s, i) => s + i.uses, 0);
    expect(total(week)).toBeLessThanOrEqual(total(all));
    for (const i of all) expect(i.lastUsed).not.toBeNull();
    const tools = await backend.usageByItem({ kind: "tool" });
    expect(tools.map((t) => t.id)).toEqual(expect.arrayContaining(["Bash", "Read", "Edit"]));
    expect(tools[0].uses).toBeGreaterThanOrEqual(tools[tools.length - 1].uses);
  });
});
