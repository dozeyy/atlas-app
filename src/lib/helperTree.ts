// Pure: arrange a session's helpers (subagents) as a forest. No React here.

import type { AgentSummary } from "./types";

export interface HelperNode {
  agent: AgentSummary;
  kids: HelperNode[];
  /** Position in reading order, for the stagger on first paint. */
  index: number;
}

/** Helpers as a forest: one that another helper started hangs under its starter. */
export function helperTree(agents: AgentSummary[]): HelperNode[] {
  const nodes = new Map(agents.map((a) => [a.agentId, { agent: a, kids: [] as HelperNode[], index: 0 }]));
  const parentOf = new Map(agents.map((a) => [a.agentId, a.parentAgentId]));
  // A starter that leads back to the helper itself would hide both from the tree: treat it as a root.
  const loops = (id: string): boolean => {
    let at: string | null | undefined = parentOf.get(id);
    for (let hops = 0; at && hops <= agents.length; hops++) {
      if (at === id) return true;
      at = parentOf.get(at);
    }
    return false;
  };
  const roots: HelperNode[] = [];
  for (const a of agents) {
    const node = nodes.get(a.agentId)!;
    const parent = a.parentAgentId ? nodes.get(a.parentAgentId) : undefined;
    if (parent && !loops(a.agentId)) parent.kids.push(node);
    else roots.push(node);
  }
  let n = 0;
  const walk = (list: HelperNode[]) =>
    list.forEach((node) => {
      node.index = n++;
      walk(node.kids);
    });
  walk(roots);
  return roots;
}
