import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../App";
import { AtlasProvider } from "../state/AtlasProvider";
import { setBackend } from "../lib/ipc";
import { MockBackend } from "../lib/mock";

function mount(prep?: (b: MockBackend) => void) {
  localStorage.setItem("atlas.mock.settings", JSON.stringify({ lastView: "history" }));
  const backend = new MockBackend();
  prep?.(backend);
  setBackend(backend);
  render(
    <AtlasProvider>
      <App />
    </AtlasProvider>,
  );
  return backend;
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});
afterEach(() => {
  setBackend(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("History", () => {
  it("opens on the numbers, the ribbon and the timeline, with no page title or explainer", async () => {
    mount();
    const rail = await screen.findByRole("list", { name: "Changes" });
    expect(screen.getByText("changes seen")).toBeInTheDocument();
    expect(screen.getByText("files watched")).toBeInTheDocument();
    // Watching began 24 days ago: the ribbon starts there, and its first date is the one beside it.
    const ribbon = screen.getByRole("group", { name: "Changes since Atlas began watching" });
    expect(within(ribbon).getAllByRole("button")).toHaveLength(25);
    const since = screen.getByText("watching since").previousElementSibling!.textContent!;
    expect(ribbon.nextElementSibling).toHaveTextContent(since);
    expect(within(rail).getByText("Today")).toBeInTheDocument();
    expect(within(rail).getByText("Yesterday")).toBeInTheDocument();
    expect(within(rail).getByText("Before Atlas was watching")).toBeInTheDocument();
    expect(screen.queryByText(/Live/)).not.toBeInTheDocument();
  });

  it("shows the newest change in full beside the list, with its lines", async () => {
    mount();
    const detail = await screen.findByTestId("history-detail");
    expect(within(detail).getByRole("heading", { name: "settings.json" })).toBeInTheDocument();
    expect(await within(detail).findByText("Changed the model to opus.")).toBeInTheDocument();
    expect(await within(detail).findByText('"model": "opus",')).toBeInTheDocument();
    expect(within(detail).getByRole("button", { name: "Copy this version" })).toBeInTheDocument();
    expect(within(detail).getByRole("button", { name: "Save a copy" })).toBeInTheDocument();
    // Read-only for now: Restore is a later phase.
    expect(screen.queryByRole("button", { name: /restore/i })).not.toBeInTheDocument();
  });

  it("picks another change from the list", async () => {
    mount();
    const rail = await screen.findByRole("list", { name: "Changes" });
    await userEvent.click(within(rail).getByRole("button", { name: /Agent added reviewer/ }));
    const detail = await screen.findByTestId("history-detail");
    expect(within(detail).getByRole("heading", { name: "reviewer" })).toBeInTheDocument();
  });

  it("filters by what changed and by search", async () => {
    mount();
    const rail = await screen.findByRole("list", { name: "Changes" });
    expect(within(rail).getAllByText(/Skill added/).length).toBeGreaterThan(0);
    const show = screen.getByRole("group", { name: "Show" });
    await userEvent.click(within(show).getByRole("button", { name: "Settings" }));
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Changes" })).queryByText(/Skill added/)).not.toBeInTheDocument());
    expect(within(screen.getByRole("list", { name: "Changes" })).getAllByText(/Settings file/).length).toBeGreaterThan(0);
    await userEvent.click(within(show).getByRole("button", { name: "All" }));
    await userEvent.type(screen.getByRole("searchbox", { name: "Search changes" }), "zzzz-no-such");
    expect(await screen.findByText(/Nothing matches that/)).toBeInTheDocument();
  });

  it("compares a copy with what is on disk now when asked", async () => {
    const backend = mount();
    const spy = vi.spyOn(backend, "historyDiff");
    const detail = await screen.findByTestId("history-detail");
    await within(detail).findByText('"model": "opus",');
    await userEvent.click(within(detail).getByLabelText("Compare with now"));
    await waitFor(() => expect(spy).toHaveBeenCalledWith(expect.objectContaining({ againstCurrent: true })));
  });

  it("opens the session behind a change Claude made", async () => {
    mount();
    const rail = await screen.findByRole("list", { name: "Changes" });
    await userEvent.click(within(rail).getByText(/Skill edited by Claude/));
    const detail = await screen.findByTestId("history-detail");
    expect(within(detail).getByRole("button", { name: "Open that session" })).toBeInTheDocument();
    expect(within(detail).getByText(/Kept by Claude Code while it worked/)).toBeInTheDocument();
  });

  it("says a removed file's last copy is still there", async () => {
    mount();
    const rail = await screen.findByRole("list", { name: "Changes" });
    await userEvent.click(within(rail).getByText(/Skill removed/));
    const detail = await screen.findByTestId("history-detail");
    expect(within(detail).getByText(/last copy Atlas kept/)).toBeInTheDocument();
  });

  it("shows a change from before Atlas was watching as a date, without inventing a diff or a sentence", async () => {
    mount();
    const rail = await screen.findByRole("list", { name: "Changes" });
    expect(within(rail).queryByText("Last changed here.")).not.toBeInTheDocument();
    await userEvent.click(within(rail).getAllByText(/last changed/i)[0]);
    const detail = await screen.findByTestId("history-detail");
    // The header already says it, with the date: no second line repeats it.
    expect(within(detail).getAllByText(/last changed/i)).toHaveLength(1);
    expect(within(detail).queryByText(/had not started keeping copies/)).not.toBeInTheDocument();
    expect(within(detail).queryByRole("button", { name: "Copy this version" })).not.toBeInTheDocument();
  });

  it("re-reads quietly when the worker finds something", async () => {
    const backend = mount();
    await screen.findByRole("list", { name: "Changes" });
    const spy = vi.spyOn(backend, "historyEvents");
    backend.history.poke();
    await waitFor(() => expect(spy).toHaveBeenCalled(), { timeout: 1500 });
    expect(screen.getByRole("list", { name: "Changes" })).toBeInTheDocument();
  });

  it("is honest while Sandbox mode pauses it", async () => {
    mount((b) => (b.history.paused = true));
    // Written "Sandbox mode", as the sidebar, Settings and Help write it.
    expect(await screen.findByText(/History is paused while Sandbox mode is on/)).toBeInTheDocument();
    // It says where the switch is.
    expect(screen.getByText(/in Settings, under Claude folder/)).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Changes" })).not.toBeInTheDocument();
  });

  it("has a first-look state before anything has been seen", async () => {
    mount((b) => (b.history.empty = true));
    expect(await screen.findByText("Atlas is taking its first look")).toBeInTheDocument();
  });

  it("on a narrow window opens a change on its own, and Back and Esc return to the list", async () => {
    class RO {
      observe() {}
      disconnect() {}
      unobserve() {}
    }
    vi.stubGlobal("ResizeObserver", RO);
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ width: 600, height: 400, x: 0, y: 0, top: 0, left: 0, right: 600, bottom: 400, toJSON: () => ({}) });
    mount();
    const rail = await screen.findByRole("list", { name: "Changes" });
    expect(screen.queryByTestId("history-detail")).not.toBeInTheDocument();
    await userEvent.click(within(rail).getByRole("button", { name: /Agent added reviewer/ }));
    const detail = await screen.findByTestId("history-detail");
    expect(within(detail).getByRole("heading", { name: "reviewer" })).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Changes" })).not.toBeInTheDocument();
    await userEvent.click(within(detail).getByRole("button", { name: "Back to the list" }));
    await screen.findByRole("list", { name: "Changes" });
    await userEvent.click(within(screen.getByRole("list", { name: "Changes" })).getByRole("button", { name: /Agent added reviewer/ }));
    await screen.findByTestId("history-detail");
    await userEvent.keyboard("{Escape}");
    await screen.findByRole("list", { name: "Changes" });
  });
});
