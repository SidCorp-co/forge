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
