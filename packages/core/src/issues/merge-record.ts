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

// A person reads a commit by its first seven characters; the whole sha stays in the answer's fields.
export const shortCommit = (sha: string): string => sha.replace(/^([0-9a-f]{7})[0-9a-f]+$/i, '$1');
export const shortenCommits = (text: string): string =>
  text.replace(/\b([0-9a-f]{7})(?:[0-9a-f]{33}|[0-9a-f]{57})\b/gi, '$1');

/** Another part of Forge's reason, cut to the one clause a sentence of ours can carry. */
export function firstClause(why: string): string {
  return (shortenCommits(why).split(/\n| — |; |\. /)[0] ?? why).trim().replace(/\.$/, '');
}

type Unverified = {
  commit: string;
  why: string;
  clears: string;
  noReader: boolean;
  notKept?: string | null;
};

/** What must hold, cut to its first phrase; a reader's route reads as "once Forge can read it". */
export function markAgainOnce(clears: string): string {
  const once = firstClause(clears.replace(/^once\s+/, '')).split(', ')[0] ?? clears;
  return /^the tracker can read the project's repository\b/.test(once)
    ? 'Mark it again once Forge can read the repository'
    : `Mark it again once ${once}`;
}

/** What checks it, in a sentence of ours; the host's own fix travels in the quoted reason. */
export function checkStep(u: { why?: string; clears: string; noReader: boolean }): string {
  if (!u.noReader) return markAgainOnce(u.clears);
  const fix = u.why?.split(' — ')[1] ?? '';
  if (/^set an SSH clone URL/i.test(fix)) {
    return "Set the repository's SSH clone URL and a deploy key, then mark it again";
  }
  return /\bbind the repository\b/.test(fix)
    ? 'Attach a deploy key or bind the repository, then mark it again'
    : 'Attach a deploy key, then mark it again';
}

/** Another part of Forge's words, quoted on a line of their own so they never run on inside ours. */
export function quoted(words: string): string {
  return `> ${words.replace(/\s+/g, ' ').trim()}`;
}

/** Our sentences, then the reason another part of Forge gave, quoted beneath them (criterion 63). */
export function withReason(sentences: string, why: string | null | undefined): string {
  const said = why
    ?.trim()
    .replace(/([^.!?])$/, '$1.')
    .replace(/^[a-z](?=[a-z]*\s)/, (c) => c.toUpperCase());
  return said ? `${sentences}\n${quoted(shortenCommits(said))}` : sentences;
}

/** A repository's address as a comment shows it: code, so `git@host:org/repo` is never a mail link. */
export function addressesAsCode(text: string): string {
  return text.replace(
    /(`[^`\n]*`)|((?:[\w.-]+@[\w.-]+:|(?:ssh|git|https?):\/\/)[^\s`'"<>()]*[^\s`'"<>().,;:])/g,
    (whole, code: string | undefined, address: string | undefined) =>
      code ? whole : `\`${address}\``,
  );
}

/** A repeat beside the claim the row keeps: why it is unchecked, or what records the other commit. */
export function keptClaimRepeat(u: Unverified): string {
  const named = u.notKept ? shortCommit(u.notKept) : null;
  return named
    ? `Commit ${named} was not recorded, because the first claim, ${shortCommit(u.commit)}, stands. To record ${named} instead, use Unmark, then Mark merged again.`
    : withReason(
        `Commit ${shortCommit(u.commit)} stays a claim, because Forge could not check it. ${checkStep(u)}.`,
        u.why,
      );
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
  unverified?: Unverified | null;
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
    const at = args.commitSha ? shortCommit(args.commitSha) : 'the commit it landed at';
    const source = args.readFrom
      ? `on ${args.readFrom.branch} of ${args.readFrom.repository}`
      : 'in the pull request or the repository';
    // The column holds the merge Forge saw, and the CHECK keeps no claim beside it.
    const overruled = differs
      ? ` Commit ${shortCommit(args.claimedCommit as string)}, named in this mark, was not recorded.`
      : '';
    return `Forge saw this merge land at commit ${at}, ${source}.${overruled}`;
  }
  if (args.unverified) {
    const u = args.unverified;
    const unchecked = u.noReader
      ? "Forge has no way to read this project's repository, so it did not check it."
      : 'Forge could not check it against the repository.';
    return withReason(
      `Commit ${shortCommit(u.commit)} was named and is kept as a claim. ${unchecked} ${checkStep(u)}.`,
      u.why,
    );
  }
  const unseen = 'Forge did not see this merge, so the mark is a claim that names no commit.';
  if (!args.claimedCommit) {
    return 'No commit was named. Forge did not see this merge, so the mark is a claim.';
  }
  // A person's commit is checked only for the repository holding it, and the row keeps none of it:
  // it counts as no work evidence (`work-evidence.ts`), so it is said to live in the comment alone.
  const claimed = shortCommit(args.claimedCommit);
  const held = args.claimHeldBy ? ` is in ${args.claimHeldBy}, and` : '';
  return `Commit ${claimed}${held} is noted in the comment only. ${unseen}`;
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

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A repeated mark changes nothing, and says so: no stored timestamp, never "Marked merged". */
export function alreadyMarkedSentence(mergedAt: Date | null): string {
  const on = mergedAt
    ? ` on ${mergedAt.getUTCDate()} ${MONTHS[mergedAt.getUTCMonth()]} ${mergedAt.getUTCFullYear()}`
    : '';
  return `Already marked merged${on}, so this call changed nothing`;
}

export const CHANGE_THE_MARK = 'To change the mark, use Unmark, then Mark merged again.';

/** The audit comment a person reads: words, never field names. A repeat opens with what it did,
 *  nothing; a first mark names its commit once, in the label only where the detail does not. */
export function threadBody(args: {
  op: 'mark' | 'unmark';
  target?: string | undefined;
  note?: string | undefined;
  stamp: MergeRecord;
  claimedCommit: string | null;
  repeated: boolean;
  unread: string | null;
  after: string;
  markDetail: string;
}): string {
  const note = args.note ? quoted(args.note) : null;
  if (args.repeated) {
    const parts = args.unread
      ? [addressesAsCode(args.unread), note]
      : [`${alreadyMarkedSentence(args.stamp.mergedAt)}.`, note, addressesAsCode(args.after)];
    return parts.filter(Boolean).join('\n\n');
  }
  const said = args.note ? ` — ${args.note}` : '.';
  if (args.op !== 'mark') return `Merge mark removed${said}`;
  const labelled = args.stamp.commitSha ?? args.claimedCommit ?? args.stamp.claimedCommit;
  const named = labelled ? shortCommit(labelled) : null;
  const at = named && !args.markDetail.includes(named) ? `, at commit ${named}` : '';
  const into = args.target ? ` into ${args.target}` : '';
  return `Marked merged${into}${at}${said}\n${addressesAsCode(args.markDetail)}`;
}
