import { describe, expect, it } from "vitest";
import { quoteValue, readField, setField } from "./frontmatter";

const SKILL = "---\nname: deep-research\ndescription: Look things up\n---\n# Body\n\nText.\n";

describe("frontmatter fields", () => {
  it("reads a one-line field", () => {
    expect(readField(SKILL, "description")).toEqual({ value: "Look things up", single: true });
    expect(readField(SKILL, "model")).toBeNull();
    expect(readField("# no header\n", "name")).toBeNull();
  });

  it("changes only that line and keeps the body", () => {
    expect(setField(SKILL, "description", "Find sources")).toBe("---\nname: deep-research\ndescription: Find sources\n---\n# Body\n\nText.\n");
  });

  it("keeps CRLF line endings and a byte order mark", () => {
    const crlf = "﻿---\r\nname: a\r\ndescription: x\r\n---\r\nBody\r\n";
    expect(setField(crlf, "description", "y")).toBe("﻿---\r\nname: a\r\ndescription: y\r\n---\r\nBody\r\n");
  });

  it("quotes only when the value would be misread", () => {
    expect(quoteValue("plain words")).toBe("plain words");
    expect(quoteValue("use this: when asked")).toBe('"use this: when asked"');
    expect(quoteValue("say \"hi\" # now")).toBe('"say \\"hi\\" # now"');
    expect(quoteValue("")).toBe('""');
    expect(readField(setField(SKILL, "description", "a: b")!, "description")?.value).toBe("a: b");
  });

  it("will not edit a block scalar or a list as a field", () => {
    const folded = "---\nname: a\ndescription: >\n  long text\n  more\n---\nBody\n";
    expect(readField(folded, "description")?.single).toBe(false);
    expect(setField(folded, "description", "x")).toBeNull();
    const list = "---\ntools:\n  - Read\n  - Edit\n---\nBody\n";
    expect(setField(list, "tools", "x")).toBeNull();
  });

  it("reads a quoted value without its quotes", () => {
    expect(readField('---\ndescription: "A: b"\n---\n', "description")?.value).toBe("A: b");
  });
});
