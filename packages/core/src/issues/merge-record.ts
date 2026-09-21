import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { issues } from '../db/schema.js';
import { repoPullRequests } from '../db/schema-repo-projection.js';

/** The pool or a caller's open transaction. A close stamps inside one; a mark does not. */
export type MergeRecordExecutor = Pick<Db, 'update' | 'select'>;

export type MergeEvidence =
  | { kind: 'observed'; commitSha: string; mergedAt: Date; via: 'kernel' | 'event' }
  | { kind: 'asserted'; at?: Date | null; via: 'mark' | 'close' };

export interface MergeRecord {
  /** Whether THIS call moved the row. Every caller has to pass this on. */
  wrote: boolean;
  mergedAt: Date | null;
  commitSha: string | null;
}

async function readBack(
  executor: MergeRecordExecutor,
  issueId: string,
): Promise<{ mergedAt: Date | null; commitSha: string | null }> {
  const [row] = await executor
    .select({ mergedAt: issues.mergedAt, mergedCommitSha: issues.mergedCommitSha })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  return { mergedAt: row?.mergedAt ?? null, commitSha: row?.mergedCommitSha ?? null };
}

/**
 * Write the merge onto the issue, or report the stamp that was already there.
 *
 * Call it inside the same transaction as whatever else has to hold with it — the
 * status UPDATE for a close, the projection row for a kernel merge — so a
 * rollback drops both together.
 */
export async function recordIssueMerge(
  executor: MergeRecordExecutor,
  args: { issueId: string; evidence: MergeEvidence },
): Promise<MergeRecord> {
  const { issueId, evidence } = args;
  const stampExpr =
    evidence.kind === 'observed'
      ? sql`${evidence.mergedAt.toISOString()}::timestamptz`
      : evidence.at
        ? sql`${evidence.at.toISOString()}::timestamptz`
        : sql`now()`;

  const gate =
    evidence.kind === 'observed' ? isNull(issues.mergedCommitSha) : isNull(issues.mergedAt);

  const [wrote] = await executor
    .update(issues)
    .set({
      mergedAt: stampExpr,
      ...(evidence.kind === 'observed' ? { mergedCommitSha: evidence.commitSha } : {}),
      updatedAt: sql`now()`,
    })
    .where(and(eq(issues.id, issueId), gate))
    .returning({ mergedAt: issues.mergedAt, mergedCommitSha: issues.mergedCommitSha });

  if (wrote) {
    return { wrote: true, mergedAt: wrote.mergedAt, commitSha: wrote.mergedCommitSha };
  }
  const held = await readBack(executor, issueId);
  return { wrote: false, mergedAt: held.mergedAt, commitSha: held.commitSha };
}

/** Clearing the stamp re-blocks every downstream child (ISS-286 AC4). */
export async function clearIssueMerge(
  executor: MergeRecordExecutor,
  issueId: string,
): Promise<void> {
  await executor
    .update(issues)
    .set({ mergedAt: null, mergedCommitSha: null, updatedAt: sql`now()` })
    .where(eq(issues.id, issueId));
}

export async function observedMergeForIssue(
  executor: MergeRecordExecutor,
  issueId: string,
): Promise<{ commitSha: string; mergedAt: Date } | null> {
  const [row] = await executor
    .select({ sha: repoPullRequests.mergeCommitSha, at: repoPullRequests.mergedAt })
    .from(repoPullRequests)
    .where(
      and(
        eq(repoPullRequests.issueId, issueId),
        eq(repoPullRequests.state, 'merged'),
        isNotNull(repoPullRequests.mergeCommitSha),
        isNotNull(repoPullRequests.mergedAt),
      ),
    )
    .orderBy(asc(repoPullRequests.mergedAt))
    .limit(1);
  if (!row?.sha || !row.at) return null;
  return { commitSha: row.sha, mergedAt: row.at };
}
