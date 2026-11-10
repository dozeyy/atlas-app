import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const listen = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: (...a: unknown[]) => listen(...a) }));

import { agoText } from "./historyModel";
import { getBackend, indexedAtMs, setBackend } from "./ipc";
import { MockBackend } from "./mock";

// 2026-11-09 12:00:00 UTC, the way the engine writes it: whole seconds.
const ENGINE_SECONDS = 1_794_225_600;
const MS = ENGINE_SECONDS * 1000;

type W = { __TAURI_INTERNALS__?: unknown; __ATLAS_BOOT__?: unknown };

describe("the last-indexed stamp", () => {
  beforeEach(() => {
    (window as unknown as W).__TAURI_INTERNALS__ = {};
    (window as unknown as W).__ATLAS_BOOT__ = {};
    setBackend(null);
    invoke.mockReset();
    listen.mockReset();
  });
  afterEach(() => {
    delete (window as unknown as W).__TAURI_INTERNALS__;
    delete (window as unknown as W).__ATLAS_BOOT__;
    setBackend(null);
  });

  it("turns the engine's seconds into milliseconds and leaves 'never' alone", () => {
    expect(indexedAtMs({ lastIndexedAt: ENGINE_SECONDS }).lastIndexedAt).toBe(MS);
    expect(indexedAtMs({ lastIndexedAt: null }).lastIndexedAt).toBeNull();
    const other = indexedAtMs({ lastIndexedAt: ENGINE_SECONDS, filesTracked: 61 });
    expect(other.filesTracked).toBe(61);
  });

  it("reads as minutes ago in the real app, never as a day in 1970", async () => {
    invoke.mockImplementation(async (cmd: string) => ({ state: "idle", lastIndexedAt: cmd === "usage_reindex" ? null : ENGINE_SECONDS }));
    const real = getBackend();
    expect(real).not.toBeInstanceOf(MockBackend);

    const usage = await real.usageStatus();
    expect(usage.lastIndexedAt).toBe(MS);
    expect(agoText(usage.lastIndexedAt!, MS + 120_000)).toBe("2 min ago");
    // The bug: the raw stamp, read as milliseconds, is a day in January 1970.
    expect(agoText(ENGINE_SECONDS, MS + 120_000)).toMatch(/^Jan \d+, 1970/);

    expect((await real.searchStatus()).lastIndexedAt).toBe(MS);
    expect((await real.usageReindex("changed")).lastIndexedAt).toBeNull();
    expect(invoke.mock.calls.map((c) => c[0])).toEqual(["usage_status", "search_status", "usage_reindex"]);
  });

  it("converts the stamp on every status event too", async () => {
    const handlers: ((e: { payload: unknown }) => void)[] = [];
    listen.mockImplementation(async (_name: string, h: (e: { payload: unknown }) => void) => {
      handlers.push(h);
      return () => {};
    });
    const real = getBackend();
    const seen: (number | null)[] = [];
    await real.onUsageStatus((s) => seen.push(s.lastIndexedAt));
    await real.onSearchStatus((s) => seen.push(s.lastIndexedAt));
    for (const h of handlers) h({ payload: { lastIndexedAt: ENGINE_SECONDS } });
    expect(seen).toEqual([MS, MS]);
  });

  it("gets the same unit from the stand-in backend, so a preview shows what the app shows", async () => {
    delete (window as unknown as W).__TAURI_INTERNALS__;
    const mock = getBackend();
    expect(mock).toBeInstanceOf(MockBackend);
    const now = Date.now();
    for (const at of [(await mock.usageStatus()).lastIndexedAt, (await mock.searchStatus()).lastIndexedAt]) {
      // Milliseconds of a recent day: a seconds stamp would be a thousand times smaller.
      expect(at).not.toBeNull();
      expect(Math.abs(now - at!)).toBeLessThan(5 * 366 * 86_400_000);
    }
  });
});
