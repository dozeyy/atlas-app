import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

const position = () => screen.getByText(/^\d+ of \d+$/).textContent ?? "";

describe("Wrapped", () => {
  it("opens on the cover, with the range as a label and the why in its hover", async () => {
    mount();
    expect(await screen.findByText("tokens so far")).toBeInTheDocument();
    const range = screen.getByText(/^[A-Z][a-z]{2} \d+ to today$/);
    expect(range.closest("[title]")?.getAttribute("title")).toMatch(/is your first day with usage\./);
    // No explanation sentence on the cover, and never a retention claim the data disproves.
    expect(screen.queryByText(/clears its logs/)).not.toBeInTheDocument();
    expect(position()).toMatch(/^1 of \d+$/);
    expect(screen.getByRole("button", { name: "Start" })).toBeInTheDocument();
    expect(screen.queryByText(/Live/)).not.toBeInTheDocument();
  });

  it("clicks through the slides with the buttons and the arrow keys", async () => {
    mount();
    await userEvent.click(await screen.findByRole("button", { name: "Start" }));
    expect(position()).toMatch(/^2 of \d+$/);
    expect(screen.queryByText("tokens so far")).not.toBeInTheDocument();
    await userEvent.keyboard("{ArrowRight}");
    expect(position()).toMatch(/^3 of \d+$/);
    await userEvent.keyboard("{ArrowLeft}");
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(position()).toMatch(/^1 of \d+$/);
    expect(screen.getByText("tokens so far")).toBeInTheDocument();
  });

  it("goes on with Space, and with a tap on the slide, and back with a tap on its left third", async () => {
    mount();
    await screen.findByText("tokens so far");
    document.body.focus();
    await userEvent.keyboard(" ");
    expect(position()).toMatch(/^2 of \d+$/);
    const stage = document.querySelector(".pr-stage") as HTMLElement;
    stage.getBoundingClientRect = () => ({ left: 0, width: 900, top: 0, height: 500, right: 900, bottom: 500, x: 0, y: 0, toJSON: () => "" });
    // The slide is a new element after every move (it is keyed), so look it up each time.
    const slide = () => stage.querySelector(".pr") as HTMLElement;
    fireEvent.click(slide(), { clientX: 600, clientY: 100 });
    expect(position()).toMatch(/^3 of \d+$/);
    fireEvent.click(slide(), { clientX: 100, clientY: 100 });
    expect(position()).toMatch(/^2 of \d+$/);
  });

  it("does not turn the page when the tap is on something you can press or read the hover of", async () => {
    mount();
    await screen.findByText("tokens so far");
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    const compare = document.querySelector(".pr-strip-text") as HTMLElement;
    expect(compare.textContent).toMatch(/^About .+\.$/);
    const before = position();
    await userEvent.click(compare);
    expect(position()).toBe(before);
  });

  it("lays each slide out differently from the one before, and wipes from the side you are heading", async () => {
    mount();
    await screen.findByText("tokens so far");
    const stage = () => document.querySelector(".pr-stage") as HTMLElement;
    const layout = () => (document.querySelector(".pr") as HTMLElement).dataset.layout;
    const seen: (string | undefined)[] = [layout()];
    for (let n = 0; n < 6; n++) {
      await userEvent.keyboard("{ArrowRight}");
      expect(stage().dataset.dir).toBe("fwd");
      seen.push(layout());
    }
    for (let n = 1; n < seen.length; n++) expect(seen[n]).not.toBe(seen[n - 1]);
    await userEvent.keyboard("{ArrowLeft}");
    expect(stage().dataset.dir).toBe("back");
  });

  it("counts the top skills down, 5 to 1, on one slide", async () => {
    mount();
    await screen.findByText("tokens so far");
    await userEvent.click(screen.getByRole("button", { name: /Your top \d skills/ }));
    const list = screen.getByRole("list", { name: /^Top \d, ranked$/ });
    expect(within(list).getAllByRole("listitem").length).toBeGreaterThan(1);
    expect(screen.queryByText("Favorite skill")).not.toBeInTheDocument();
  });

  it("gives the coder type its reason, with the real figure, in the hover", async () => {
    mount();
    await screen.findByText("tokens so far");
    await userEvent.click(screen.getByRole("button", { name: /Your coder type/ }));
    const fig = document.querySelector(".pr-fig") as HTMLElement;
    expect(fig.getAttribute("title") ?? fig.getAttribute("data-tip")).toMatch(/\d+%|\d+ (of|skill)/);
    expect(screen.queryByText(/\$/)).not.toBeInTheDocument();
  });

  it("tells the tokens as novels on their own slide, marked as an estimate in the hover", async () => {
    mount();
    await screen.findByText("tokens so far");
    await userEvent.click(screen.getByRole("button", { name: /In book terms/ }));
    const fig = document.querySelector(".pr-fig") as HTMLElement;
    expect(fig.getAttribute("title") ?? "").toMatch(/0\.75 words per token[\s\S]*An estimate/);
    expect(fig.getAttribute("aria-label")).toMatch(/An estimate/);
    expect(document.querySelector(".pr-strip-text")?.textContent).toMatch(/^Reading takes about /);
  });

  it("puts one comparison on every slide but the card, each with its source in the hover", async () => {
    mount();
    await screen.findByText("tokens so far");
    const total = Number(/of (\d+)/.exec(position())?.[1]);
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    let withLine = 0;
    for (let i = 2; i < total; i++) {
      const c = document.querySelector(".pr-strip-text");
      if (c) {
        withLine++;
        expect(c.textContent).toMatch(/^[\x20-\x7e]+\.$/);
        expect(c.closest("[title]")?.getAttribute("title")).toMatch(/\d/);
      }
      await userEvent.keyboard("{ArrowRight}");
    }
    expect(withLine).toBeGreaterThanOrEqual(5);
    expect(document.querySelector(".pr-strip-text")).toBeNull();
  });

  it("ends on the share card, saves the picture it shows, and draws no chat name", async () => {
    const drawn = fakeCanvas();
    const backend = mount();
    await screen.findByText("tokens so far");
    const total = Number(/of (\d+)/.exec(position())?.[1]);
    await userEvent.click(screen.getByRole("button", { name: new RegExp(`Slide ${total} of ${total}`) }));
    expect(screen.getByRole("img", { name: /My Claude Code, so far: .* tokens/ })).toBeInTheDocument();
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
    expect(drawn.join("|")).toContain("TOKENS");
  });

  it("says where the card was saved, and shows a failure plainly", async () => {
    fakeCanvas();
    const backend = mount((b) => {
      b.wrappedSaveCard = async () => "C:/Users/me/Pictures/Atlas Wrapped 2026-11-08.png";
    });
    await screen.findByText("tokens so far");
    const total = Number(/of (\d+)/.exec(position())?.[1]);
    await userEvent.click(screen.getByRole("button", { name: new RegExp(`Slide ${total} of ${total}`) }));
    await userEvent.click(screen.getByRole("button", { name: "Save image" }));
    expect(await screen.findByText("Saved to C:/Users/me/Pictures/Atlas Wrapped 2026-11-08.png")).toBeInTheDocument();
    backend.wrappedSaveCard = async () => {
      throw "The image could not be saved: disk full";
    };
    await userEvent.click(screen.getByRole("button", { name: "Save image" }));
    expect(await screen.findByText("The image could not be saved: disk full")).toBeInTheDocument();
  });

  it("jumps from the progress bar, ends on Replay, and starts over", async () => {
    mount();
    await screen.findByText("tokens so far");
    const total = Number(/of (\d+)/.exec(position())?.[1]);
    await userEvent.click(screen.getByRole("button", { name: new RegExp(`Slide ${total} of ${total}`) }));
    expect(position()).toBe(`${total} of ${total}`);
    expect(screen.queryByRole("button", { name: "Next" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Replay" }));
    expect(position()).toBe(`1 of ${total}`);
    expect(screen.getByText("tokens so far")).toBeInTheDocument();
  });
});
