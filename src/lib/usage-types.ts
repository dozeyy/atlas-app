// What the "Used and never used" panel reads: one row per skill or agent, joined
// from the Setup scan and the usage engine (see usage-join.ts).

import type { ItemKind } from "./setup-types";

export interface UsageRow {
  /** The Setup item's id. */
  id: string;
  kind: ItemKind;
  /** Times it was used in the last 30 days. */
  uses30d: number;
  /** Epoch milliseconds of the last use ever, or null when it never was. */
  lastUsed: number | null;
  /** Made or changed inside the window, so "not used yet" says nothing about it. */
  isNew?: boolean;
}
