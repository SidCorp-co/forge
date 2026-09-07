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
import type { IssueDependencyExecutor } from './dependency-executor.js';

const CYCLE_DEPTH_CAP = 100;

const isExpired = (validUntil: Date | string | null, now: number): boolean =>
  validUntil !== null && new Date(validUntil).getTime() <= now;

/**
 * DFS forward from `start` following only `kind='blocks'` edges. If we reach
 * `target`, returns `'cycle'`. Caps depth defensively.
 */
// cm:guard the walk MUST run on the caller's executor, not the module-level `db`. Inside a create transaction the edges written earlier in that same transaction are not yet committed, so a `db`-level walk cannot see them — and relations-service's sequential loop exists precisely so A→B then B→A is refused on the second edge. Read the graph outside the transaction and that pair goes in clean.
export async function detectCycle(
  start: string,
  target: string,
  ex: IssueDependencyExecutor = db,
): Promise<'cycle' | 'depth_exceeded' | null> {
  if (start === target) return 'cycle';
  const now = Date.now();
  const visited = new Set<string>();
  const stack: Array<{ node: string; depth: number }> = [{ node: start, depth: 0 }];
  while (stack.length > 0) {
    // biome-ignore lint/style/noNonNullAssertion: length checked
    const { node, depth } = stack.pop()!;
    if (depth > CYCLE_DEPTH_CAP) return 'depth_exceeded';
    if (visited.has(node)) continue;
    visited.add(node);
    const children = await ex
      .select({ to: issueDependencies.toIssueId, validUntil: issueDependencies.validUntil })
      .from(issueDependencies)
      .where(and(eq(issueDependencies.fromIssueId, node), eq(issueDependencies.kind, 'blocks')));
    for (const c of children) {
      // cm:why an EXPIRED edge is not an arc of this graph: `validUntil` in the past is how a retraction is recorded (the row survives as the record that the dependency once held), and the dispatcher already ignores it, so counting it here refuses a new edge on the strength of one that gates nothing. Filtered in JS rather than in SQL because the walk already fetches every child of the node, and the predicate has to agree with the dispatcher's, which reads the same column.
      if (isExpired(c.validUntil, now)) continue;
      if (c.to === target) return 'cycle';
      if (!visited.has(c.to)) stack.push({ node: c.to, depth: depth + 1 });
    }
  }
  return null;
}
