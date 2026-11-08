// A small, safe Markdown reader for the Setup preview: headings, lists, code,
// quotes, paragraphs. It builds plain data (never HTML), so nothing in a file can
// run or load anything. Text arrives already masked by Rust.

export interface Frontmatter {
  fields: { key: string; value: string }[];
  body: string;
}

/** Split `---` frontmatter off the top. Unclosed or absent frontmatter leaves the text alone. */
export function splitFrontmatter(src: string): Frontmatter {
  const text = src.replace(/^﻿/, "");
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { fields: [], body: text };
  const fields: { key: string; value: string }[] = [];
  let current: { key: string; value: string } | null = null;
  for (const line of (m[1] ?? "").split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) {
      current = { key: kv[1]!, value: (kv[2] ?? "").replace(/^["']|["']$/g, "") };
      fields.push(current);
    } else if (current && line.trim()) {
      current.value = `${current.value} ${line.trim().replace(/^-\s*/, "")}`.trim();
    }
  }
  return { fields, body: text.slice(m[0].length) };
}

export type Block =
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "code"; text: string; lang: string }
  | { type: "quote"; text: string }
  | { type: "rule" };

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push({ type: "paragraph", text: para.join(" ") });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^\s*(```|~~~)\s*([\w+-]*)/.exec(line);
    if (fence) {
      flush();
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trimStart().startsWith(fence[1]!)) code.push(lines[i++]!);
      out.push({ type: "code", text: code.join("\n"), lang: fence[2] ?? "" });
      continue;
    }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      flush();
      out.push({ type: "heading", level: h[1]!.length, text: h[2]! });
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      out.push({ type: "rule" });
      continue;
    }
    const li = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line);
    if (li) {
      flush();
      const ordered = li[2] !== undefined;
      const items: string[] = [li[3]!];
      while (i + 1 < lines.length) {
        const nx = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(lines[i + 1]!);
        if (!nx || (nx[2] !== undefined) !== ordered) break;
        items.push(nx[3]!);
        i++;
      }
      out.push({ type: "list", ordered, items });
      continue;
    }
    if (/^\s*>/.test(line)) {
      flush();
      const q: string[] = [line.replace(/^\s*>\s?/, "")];
      while (i + 1 < lines.length && /^\s*>/.test(lines[i + 1]!)) q.push(lines[++i]!.replace(/^\s*>\s?/, ""));
      out.push({ type: "quote", text: q.join(" ") });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    para.push(line.trim());
  }
  flush();
  return out;
}

export type Inline = { type: "text" | "code" | "strong" | "em" | "link"; text: string };

/** `code`, **bold**, *italic* and [links](x) (shown as text, never followed). */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|\[([^\]]+)\]\([^)]*\)/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ type: "text", text: text.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ type: "code", text: m[1] });
    else if (m[2] !== undefined || m[3] !== undefined) out.push({ type: "strong", text: (m[2] ?? m[3])! });
    else if (m[4] !== undefined) out.push({ type: "em", text: m[4] });
    else out.push({ type: "link", text: m[5]! });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ type: "text", text: text.slice(last) });
  return out;
}
