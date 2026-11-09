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

  it("quotes a value that ends in a colon, so the file stays valid YAML", () => {
    expect(quoteValue("Notes:")).toBe('"Notes:"');
    expect(quoteValue("a:b")).toBe("a:b");
    const out = setField(SKILL, "description", "Use when asked about:")!;
    expect(out).toContain('description: "Use when asked about:"');
    expect(readField(out, "description")).toEqual({ value: "Use when asked about:", single: true });
  });

  it("keeps whatever it writes readable back, exactly", () => {
    for (const v of ['say "hi"', "back\\slash", "ends with \\", "a # b", "it's", "- dash", "true", "12", "x: y", "tail:"]) {
      const out = setField(SKILL, "description", v)!;
      expect(readField(out, "description")).toEqual({ value: v, single: true });
    }
  });

  it("will not edit a value with a trailing comment as a field", () => {
    for (const line of ["description: Look things up # why", 'description: "Look things up" # why', "description: 'Look things up' # why"]) {
      const text = `---\nname: a\n${line}\n---\nBody\n`;
      expect(readField(text, "description")?.single).toBe(false);
      expect(setField(text, "description", "x")).toBeNull();
    }
    // A # inside the value is not a comment.
    expect(readField("---\ndescription: C#\n---\n", "description")).toEqual({ value: "C#", single: true });
    expect(readField('---\ndescription: "a # b"\n---\n', "description")).toEqual({ value: "a # b", single: true });
  });

  it("will not edit a double-quoted value with an escape sequence, a stray quote, or a flow list", () => {
    for (const line of ['description: "line one\\nline two"', 'description: "caf\\u00e9"', 'description: "a "b" c"', 'description: "unclosed', "description: 'it's'", "description: [a, b]", "description: &anchor text", "description: !!str text"]) {
      const text = `---\nname: a\n${line}\n---\nBody\n`;
      expect(readField(text, "description")?.single, line).toBe(false);
      expect(setField(text, "description", "x"), line).toBeNull();
    }
    // Escaped backslash followed by a letter is not an escape sequence.
    expect(readField('---\ndescription: "C:\\\\new"\n---\n', "description")).toEqual({ value: "C:\\new", single: true });
    expect(readField("---\ndescription: 'it''s fine'\n---\n", "description")).toEqual({ value: "it's fine", single: true });
  });

  it("will not edit a header that mixes line endings", () => {
    const mixed = "---\r\nname: a\ndescription: x\r\n---\r\nBody\r\n";
    expect(readField(mixed, "description")?.single).toBe(false);
    expect(setField(mixed, "description", "y")).toBeNull();
    const lfThenCrlfBody = "---\nname: a\ndescription: x\n---\nBody\r\nmore\r\n";
    expect(readField(lfThenCrlfBody, "description")?.single).toBe(true);
  });
});
