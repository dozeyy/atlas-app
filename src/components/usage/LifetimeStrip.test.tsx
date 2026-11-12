import { afterEach, describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { LifetimeStrip } from "./LifetimeStrip";
import { setBackend } from "../../lib/ipc";
import { MockBackend } from "../../lib/mock";
import type { Daily } from "../../lib/useDaily";

afterEach(() => setBackend(null));

const daily = (today: string, streak: number) => ({ today, streak, longest: streak, days: [], tokens: [], points: [] }) as Daily;

async function row(d: (lifeToday: string) => Daily | null) {
  const backend = new MockBackend();
  setBackend(backend);
  const life = await backend.usageLifetime();
  render(<LifetimeStrip daily={d(life.today)} />);
  const el = await screen.findByRole("region", { name: "All time" });
  await waitFor(() => expect(within(el).getByText(/^Since /)).toBeInTheDocument());
  return el;
}

describe("LifetimeStrip streaks", () => {
  it("shows both streak figures when they were counted up to the same day", async () => {
    const el = await row((t) => daily(t, 4));
    expect(el.querySelector('[title^="Days in a row"]')?.textContent).toBe("4");
    expect(Number(el.querySelector('[title^="Your longest streak"]')?.textContent)).toBeGreaterThanOrEqual(4);
  });

  it("hides both while the two were counted up to different days (right after midnight)", async () => {
    const el = await row(() => daily("1999-01-01", 4));
    expect(el.querySelector('[title^="Days in a row"]')).toBeNull();
    expect(el.querySelector('[title^="Your longest streak"]')).toBeNull();
    // The totals do not wait.
    expect(within(el).getByText("sessions")).toBeInTheDocument();
  });

  it("shows the totals with no daily picture at all", async () => {
    const el = await row(() => null);
    expect(el.querySelector('[title^="Days in a row"]')).toBeNull();
    expect(within(el).getByText("tokens")).toBeInTheDocument();
    expect(within(el).queryByRole("status")).toBeNull();
  });
});
