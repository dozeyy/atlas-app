import { beforeEach, describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../App";
import { AtlasProvider } from "./AtlasProvider";
import { setBackend } from "../lib/ipc";
import { MockBackend } from "../lib/mock";
import type { AppInfo } from "../lib/types";

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

    await userEvent.click(screen.getByRole("button", { name: "Setup" })); // starts a save
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
