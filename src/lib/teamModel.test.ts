import { describe, expect, it } from "vitest";
import { endRows, filterCards, historyLine, loadPrefs, madeLabel, modelLine, rateSentence, reviewCountsLine, reviewerLine, startedLine, TOO_FEW, usualLine, verdictRows, weeklyBars, weeklyLegend, weeklyTitle } from "./teamModel";
import type { ReviewCounts, TypeCard } from "./teamTypes";

const counts = (o: Partial<ReviewCounts>): ReviewCounts => ({ tied: 0, passed: 0, sentBack: 0, other: 0, notTied: 0, rateOk: false, ...o });

describe("team model", () => {
  it("lists only the endings and verdicts that happened, and labels the effort", () => {
    expect(endRows({ finished: 6, errored: 1, stopped: 0, unknown: 0 }).map((r) => r.label)).toEqual(["Finished", "Hit an error"]);
    // A run whose ending is not known is still said.
    expect(endRows({ finished: 0, errored: 0, stopped: 0, unknown: 2 })).toEqual([{ key: "unknown", label: "Not known", n: 2 }]);
    expect(endRows({ finished: 0, errored: 0, stopped: 0, unknown: 0 })).toEqual([]);
    expect(verdictRows({ pass: 3, findings: 0, partial: 0, other: 0, none: 1 }).map((r) => r.label)).toEqual(["Passed", "No verdict"]);
    expect(modelLine("claude-sonnet-5-5", "high")).toMatch(/, high effort$/);
    expect(modelLine("claude-sonnet-5-5", null)).not.toMatch(/effort/);
    expect(weeklyLegend(12)).toBe("The small bars on a card are its runs per week, last 12 weeks.");
  });

  it("only says a rate from 5 tied reviews, and always says the counts", () => {
    expect(rateSentence(counts({ tied: 4, passed: 3, sentBack: 1, rateOk: false }))).toBeNull();
    expect(rateSentence(counts({ tied: 12, passed: 9, sentBack: 3, rateOk: true }))).toBe("Passed 9 of 12 reviews");
    expect(rateSentence(null)).toBeNull();
    expect(reviewCountsLine(counts({ tied: 4, passed: 3, sentBack: 1, notTied: 2 }))).toBe("3 passed, 1 sent back, 2 not tied to a review");
    expect(reviewCountsLine(counts({}))).toBe("No reviews yet");
  });

  it("hides medians below 3 runs, and says so once", () => {
    const few = { tooFewRuns: true, durationMsMedian: 1000, toolCallsMedian: 4 } as TypeCard;
    expect(usualLine(few)).toBe(TOO_FEW);
    const ok = { tooFewRuns: false, durationMsMedian: 540_000, toolCallsMedian: 1 } as TypeCard;
    expect(usualLine(ok)).toBe("Usually 9 min and 1 tool call");
    expect(usualLine({ ...ok, toolCallsMedian: null } as TypeCard)).toBe("Usually 9 min");
    expect(usualLine({ ...ok, durationMsMedian: null, toolCallsMedian: null } as TypeCard)).toBe(TOO_FEW);
  });

  it("says where runs started and the weekly counts in plain words", () => {
    expect(startedLine({ interactive: 1, headless: 6 })).toBe("1 run from a chat, 6 outside a chat");
    expect(weeklyTitle([0, 2, 1])).toBe("Runs per week, last 3 weeks, oldest first: 0, 2, 1. 3 runs in all.");
  });

  it("filters cards by every typed word", () => {
    const cards = [
      { displayName: "UI builder", agentType: "ui-builder" },
      { displayName: "Code reviewer", agentType: "code-reviewer" },
    ] as TypeCard[];
    expect(filterCards(cards, "")).toHaveLength(2);
    expect(filterCards(cards, "code rev").map((c) => c.agentType)).toEqual(["code-reviewer"]);
    expect(filterCards(cards, "nope")).toHaveLength(0);
  });

  it("labels twelve weeks ending today", () => {
    const bars = weeklyBars([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], new Date(2026, 10, 9, 12).getTime());
    expect(bars).toHaveLength(12);
    expect(bars[11].title).toBe("Week of Nov 3");
    expect(bars[11].valueText).toBe("11 runs");
    expect(bars[1].valueText).toBe("1 run");
  });

  it("words the reviewer line, the made label and the history line", () => {
    expect(reviewerLine({ pass: 6, findings: 3, partial: 0, other: 1, none: 1 })).toBe("6 passed, 3 sent back");
    expect(reviewerLine({ pass: 0, findings: 0, partial: 0, other: 0, none: 2 })).toBe("No verdicts given yet");
    expect(madeLabel(new Date(2026, 10, 9, 12).getTime())).toBe("Made a rule, Nov 9");
    expect(historyLine(82)).toBe("History covers the last 82 days.");
    expect(historyLine(1)).toBe("History covers the last 1 day.");
    expect(historyLine(null)).toBeNull();
  });

  it("falls back to the defaults when the saved choice is unreadable", () => {
    localStorage.setItem("atlas.team.prefs", "{not json");
    expect(loadPrefs()).toEqual({ view: "scorecard", range: "30", startedFrom: "all" });
    localStorage.setItem("atlas.team.prefs", JSON.stringify({ view: "review", range: "7", startedFrom: "headless" }));
    expect(loadPrefs()).toEqual({ view: "review", range: "7", startedFrom: "headless" });
    localStorage.clear();
  });
});
