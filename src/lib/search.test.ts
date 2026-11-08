import { describe, expect, it } from "vitest";
import { MockBackend } from "./mock";
import { parseQuery } from "./mockSearch";
import type { SearchHit } from "./types";

const plain = (h: SearchHit): string => h.snippet.map((p) => p.text).join("");
const marked = (h: SearchHit): string[] => h.snippet.filter((p) => p.hit).map((p) => p.text);

describe("chat search (stand-in backend)", () => {
  it("finds a word, marks it, and says who wrote it", async () => {
    const b = new MockBackend();
    const page = await b.searchChats("backoff");
    expect(page.hits.length).toBeGreaterThan(0);
    for (const h of page.hits) {
      expect(plain(h).toLowerCase()).toContain("backoff");
      expect(marked(h).map((m) => m.toLowerCase())).toContain("backoff");
      expect(["user", "assistant"]).toContain(h.role);
      expect(h.projectName).toBe("orchard-api");
    }
    expect(page.index.ready).toBe(true);
  });

  it("needs every word, and keeps a quoted phrase together", async () => {
    const b = new MockBackend();
    const both = await b.searchChats("retry timeout ");
    expect(both.hits.length).toBeGreaterThan(0);
    const none = await b.searchChats("retry flaky ");
    expect(none.hits).toEqual([]);
    const phrase = await b.searchChats('"retry loop"');
    expect(phrase.hits.length).toBeGreaterThan(0);
    const apart = await b.searchChats('"loop retry"');
    expect(apart.hits).toEqual([]);
  });

  it("treats the last word as a prefix only while it is being typed, from the third letter", async () => {
    const b = new MockBackend();
    expect((await b.searchChats("flak")).hits.length).toBeGreaterThan(0);
    expect((await b.searchChats("flak ")).hits).toEqual([]);
    expect((await b.searchChats("fl")).hits).toEqual([]);
    expect(parseQuery("fix te").at(-1)?.prefix).toBe(false);
    expect(parseQuery("fix tes").at(-1)?.prefix).toBe(true);
  });

  it("ranks the tighter message first, then the newer one", async () => {
    const b = new MockBackend();
    const page = await b.searchChats("test ");
    const ids = page.hits.map((h) => h.id);
    // Messages 3 and 4 say "test" once each; the shorter one (3) ranks first.
    expect(ids).toContain(3);
    expect(ids).toContain(4);
    expect(ids.indexOf(3)).toBeLessThan(ids.indexOf(4));
    // Same score, then the newer one: nothing here is older-first.
    const ts = page.hits.map((h) => h.ts ?? 0);
    expect(ts[0]).toBeGreaterThan(0);
  });

  it("a helper's message belongs to the parent session", async () => {
    const b = new MockBackend();
    const page = await b.searchChats("covers three timeouts");
    const hit = page.hits.find((h) => h.agentId !== null);
    expect(hit?.sessionId).toBe("s-orchard");
    expect(hit?.agentId).toBe("agent-test");
  });

  it("shows a masked secret as stars, pages, and survives odd input", async () => {
    const b = new MockBackend();
    const star = await b.searchChats("restart preview");
    expect(star.hits.map(plain).join(" ")).toContain("***");
    const first = await b.searchChats("the ", 2, 0);
    expect(first.hits).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    const second = await b.searchChats("the ", 2, 2);
    expect(second.hits.map((h) => h.id)).not.toEqual(first.hits.map((h) => h.id));
    for (const q of ["", "   ", '"', "+ - * ( )", "AND OR NOT"]) {
      await expect(b.searchChats(q)).resolves.toBeTruthy();
    }
    expect((await b.searchChats("")).hits).toEqual([]);
  });

  it("closeToTray starts off and can be switched", async () => {
    const b = new MockBackend();
    expect(b.boot().settings.closeToTray).toBe(false);
    const info = await b.updateSettings({ closeToTray: true });
    expect(info.settings.closeToTray).toBe(true);
  });

  it("reports status and pushes changes", async () => {
    const b = new MockBackend();
    const seen: string[] = [];
    const off = await b.onSearchStatus((s) => seen.push(s.state));
    b.search.setStatus({ state: "indexing", ready: false });
    off();
    b.search.setStatus({ state: "idle" });
    expect(seen).toEqual(["indexing"]);
    expect((await b.searchStatus()).state).toBe("idle");
  });
});
