import { and, desc, eq, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
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
      supersedes?: string | null;
    }
  | { kind: 'landed'; landing: string; at?: Date | null; via: 'mark' }
  | {
      kind: 'asserted';
      at?: Date | null;
      via: 'mark' | 'close';
      /** A commit the caller named that Forge had no way to check (ISS-1409), kept as a claim. */
      unverifiedCommit?: string | null;
    };

export interface MergeRecord {
  /** Whether THIS call moved the row. Every caller has to pass this on. */
  wrote: boolean;
  mergedAt: Date | null;
  commitSha: string | null;
  landing: string | null;
  /** The unverified claim the row holds (`merged_claimed_commit`): never beside `commitSha`. */
  claimedCommit: string | null;
}

/** The one name for what the pair of columns means, and the ONLY reading of it:
 *  docs/modules/issues/merge-mark.md. */
export type MergeMarkKind = 'unmarked' | 'asserted' | 'landed' | 'observed';

/** The two columns, as any row carrying them spells them. */
export interface MergeMarkColumns {
  mergedAt: Date | string | null;
  mergedCommitSha: string | null;
  mergedLanding: string | null;
  /** `merged_claimed_commit`; a row that does not select it reads as holding none. */
  mergedClaimedCommit?: string | null;
}

export function mergeMarkKindOf(row: MergeMarkColumns): MergeMarkKind {
  if (row.mergedAt == null) return 'unmarked';
  // `''` is representable and is not a commit; the doc says why it reads as a claim.
  if ((row.mergedCommitSha ?? '').trim() !== '') return 'observed';
  return (row.mergedLanding ?? '').trim() === '' ? 'asserted' : 'landed';
}

/** The pair every projection reporting a mark carries, as one spread: the sha travels with
 *  the word, so no projection can carry one without the other. */
export function mergeMarkFields(row: MergeMarkColumns): {
  mergedCommitSha: string | null;
  mergedLanding: string | null;
  /** The commit an `asserted` mark names that Forge could not check; null on every other mark. */
  mergedClaimedCommit: string | null;
  mergeMark: MergeMarkKind;
} {
  return {
    mergedCommitSha: row.mergedCommitSha,
    mergedLanding: row.mergedLanding,
    mergedClaimedCommit: row.mergedClaimedCommit ?? null,
    mergeMark: mergeMarkKindOf(row),
  };
}

/** Another part of Forge's words, quoted on a line of their own so they never run on inside ours. */
export function quoted(words: string): string {
  return `> ${words.replace(/\s+/g, ' ').trim()}`;
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
  /** The repository this call found the claimed commit in; it says nothing of whose landing it is. */
  claimHeldBy?: string | null;
  /** The commit the mark holds as a claim because the project gives Forge no way to read its
   *  repository (ISS-1409), and the cause with the setting that clears it. */
  unverified?: {
    commit: string;
    why: string;
    clears: string;
    noReader: boolean;
    notKept?: string | null;
  } | null;
}): string {
  if (args.kind === 'unmarked') {
    return 'This issue is not marked merged, so nothing here says the work landed.';
  }
  if (args.kind === 'landed') {
    return `Marked as landed outside git, at ${args.landing ?? 'the landing it was given'}. Forge did not see it land; this is the marker's word.`;
  }
  if (args.kind === 'observed') {
    // Against the COLUMN, not the row this call selected: docs/modules/issues/merge-mark.md.
    const differs =
      !!args.claimedCommit &&
      args.claimedCommit.toLowerCase() !== (args.commitSha ?? '').toLowerCase();
    const source = args.readFrom
      ? `It read the commit from ${args.readFrom.repository}, on ${args.readFrom.branch}.`
      : 'It read it from the pull request or the repository.';
    const overruled = differs
      ? ` Commit ${args.claimedCommit}, named in this mark, is kept as a claim only.`
      : '';
    return `Forge saw this merge land at commit ${args.commitSha ?? 'the commit it landed at'}. ${source}${overruled}`;
  }
  if (args.unverified) {
    const { commit, noReader, why, clears, notKept } = args.unverified;
    const repeat = notKept
      ? ` Commit ${notKept} was not recorded: the first claim, ${commit}, stands. To change it, Unmark, then Mark merged again.`
      : '';
    // The reason and the step are worded where the reading failed, so each stands quoted as its own.
    const steps = noReader
      ? `Forge has no way to read this project's repository, so it did not check it. To have it checked, do this, then mark it again:\n${quoted(why)}`
      : `Forge could not check it. The reason:\n${quoted(why)}\nMark it again once this holds:\n${quoted(clears.replace(/^once\s+/, ''))}`;
    return `Commit ${commit} was named, and is kept as a claim.${repeat} ${steps}`;
  }
  if (!args.claimedCommit) {
    return 'No commit was named. Forge did not see this merge, so the mark is a claim.';
  }
  const held = args.claimHeldBy
    ? ` ${args.claimHeldBy} has commit ${args.claimedCommit}. Forge did not check that it is this issue's work.`
    : '';
  return `Commit ${args.claimedCommit} was named, and is kept as a claim. Forge did not see this merge, so it is not the merge commit.${held}`;
}

export async function readMergeColumns(
  executor: MergeRecordExecutor,
  issueId: string,
): Promise<Omit<MergeRecord, 'wrote'>> {
  const [row] = await executor
    .select({
      mergedAt: issues.mergedAt,
      mergedCommitSha: issues.mergedCommitSha,
      mergedLanding: issues.mergedLanding,
      mergedClaimedCommit: issues.mergedClaimedCommit,
    })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  return {
    mergedAt: row?.mergedAt ?? null,
    commitSha: row?.mergedCommitSha ?? null,
    landing: row?.mergedLanding ?? null,
    claimedCommit: row?.mergedClaimedCommit ?? null,
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
  args: {
    issueId: string;
    evidence: MergeEvidence;
    /** The issue's declared lane the mark was judged on; the stamp lands only while it still holds. */
    declared?: string | null;
  },
): Promise<MergeRecord> {
  const { issueId, evidence } = args;
  const stampExpr =
    evidence.kind === 'observed'
      ? sql`${evidence.mergedAt.toISOString()}::timestamptz`
      : evidence.at
        ? sql`${evidence.at.toISOString()}::timestamptz`
        : sql`now()`;

  // A claim may be attached to a bare `asserted` mark (one naming no commit, landing or claim), the
  // way an observed write may replace one: the first stamp still wins `merged_at`.
  const claimsOnly = evidence.kind === 'asserted' && Boolean(evidence.unverifiedCommit);
  const supersedes = evidence.kind === 'observed' ? (evidence.supersedes ?? null) : null;
  const gate =
    evidence.kind === 'observed'
      ? supersedes
        ? eq(issues.mergedCommitSha, supersedes)
        : isNull(issues.mergedCommitSha)
      : claimsOnly
        ? or(
            isNull(issues.mergedAt),
            and(
              isNull(issues.mergedCommitSha),
              isNull(issues.mergedLanding),
              isNull(issues.mergedClaimedCommit),
            ),
          )
        : isNull(issues.mergedAt);
  const landing = evidence.kind === 'asserted' ? null : (evidence.landing ?? null);

  const [wrote] = await executor
    .update(issues)
    .set({
      mergedAt: claimsOnly ? sql`coalesce(${issues.mergedAt}, ${stampExpr})` : stampExpr,
      // A merge Forge read replaces any claim in the same statement: the CHECK holds a claim
      // beside no commit.
      ...(evidence.kind === 'observed'
        ? { mergedCommitSha: evidence.commitSha, mergedClaimedCommit: null }
        : {}),
      ...(evidence.kind === 'asserted' && evidence.unverifiedCommit
        ? { mergedClaimedCommit: evidence.unverifiedCommit.toLowerCase() }
        : {}),
      ...(landing ? { mergedLanding: landing } : {}),
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(issues.id, issueId),
        gate,
        args.declared === undefined
          ? undefined
          : sql`${issues.declaredLandingShape} IS NOT DISTINCT FROM ${args.declared}::text`,
      ),
    )
    .returning({
      mergedAt: issues.mergedAt,
      mergedCommitSha: issues.mergedCommitSha,
      mergedLanding: issues.mergedLanding,
      mergedClaimedCommit: issues.mergedClaimedCommit,
    });

  if (wrote) {
    return {
      wrote: true,
      mergedAt: wrote.mergedAt,
      commitSha: wrote.mergedCommitSha,
      landing: wrote.mergedLanding,
      claimedCommit: wrote.mergedClaimedCommit,
    };
  }
  const held = await readMergeColumns(executor, issueId);
  return { wrote: false, ...held };
}

/** Clear the claim, and report whether the row took it. It re-blocks nothing (ISS-1100). The
 *  `closed` guard is IN the statement: a read then a write leaves a window where the row is closed
 *  by somebody else, and what arrives then is the trigger's raw exception (ISS-1108). A row holding
 *  no mark is not taken either, so a call that would clear nothing is never reported as a clear. */
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
      mergedClaimedCommit: null,
      updatedAt: sql`now()`,
    })
    .where(and(eq(issues.id, issueId), ne(issues.status, 'closed'), isNotNull(issues.mergedAt)))
    .returning({ id: issues.id });
  return rows.length > 0;
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
    .orderBy(desc(repoPullRequests.mergedAt))
    .limit(1);
  if (!row?.sha || !row.at) return null;
  return { commitSha: row.sha, mergedAt: row.at };
}
