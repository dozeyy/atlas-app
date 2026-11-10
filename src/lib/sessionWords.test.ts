import { describe, expect, it } from "vitest";
import { MockUsage } from "./mockUsage";
import { mockCostReport } from "./setup-cost-mock";
import { costWords, engineLineWords, loadsInWords, receiptWords } from "./sessionWords";
import { setBackend } from "./ipc";
import { MockBackend } from "./mock";
import { openFolder } from "./sessionActions";
import { renderHook } from "@testing-library/react";
import { resetToasts, useToasts } from "../state/toastStore";

describe("the engine's fixed names, in the app's word", () => {
  it("rewords where a thing loads and leaves a project's own name alone", () => {
    expect(loadsInWords("All chats")).toBe("All sessions");
    expect(loadsInWords("Chats in atlas")).toBe("Sessions in atlas");
    expect(loadsInWords("Chats under docs/chats")).toBe("Sessions under docs/chats");
    expect(loadsInWords("Chats that connect them")).toBe("Sessions that connect them");
    expect(loadsInWords("Every project")).toBe("Every project");
  });

  it("names the main thread of a receipt 'Main session' and touches no helper", async () => {
    const usage = new MockUsage();
    const row = (await usage.sessionsList({ limit: 50 })).rows.find((r) => r.agentCount > 0)!;
    const raw = (await usage.sessionReceipt(row.sessionId))!;
    // The mock answers the way the engine does.
    expect(raw.threads.find((t) => t.agentId === null)!.name).toBe("Main chat");
    const said = receiptWords(raw)!;
    expect(said.threads.find((t) => t.agentId === null)!.name).toBe("Main session");
    expect(said.threads.filter((t) => t.agentId !== null).map((t) => t.name)).toEqual(raw.threads.filter((t) => t.agentId !== null).map((t) => t.name));
    expect(JSON.stringify(said)).not.toContain("Main chat");
    expect(receiptWords(null)).toBeNull();
  });

  it("rewords the engine's own error line and nothing a person wrote", () => {
    // crates/app/src/usage.rs, project_dir: the toast Open folder shows for a session with no project.
    expect(engineLineWords("This chat has no project folder.")).toBe("This session has no project folder.");
    expect(engineLineWords("That folder is gone.")).toBe("That folder is gone.");
    expect(engineLineWords("Could not open C:/work/This chat/notes")).toBe("Could not open C:/work/This chat/notes");
  });

  it("says session in the toast when Open folder has nothing to open", async () => {
    const backend = new MockBackend();
    backend.sessionOpenFolder = async () => {
      throw new Error("This chat has no project folder.");
    };
    setBackend(backend);
    resetToasts();
    await openFolder("s-1");
    const { result } = renderHook(() => useToasts());
    expect(result.current.map((t) => [t.message, t.tone])).toEqual([["This session has no project folder.", "error"]]);
    resetToasts();
    setBackend(null);
  });

  it("rewords every row of the cost report", () => {
    const report = costWords(mockCostReport([]));
    expect(report.rows.length).toBeGreaterThan(0);
    for (const r of report.rows) expect(r.loadsIn).not.toMatch(/chats/i);
  });
});
