import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../App";
import { AtlasProvider } from "../state/AtlasProvider";
import { setBackend } from "../lib/ipc";
import { MockBackend } from "../lib/mock";
import { compact, headline } from "../lib/usage";
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
    const month = screen.getByRole("region", { name: "Last 30 days" });
    expect(within(month).getByText(compact(headline(dash.month.tokens)))).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Today" })).toBeInTheDocument();
    expect(screen.getAllByText("estimated cost").length).toBe(3);
    expect(screen.queryByText("Coming soon")).not.toBeInTheDocument();
  });

  it("labels costs as estimates and keeps cache reads apart", async () => {
    mount();
    await screen.findByText("Last 7 days");
    expect(screen.getByText(/Costs are estimates from a price list/)).toBeInTheDocument();
    expect(screen.getAllByText(/cache reads/).length).toBeGreaterThan(0);
  });

  it("switches the chart between tokens and cost and to a table", async () => {
    mount();
    await screen.findByRole("group", { name: /Tokens, last 30 days/ });
    await userEvent.click(screen.getByRole("radio", { name: "Cost" }));
    expect(screen.getByRole("group", { name: /Estimated cost, last 30 days/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Table" }));
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getAllByRole("row").length).toBeGreaterThan(20);
  });

  it("moves the chart readout with the arrow keys", async () => {
    mount();
    const chart = await screen.findByRole("group", { name: /Tokens, last 30 days/ });
    const readout = screen.getByTestId("chart-readout");
    expect(readout).toHaveTextContent("Last 30 days");
    chart.focus();
    await userEvent.keyboard("{End}");
    expect(readout).not.toHaveTextContent("Last 30 days");
    expect(readout).toHaveTextContent(/(Sun|Mon|Tue|Wed|Thu|Fri|Sat),/);
    await userEvent.keyboard("{Escape}");
    expect(readout).toHaveTextContent("Last 30 days");
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
    await userEvent.type(screen.getByRole("searchbox", { name: "Search sessions" }), "zzzz-nothing");
    expect(await screen.findByText("No sessions match")).toBeInTheDocument();
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
    expect(await screen.findByRole("searchbox", { name: "Search sessions" })).toBeVisible();
  });

  it("reports a load failure with a retry", async () => {
    const backend = mount("error", "sessions");
    expect(await screen.findByText("Could not load your sessions")).toBeInTheDocument();
    backend.usage.setScenario("data");
    await userEvent.click(screen.getAllByRole("button", { name: "Try again" }).at(-1)!);
    await screen.findAllByRole("button", { name: /tokens/ });
  });
});
