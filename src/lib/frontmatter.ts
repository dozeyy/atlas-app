// Read and set one header field of a Markdown file (`---` block at the top) without
// disturbing anything else in the text: other lines, line endings and order stay as they are.
// Only a plain one-line `key: value` is editable as a field; block scalars and lists are left
// to the text editor.

const BLOCK = /^(\uFEFF?)---[ \t]*(\r?\n)([\s\S]*?)(\r?\n)---[ \t]*(?=\r?\n|$)/;

export interface FieldRead {
  value: string;
  /** One plain line: safe to edit as a field. */
  single: boolean;
}

function unquote(v: string): string {
  const t = v.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    const inner = t.slice(1, -1);
    return t.startsWith('"') ? inner.replace(/\\(["\\])/g, "$1") : inner.replace(/''/g, "'");
  }
  return t;
}

/** Quote only when YAML would read the value as something else. */
export function quoteValue(v: string): string {
  const needs = v === "" || /^[\s#[\]{}&*!|>'"%@`-]|:\s|\s#|\s$|^[?:]/.test(v) || /^(true|false|null|yes|no|~|[\d.]+)$/i.test(v);
  return needs ? `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : v;
}

function locate(text: string, key: string) {
  const m = BLOCK.exec(text);
  if (!m) return null;
  const eol = m[2] ?? "\n";
  const lines = (m[3] ?? "").split(/\r?\n/);
  const re = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:[ \\t]*(.*)$`);
  const at = lines.findIndex((l) => re.test(l));
  if (at < 0) return null;
  const raw = re.exec(lines[at]!)![1] ?? "";
  const next = lines[at + 1];
  const continued = next !== undefined && /^[ \t]+\S|^-\s/.test(next);
  const block = /^[|>][+-]?\d*\s*$/.test(raw.trim());
  return { m, eol, lines, at, raw, single: !continued && !block && raw.trim() !== "" };
}

export function readField(text: string, key: string): FieldRead | null {
  const f = locate(text, key);
  if (!f) return null;
  return { value: f.single ? unquote(f.raw) : f.raw.trim(), single: f.single };
}

/** The text with that one line replaced, or null when there is no editable one-line field by that name. */
export function setField(text: string, key: string, value: string): string | null {
  const f = locate(text, key);
  if (!f || !f.single) return null;
  const clean = value.replace(/[\r\n]+/g, " ");
  const lines = f.lines.slice();
  lines[f.at] = `${key}: ${quoteValue(clean)}`;
  const m = f.m;
  const head = `${m[1] ?? ""}---${f.eol}${lines.join(f.eol)}${m[4] ?? "\n"}---`;
  return head + text.slice(m[0].length);
}
