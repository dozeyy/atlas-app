import { plural } from "./usage";

/** The values Atlas offers for how long Claude Code keeps saved sessions. Never 0: that is not "forever". */
export const KEEP_PICKS = [
  { days: 30, label: "30 days" },
  { days: 365, label: "1 year" },
  { days: 3650, label: "Forever" },
] as const;

export interface KeepChoice {
  /** The option shown as selected; "" when the file holds a value Claude Code will not accept. */
  value: string;
  options: { value: string; label: string }[];
  /** What is set, in words (for the read-only line). */
  label: string;
}

/**
 * What the picker shows for what the file says. A missing key is Claude Code's default of 30 days.
 * A value that is not one of the picks (90 days, say) gets its own selected option, so Atlas never
 * pretends it is something else and never changes it unless the user picks another.
 */
export function keepChoice(days: number | null, invalid: boolean): KeepChoice {
  const options: { days: number; label: string }[] = KEEP_PICKS.map((p) => ({ days: p.days, label: p.label }));
  if (invalid) return { value: "", options: options.map(asOption), label: "Not a value Claude Code accepts" };
  const now = days ?? 30;
  let at = options.find((o) => o.days === now);
  if (!at) {
    at = { days: now, label: plural(now, "day") };
    options.push(at);
    options.sort((a, b) => a.days - b.days);
  }
  return { value: String(now), options: options.map(asOption), label: at.label };
}

function asOption(o: { days: number; label: string }) {
  return { value: String(o.days), label: o.label };
}

/** The toast after a change: plain words for what Claude Code will do now. */
export function keepToast(days: number): string {
  return days === 3650 ? "Saved sessions will be kept forever (3,650 days)." : days === 365 ? "Saved sessions will be kept for a year." : "Saved sessions will be kept for 30 days.";
}
