import type { AttentionItem } from "@/features/attention/types";

export interface CostPart {
  label: string;
  n: number;
}

const PARTS: Array<{ key: "claimsHeld" | "workspacesPinned" | "dependents"; one: string; many: string }> = [
  { key: "claimsHeld", one: "claim", many: "claims" },
  { key: "workspacesPinned", one: "workspace", many: "workspaces" },
  { key: "dependents", one: "dependent", many: "dependents" },
];

// cm:guard a ZERO part is dropped rather than rendered as "0 claims": every row in this bucket is ranked by these numbers, so a visible zero reads as a measured cost and pushes the eye away from the part that is actually non-zero. A row with no cost at all returns an empty list and the caller renders nothing (ISS-964 criteria 19, 53).
// cm:guard the ORDER is the order the server ranks by — claims, then workspaces, then dependents — and it is not sorted by size. A reader comparing two rows has to see the same fields in the same places, and the leading number is the one that decided the rank (`me/attention-buckets.ts:AWAITING_COST_ORDER`).
export function costParts(item: Pick<AttentionItem, "cost">): CostPart[] {
  const cost = item.cost;
  if (!cost) return [];
  return PARTS.filter((p) => cost[p.key] > 0).map((p) => ({
    label: cost[p.key] === 1 ? p.one : p.many,
    n: cost[p.key],
  }));
}

/** One line for a row: "2 claims · 1 workspace", or null when nothing is held. */
export function costSummary(item: Pick<AttentionItem, "cost">): string | null {
  const parts = costParts(item);
  return parts.length === 0 ? null : parts.map((p) => `${p.n} ${p.label}`).join(" · ");
}
