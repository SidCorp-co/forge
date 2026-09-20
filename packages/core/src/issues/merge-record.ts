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

/**
 * ISS-1126 — the one name for what the pair of columns means.
 *
 * `merged_at` set with `merged_commit_sha` empty is not a half-written row: it is ISS-959's
 * encoding for a merge nobody here observed, and the two states are as different as a receipt is
 * from a promise. Until this function existed the distinction lived only in the columns, so every
 * surface that wanted it had to re-derive it from a null test and none of them did — 851 of 851
 * marks on this project are asserted and nothing an agent reads says so.
 *
 * It is a pure reading of two fields and it is the ONLY one. `check-merged-at-writers.mjs` makes
 * this module the single writer of the pair; a second place deciding what the pair MEANS would be
 * the same defect one axis over, and a reader that disagrees with the writer about which state it
 * is looking at is how state starts lying.
 */
export type MergeMarkKind = 'unmarked' | 'asserted' | 'observed';

/** The two columns, as any row carrying them spells them. */
export interface MergeMarkColumns {
  mergedAt: Date | string | null;
  mergedCommitSha: string | null;
}

export function mergeMarkKindOf(row: MergeMarkColumns): MergeMarkKind {
  if (row.mergedAt == null) return 'unmarked';
  // A blank string is not a commit, and the column is plain text with no check constraint, so it
  // is representable. `observed` is a claim that Forge holds a record of the merge; a column
  // holding nothing is not that record, whichever of null and '' it holds.
  return (row.mergedCommitSha ?? '').trim() === '' ? 'asserted' : 'observed';
}

/**
 * The pair of fields every projection that reports a mark carries, as one spread.
 *
 * The sha travels with the word so a reader can check the word rather than take it, and so no
 * projection can carry one without the other.
 */
export function mergeMarkFields(row: MergeMarkColumns): {
  mergedCommitSha: string | null;
  mergeMark: MergeMarkKind;
} {
  return { mergedCommitSha: row.mergedCommitSha, mergeMark: mergeMarkKindOf(row) };
}

/**
 * The sentence that says which kind this is, in the words a caller can act on.
 *
 * One author for it, because `applyMergeMarker` writes it into the audit comment AND returns it to
 * whoever made the mark: two sentences built at two call sites are two records that can disagree
 * about the same row.
 *
 * `claimedCommit` is the commit the CALLER named. It is deliberately not the column — naming a
 * commit is not observing a merge, and putting the caller's word in `merged_commit_sha` is exactly
 * the judgement-call-from-prose ISS-959 removed.
 */
export function describeMergeMark(args: {
  kind: MergeMarkKind;
  commitSha?: string | null;
  claimedCommit?: string | null;
}): string {
  if (args.kind === 'unmarked') {
    return 'this issue carries no merged mark: `merged_at` is empty, so nothing here says the work landed';
  }
  if (args.kind === 'observed') {
    // A caller that named a DIFFERENT commit is told so. Its word did not reach the column and
    // did not overwrite what Forge observed, and a caller left to assume either would be reading
    // its own claim back as a confirmation.
    const overruled = args.claimedCommit
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
