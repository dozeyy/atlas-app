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
    expect(screen.getByRole("img", { name: "2 of 5 used in the last 30 days" })).toBeInTheDocument();

    const most = screen.getByRole("heading", { name: "Used most" }).parentElement!;
    const names = within(most).getAllByRole("listitem").map((li) => li.textContent);
    expect(names[0]).toContain("commit-helper");
    expect(names[0]).toContain("12x");
    expect(names[1]).toContain("deep-research");

    // The unused are named: each one a small tag with its name, and the whole line on hover.
    const never = screen.getByRole("heading", { name: /Never used/ }).parentElement!;
    expect(never).toHaveTextContent("3");
    const tags = [...never.querySelectorAll("[data-never-list] [data-never]")];
    expect(tags.map((c) => c.textContent)).toEqual(["brand-new", "code-reviewer", "dusty"]); // A to Z
    const titles = tags.map((c) => c.getAttribute("title")!);
    expect(titles).toContain("dusty (skill), never used");
    expect(titles.some((t) => /^code-reviewer \(agent\), last used /.test(t))).toBe(true);
  });

  it("counts something added recently and not used since as never used, with no 'too soon' group", () => {
    render(<UsagePanel rows={rows} items={items} />);
    expect(screen.queryByText(/too soon/)).toBeNull();
    const never = screen.getByRole("heading", { name: /Never used/ }).parentElement!;
    expect(never.querySelector('[data-never-list] [data-never="s4"]')).toHaveAttribute("title", "brand-new (skill), never used");
  });

  it("names the first few of dozens of unused items and lays out the rest on request", () => {
    const many = Array.from({ length: 130 }, (_, i) => ({ id: `m${i}`, kind: i % 3 ? "skill" : "agent", name: `thing-${i}` })) as SetupItem[];
    const manyRows: UsageRow[] = many.map((it, i) => ({ id: it.id, kind: it.kind, uses30d: i < 6 ? 10 - i : 0, lastUsed: null, isNew: i >= 120 }));
    render(<UsagePanel rows={manyRows} items={many} onOpen={() => {}} />);
    const most = screen.getByRole("heading", { name: "Used most" }).parentElement!;
    expect(within(most).getAllByRole("listitem")).toHaveLength(4);
    const list = document.querySelector("[data-never-list]")!;
    expect(list.querySelectorAll("[data-never]")).toHaveLength(8); // 124 never used, 8 named
    // Numbers sort as numbers: thing-6 comes before thing-10.
    expect(list.querySelector("[data-never]")).toHaveTextContent("thing-6");
    const more = within(list as HTMLElement).getByRole("button", { name: "+116 more" });
    expect(more).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(more);
    expect(list.querySelectorAll("[data-never]")).toHaveLength(124);
    fireEvent.click(within(list as HTMLElement).getByRole("button", { name: "Show fewer" }));
    expect(list.querySelectorAll("[data-never]")).toHaveLength(8);
  });

  it("shows no 'more' button when every unused item is already named", () => {
    render(<UsagePanel rows={rows} items={items} onOpen={() => {}} />);
    expect(screen.queryByRole("button", { name: /more$/ })).toBeNull();
    expect(screen.queryByText(/Hover one/)).toBeNull();
  });

  it("opens an item when its name is pressed, used or unused", () => {
    const opened: string[] = [];
    render(<UsagePanel rows={rows} items={items} onOpen={(id) => opened.push(id)} />);
    screen.getByRole("button", { name: "commit-helper" }).click();
    (document.querySelector('[data-never="s3"]') as HTMLElement).click();
    expect(opened).toEqual(["s1", "s3"]);
  });

  it("says so when everything has been used", () => {
    render(<UsagePanel rows={rows.filter((r) => r.uses30d > 0)} items={items} />);
    expect(screen.getByText("Everything here has been used. Nice and tidy.")).toBeInTheDocument();
  });
});
