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
  row({ id: "i1", name: "CLAUDE.md", loadsIn: "Chats in pixel-garden", global: false, tokens: 8804, turns: 12_103, usdWeek: 21.26 }),
  row({ name: "Other connected tools (19)", kind: "mcpServer", loadsIn: "Chats that connect them", global: false, tokens: 7294, turns: 15_682, usdWeek: 25.26, measured: true }),
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

  it("leads with one headline in tokens, then ranks rows by tokens", () => {
    render(<CostPanel report={report(rows)} items={items} />);
    expect(screen.getByRole("heading", { name: "What your setup costs" })).toBeInTheDocument();
    const head = document.querySelector("[data-cost-headline]")!;
    expect(head).toHaveTextContent("30k tokens per message, in every chat");

    const lis = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(lis).toHaveLength(3);
    // Ranked by tokens over the window: tools 114M, then CLAUDE.md 107M, then the rule 62M.
    // A count is set the way the headings set one ("Global 3"): after the label, no brackets.
    expect(lis[0]).toHaveTextContent("Other connected tools19");
    expect(lis[0]).not.toHaveTextContent("(19)");
    expect(lis[0]).toHaveTextContent("114M a week");
    // One unit on the surface: the row says where it loads, never a second per-message figure
    // (a some-chats row can be bigger per message than the every-chat headline).
    expect(lis[0]).toHaveTextContent("Only chats that connect them");
    expect(lis[0]).not.toHaveTextContent("per message");
    // A project's file carries the project name in its title, so same-named files differ.
    expect(lis[1]).toHaveTextContent("CLAUDE.md · pixel-garden");
    expect(lis[1]).toHaveTextContent("107M a week");
    expect(lis[2]).toHaveTextContent("agent-routing");
    expect(lis[2]).not.toHaveTextContent("·");
    expect(lis[1]).toHaveTextContent("Only chats in pixel-garden");
    expect(lis[2]).toHaveTextContent("Every chat");
  });

  it("shows no dollars on screen: they live in the hover", () => {
    const { container } = render(<CostPanel report={report(rows)} items={items} />);
    expect(container.textContent).not.toContain("$");
    expect(document.querySelector("[data-cost-headline]")).toHaveAttribute("title", "Estimate: about $287 a week at API prices, last 7 days.");
    expect(document.querySelector('[data-cost-row="i1"]')?.getAttribute("title")).toMatch(/8,804 tokens with every message.*Estimate: about \$21 a week/);
  });

  it("carries no explanation sentence, pills or Live tag: the estimate is only in the hovers", () => {
    const { container } = render(<CostPanel report={report(rows)} items={items} />);
    expect(container.textContent).not.toMatch(/Estimate/);
    expect(container.querySelectorAll("[title*='Estimate']").length).toBeGreaterThan(0);
    expect(container.textContent).not.toMatch(/\bLive\b/);
    expect(container.querySelector(".chip, [class*='rounded-full'][class*='px-']")).toBeNull();
  });

  it("opens an item that is in the setup, and leaves the rest as plain text", async () => {
    const onOpen = vi.fn();
    render(<CostPanel report={report(rows)} items={items} onOpen={onOpen} />);
    await userEvent.click(screen.getByRole("button", { name: "CLAUDE.md · pixel-garden" }));
    expect(onOpen).toHaveBeenCalledWith("i1");
    expect(screen.queryByRole("button", { name: /Other connected tools/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "agent-routing" })).not.toBeInTheDocument(); // i2 is not in `items`
  });

  it("shows only the four biggest", () => {
    const many = Array.from({ length: 9 }, (_, i) => row({ name: `n${i}`, tokens: 1000 - i * 10 }));
    render(<CostPanel report={report(many)} items={items} />);
    expect(within(screen.getByRole("list")).getAllByRole("listitem")).toHaveLength(4);
  });

  it("shows per-message sizes, with no weekly figure, when there are no chats yet", () => {
    const sizes = [row({ name: "big", tokens: 900, turns: 0, usdWeek: 0 }), row({ name: "small", tokens: 10, turns: 0, usdWeek: 0 })];
    const { container } = render(<CostPanel report={report(sizes, { turns: 0, usdWeek: 0 })} items={items} />);
    expect(container.textContent).not.toContain("$");
    expect(container.textContent).not.toContain("a week");
    const lis = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(lis[0]).toHaveTextContent("900 each");
    expect(document.querySelector("[data-cost-headline]")).not.toHaveAttribute("title");
  });

  it("leaves on-demand items to their own lists", () => {
    const onDemand = row({ id: "i1", name: "brand", kind: "skill", tokens: 0, turns: 0, bodyTokens: 7300 });
    const { container } = render(<CostPanel report={report([onDemand])} items={items} />);
    expect(container).toBeEmptyDOMElement();
  });
});
