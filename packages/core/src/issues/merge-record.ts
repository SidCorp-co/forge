import { and, asc, eq, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { issues } from '../db/schema.js';
import { repoPullRequests } from '../db/schema-repo-projection.js';

/** The pool or a caller's open transaction. A close stamps inside one; a mark does not. */
export type MergeRecordExecutor = Pick<Db, 'update' | 'select'>;

export type MergeEvidence =
  | {
      kind: 'observed';
      commitSha: string;
      mergedAt: Date;
      via: 'kernel' | 'event' | 'repository';
      /** Where the work also landed outside git, on a project whose landing is named. */
      landing?: string | null;
    }
  | { kind: 'landed'; landing: string; at?: Date | null; via: 'mark' }
  | { kind: 'asserted'; at?: Date | null; via: 'mark' | 'close' };

export interface MergeRecord {
  /** Whether THIS call moved the row. Every caller has to pass this on. */
  wrote: boolean;
  mergedAt: Date | null;
  commitSha: string | null;
  landing: string | null;
}

/** The one name for what the pair of columns means, and the ONLY reading of it:
 *  docs/modules/issues/merge-mark.md. */
export type MergeMarkKind = 'unmarked' | 'asserted' | 'landed' | 'observed';

/** The two columns, as any row carrying them spells them. */
export interface MergeMarkColumns {
  mergedAt: Date | string | null;
  mergedCommitSha: string | null;
  mergedLanding: string | null;
}

export function mergeMarkKindOf(row: MergeMarkColumns): MergeMarkKind {
  if (row.mergedAt == null) return 'unmarked';
  // `''` is representable and is not a commit; the doc says why it reads as a claim.
  if ((row.mergedCommitSha ?? '').trim() !== '') return 'observed';
  return (row.mergedLanding ?? '').trim() === '' ? 'asserted' : 'landed';
}

/** The sentence saying which kind this is, written once: the audit comment and the caller's
 *  answer are both built from it. `claimedCommit` is the caller's word, not the column. */
export function describeMergeMark(args: {
  kind: MergeMarkKind;
  commitSha?: string | null;
  claimedCommit?: string | null;
  landing?: string | null;
  /** Where this call read an `observed` commit from the repository rather than a pull request. */
  readFrom?: { repository: string; branch: string } | null;
}): string {
  if (args.kind === 'unmarked') {
    return 'this issue carries no merged mark: `merged_at` is empty, so nothing here says the work landed';
  }
  if (args.kind === 'landed') {
    return `this mark names where the work landed outside git: \`merged_landing\` holds ${args.landing ?? 'the landing it was given'}. It is the word of whoever marked it, not a merge Forge observed`;
  }
  if (args.kind === 'observed') {
    // Against the COLUMN, not the row this call selected: docs/modules/issues/merge-mark.md.
    const differs =
      !!args.claimedCommit &&
      args.claimedCommit.toLowerCase() !== (args.commitSha ?? '').toLowerCase();
    const overruled = differs
      ? `. Commit ${args.claimedCommit}, which this call named, is recorded as its claim and is not what the column holds`
      : '';
    const source = args.readFrom
      ? `read from ${args.readFrom.repository} itself, which resolves it, gives it to this issue by its subject and holds it on ${args.readFrom.branch}`
      : "read by Forge itself, from its record of the pull request or from the project's repository";
    return `this mark is a merge Forge observed: \`merged_commit_sha\` holds ${args.commitSha ?? 'the commit it landed at'}, ${source}, rather than from anybody's word for it${overruled}`;
  }
  const claim = args.claimedCommit
    ? `commit ${args.claimedCommit} is recorded here as this call's claim and is NOT in \`merged_commit_sha\``
    : 'no commit is recorded in `merged_commit_sha`';
  return `this mark is a CLAIM Forge did not observe, not a merge it witnessed: ${claim}, because that column holds only a merge Forge has its own record of. Forge holds no merged pull request for this issue`;
}

async function readBack(
  executor: MergeRecordExecutor,
  issueId: string,
): Promise<{ mergedAt: Date | null; commitSha: string | null; landing: string | null }> {
  const [row] = await executor
    .select({
      mergedAt: issues.mergedAt,
      mergedCommitSha: issues.mergedCommitSha,
      mergedLanding: issues.mergedLanding,
    })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  return {
    mergedAt: row?.mergedAt ?? null,
    commitSha: row?.mergedCommitSha ?? null,
    landing: row?.mergedLanding ?? null,
  };
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
  const landing = evidence.kind === 'asserted' ? null : (evidence.landing ?? null);

  const [wrote] = await executor
    .update(issues)
    .set({
      mergedAt: stampExpr,
      ...(evidence.kind === 'observed' ? { mergedCommitSha: evidence.commitSha } : {}),
      ...(landing ? { mergedLanding: landing } : {}),
      updatedAt: sql`now()`,
    })
    .where(and(eq(issues.id, issueId), gate))
    .returning({
      mergedAt: issues.mergedAt,
      mergedCommitSha: issues.mergedCommitSha,
      mergedLanding: issues.mergedLanding,
    });

  if (wrote) {
    return {
      wrote: true,
      mergedAt: wrote.mergedAt,
      commitSha: wrote.mergedCommitSha,
      landing: wrote.mergedLanding,
    };
  }
  const held = await readBack(executor, issueId);
  return { wrote: false, ...held };
}

/** Clear the claim, and report whether the row took it. It re-blocks nothing (ISS-1100). The
 *  `closed` guard is IN the statement: a read then a write leaves a window where the row is closed
 *  by somebody else, and what arrives then is the trigger's raw exception (ISS-1108). */
export async function clearIssueMerge(
  executor: MergeRecordExecutor,
  issueId: string,
): Promise<boolean> {
  const rows = await executor
    .update(issues)
    .set({
      mergedAt: null,
      mergedCommitSha: null,
      mergedLanding: null,
      mergedTarget: null,
      updatedAt: sql`now()`,
    })
    .where(and(eq(issues.id, issueId), ne(issues.status, 'closed')))
    .returning({ id: issues.id });
  return rows.length > 0;
}

// cm:why the first target named on a standing mark is the branch the work landed on; a later mark
// with another target does not move it, as a later stamp does not move merged_at.
export async function recordMergeTarget(
  executor: MergeRecordExecutor,
  issueId: string,
  target: string,
): Promise<void> {
  await executor
    .update(issues)
    .set({ mergedTarget: target })
    .where(and(eq(issues.id, issueId), isNotNull(issues.mergedAt), isNull(issues.mergedTarget)));
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
