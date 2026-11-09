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
  it("opens on the cover, said honestly about how far back it goes", async () => {
    mount();
    expect(await screen.findByText("tokens so far")).toBeInTheDocument();
    expect(screen.getAllByText(/Claude Code clears its logs after \d+ days/).length).toBeGreaterThan(0);
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
    const stage = document.querySelector(".wr-story-stage") as HTMLElement;
    stage.getBoundingClientRect = () => ({ left: 0, width: 900, top: 0, height: 500, right: 900, bottom: 500, x: 0, y: 0, toJSON: () => "" });
    // The slide is a new element after every move (it is keyed), so look it up each time.
    const slide = () => stage.querySelector(".wr-slide") as HTMLElement;
    fireEvent.click(slide(), { clientX: 600, clientY: 100 });
    expect(position()).toMatch(/^3 of \d+$/);
    fireEvent.click(slide(), { clientX: 100, clientY: 100 });
    expect(position()).toMatch(/^2 of \d+$/);
  });

  it("does not turn the page when the tap is on something you can press or read the hover of", async () => {
    mount();
    await screen.findByText("tokens so far");
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    const aside = screen.getByText(/^About [\d.,]+[kMB]? novels? of text\.$/);
    const before = position();
    await userEvent.click(aside);
    expect(position()).toBe(before);
  });

  it("gives each slide its own way in, from the side you are heading", async () => {
    mount();
    await screen.findByText("tokens so far");
    const slide = () => document.querySelector(".wr-story-slide") as HTMLElement;
    expect(slide().dataset.tx).toBe("zoom");
    await userEvent.keyboard("{ArrowRight}");
    const a = slide().dataset.tx;
    expect(slide().dataset.dir).toBe("fwd");
    await userEvent.keyboard("{ArrowRight}");
    expect(slide().dataset.tx).not.toBe(a);
    await userEvent.keyboard("{ArrowLeft}");
    expect(slide().dataset.dir).toBe("back");
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
    const fig = document.querySelector(".wr-fig") as HTMLElement;
    expect(fig.getAttribute("title") ?? fig.getAttribute("data-tip")).toMatch(/\d+%|\d+ (of|skill)/);
    expect(screen.queryByText(/\$/)).not.toBeInTheDocument();
  });

  it("puts the tokens as novels on the totals slide, marked as an estimate in the hover", async () => {
    mount();
    await userEvent.click(await screen.findByRole("button", { name: "Start" }));
    const aside = screen.getByText(/^About [\d.,]+[kMB]? novels? of text\.$/);
    expect((aside.getAttribute("title") ?? aside.getAttribute("data-tip")) ?? "").toMatch(/0\.75 words per token[\s\S]*An estimate/);
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
    expect(drawn.join("|")).toContain("tokens");
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
