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

/** The one name for what the pair of columns means, and the ONLY reading of it:
 *  docs/modules/issues/merge-mark.md. */
export type MergeMarkKind = 'unmarked' | 'asserted' | 'observed';

/** The two columns, as any row carrying them spells them. */
export interface MergeMarkColumns {
  mergedAt: Date | string | null;
  mergedCommitSha: string | null;
}

export function mergeMarkKindOf(row: MergeMarkColumns): MergeMarkKind {
  if (row.mergedAt == null) return 'unmarked';
  // `''` is representable and is not a commit; the doc says why it reads as a claim.
  return (row.mergedCommitSha ?? '').trim() === '' ? 'asserted' : 'observed';
}

/** The pair every projection reporting a mark carries, as one spread: the sha travels with
 *  the word, so no projection can carry one without the other. */
export function mergeMarkFields(row: MergeMarkColumns): {
  mergedCommitSha: string | null;
  mergeMark: MergeMarkKind;
} {
  return { mergedCommitSha: row.mergedCommitSha, mergeMark: mergeMarkKindOf(row) };
}

/** The sentence saying which kind this is, written once: the audit comment and the caller's
 *  answer are both built from it. `claimedCommit` is the caller's word, not the column. */
export function describeMergeMark(args: {
  kind: MergeMarkKind;
  commitSha?: string | null;
  claimedCommit?: string | null;
}): string {
  if (args.kind === 'unmarked') {
    return 'this issue carries no merged mark: `merged_at` is empty, so nothing here says the work landed';
  }
  if (args.kind === 'observed') {
    // Against the COLUMN, not the row this call selected: docs/modules/issues/merge-mark.md.
    const differs =
      !!args.claimedCommit &&
      args.claimedCommit.toLowerCase() !== (args.commitSha ?? '').toLowerCase();
    const overruled = differs
      ? `. Commit ${args.claimedCommit}, which this call named, is recorded as its claim and is not what the column holds`
      : '';
    return `this mark is a merge Forge observed: \`merged_commit_sha\` holds ${args.commitSha ?? 'the commit it landed at'}, read from Forge's own record of the pull request rather than from anybody's word for it${overruled}`;
  }
  const claim = args.claimedCommit
    ? `commit ${args.claimedCommit} is recorded here as this call's claim and is NOT in \`merged_commit_sha\``
    : 'no commit is recorded in `merged_commit_sha`';
  return `this mark is a CLAIM Forge did not observe, not a merge it witnessed: ${claim}, because that column holds only a merge Forge has its own record of. Forge holds no merged pull request for this issue`;
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

/** Clear the claim. It re-blocks nothing — a `blocks` edge is released by STATUS (ISS-1100) — and
 *  whether the row may lose the claim at all is `refuseUnmarkOnClosed`'s, not this function's. */
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
