import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
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

  it("ranks what is used, lists what is not, and counts only established items", () => {
    render(<UsagePanel rows={rows} items={items} />);
    expect(screen.getByRole("heading", { name: "Used and never used" })).toBeInTheDocument();
    expect(screen.getByText("2 of 4 used in the last 30 days")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "2 used, 2 never used" })).toBeInTheDocument();

    const most = screen.getByRole("heading", { name: "Used most" }).parentElement!;
    const names = within(most).getAllByRole("listitem").map((li) => li.textContent);
    expect(names[0]).toContain("commit-helper");
    expect(names[0]).toContain("12 times");
    expect(names[1]).toContain("deep-research");

    const never = screen.getByRole("heading", { name: /Never used/ }).parentElement!;
    expect(within(never).getByText("dusty")).toBeInTheDocument();
    expect(within(never).getByText("code-reviewer")).toBeInTheDocument();
    expect(within(never).getByText(/last used/)).toBeInTheDocument();
  });

  it("says new, not never used, for something added recently", () => {
    render(<UsagePanel rows={rows} items={items} />);
    const fresh = screen.getByRole("heading", { name: "New, too soon to tell" }).parentElement!;
    expect(within(fresh).getByText("brand-new")).toBeInTheDocument();
    const never = screen.getByRole("heading", { name: /Never used/ }).parentElement!;
    expect(within(within(never).getAllByRole("list")[0]!).queryByText("brand-new")).not.toBeInTheDocument();
  });

  it("keeps each list short and says how many are left out", () => {
    // 6 used, 6 never used, 4 new.
    const many = Array.from({ length: 16 }, (_, i) => ({ id: `m${i}`, kind: "skill", name: `skill-${i}` })) as SetupItem[];
    const manyRows: UsageRow[] = many.map((it, i) => ({
      id: it.id,
      kind: "skill",
      uses30d: i < 6 ? 10 - i : 0,
      lastUsed: null,
      isNew: i >= 12,
    }));
    render(<UsagePanel rows={manyRows} items={many} onOpen={() => {}} />);
    const most = screen.getByRole("heading", { name: "Used most" }).parentElement!;
    expect(within(most).getAllByRole("listitem")).toHaveLength(4);
    const never = screen.getByRole("heading", { name: /Never used/ }).parentElement!;
    expect(within(never).getByText("and 1 more")).toBeInTheDocument(); // 6 never used, 5 shown
    const fresh = screen.getByRole("heading", { name: "New, too soon to tell" }).parentElement!;
    expect(within(fresh).getAllByRole("button")).toHaveLength(3);
    expect(within(fresh).getByText("and 1 more")).toBeInTheDocument();
  });

  it("opens an item when its name is pressed", () => {
    const opened: string[] = [];
    render(<UsagePanel rows={rows} items={items} onOpen={(id) => opened.push(id)} />);
    screen.getByRole("button", { name: "commit-helper" }).click();
    expect(opened).toEqual(["s1"]);
  });
});
