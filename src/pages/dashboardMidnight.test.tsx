import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { App } from "../App";
import { AtlasProvider } from "../state/AtlasProvider";
import { setBackend } from "../lib/ipc";
import { MockBackend } from "../lib/mock";
import { addDays, localDay } from "../lib/usage";

// The window stays open overnight (tray): the Dashboard must move to the new day by itself.

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setBackend(null);
});

async function settle(ms = 0) {
  await act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
}

describe("Dashboard at midnight", () => {
  it("asks for the new day everywhere that shows a date, with no usage event", async () => {
    vi.setSystemTime(new Date("2026-11-10T23:59:40"));
    localStorage.setItem("atlas.mock.settings", JSON.stringify({ lastView: "dashboard" }));
    const backend = new MockBackend();
    const dash = vi.spyOn(backend.usage, "usageDashboard");
    const life = vi.spyOn(backend.usage, "usageLifetime");
    const timeline = vi.spyOn(backend.usage, "usageTimeline");
    setBackend(backend);
    render(
      <AtlasProvider>
        <App />
      </AtlasProvider>,
    );
    await settle(1500);
    expect(screen.getByRole("region", { name: "All time" })).toBeInTheDocument();
    const dashBefore = dash.mock.calls.length;
    const lifeBefore = life.mock.calls.length;
    const lastTo = () => timeline.mock.calls.at(-1)![0].to;
    expect(lastTo()).toBe("2026-11-10");

    await settle(30_000); // midnight passes
    expect(localDay(new Date())).toBe("2026-11-11");

    // The cards, the streak and heat grid (365-day picture), the Activity chart and the lifetime row
    // all asked again for the new day.
    expect(dash.mock.calls.length).toBeGreaterThan(dashBefore);
    expect(life.mock.calls.length).toBeGreaterThan(lifeBefore);
    const asked = timeline.mock.calls.map(([a]) => a);
    expect(asked.some((a) => a.to === "2026-11-11" && a.from === addDays("2026-11-11", -364))).toBe(true);
    expect(asked.some((a) => a.to === "2026-11-11" && a.from === addDays("2026-11-11", -29) && a.bucket === "day")).toBe(true);
    // The heat grid's last cell is the new day (its label names the span it covers).
    expect(screen.getByRole("region", { name: "On a roll" })).toBeInTheDocument();
  });
});
