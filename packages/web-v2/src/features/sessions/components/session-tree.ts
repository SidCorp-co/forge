import type { SessionRow } from "../types";

/**
 * The sessions index as a tree: `parentSessionId` is core's own record of which
 * run belongs to which master, so the shape is shown rather than inferred.
 */
export interface TreeRow<T extends { id: string }> {
  row: T;
  depth: number;
  hasChildren: boolean;
}

const MAX_RENDERED_DEPTH = 4;

/**
 * Order rows so each follows the session that owns it, keeping the caller's
 * order within every sibling group.
 *
 * A row whose owner is not in this list is a root HERE: hiding it because a
 * filter excluded its parent is worse than a flat list. A cycle is the same —
 * a row is never placed twice, and leftovers are appended at depth zero.
 */
export function orderByOwner<T extends { id: string; parentSessionId?: string | null }>(
  rows: readonly T[],
): TreeRow<T>[] {
  const present = new Set(rows.map((r) => r.id));
  const childrenOf = new Map<string, T[]>();
  const roots: T[] = [];

  for (const row of rows) {
    const parent = row.parentSessionId;
    if (parent && parent !== row.id && present.has(parent)) {
      const siblings = childrenOf.get(parent);
      if (siblings) siblings.push(row);
      else childrenOf.set(parent, [row]);
    } else {
      roots.push(row);
    }
  }

  const out: TreeRow<T>[] = [];
  const placed = new Set<string>();

  const walk = (row: T, depth: number): void => {
    if (placed.has(row.id)) return;
    placed.add(row.id);
    const children = childrenOf.get(row.id) ?? [];
    out.push({
      row,
      depth: Math.min(depth, MAX_RENDERED_DEPTH),
      hasChildren: children.length > 0,
    });
    for (const child of children) walk(child, depth + 1);
  };

  for (const root of roots) walk(root, 0);
  for (const row of rows) {
    if (!placed.has(row.id)) {
      placed.add(row.id);
      out.push({ row, depth: 0, hasChildren: (childrenOf.get(row.id) ?? []).length > 0 });
    }
  }
  return out;
}

export const OWNER_INDENT_PX = 18;

export type SessionTreeRow = TreeRow<SessionRow>;
