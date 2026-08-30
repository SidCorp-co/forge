/**
 * Cycle detection over `kind='blocks'` edges.
 *
 * ISS-889 — its own module, not because the walk is long, but because it is
 * the one part of the edge write that reaches the graph rather than a row: a
 * caller's test can stub the traversal without also stubbing the insert it is
 * actually asserting on.
 */

import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issueDependencies } from '../db/schema.js';

const CYCLE_DEPTH_CAP = 100;

/**
 * DFS forward from `start` following only `kind='blocks'` edges. If we reach
 * `target`, returns `'cycle'`. Caps depth defensively.
 */
export async function detectCycle(
  start: string,
  target: string,
): Promise<'cycle' | 'depth_exceeded' | null> {
  if (start === target) return 'cycle';
  const visited = new Set<string>();
  const stack: Array<{ node: string; depth: number }> = [{ node: start, depth: 0 }];
  while (stack.length > 0) {
    // biome-ignore lint/style/noNonNullAssertion: length checked
    const { node, depth } = stack.pop()!;
    if (depth > CYCLE_DEPTH_CAP) return 'depth_exceeded';
    if (visited.has(node)) continue;
    visited.add(node);
    const children = await db
      .select({ to: issueDependencies.toIssueId })
      .from(issueDependencies)
      .where(and(eq(issueDependencies.fromIssueId, node), eq(issueDependencies.kind, 'blocks')));
    for (const c of children) {
      if (c.to === target) return 'cycle';
      if (!visited.has(c.to)) stack.push({ node: c.to, depth: depth + 1 });
    }
  }
  return null;
}
