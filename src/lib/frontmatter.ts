// Read and set one header field of a Markdown file (`---` block at the top) without
// disturbing anything else in the text: other lines, line endings and order stay as they are.
// Only a plain one-line `key: value` is editable as a field; block scalars, lists, a value with
// a trailing comment or an escape sequence, and a header with mixed line endings are left to
// the text editor, because writing them back as a field would change more than the value.

const BLOCK = /^(\uFEFF?)---[ \t]*(\r?\n)([\s\S]*?)(\r?\n)---[ \t]*(?=\r?\n|$)/;

export interface FieldRead {
  value: string;
  /** One plain line: safe to edit as a field. */
  single: boolean;
}

/**
 * The text a one-line value stands for, or null when reading it as plain text would lose
 * something: a trailing `# comment`, an escape sequence in double quotes (`\n`, `\u00e9`), a
 * stray quote, or a flow list, anchor or tag. Those stay in the text editor.
 */
function scalar(raw: string): string | null {
  const t = raw.trim();
  if (t.startsWith('"')) {
    if (t.length < 2 || !t.endsWith('"')) return null;
    const inner = t.slice(1, -1);
    // Take away the two escapes Atlas understands; a quote or backslash left over means
    // an unescaped quote (a comment after the value) or another escape sequence.
    if (/["\\]/.test(inner.replace(/\\["\\]/g, ""))) return null;
    return inner.replace(/\\(["\\])/g, "$1");
  }
  if (t.startsWith("'")) {
    if (t.length < 2 || !t.endsWith("'")) return null;
    const inner = t.slice(1, -1);
    if (inner.replace(/''/g, "").includes("'")) return null;
    return inner.replace(/''/g, "'");
  }
  if (/\s#/.test(t) || /^[[{&*!]/.test(t)) return null;
  return t;
}

/** Quote only when YAML would read the value as something else. */
export function quoteValue(v: string): string {
  const needs = v === "" || /^[\s#[\]{}&*!|>'"%@`-]|:\s|:$|\s#|\s$|^[?:]/.test(v) || /^(true|false|null|yes|no|~|[\d.]+)$/i.test(v);
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
  // Writing the header back joins its lines with one line ending; a header that mixes both
  // kinds would change on lines the user never touched.
  const mixed = /\r\n/.test(m[0]) && /(?:^|[^\r])\n/.test(m[0]);
  const value = scalar(raw);
  return { m, eol, lines, at, raw, value, single: !continued && !block && !mixed && value !== null && raw.trim() !== "" };
}

export function readField(text: string, key: string): FieldRead | null {
  const f = locate(text, key);
  if (!f) return null;
  return { value: f.single ? (f.value ?? f.raw.trim()) : f.raw.trim(), single: f.single };
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
