import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "../App";
import { AtlasProvider } from "../state/AtlasProvider";
import { setBackend } from "../lib/ipc";
import { MockBackend } from "../lib/mock";
import { shortcutGroups } from "../lib/appMenu";

beforeEach(() => {
  localStorage.clear();
  setBackend(new MockBackend());
  render(
    <AtlasProvider>
      <App />
    </AtlasProvider>,
  );
});
afterEach(() => setBackend(null));

const menuButton = () => screen.getByRole("button", { name: "Menu" });

describe("app menu", () => {
  it("opens from the button, with Help; Help opens its entries", async () => {
    await userEvent.click(menuButton());
    expect(menuButton()).toHaveAttribute("aria-expanded", "true");
    const help = screen.getByRole("menuitem", { name: "Help" });
    await userEvent.click(help);
    const sub = screen.getAllByRole("menu").find((m) => m.hasAttribute("data-menu")) as HTMLElement;
    expect(within(sub).getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
      "About Atlas",
      "How to use Atlas",
      "Keyboard shortcuts",
      "Privacy",
      "Terms of service",
      "Report a problem",
    ]);
  });

  it("About shows the version and build; Escape closes it and focus returns to the button", async () => {
    await userEvent.click(menuButton());
    await userEvent.click(screen.getByRole("menuitem", { name: "Help" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "About Atlas" }));
    const dlg = screen.getByRole("dialog", { name: "About Atlas" });
    expect(within(dlg).getByText("0.1.0")).toBeInTheDocument();
    expect(within(dlg).getByText("release")).toBeInTheDocument();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(menuButton()).toHaveFocus();
  });

  it("F10 opens it on the first item; arrows go into the submenu and back, Escape closes", async () => {
    await userEvent.keyboard("{F10}");
    expect(screen.getByRole("menuitem", { name: "Help" })).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}");
    await screen.findByRole("menuitem", { name: "About Atlas" });
    await userEvent.keyboard("{ArrowDown}");
    expect(await screen.findByRole("menuitem", { name: "How to use Atlas" })).toHaveFocus();
    await userEvent.keyboard("{ArrowUp}{ArrowUp}");
    expect(screen.getByRole("menuitem", { name: "Report a problem" })).toHaveFocus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(screen.getByRole("menuitem", { name: "Help" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(menuButton()).toHaveFocus();
  });

  it("Alt pressed and released on its own opens it", async () => {
    await userEvent.keyboard("{Alt}");
    expect(await screen.findByRole("menuitem", { name: "Help" })).toBeInTheDocument();
  });

  it("the Keyboard shortcuts sheet lists every shortcut", async () => {
    await userEvent.click(menuButton());
    await userEvent.click(screen.getByRole("menuitem", { name: "Help" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Keyboard shortcuts" }));
    const dlg = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    for (const g of shortcutGroups("windows")) for (const r of g.rows) expect(within(dlg).getByText(r.does)).toBeInTheDocument();
    expect(within(dlg).getByText("Ctrl+B")).toBeInTheDocument();
  });

  it("Privacy and Terms open as sheets", async () => {
    for (const name of ["Privacy", "Terms of service"]) {
      await userEvent.click(menuButton());
      await userEvent.click(screen.getByRole("menuitem", { name: "Help" }));
      await userEvent.click(screen.getByRole("menuitem", { name }));
      expect(screen.getByRole("dialog", { name })).toBeInTheDocument();
      await userEvent.keyboard("{Escape}");
    }
  });

  it("Report a problem can open the data folder", async () => {
    await userEvent.click(menuButton());
    await userEvent.click(screen.getByRole("menuitem", { name: "Help" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Report a problem" }));
    const dlg = screen.getByRole("dialog", { name: "Report a problem" });
    expect(within(dlg).getByRole("button", { name: "Open data folder" })).toBeInTheDocument();
    expect(within(dlg).getByRole("button", { name: "Copy details" })).toBeInTheDocument();
  });
});
