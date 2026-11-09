import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../App";
import { AtlasProvider } from "../state/AtlasProvider";
import { setBackend } from "../lib/ipc";
import { MockBackend } from "../lib/mock";

function mount(prep?: (b: MockBackend) => void) {
  localStorage.setItem("atlas.mock.settings", JSON.stringify({ lastView: "wrapped" }));
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

/** jsdom draws nothing: hand the canvas a 2D context that records the text it is asked to draw. */
function fakeCanvas(): string[] {
  const drawn: string[] = [];
  const ctx = new Proxy(
    {},
    {
      get: (_t, k) => {
        if (k === "measureText") return (s: string) => ({ width: s.length * 10 });
        if (k === "fillText") return (s: string) => void drawn.push(s);
        return () => {};
      },
      set: () => true,
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as never);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((cb: BlobCallback) => {
    cb(new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])], { type: "image/png" }));
  });
  return drawn;
}

const OPENER = "Your year in Claude Code";
const position = () => screen.getByText(/^\d+ of \d+$/).textContent ?? "";
const total = () => Number(/of (\d+)/.exec(position())?.[1]);
/** The slide on screen (the one leaving, while it fades, is aria-hidden and skipped). */
const frame = () => document.querySelector(".sm-slot:not(.sm-out) .sm-frame") as HTMLElement;
const kicker = () => frame().querySelector(".sm-kicker")?.textContent ?? "";
const lastSlide = async () => {
  await userEvent.click(screen.getByRole("button", { name: new RegExp(`Slide ${total()} of ${total()}`) }));
};

describe("Wrapped", () => {
  it("opens on the cover: the year, the title and the range, and nothing else", async () => {
    mount();
    expect(await screen.findByText(OPENER)).toBeInTheDocument();
    expect(frame().querySelector(".sm-year")?.textContent).toMatch(/^\d{4}$/);
    const range = frame().querySelector(".sm-range") as HTMLElement;
    expect(range.textContent).toMatch(/^[A-Z][a-z]{2} \d+ to today$/);
    // The cover has no numbers to read and no hover to explain.
    expect(frame().querySelector("[title], [data-tip]")).toBeNull();
    expect(frame().querySelector(".sm-fig")).toBeNull();
    expect(position()).toMatch(/^1 of \d+$/);
    expect(screen.getByRole("button", { name: "Start" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
    expect(screen.queryByText(/Live/)).not.toBeInTheDocument();
  });

  it("clicks through the slides with the buttons and the arrow keys", async () => {
    mount();
    await userEvent.click(await screen.findByRole("button", { name: "Start" }));
    expect(position()).toMatch(/^2 of \d+$/);
    expect(screen.queryByText(OPENER)).not.toBeInTheDocument();
    await userEvent.keyboard("{ArrowRight}");
    expect(position()).toMatch(/^3 of \d+$/);
    await userEvent.keyboard("{ArrowLeft}");
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(position()).toMatch(/^1 of \d+$/);
    expect(screen.getByText(OPENER)).toBeInTheDocument();
  });

  it("goes on with Space, and with a tap on the slide, and back with a tap on its left third", async () => {
    mount();
    await screen.findByText(OPENER);
    document.body.focus();
    await userEvent.keyboard(" ");
    expect(position()).toMatch(/^2 of \d+$/);
    const stage = document.querySelector(".sm-stage") as HTMLElement;
    stage.getBoundingClientRect = () => ({ left: 0, width: 900, top: 0, height: 500, right: 900, bottom: 500, x: 0, y: 0, toJSON: () => "" });
    fireEvent.click(frame(), { clientX: 600, clientY: 100 });
    expect(position()).toMatch(/^3 of \d+$/);
    fireEvent.click(frame(), { clientX: 100, clientY: 100 });
    expect(position()).toMatch(/^2 of \d+$/);
  });

  it("does not turn the page when the tap is on something you can read the hover of", async () => {
    mount();
    await screen.findByText(OPENER);
    await userEvent.click(screen.getByRole("button", { name: /Slide \d+ of \d+: Tokens/ }));
    const fig = frame().querySelector(".sm-fig") as HTMLElement;
    expect(fig.getAttribute("title")).toMatch(/^[\d,]+ tokens\.$/);
    const before = position();
    await userEvent.click(fig);
    expect(position()).toBe(before);
  });

  it("shows the trail: a waypoint for every slide, filled behind you, the current one marked", async () => {
    mount();
    await screen.findByText(OPENER);
    const n = total();
    const stops = () => Array.from(document.querySelectorAll<HTMLElement>(".sm-wp"));
    expect(stops()).toHaveLength(n);
    expect(stops()[0].hasAttribute("data-now")).toBe(true);
    await userEvent.keyboard("{ArrowRight}{ArrowRight}");
    expect(stops().filter((s) => s.hasAttribute("data-done"))).toHaveLength(2);
    expect(stops()[2].getAttribute("aria-current")).toBe("true");
    expect(stops()[2].getAttribute("aria-label")).toMatch(/^Slide 3 of \d+: .+/);
  });

  it("wipes from the side you are heading", async () => {
    mount();
    await screen.findByText(OPENER);
    const stage = () => document.querySelector(".sm-stage") as HTMLElement;
    await userEvent.keyboard("{ArrowRight}");
    expect(stage().dataset.dir).toBe("fwd");
    await userEvent.keyboard("{ArrowLeft}");
    expect(stage().dataset.dir).toBe("back");
  });

  it("gives every slide a kicker, one hero, and one short line", async () => {
    mount();
    await screen.findByText(OPENER);
    const n = total();
    await userEvent.keyboard("{ArrowRight}");
    for (let i = 2; i < n; i++) {
      expect(kicker().length).toBeGreaterThan(0);
      expect(frame().querySelectorAll(".sm-fig")).toHaveLength(1);
      expect(frame().querySelectorAll(".sm-line")).toHaveLength(1);
      expect((frame().querySelector(".sm-line") as HTMLElement).textContent!.length).toBeLessThan(110);
      await userEvent.keyboard("{ArrowRight}");
    }
  });

  it("puts a hover only on the figures and graphics that have something exact to say", async () => {
    mount();
    await screen.findByText(OPENER);
    const n = total();
    await userEvent.keyboard("{ArrowRight}");
    for (let i = 2; i < n; i++) {
      const tips = Array.from(frame().querySelectorAll<HTMLElement>("[title], [data-tip]"));
      for (const t of tips) {
        const ok =
          t.matches(".sm-fig") || // the exact count
          t.matches(".sm-cell, .sm-bar") || // one day, one hour
          t.closest(".sm-line") !== null; // the source of a rounded phrase
        expect(ok).toBe(true);
        expect(t.getAttribute("title") ?? t.getAttribute("data-tip")).toMatch(/\S/);
      }
      await userEvent.keyboard("{ArrowRight}");
    }
  });

  it("ends on the recap card, saves the picture it shows, and draws no chat name", async () => {
    const drawn = fakeCanvas();
    const backend = mount();
    await screen.findByText(OPENER);
    await lastSlide();
    expect(screen.getByRole("img", { name: /^Atlas Wrapped, .+: .+ tokens/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save image" }));
    await waitFor(() => expect(backend.lastCard).not.toBeNull());
    expect(backend.lastCard!.bytes).toBeGreaterThan(8);
    expect(backend.lastCard!.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Cancelling the picker leaves no message behind.
    expect(screen.getByRole("status").textContent).toBe("");
    const chats = await backend.sessionsList({ limit: 200 });
    const names = chats.rows.map((r) => r.name).filter((n): n is string => !!n);
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) expect(drawn.join("|")).not.toContain(n);
    expect(drawn.join("|")).toContain("Atlas Wrapped");
  });

  it("says where the card was saved, and shows a failure plainly", async () => {
    fakeCanvas();
    const backend = mount((b) => {
      b.wrappedSaveCard = async () => "C:/Users/me/Pictures/Atlas Wrapped 2026-11-08.png";
    });
    await screen.findByText(OPENER);
    await lastSlide();
    await userEvent.click(screen.getByRole("button", { name: "Save image" }));
    expect(await screen.findByText("Saved to C:/Users/me/Pictures/Atlas Wrapped 2026-11-08.png")).toBeInTheDocument();
    backend.wrappedSaveCard = async () => {
      throw "The image could not be saved: disk full";
    };
    await userEvent.click(screen.getByRole("button", { name: "Save image" }));
    expect(await screen.findByText("The image could not be saved: disk full")).toBeInTheDocument();
  });

  it("jumps from the trail, ends on Replay, and starts over", async () => {
    mount();
    await screen.findByText(OPENER);
    const n = total();
    await lastSlide();
    expect(position()).toBe(`${n} of ${n}`);
    expect(screen.queryByRole("button", { name: "Next" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Replay" }));
    expect(position()).toBe(`1 of ${n}`);
    expect(screen.getByText(OPENER)).toBeInTheDocument();
  });
});
