import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpdateButton } from "./UpdateButton";
import { setBackend } from "../lib/ipc";
import { MockBackend } from "../lib/mock";
import { CHECK_EVERY_MS, FIRST_CHECK_MS, checkForUpdate, resetUpdateStore } from "../lib/updateStore";

const NEWER = { version: "0.2.0", notes: "A calmer Dashboard.\n\n- faster first open", current: "0.1.0" };

let mock: MockBackend;

beforeEach(() => {
  resetUpdateStore();
  mock = new MockBackend();
  mock.updates.stepMs = 5;
  setBackend(mock);
});
afterEach(() => {
  setBackend(null);
  vi.useRealTimers();
});

const icon = () => screen.queryByRole("button", { name: /update to|downloading|installing/i });

describe("the update icon", () => {
  it("shows nothing when there is no newer version", async () => {
    render(<UpdateButton />);
    expect(await checkForUpdate({ manual: false })).toEqual({ outcome: "latest" });
    expect(icon()).toBeNull();
  });

  it("appears with the version in its name and the notes as the quieter second paragraph", async () => {
    mock.updates.available = NEWER;
    render(<UpdateButton />);
    await act(() => checkForUpdate({ manual: false }));
    const b = icon()!;
    expect(b).toHaveAccessibleName("Update to 0.2.0");
    const [first, ...rest] = (b.getAttribute("title") ?? "").split("\n");
    expect(first).toBe("Update to 0.2.0");
    expect(rest.join(" ")).toContain("A calmer Dashboard");
    expect(rest.join(" ")).not.toMatch(/[-#*]/); // markdown marks are stripped
  });

  it("checks once after the first paint and then every hour, and never installs by itself", async () => {
    vi.useFakeTimers();
    mock.updates.available = NEWER;
    render(<UpdateButton />);
    expect(mock.updates.checks).toBe(0);
    await act(() => vi.advanceTimersByTimeAsync(FIRST_CHECK_MS + 1));
    expect(mock.updates.checks).toBe(1);
    await act(() => vi.advanceTimersByTimeAsync(CHECK_EVERY_MS));
    expect(mock.updates.checks).toBe(2);
    expect(mock.updates.installs).toBe(0); // the offer pops up; nothing installs by itself
    expect(screen.getByRole("dialog", { name: "Update" })).toBeInTheDocument();
  });

  it("a failed check is silent", async () => {
    mock.updates.available = NEWER;
    mock.updates.checkError = "Could not reach the update server.";
    render(<UpdateButton />);
    const r = await act(() => checkForUpdate({ manual: false }));
    expect(r).toEqual({ outcome: "failed", message: "Could not reach the update server." });
    expect(icon()).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("pops up a small offer by itself, once per launch, without taking the focus", async () => {
    mock.updates.available = NEWER;
    render(<UpdateButton />);
    await act(() => checkForUpdate({ manual: false }));
    const dialog = await screen.findByRole("dialog", { name: "Update" });
    expect(dialog).toHaveTextContent("Atlas 0.2.0 is ready");
    expect(dialog.contains(document.activeElement)).toBe(false); // never steals the keyboard
    expect(screen.getByRole("button", { name: "Update and restart" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Later" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(icon()).not.toBeNull(); // Escape closes the panel, the icon stays
    await act(() => checkForUpdate({ manual: false }));
    expect(screen.queryByRole("dialog")).toBeNull(); // offered once per launch, not on every check
    await userEvent.click(icon()!);
    expect(await screen.findByRole("dialog", { name: "Update" })).toBeInTheDocument();
  });

  it("'Later' hides the icon until the next launch; only the Settings button brings it back", async () => {
    mock.updates.available = NEWER;
    render(<UpdateButton />);
    await act(() => checkForUpdate({ manual: false }));
    await userEvent.click(await screen.findByRole("button", { name: "Later" }));
    expect(icon()).toBeNull();
    await act(() => checkForUpdate({ manual: false }));
    expect(icon()).toBeNull();
    await act(() => checkForUpdate({ manual: true }));
    expect(icon()).not.toBeNull();
  });

  it("'Update and restart' shows the download on the icon as a ring, then installing", async () => {
    mock.updates.available = NEWER;
    mock.updates.stepMs = 30;
    render(<UpdateButton />);
    await act(() => checkForUpdate({ manual: false }));
    await userEvent.click(await screen.findByRole("button", { name: "Update and restart" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /^Downloading 0\.2\.0, \d+%$/ })).toHaveAttribute("data-state", "downloading"));
    expect(document.querySelector(".upd-ring .upd-arc")).not.toBeNull();
    await waitFor(() => expect(screen.getByRole("button", { name: "Installing 0.2.0" })).toHaveAttribute("data-state", "installing"));
    expect(mock.updates.installs).toBe(1);
  });

  it("a failure says one plain line with a retry, and the retry runs again", async () => {
    mock.updates.available = NEWER;
    mock.updates.installError = "The update did not pass its safety check, so it was not installed.";
    render(<UpdateButton />);
    await act(() => checkForUpdate({ manual: false }));
    await userEvent.click(await screen.findByRole("button", { name: "Update and restart" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The update did not pass its safety check, so it was not installed.");
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(mock.updates.installs).toBe(2));
    await waitFor(() => expect(icon()).toHaveAttribute("data-state", "installing"));
  });
});
