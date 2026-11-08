// What the "Used vs never used" panel reads. The usage engine (Phase 2) fills
// this in; until a backend provides `usageRows`, the panel is simply not shown.

import type { ItemKind } from "./setup-types";

export interface UsageRow {
  /** The Setup item's id. */
  id: string;
  kind: ItemKind;
  /** Times it was used in the last 30 days. */
  uses30d: number;
  /** Epoch milliseconds of the last use, or null when it never was. */
  lastUsed: number | null;
}
