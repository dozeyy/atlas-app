import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../App";
import { AtlasProvider } from "./AtlasProvider";
import { setBackend } from "../lib/ipc";
import { MockBackend } from "../lib/mock";
import type { AppInfo } from "../lib/types";
import type { SettingsPatch } from "../lib/ipc";

/** A backend the test can push snapshots into, like the Rust side's events. */
class Probe extends MockBackend {
  push(info: AppInfo) {
    // @ts-expect-error reaching into the stand-in on purpose
    (this.listeners as Set<(i: AppInfo) => void>).forEach((l) => l(info));
  }
}

function mount(backend: Probe) {
  setBackend(backend);
  return render(
    <AtlasProvider>
      <App />
    </AtlasProvider>,
  );
}

const withError = (b: Probe, seq: number, settingsSaveError: string | null): AppInfo => ({
  ...b.boot(),
  seq,
  settingsSaveError,
});

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

describe("a failed settings save", () => {
  it("is shown on every page, in words, and goes away when a save works", async () => {
    const b = new Probe();
    mount(b);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    act(() => b.push(withError(b, 5, "Atlas could not save its settings (disk full). What you changed will be lost when Atlas closes.")));
    expect(screen.getByRole("alert")).toHaveTextContent("could not save its settings");
    await userEvent.click(screen.getByRole("button", { name: "Sessions" }));
    expect(screen.getByRole("alert")).toBeInTheDocument();

    act(() => b.push(withError(b, 6, null)));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("stale snapshots", () => {
  it("ignores an event older than what the page already has", () => {
    const b = new Probe();
    mount(b);
    act(() => b.push(withError(b, 10, "newer")));
    act(() => b.push(withError(b, 4, null))); // arrived late
    expect(screen.getByRole("alert")).toHaveTextContent("newer");
    act(() => b.push(withError(b, 11, null)));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("ignores a command result that an event overtook", async () => {
    const b = new Probe();
    let finish!: (i: AppInfo) => void;
    b.updateSettings = () => new Promise<AppInfo>((r) => (finish = r));
    mount(b);

    await userEvent.click(screen.getByRole("button", { name: "Toolkit" })); // starts a save
    act(() => b.push(withError(b, 20, "newer")));
    await act(async () => finish(withError(b, 3, null))); // the save's answer, taken earlier
    expect(screen.getByRole("alert")).toHaveTextContent("newer");
  });

  it("takes an equal or higher number", () => {
    const b = new Probe();
    mount(b);
    act(() => b.push(withError(b, 7, "a")));
    act(() => b.push(withError(b, 7, "b")));
    expect(screen.getByRole("alert")).toHaveTextContent("b");
  });
});

describe("zoom keys", () => {
  const press = (key: string, o: KeyboardEventInit = {}) => fireEvent.keyDown(window, { key, ctrlKey: true, ...o });
  const zoomVar = () => document.documentElement.style.getPropertyValue("--zoom");
  const savedZoom = () => JSON.parse(localStorage.getItem("atlas.mock.settings") ?? "{}").zoomPercent;

  /** A backend whose saves wait until the test lets them finish, in the order they were asked. */
  class Slow extends Probe {
    asked: { patch: SettingsPatch; done: () => void; fail: (e: Error) => void }[] = [];
    updateSettings = (patch: SettingsPatch) =>
      new Promise<AppInfo>((resolve, reject) => {
        const real = MockBackend.prototype.updateSettings.bind(this);
        this.asked.push({ patch, done: () => void real(patch).then(resolve), fail: (e) => reject(e) });
      });
  }

  beforeEach(() => document.documentElement.style.removeProperty("--zoom"));

  it("Ctrl + and - step through the levels, Ctrl 0 goes back to 100, and each one is saved", async () => {
    const b = new Probe();
    mount(b);
    press("=");
    await waitFor(() => expect(savedZoom()).toBe(110));
    expect(zoomVar()).toBe("1.1");
    press("=");
    await waitFor(() => expect(savedZoom()).toBe(125));
    press("-");
    await waitFor(() => expect(savedZoom()).toBe(110));
    press("0");
    await waitFor(() => expect(savedZoom()).toBe(100));
    expect(zoomVar()).toBe("1");
  });

  it("other keys, Alt chords and a plain + do nothing", () => {
    const b = new Probe();
    mount(b);
    const spy = vi.spyOn(b, "updateSettings");
    press("a");
    press("=", { altKey: true });
    fireEvent.keyDown(window, { key: "=" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("quick presses are saved one at a time, in order, and each steps from the one before", async () => {
    const b = new Slow();
    mount(b);
    press("=");
    press("=");
    press("=");
    expect(zoomVar()).toBe("1.5"); // 100 -> 110 -> 125 -> 150 on screen at once
    await waitFor(() => expect(b.asked).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(b.asked.map((a) => a.patch.zoomPercent)).toEqual([110]); // the next waits for this one
    await act(async () => b.asked[0].done());
    // The page re-rendered with 110 saved; a fourth press still steps from the 150 in flight.
    press("=");
    await waitFor(() => expect(b.asked.map((a) => a.patch.zoomPercent)).toEqual([110, 125]));
    await act(async () => b.asked[1].done());
    await waitFor(() => expect(b.asked).toHaveLength(3));
    await act(async () => b.asked[2].done());
    await waitFor(() => expect(b.asked).toHaveLength(4));
    expect(b.asked.map((a) => a.patch.zoomPercent)).toEqual([110, 125, 150, 175]);
    await act(async () => b.asked[3].done());
    expect(savedZoom()).toBe(175);
    expect(zoomVar()).toBe("1.75");
  });

  it("goes back to what is saved when the save fails", async () => {
    const b = new Slow();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    mount(b);
    press("=");
    expect(zoomVar()).toBe("1.1");
    await waitFor(() => expect(b.asked).toHaveLength(1));
    await act(async () => b.asked[0].fail(new Error("nope")));
    expect(zoomVar()).toBe("1");
    // A later press steps from the saved 100, not the failed 110.
    press("=");
    await waitFor(() => expect(b.asked.map((a) => a.patch.zoomPercent)).toEqual([110, 110]));
    err.mockRestore();
  });

  it("a failure with a newer press waiting does not pull the page back", async () => {
    const b = new Slow();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    mount(b);
    press("=");
    press("=");
    await waitFor(() => expect(b.asked).toHaveLength(1));
    await act(async () => b.asked[0].fail(new Error("nope")));
    expect(zoomVar()).toBe("1.25");
    await waitFor(() => expect(b.asked).toHaveLength(2));
    await act(async () => b.asked[1].done());
    expect(savedZoom()).toBe(125);
    expect(zoomVar()).toBe("1.25");
    err.mockRestore();
  });
});
