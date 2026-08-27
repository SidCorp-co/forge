// Dropping an issue releases everything it was blocking.
//
// `dropped` means the work will never happen, so an outgoing `blocks` edge can
// never be satisfied the way the L2 gate expects — the blocker will not stamp
// `merged_at` and will not reach `closed`. The edge is expired instead, which
// is a predicate the gate already reads.

import { and, eq, isNull, or, sql } from 'drizzle-orm';
import type { PgTransaction } from 'drizzle-orm/pg-core';
import { issueDependencies, issues } from '../db/schema.js';

export interface UnblockedDependent {
  issueId: string;
  issSeq: number;
  projectId: string | null;
}

// biome-ignore lint/suspicious/noExplicitAny: the drizzle tx generic is not exported in a usable form
type Tx = PgTransaction<any, any, any>;

const liveEdge = or(
  isNull(issueDependencies.validUntil),
  sql`${issueDependencies.validUntil} > now()`,
);

/**
 * Expire the dropped issue's outgoing `blocks` edges and return the dependents
 * they were holding. Runs inside the transition's transaction, so a rollback
 * drops the expiry alongside the status flip.
 */
// cm:guard collect the dependents BEFORE the UPDATE and hand the list to the caller — never re-query after. Every dependent read in this repo filters `valid_until > now()` (issues/transition.ts, issues/pipeline-health.ts, jobs/dispatch-gates.ts), so a read after the write returns an empty set and the unblock ships with nothing announced and nothing recorded. Auto-release was the owner's call; releasing SILENTLY was not.
export async function expireBlocksEdgesOnDrop(
  tx: Tx,
  projectId: string,
  issueId: string,
): Promise<UnblockedDependent[]> {
  // cm:guard serialize drop expiry against `blocks` writes per project — without matching the graph lock, a relation can commit after the scan from a dropped blocker and strand its dependent behind an impossible merged_at
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${projectId}))`);
  const scope = and(
    eq(issueDependencies.fromIssueId, issueId),
    eq(issueDependencies.kind, 'blocks'),
    liveEdge,
  );

  const dependents = await tx
    .select({
      issueId: issueDependencies.toIssueId,
      issSeq: issues.issSeq,
      projectId: issueDependencies.projectId,
    })
    .from(issueDependencies)
    .innerJoin(issues, eq(issues.id, issueDependencies.toIssueId))
    .where(scope);

  if (dependents.length === 0) return [];

  await tx.update(issueDependencies).set({ validUntil: sql`now()` }).where(scope);

  return dependents;
}
