import { describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CATCH_UP_CARD_DELAY_MS, IndexProgress } from "./IndexProgress";
import type { IndexProgress as Progress, UsageStatus } from "../lib/types";

const status = (over: Partial<UsageStatus> = {}): UsageStatus => ({
  state: "idle",
  firstIndexDone: true,
  lastIndexedAt: 1,
  filesTracked: 3,
  filesMissing: 0,
  malformedLines: 0,
  longLines: 0,
  unknownModels: [],
  cwAssumedRows: 0,
  crossFileDupes: 0,
  cachePath: "x",
  cacheBytes: 0,
  error: null,
  note: null,
  ...over,
});

const progress = (over: Partial<Progress> = {}): Progress => ({
  phase: "reading",
  filesDone: 124,
  filesTotal: 980,
  bytesDone: 50_000_000,
  bytesTotal: 200_000_000,
  startedAt: 0,
  ...over,
});

describe("IndexProgress", () => {
  it("says nothing while the engine is idle and healthy", () => {
    const { container } = render(<IndexProgress status={status()} progress={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("says nothing before the first status arrives", () => {
    const { container } = render(<IndexProgress status={null} progress={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a real progress bar with counts during the first read", () => {
    render(<IndexProgress status={status({ state: "indexing", firstIndexDone: false })} progress={progress()} />);
    const bar = screen.getByRole("progressbar", { name: "Reading your sessions" });
    expect(bar).toHaveAttribute("aria-valuenow", "25");
    expect(screen.getByText(/124 of 980 files/)).toBeInTheDocument();
    expect(screen.getByText(/This happens once/)).toBeInTheDocument();
  });

  it("uses an indeterminate bar before any size is known", () => {
    render(<IndexProgress status={status({ state: "indexing", firstIndexDone: false })} progress={null} />);
    const bar = screen.getByRole("progressbar");
    expect(bar).not.toHaveAttribute("aria-valuenow");
    expect(bar).toHaveAttribute("aria-valuetext", "Starting");
    expect(screen.getByText("Looking for sessions...")).toBeInTheDocument();
  });

  it("is quieter on later passes, and shows them only once they run long", () => {
    vi.useFakeTimers();
    try {
      render(<IndexProgress status={status({ state: "indexing", firstIndexDone: true })} progress={progress()} />);
      expect(screen.queryByText("Catching up with your latest sessions")).not.toBeInTheDocument();
      act(() => vi.advanceTimersByTime(CATCH_UP_CARD_DELAY_MS));
      expect(screen.getByText("Catching up with your latest sessions")).toBeInTheDocument();
      expect(screen.queryByText(/This happens once/)).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("never blinks for a quick catch-up pass (a window drag used to start one)", () => {
    vi.useFakeTimers();
    try {
      const { container, rerender } = render(<IndexProgress status={status()} progress={null} />);
      rerender(<IndexProgress status={status({ state: "indexing" })} progress={progress({ phase: "scanning", filesTotal: 0 })} />);
      expect(container).toBeEmptyDOMElement();
      act(() => vi.advanceTimersByTime(5));
      rerender(<IndexProgress status={status()} progress={null} />);
      act(() => vi.advanceTimersByTime(CATCH_UP_CARD_DELAY_MS * 2));
      expect(container).toBeEmptyDOMElement();
      // The next pass starts its own clock.
      rerender(<IndexProgress status={status({ state: "indexing" })} progress={progress()} />);
      act(() => vi.advanceTimersByTime(CATCH_UP_CARD_DELAY_MS - 1));
      expect(container).toBeEmptyDOMElement();
    } finally {
      vi.useRealTimers();
    }
  });

  it("never exceeds 100 percent", () => {
    render(<IndexProgress status={status({ state: "indexing", firstIndexDone: false })} progress={progress({ bytesDone: 9, bytesTotal: 3 })} />);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
  });

  it("reports an error as an alert with a way to retry", async () => {
    const retry = vi.fn();
    render(<IndexProgress status={status({ state: "error", error: "The cache is locked." })} progress={null} onRetry={retry} />);
    expect(screen.getByRole("alert")).toHaveTextContent("The cache is locked.");
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it("explains a read-only cache and a rebuild in plain words", () => {
    const { rerender } = render(<IndexProgress status={status({ state: "readOnly" })} progress={null} />);
    expect(screen.getByRole("status")).toHaveTextContent(/newer Atlas/);
    rerender(<IndexProgress status={status({ state: "recovering" })} progress={null} />);
    expect(screen.getByRole("status")).toHaveTextContent(/rebuilding/);
  });
});
