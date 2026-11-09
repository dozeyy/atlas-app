import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { UsagePanel } from "./UsagePanel";
import type { SetupItem } from "../../lib/setup-types";
import type { UsageRow } from "../../lib/usage-types";

const DAY = 86_400_000;
const items = [
  { id: "s1", kind: "skill", name: "commit-helper" },
  { id: "s2", kind: "skill", name: "deep-research" },
  { id: "s3", kind: "skill", name: "dusty" },
  { id: "a1", kind: "agent", name: "code-reviewer" },
  { id: "s4", kind: "skill", name: "brand-new" },
] as SetupItem[];

const rows: UsageRow[] = [
  { id: "s1", kind: "skill", uses30d: 12, lastUsed: Date.now() - DAY },
  { id: "s2", kind: "skill", uses30d: 3, lastUsed: Date.now() - 3 * DAY },
  { id: "a1", kind: "agent", uses30d: 0, lastUsed: Date.now() - 80 * DAY },
  { id: "s3", kind: "skill", uses30d: 0, lastUsed: null },
  { id: "s4", kind: "skill", uses30d: 0, lastUsed: null, isNew: true },
];

describe("UsagePanel", () => {
  it("draws nothing at all without data: no placeholder, no coming soon", () => {
    for (const r of [null, undefined, [] as UsageRow[]]) {
      const { container, unmount } = render(<UsagePanel rows={r} items={items} />);
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });

  it("draws nothing when no row matches anything that is set up", () => {
    const { container } = render(<UsagePanel rows={[{ id: "zzz", kind: "skill", uses30d: 4, lastUsed: null }]} items={items} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a ring, ranks what is used, and counts only established items", () => {
    render(<UsagePanel rows={rows} items={items} />);
    expect(screen.getByRole("heading", { name: "Used and never used" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "2 of 4 used in the last 30 days" })).toBeInTheDocument();

    const most = screen.getByRole("heading", { name: "Used most" }).parentElement!;
    const names = within(most).getAllByRole("listitem").map((li) => li.textContent);
    expect(names[0]).toContain("commit-helper");
    expect(names[0]).toContain("12x");
    expect(names[1]).toContain("deep-research");

    // The unused are squares you hover, each named in full for screen readers and the tooltip.
    const never = screen.getByRole("heading", { name: /Never used/ }).parentElement!;
    expect(never).toHaveTextContent("2");
    const cells = never.querySelectorAll("[data-dust-field] [data-dust]");
    const titles = [...cells].map((c) => c.getAttribute("title")!);
    expect(titles).toHaveLength(2);
    expect(titles).toContain("dusty (skill), never used");
    expect(titles.some((t) => /^code-reviewer \(agent\), last used /.test(t))).toBe(true);
  });

  it("says new, not never used, for something added recently", () => {
    render(<UsagePanel rows={rows} items={items} />);
    const fresh = screen.getByRole("heading", { name: "New, too soon to tell" }).parentElement!;
    expect(fresh.querySelector('[data-dust="s4"]')).not.toBeNull();
    const never = screen.getByRole("heading", { name: /Never used/ }).parentElement!;
    expect(never.querySelectorAll('[data-dust-field] [data-dust="s4"]')).toHaveLength(0);
    expect(fresh.querySelector("[data-dust]")).toHaveAttribute("title", "brand-new (skill), new, too soon to tell");
  });

  it("packs dozens of unused items into a capped field and says how many are left out", () => {
    const many = Array.from({ length: 130 }, (_, i) => ({ id: `m${i}`, kind: i % 3 ? "skill" : "agent", name: `thing-${i}` })) as SetupItem[];
    const manyRows: UsageRow[] = many.map((it, i) => ({ id: it.id, kind: it.kind, uses30d: i < 6 ? 10 - i : 0, lastUsed: null, isNew: i >= 120 }));
    render(<UsagePanel rows={manyRows} items={many} onOpen={() => {}} />);
    const most = screen.getByRole("heading", { name: "Used most" }).parentElement!;
    expect(within(most).getAllByRole("listitem")).toHaveLength(4);
    const field = document.querySelector("[data-dust-field]")!;
    expect(field.querySelectorAll("[data-dust]")).toHaveLength(78); // 114 never used, 78 drawn
    expect(within(field as HTMLElement).getByText("+36")).toBeInTheDocument();
    const fresh = screen.getByRole("heading", { name: "New, too soon to tell" }).parentElement!;
    expect(fresh.querySelectorAll("[data-dust]")).toHaveLength(6);
    expect(within(fresh).getByText("+4")).toBeInTheDocument();
  });

  it("names a square under the field on hover and focus", () => {
    render(<UsagePanel rows={rows} items={items} onOpen={() => {}} />);
    expect(screen.getByText("Gathering dust. Hover one to see which.")).toBeInTheDocument();
    const dusty = document.querySelector('[data-dust="s3"]')!;
    fireEvent.mouseEnter(dusty);
    expect(screen.getAllByText("dusty (skill), never used").length).toBeGreaterThan(0);
    fireEvent.mouseLeave(dusty);
    expect(screen.getByText("Gathering dust. Hover one to see which.")).toBeInTheDocument();
  });

  it("walks the field with arrow keys using one tab stop", () => {
    render(<UsagePanel rows={rows} items={items} onOpen={() => {}} />);
    const field = document.querySelector("[data-dust-field]")!;
    const [first, second] = [...field.querySelectorAll<HTMLElement>("[data-dust]")];
    expect(first).toHaveAttribute("tabindex", "0");
    expect(second).toHaveAttribute("tabindex", "-1");
    first!.focus();
    fireEvent.keyDown(first!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(second);
  });

  it("opens an item when its name or its square is pressed", () => {
    const opened: string[] = [];
    render(<UsagePanel rows={rows} items={items} onOpen={(id) => opened.push(id)} />);
    screen.getByRole("button", { name: "commit-helper" }).click();
    (document.querySelector('[data-dust="s3"]') as HTMLElement).click();
    expect(opened).toEqual(["s1", "s3"]);
  });

  it("says so when everything has been used", () => {
    render(<UsagePanel rows={rows.filter((r) => r.uses30d > 0)} items={items} />);
    expect(screen.getByText("Everything here has been used. Nice and tidy.")).toBeInTheDocument();
  });
});
