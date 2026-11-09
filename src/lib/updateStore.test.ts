import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setBackend } from "./ipc";
import { MockBackend } from "./mock";
import { checkForUpdate, dismissUpdate, resetUpdateStore, startInstall } from "./updateStore";

const NEWER = { version: "0.2.0", notes: "Notes.", current: "0.1.0" };
let mock: MockBackend;

beforeEach(() => {
  resetUpdateStore();
  mock = new MockBackend();
  mock.updates.stepMs = 1;
  setBackend(mock);
});
afterEach(() => setBackend(null));

describe("update store", () => {
  it("says latest when nothing newer exists", async () => {
    expect(await checkForUpdate({ manual: true })).toEqual({ outcome: "latest" });
    expect(mock.updates.checks).toBe(1);
  });

  it("reports a newer version and asks the backend every time", async () => {
    mock.updates.available = NEWER;
    expect(await checkForUpdate({ manual: false })).toEqual({ outcome: "available", info: NEWER });
    expect(await checkForUpdate({ manual: false })).toEqual({ outcome: "available", info: NEWER });
    expect(mock.updates.checks).toBe(2);
  });

  it("turns a failed check into a message instead of throwing", async () => {
    mock.updates.checkError = "Could not reach the update server.";
    expect(await checkForUpdate({ manual: false })).toEqual({ outcome: "failed", message: "Could not reach the update server." });
  });

  it("does nothing on install when no update was found", async () => {
    await startInstall();
    expect(mock.updates.installs).toBe(0);
  });

  it("installs only when asked, once per ask, even after Later", async () => {
    mock.updates.available = NEWER;
    await checkForUpdate({ manual: false });
    expect(mock.updates.installs).toBe(0);
    dismissUpdate();
    void startInstall(); // a successful install never returns: the app is replaced under it
    await new Promise((r) => setTimeout(r, 20));
    expect(mock.updates.installs).toBe(1);
  });
});
