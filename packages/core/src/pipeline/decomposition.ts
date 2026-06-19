/**
 * ISS-119 — Epic decomposition lifecycle helpers.
 *
 * The `kind='decomposes'` edge in `issue_dependencies` models a parent epic
 * pointing at its children. It engages four hooks (cascade approve, watcher,
 * atomic release gate, close cascade) — wired up in
 * `pipeline/decomposition-subscribers.ts` and `jobs/dispatch-gates.ts`. The
 * pure query/predicate helpers live here so the subscriber module and the
 * dispatch gate can share them, and so the unit tests do not need to import
 * the subscriber wiring.
 *
 * No new tables or columns — the column `issue_dependencies.kind` is plain
 * `text` (no CHECK constraint in SQL), so adding `'decomposes'` to the TS
 * enum is the only schema change.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type IssueStatus, issueDependencies, issues } from '../db/schema.js';

/**
 * Child statuses that count as "ready" for the watcher's all-children-ready
 * check. When the LAST sibling enters this set, the parent gets a comment
 * and its pipeline is re-triggered for the integration-test step.
 */
export const DECOMP_CHILD_READY_STATUSES: ReadonlySet<IssueStatus> = new Set([
  'tested',
  'released',
  'closed',
]);

/**
 * Parent statuses that satisfy the L2 decomposition release gate. While the
 * parent is in any other status, child `release` jobs stay queued with
 * `waiting_on_decomp_parent`. `closed` counts as released — a closed parent
 * (e.g. wont-fix on the epic) should not strand finished children.
 */
export const DECOMP_PARENT_RELEASED_STATUSES: ReadonlySet<IssueStatus> = new Set([
  'released',
  'closed',
]);

export interface DecompositionChild {
  id: string;
  status: IssueStatus;
  projectId: string;
}

export interface DecompositionParent {
  id: string;
  status: IssueStatus;
  projectId: string;
  issSeq: number;
}

/**
 * Returns children of `parentIssueId` — rows where the parent is the `from`
 * side of a `kind='decomposes'` edge. Ignores expired edges (`valid_until`
 * in the past) to mirror the L2 blocks-gate convention.
 */
export async function findDecompositionChildren(
  parentIssueId: string,
): Promise<DecompositionChild[]> {
  const rows = await db
    .select({
      id: issues.id,
      status: issues.status,
      projectId: issues.projectId,
    })
    .from(issueDependencies)
    .innerJoin(issues, eq(issues.id, issueDependencies.toIssueId))
    .where(
      and(
        eq(issueDependencies.fromIssueId, parentIssueId),
        eq(issueDependencies.kind, 'decomposes'),
        sql`(${issueDependencies.validUntil} IS NULL OR ${issueDependencies.validUntil} > now())`,
      ),
    );
  return rows as DecompositionChild[];
}

/**
 * Returns the decomposition parent of `childIssueId`, if any. The schema
 * permits multiple inbound `decomposes` edges; the watcher and release gate
 * only need the first one. Nested decomposition (epic → epic → story) is
 * out of scope for v1.
 */
export async function findDecompositionParent(
  childIssueId: string,
): Promise<DecompositionParent | null> {
  const rows = await db
    .select({
      id: issues.id,
      status: issues.status,
      projectId: issues.projectId,
      issSeq: issues.issSeq,
    })
    .from(issueDependencies)
    .innerJoin(issues, eq(issues.id, issueDependencies.fromIssueId))
    .where(
      and(
        eq(issueDependencies.toIssueId, childIssueId),
        eq(issueDependencies.kind, 'decomposes'),
        sql`(${issueDependencies.validUntil} IS NULL OR ${issueDependencies.validUntil} > now())`,
      ),
    )
    .limit(1);
  return (rows[0] as DecompositionParent | undefined) ?? null;
}

/**
 * Pure predicate for the watcher: are ALL siblings in
 * {staging, released, closed}? Empty input is false — a parent with no
 * decomposition edges should not trigger the watcher.
 */
export function allChildrenReady(
  children: ReadonlyArray<{ status: IssueStatus }>,
): boolean {
  if (children.length === 0) return false;
  return children.every((c) => DECOMP_CHILD_READY_STATUSES.has(c.status));
}
