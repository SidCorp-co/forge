import type { SessionRow } from "../types";

/**
 * The sessions index as a tree, because a session now says who owns it.
 *
 * ISS-1136 — the list was flat because nothing in the row could say otherwise:
 * a master and the runs it started were three unrelated lines, and which run
 * belonged to which master was a fact only the box held. `parentSessionId` is
 * core's own record of that edge, so the index can show the shape instead of
 * asking the reader to infer it from timestamps.
 */
export interface TreeRow<T extends { id: string }> {
  row: T;
  /** How many owners stand between this row and its root, in THIS list. */
  depth: number;
  /** Whether anything in this list is owned by it. */
  hasChildren: boolean;
}

/** How deep the index will indent before it stops; below this, rows sit flat. */
const MAX_RENDERED_DEPTH = 4;

/**
 * Order rows so each one follows the session that owns it, keeping the order
 * the caller sorted them in within every sibling group.
 *
 * A row whose owner is not in this list is a root HERE, whatever it is in the
 * database: the alternative is hiding it because a filter excluded its parent,
 * and a session that vanishes from a filtered list because of something not in
 * that list is worse than a flat one. The same rule covers a cycle — a row
 * already placed is never placed twice, and anything left over is appended at
 * depth zero rather than dropped.
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
  // A cycle leaves its members unplaced, because every one of them has a parent
  // that is present. They are still sessions somebody is looking for.
  for (const row of rows) {
    if (!placed.has(row.id)) {
      placed.add(row.id);
      out.push({ row, depth: 0, hasChildren: (childrenOf.get(row.id) ?? []).length > 0 });
    }
  }
  return out;
}

/** The indent one nesting level buys, in pixels. */
export const OWNER_INDENT_PX = 18;

export type SessionTreeRow = TreeRow<SessionRow>;
