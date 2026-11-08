import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Button, Card, IconButton, SegmentedControl } from "./controls";

// jsdom has no layout, so the geometry proof lives in hitbox.test.ts (CSS) and in the CDP
// click-at-the-edge run. These pin the structure that makes the CSS rule work: the clicked
// element is a fixed box, the look and the motion live on an inner face.

describe("two-layer controls", () => {
  it("Button: the button owns the click, the face carries the look", () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Open folder</Button>);
    const btn = screen.getByRole("button", { name: "Open folder" });
    expect(btn).toHaveClass("btn");
    const face = btn.querySelector(":scope > .btn-face");
    expect(face).not.toBeNull();
    expect(face).toHaveTextContent("Open folder");
    fireEvent.click(face!); // a click that lands on the face reaches the button
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("Button: layout classes go on the button, not the face", () => {
    render(<Button className="mt-4">Go</Button>);
    const btn = screen.getByRole("button", { name: "Go" });
    expect(btn).toHaveClass("mt-4");
    expect(btn.querySelector(".btn-face")).not.toHaveClass("mt-4");
  });

  it("Button: disabled does not fire", () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Nope
      </Button>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Nope" }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("IconButton keeps its label and a face", () => {
    render(<IconButton aria-label="Refresh">x</IconButton>);
    const btn = screen.getByRole("button", { name: "Refresh" });
    expect(btn.querySelector(":scope > .btn-face")).not.toBeNull();
  });

  it("SegmentedControl items wrap their label in a face", () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl
        label="Range"
        value="a"
        onChange={onChange}
        options={[
          { value: "a", label: "Alpha" },
          { value: "b", label: "Beta" },
        ]}
      />,
    );
    const beta = screen.getByRole("radio", { name: "Beta" });
    expect(beta.querySelector(":scope > .seg-face")).not.toBeNull();
    fireEvent.click(beta);
    expect(onChange).toHaveBeenCalledWith("b");
  });

  it("clickable Card: outer button is the hit box, inner face moves", () => {
    const onClick = vi.fn();
    render(
      <Card onClick={onClick} className="p-5" hitClassName="col-span-2" aria-label="Open session">
        body
      </Card>,
    );
    const hit = screen.getByRole("button", { name: "Open session" });
    expect(hit).toHaveClass("card-hit", "col-span-2");
    const face = hit.querySelector(":scope > .card-face");
    expect(face).toHaveClass("card", "p-5");
    fireEvent.click(face!);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("static Card stays a plain div", () => {
    const { container } = render(<Card>quiet</Card>);
    expect(container.querySelector("button")).toBeNull();
    expect(container.firstElementChild).toHaveClass("card");
  });
});
