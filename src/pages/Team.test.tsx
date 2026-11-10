import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../App";
import { AtlasProvider } from "../state/AtlasProvider";
import { setBackend } from "../lib/ipc";
import { MockBackend } from "../lib/mock";
import { resetSetupStore } from "../state/setupStore";
import { resetToasts } from "../state/toastStore";
import { resetUnsaved } from "../state/unsavedStore";
import { clearPendingAgent, clearPendingSession, onNavRequest, peekPendingAgent, peekPendingSession } from "../lib/nav";
import type { Scorecard } from "../lib/teamTypes";

class Backend extends MockBackend {
  empty = false;
  teamScorecard: MockBackend["teamScorecard"] = async (a) => {
    if (this.empty) return { fromTs: null, toTs: Date.now(), historyDays: 12, totalRuns: 0, types: [] } satisfies Scorecard;
    return this.team.teamScorecard(a);
  };
}

function setPrefs(view: "scorecard" | "review", range = "all") {
  localStorage.setItem("atlas.team.prefs", JSON.stringify({ view, range, startedFrom: "all" }));
}

async function openToolkit(tab: "setup" | "team" = "team") {
  localStorage.setItem("atlas.toolkit.tab", tab);
  render(
    <AtlasProvider>
      <App />
    </AtlasProvider>,
  );
  await userEvent.click(screen.getByRole("button", { name: "Toolkit" }));
}

const card = (name: string) => screen.findByRole("button", { name: new RegExp(`^${name}, \\d+ runs?\\.`) });

let backend: Backend;
beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  resetSetupStore();
  resetToasts();
  resetUnsaved();
  clearPendingSession();
  clearPendingAgent();
  backend = new Backend();
  setBackend(backend);
});
afterEach(() => {
  resetUnsaved();
  resetSetupStore();
  resetToasts();
});

describe("Team: a tab of the Toolkit", () => {
  it("is reachable by keyboard from the one tab row and adds nothing to the sidebar", async () => {
    await openToolkit("setup");
    const tabs = await screen.findByRole("radiogroup", { name: "Toolkit view" });
    expect(screen.queryByRole("button", { name: "Team" })).not.toBeInTheDocument();
    const setupTab = within(tabs).getByRole("radio", { name: "Your setup" });
    expect(setupTab).toHaveAttribute("aria-checked", "true");
    expect(within(tabs).getByRole("radio", { name: "Library" })).toBeInTheDocument();
    setupTab.focus();
    await userEvent.keyboard("{ArrowRight}{ArrowRight}");
    expect(within(tabs).getByRole("radio", { name: "Team" })).toHaveAttribute("aria-checked", "true");
    expect(await screen.findByRole("radiogroup", { name: "Team view" })).toBeInTheDocument();
    await userEvent.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(within(tabs).getByRole("radio", { name: "Your setup" })).toHaveAttribute("aria-checked", "true");
    expect(localStorage.getItem("atlas.toolkit.tab")).toBe("setup");
  });
});

describe("Team: Scorecard", () => {
  beforeEach(() => setPrefs("scorecard"));

  it("shows a card per helper type, with medians hidden below 3 runs and a rate only from 5 reviews", async () => {
    await openToolkit();
    const worker = await card("General purpose");
    expect(within(worker).getByText("Passed 9 of 12 reviews")).toBeInTheDocument();
    expect(within(worker).getByText("9 min typical")).toBeInTheDocument();

    // 4 tied reviews: counts, no rate.
    const few = await card("UI builder");
    expect(within(few).queryByText(/^Passed \d+ of/)).not.toBeInTheDocument();
    expect(within(few).getByText("3 passed, 1 sent back, 4 not tied to a review")).toBeInTheDocument();

    // 2 runs: no medians.
    const tiny = await card("Chore runner");
    expect(within(tiny).getAllByText("Too few runs yet")).toHaveLength(2);

    // A reviewer shows the verdicts it gave.
    const reviewer = await card("Code reviewer");
    expect(within(reviewer).getByText("6 passed, 3 sent back")).toBeInTheDocument();
  });

  it("puts dollars on hover only", async () => {
    await openToolkit();
    const worker = await card("General purpose");
    const used = within(worker).getByText(/tokens/, { selector: "span[title]" });
    // What shows is the token count; the dollar estimate is in the hover (and read out for screen readers).
    expect(used.firstChild?.textContent).toBe("7.6M tokens");
    expect(used.getAttribute("title")).toMatch(/\$/);
  });

  it("says how far back the history goes", async () => {
    await openToolkit();
    await card("General purpose");
    expect(screen.getByText(/History covers the last 82 days\./)).toBeInTheDocument();
  });

  it("Headless shows only the runs that started headless", async () => {
    await openToolkit();
    await card("General purpose");
    await userEvent.selectOptions(screen.getByLabelText("Started from"), "headless");
    const worker = await screen.findByRole("button", { name: /^General purpose, 6 runs\./ });
    expect(worker).toBeInTheDocument();
    expect(backend.team.calls.at(-1)?.startedFrom).toBe("headless");
    expect(screen.queryByRole("button", { name: /^UI builder,/ })).not.toBeInTheDocument();
  });

  it("filters by name as you type", async () => {
    await openToolkit();
    await card("General purpose");
    await userEvent.type(screen.getByLabelText("Find a helper"), "verif");
    expect(await screen.findByRole("button", { name: /^Verifier,/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^UI builder,/ })).not.toBeInTheDocument();
  });

  it("opens a calm sheet on Enter, returns focus to the card on Escape, and a run opens that helper", async () => {
    await openToolkit();
    const worker = await card("Verifier");
    worker.focus();
    await userEvent.keyboard("{Enter}");
    const sheet = await screen.findByRole("dialog", { name: "Verifier" });
    expect(within(sheet).getByRole("heading", { name: "Runs per week" })).toBeInTheDocument();
    expect(within(sheet).getByRole("heading", { name: "Verdicts it gave" })).toBeInTheDocument();
    // A chart in a sheet is calm: no summit spark.
    expect(sheet.querySelector(".summit-spark, .spark")).toBeNull();

    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(worker).toHaveFocus();

    await userEvent.click(worker);
    const again = await screen.findByRole("dialog", { name: "Verifier" });
    const row = within(again).getAllByRole("button", { name: /Open this run|Passed|Sent back|Finished|Not known/ })[0];
    const asked: { session: string | null; agent: string | null }[] = [];
    const off = onNavRequest(() => {
      const s = peekPendingSession();
      asked.push({ session: s, agent: s ? peekPendingAgent(s) : null });
    });
    await act(async () => {
      await userEvent.click(row);
    });
    off();
    expect(asked[0].session).toMatch(/^mock-session-verifier-/);
    expect(asked[0].agent === null || /^agent-verifier-/.test(asked[0].agent)).toBe(true);
  });

  it("has a real empty state, not a blank pane", async () => {
    backend.empty = true;
    await openToolkit();
    expect(await screen.findByRole("heading", { name: "No helper runs yet" })).toBeInTheDocument();
  });

  it("says so when the numbers cannot be read, and can try again", async () => {
    backend.team.failNext = true;
    await openToolkit();
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not be read/i);
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await card("General purpose");
  });
});

describe("Team: Caught in review", () => {
  beforeEach(() => setPrefs("review"));

  it("lists what reviewers keep catching and offers a rule for each", async () => {
    await openToolkit();
    expect(await screen.findByText("Missing null check on the response before it is used")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Make this a rule" })).toHaveLength(3);
    expect(screen.getByText(/Raised 7 times in 4 runs, 3 high, 4 medium/)).toBeInTheDocument();
  });

  it("Make this a rule saves through one write, offers Undo, and Undo takes it back", async () => {
    await openToolkit();
    const buttons = await screen.findAllByRole("button", { name: "Make this a rule" });
    await userEvent.click(buttons[0]);
    const sheet = await screen.findByRole("dialog", { name: "Make this a rule" });
    expect(await within(sheet).findByRole("radio", { name: /CLAUDE\.md in your Claude folder/ })).toBeChecked();
    await userEvent.click(within(sheet).getByRole("button", { name: "Save rule" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(backend.team.saved).toHaveLength(1);
    expect(backend.team.saved[0].stamp).toBe("s-global");
    const toast = await screen.findByText(/Added a rule to your global CLAUDE\.md\./);
    expect(toast).toBeInTheDocument();
    expect(await screen.findByText(/Made a rule, /)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(backend.team.forgotten).toEqual(["t-null-check"]));
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Make this a rule" })).toHaveLength(3));
  });

  it("offers a project by its folder, keeps the line to one dash line, and the toast names the file", async () => {
    await openToolkit();
    await userEvent.click((await screen.findAllByRole("button", { name: "Make this a rule" }))[0]);
    const sheet = await screen.findByRole("dialog", { name: "Make this a rule" });
    // A project is offered by its folder, not by its position.
    const project = await within(sheet).findByRole("radio", { name: /CLAUDE\.md in atlas/ });
    await userEvent.click(project);
    const field = within(sheet).getByRole("textbox", { name: "The line" }) as HTMLInputElement;
    expect(field.tagName).toBe("INPUT");
    expect(field.maxLength).toBe(400);
    // The line must start with a dash: nothing else can be saved.
    await userEvent.clear(field);
    await userEvent.type(field, "A heading would go here");
    expect(within(sheet).getByRole("button", { name: "Save rule" })).toBeDisabled();
    await userEvent.clear(field);
    await userEvent.type(field, "- Check the empty case.");
    await userEvent.click(within(sheet).getByRole("button", { name: "Save rule" }));
    await waitFor(() => expect(backend.team.saved).toHaveLength(1));
    expect(backend.team.saved[0].targetId).toBe("project:/mock/work/atlas");
    expect(backend.team.saved[0].projectPaths).toContain("/mock/work/atlas");
    expect(await screen.findByText(/Added a rule to atlas's CLAUDE\.md\./)).toBeInTheDocument();

  });

  it("refuses a file that changed since the sheet opened, writes nothing, and can reload", async () => {
    await openToolkit();
    await userEvent.click((await screen.findAllByRole("button", { name: "Make this a rule" }))[1]);
    const sheet = await screen.findByRole("dialog", { name: "Make this a rule" });
    await within(sheet).findByRole("radio", { name: /CLAUDE\.md in your Claude folder/ });
    backend.team.staleNext = true;
    await userEvent.click(within(sheet).getByRole("button", { name: "Save rule" }));
    expect(await within(sheet).findByRole("alert")).toHaveTextContent("This file changed since you opened it.");
    expect(backend.team.saved).toHaveLength(0);
    await userEvent.click(within(sheet).getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(within(sheet).queryByRole("alert")).not.toBeInTheDocument());
    await userEvent.click(within(sheet).getByRole("button", { name: "Save rule" }));
    await waitFor(() => expect(backend.team.saved).toHaveLength(1));
  });
});
