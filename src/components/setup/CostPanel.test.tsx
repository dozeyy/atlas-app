import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CostPanel } from "./CostPanel";
import type { CostReport, CostRow, SetupItem } from "../../lib/setup-types";

function row(over: Partial<CostRow>): CostRow {
  return {
    id: null,
    name: "CLAUDE.md",
    kind: "instructions",
    scopeLabel: "Global",
    loadsIn: "All chats",
    global: true,
    path: null,
    tokens: 3386,
    turns: 22_366,
    usdLoaded: 16.89,
    bodyTokens: 0,
    uses: null,
    usdUsed: 0,
    usdWeek: 16.89,
    measured: false,
    ...over,
  };
}

function report(rows: CostRow[], over: Partial<CostReport> = {}): CostReport {
  return { windowDays: 7, charsPerToken: 2.4, turns: 22_366, globalTokens: 29_702, usdWeek: 287.4, incomplete: false, rows, ...over };
}

const items = [{ id: "i1", kind: "instructions", name: "CLAUDE.md" }] as SetupItem[];

const rows = [
  row({ id: "i1", name: "CLAUDE.md", loadsIn: "Chats in heavens-casino", tokens: 8804, turns: 12_103, usdWeek: 21.26 }),
  row({ name: "Other connected tools (19)", kind: "mcpServer", loadsIn: "Chats that connect them", tokens: 7294, turns: 15_682, usdWeek: 25.26, measured: true }),
  row({ id: "i2", name: "agent-routing", kind: "rule", tokens: 2791, usdWeek: 13.92 }),
];

describe("CostPanel", () => {
  it("draws nothing without an answer or without rows", () => {
    for (const r of [null, report([])]) {
      const { container, unmount } = render(<CostPanel report={r} items={items} />);
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });

  it("ranks by dollars with where it applies, tokens x turns and the weekly total", () => {
    render(<CostPanel report={report(rows)} items={items} />);
    expect(screen.getByRole("heading", { name: "What your setup costs" })).toBeInTheDocument();
    expect(screen.getByText("~$287")).toBeInTheDocument();
    const lis = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(lis).toHaveLength(3);
    // The report arrives sorted; the panel keeps that order.
    expect(lis[0]).toHaveTextContent("CLAUDE.md");
    expect(lis[0]).toHaveTextContent("~$21");
    expect(lis[0]).toHaveTextContent("Chats in heavens-casino - 8.8k tokens x 12k turns");
    expect(lis[1]).toHaveTextContent("Other connected tools (19)");
    expect(lis[2]).toHaveTextContent("All chats - 2.8k tokens x 22k turns");
  });

  it("says estimate once and carries no explanation, pills or Live tag", () => {
    const { container } = render(<CostPanel report={report(rows)} items={items} />);
    expect(container.textContent?.match(/Estimate/g)).toHaveLength(1);
    expect(container.textContent).toContain("Estimate, last 7 days. 30k tokens load in every chat.");
    expect(container.textContent).not.toMatch(/\bLive\b/);
    expect(container.querySelector(".chip, [class*='rounded-full'][class*='px-']")).toBeNull();
  });

  it("opens an item that is in the setup, and leaves the rest as plain text", async () => {
    const onOpen = vi.fn();
    render(<CostPanel report={report(rows)} items={items} onOpen={onOpen} />);
    await userEvent.click(screen.getByRole("button", { name: "CLAUDE.md" }));
    expect(onOpen).toHaveBeenCalledWith("i1");
    expect(screen.queryByRole("button", { name: /Other connected tools/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "agent-routing" })).not.toBeInTheDocument(); // i2 is not in `items`
  });

  it("shows only the five biggest", () => {
    const many = Array.from({ length: 9 }, (_, i) => row({ name: `n${i}`, usdWeek: 9 - i }));
    render(<CostPanel report={report(many)} items={items} />);
    expect(within(screen.getByRole("list")).getAllByRole("listitem")).toHaveLength(5);
  });

  it("shows sizes instead of dollars when nothing could be priced", () => {
    const sizes = [row({ name: "big", tokens: 900, usdWeek: 0, usdLoaded: 0 }), row({ name: "small", tokens: 10, usdWeek: 0, usdLoaded: 0 })];
    const { container } = render(<CostPanel report={report(sizes, { turns: 0, usdWeek: 0, incomplete: true })} items={items} />);
    expect(container.textContent).not.toContain("$");
    expect(container.textContent).toContain("900");
    expect(container.textContent).toContain("No chats yet, so sizes only.");
  });

  it("says when some chats could not be priced", () => {
    render(<CostPanel report={report(rows, { incomplete: true })} items={items} />);
    expect(screen.getByText(/Some chats could not be priced/)).toBeInTheDocument();
  });

  it("shows when an on-demand item only has a body", () => {
    const scoped = row({ id: "i1", name: "ts-only", kind: "rule", tokens: 0, turns: 0, bodyTokens: 300, usdWeek: 0.5, usdUsed: 0.5, uses: 2 });
    render(<CostPanel report={report([scoped])} items={items} />);
    expect(screen.getByText(/300 tokens when used/)).toBeInTheDocument();
  });
});
