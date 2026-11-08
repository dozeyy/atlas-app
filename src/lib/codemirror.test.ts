import { afterEach, describe, expect, it } from "vitest";
import { EditorView } from "@codemirror/view";
import { mountViewer, type Viewer } from "./codemirror";

let viewer: Viewer | null = null;
afterEach(() => {
  viewer?.destroy();
  viewer = null;
  document.body.innerHTML = "";
});

describe("the file viewer", () => {
  it("is read only: it says so, and the editor state refuses edits", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    viewer = await mountViewer(host, "name: demo\nline two", "yaml", []);

    const inner = host.firstElementChild!.shadowRoot!;
    const content = inner.querySelector<HTMLElement>(".cm-content")!;
    expect(content.getAttribute("aria-readonly")).toBe("true");
    expect(content.getAttribute("aria-label")).toBe("File contents, read only");

    const view = EditorView.findFromDOM(inner.querySelector<HTMLElement>(".cm-editor")!)!;
    expect(view.state.readOnly).toBe(true);

    expect(view.state.doc.toString()).toBe("name: demo\nline two");
  });
});
