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
export async function expireBlocksEdgesOnDrop(
  tx: Tx,
  projectId: string,
  issueId: string,
): Promise<UnblockedDependent[]> {
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
