import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { OptionField, OptionsMenu } from "./OptionsMenu";

function Demo() {
  const [flavour, setFlavour] = useState("plain");
  return (
    <div>
      <OptionsMenu label="Filters" count={flavour === "plain" ? 0 : 1} onReset={() => setFlavour("plain")}>
        <OptionField label="Flavour">
          <select aria-label="Flavour" value={flavour} onChange={(e) => setFlavour(e.target.value)}>
            <option value="plain">Plain</option>
            <option value="salty">Salty</option>
          </select>
        </OptionField>
      </OptionsMenu>
      <button type="button">elsewhere</button>
    </div>
  );
}

describe("OptionsMenu", () => {
  it("opens a panel under one button, with no badge until something changes", async () => {
    render(<Demo />);
    const btn = screen.getByRole("button", { name: "Filters" });
    expect(btn).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await userEvent.click(btn);
    expect(btn).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("dialog", { name: "Filters" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reset" })).not.toBeInTheDocument();
  });

  it("counts changed options on the button and Reset puts them back", async () => {
    render(<Demo />);
    await userEvent.click(screen.getByRole("button", { name: "Filters" }));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Flavour" }), "salty");
    expect(screen.getByRole("button", { name: "Filters, 1 changed" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(screen.getByRole("combobox", { name: "Flavour" })).toHaveValue("plain");
    expect(screen.getByRole("button", { name: "Filters" })).toBeInTheDocument();
  });

  it("Escape closes it and gives focus back to the button", async () => {
    render(<Demo />);
    const btn = screen.getByRole("button", { name: "Filters" });
    await userEvent.click(btn);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(btn).toHaveFocus();
  });

  it("a click outside closes it", async () => {
    render(<Demo />);
    await userEvent.click(screen.getByRole("button", { name: "Filters" }));
    await userEvent.click(screen.getByRole("button", { name: "elsewhere" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
