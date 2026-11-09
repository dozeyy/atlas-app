// A figure that counts up: reading "851M" into parts, and the text it shows at any step. Pure
// functions; `useCountUp` in SlideView.tsx decides the step.

const NUM = /^(\d[\d,]*(?:\.\d+)?)([kMBT]?)$/;

export interface CountParts {
  n: number;
  decimals: number;
  commas: boolean;
  suffix: string;
}

/** A bare four-digit number in the calendar's range is a year, not a quantity: it must not count up from zero. */
const YEAR = /^(?:19|20)\d{2}$/;

/** "851M" -> 851 with suffix "M"; "1,234" -> 1234 with commas. Null for anything else (a date, a year, a name). */
export function parseCount(text: string): CountParts | null {
  const m = NUM.exec(text);
  if (!m || YEAR.test(text)) return null;
  const n = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(n) || n === 0) return null;
  return {
    n,
    decimals: (m[1].split(".")[1] ?? "").length,
    commas: m[1].includes(","),
    suffix: m[2],
  };
}

export function formatCount(v: number, p: CountParts): string {
  const body = p.commas
    ? v.toLocaleString("en-US", {
        minimumFractionDigits: p.decimals,
        maximumFractionDigits: p.decimals,
      })
    : v.toFixed(p.decimals);
  return body + p.suffix;
}

/**
 * The text of a figure at eased progress `k` (0..1), right-aligned into as many cells as the final
 * text has: cells with nothing in them yet are empty strings, so the suffix and the last digits
 * never move while the leading digits fill in. At k = 1 it is the final text, cell for cell.
 */
export function countCells(text: string, k: number): string[] {
  const cells = Array.from(text);
  const p = parseCount(text);
  if (!p || k >= 1) return cells;
  const now = Array.from(formatCount(p.n * Math.max(0, k), p));
  const out = new Array<string>(cells.length).fill("");
  for (let i = 1; i <= Math.min(now.length, cells.length); i++)
    out[cells.length - i] = now[now.length - i];
  return out;
}
