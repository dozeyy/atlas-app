import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../App";
import { AtlasProvider } from "../state/AtlasProvider";
import { setBackend } from "../lib/ipc";
import { MockBackend } from "../lib/mock";
import { resetSetupCost } from "../lib/useSetupCost";
import { resetSetupStore } from "../state/setupStore";
import { resetToasts } from "../state/toastStore";
import type { CostReport } from "../lib/setup-types";

// The viewer needs real layout; the cost figures do not depend on it.
vi.mock("../lib/codemirror", () => ({
  mountViewer: async (el: HTMLElement, text: string) => {
    const pre = document.createElement("pre");
    pre.textContent = text;
    el.appendChild(pre);
    return { destroy: () => pre.remove() };
  },
  mountEditor: async () => ({ focus: () => {}, markLine: () => {}, destroy: () => {} }),
}));

class Backend extends MockBackend {
  cost: (() => Promise<CostReport>) | null = null;
  calls = 0;
  async setupCost(): Promise<CostReport> {
    this.calls += 1;
    return this.cost ? this.cost() : super.setupCost();
  }
}

async function open(b: Backend) {
  setBackend(b);
  render(
    <AtlasProvider>
      <App />
    </AtlasProvider>,
  );
  await userEvent.click(screen.getByRole("button", { name: "Toolkit" }));
  await screen.findByRole("list", { name: "Types of things in your toolkit" });
}

let backend: Backend;
beforeEach(() => {
  localStorage.clear();
  resetSetupStore();
  resetSetupCost();
  resetToasts();
  backend = new Backend();
});
afterEach(() => {
  resetSetupStore();
  resetSetupCost();
  resetToasts();
});

describe("Toolkit: what the setup costs", () => {
  it("keeps cost off the category tiles: count and name only", async () => {
    await open(backend);
    const skills = await screen.findByRole("button", { name: /^Skills, \d+$/ });
    await screen.findByRole("region", { name: "What your setup costs" }); // the cost report has arrived
    expect(skills.textContent).toMatch(/^\d[\d,]*Skills$/);
    expect(document.querySelector("[data-tile] [data-cost]")).toBeNull();
    expect(document.querySelector("[data-tile]")?.textContent).not.toMatch(/token|\$|week/);
  });

  it("ranks the biggest costs in tokens under the tiles and opens an item with its own figures", async () => {
    await open(backend);
    const panel = await screen.findByRole("region", { name: "What your setup costs" });
    expect(panel).toHaveTextContent(/tokens per message, in every chat/);
    // Will's layout: the tiles are the way in, so they come before any numbers.
    const tile = document.querySelector("[data-tile]")!;
    expect(tile.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(panel.textContent).not.toContain("$");
    expect(within(panel).getAllByRole("listitem").length).toBeGreaterThan(1);
    await userEvent.click(within(panel).getAllByRole("button")[0]!);
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByRole("heading", { name: "What it costs" })).toBeInTheDocument();
    // The dollar estimate is a hover, never a sentence on the sheet.
    expect(sheet.textContent).not.toMatch(/Estimate/);
    expect(sheet.querySelector("[title*='Estimate']")).not.toBeNull();
    expect(sheet).toHaveTextContent(/Per message/);
  });

  it("says tokens per call on each skill and in its sheet, with dollars only in the hover", async () => {
    await open(backend);
    await userEvent.click(await screen.findByRole("button", { name: /^Skills, \d+$/ }));
    await screen.findByPlaceholderText("Search skills");
    const rowBtn = (await screen.findAllByRole("button", { name: /^skill / }))[0];
    expect(rowBtn).toBeDefined();
    const figure = await waitFor(() => {
      const el = rowBtn!.querySelector<HTMLElement>("[data-item-cost]");
      expect(el).not.toBeNull();
      return el!;
    });
    expect(figure).toHaveTextContent(/^[\d.]+[kMBT]? tokens per call$/);
    expect(figure.textContent).not.toContain("$");

    await userEvent.click(rowBtn!);
    const sheet = await screen.findByRole("dialog");
    const costHeading = within(sheet).getByRole("heading", { name: "What it costs" });
    expect(sheet).toHaveTextContent(/Per call/);
    expect(sheet).toHaveTextContent(/tokens/);
    expect(sheet.textContent).not.toContain("$");
    // The cost comes first, so it is on screen without scrolling the sheet.
    const about = within(sheet).getByRole("heading", { name: "About" });
    expect(costHeading.compareDocumentPosition(about) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("draws no figures at all when Atlas cannot give a cost", async () => {
    backend.cost = () => Promise.reject(new Error("no usage"));
    await open(backend);
    await waitFor(() => expect(backend.calls).toBeGreaterThan(0));
    expect(screen.queryByRole("heading", { name: "What your setup costs" })).not.toBeInTheDocument();
    expect(document.querySelector("[data-cost-headline], [data-item-cost]")).toBeNull();
    expect(document.body.textContent).not.toMatch(/\$/);
  });

  it("asks again when the setup is reloaded, not on every render", async () => {
    await open(backend);
    await waitFor(() => expect(backend.calls).toBe(1));
    await userEvent.click(await screen.findByRole("button", { name: /^Skills, \d+$/ }));
    await screen.findByPlaceholderText("Search skills");
    expect(backend.calls).toBe(1);
  });
});
