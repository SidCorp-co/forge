import {
  COMMIT_FIELD,
  LANDING_UNSEEN,
  LATER_MERGE_ACTION,
  MARK_UNSEEN,
} from '@forge/contracts/mark-merged-words';
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
  /** ISS-1300 r3 — `supersedes` is a held commit the repository was read and lacks. */
  | { kind: 'stated'; commitSha: string; at?: Date | null; supersedes: string | null }
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
  /** Whether `commitSha` is a person's word (`merged_commit_stated`), not a merge Forge saw. */
  stated: boolean;
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
  /** `merged_commit_stated`, required: a row that left it out would read a person's commit as one
   *  Forge saw land. */
  mergedCommitStated: boolean | null;
}

export function mergeMarkKindOf(row: MergeMarkColumns): MergeMarkKind {
  if (row.mergedAt == null) return 'unmarked';
  // `''` is representable and is not a commit; the doc says why it reads as a claim.
  if ((row.mergedCommitSha ?? '').trim() !== '')
    return row.mergedCommitStated ? 'asserted' : 'observed';
  return (row.mergedLanding ?? '').trim() === '' ? 'asserted' : 'landed';
}

/** The pair every projection reporting a mark carries, as one spread: the sha travels with
 *  the word, so no projection can carry one without the other. */
export function mergeMarkFields(row: MergeMarkColumns): {
  mergedCommitSha: string | null;
  mergedLanding: string | null;
  /** The commit an `asserted` mark names that Forge could not check; null on every other mark. */
  mergedClaimedCommit: string | null;
  mergedCommitStated: boolean;
  mergeMark: MergeMarkKind;
} {
  return {
    mergedCommitSha: row.mergedCommitSha,
    mergedCommitStated: row.mergedCommitStated === true,
    mergedLanding: row.mergedLanding,
    mergedClaimedCommit: row.mergedClaimedCommit ?? null,
    mergeMark: mergeMarkKindOf(row),
  };
}

function sharedPrefix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n]?.toLowerCase() === b[n]?.toLowerCase()) n += 1;
  return n;
}

// Seven characters, or as many more as tell it from each commit `beside` it (ISS-578's pair shares
// eight; ISS-1300 r4). The whole sha stays in the answer's fields.
export const shortCommit = (sha: string, ...beside: Array<string | null | undefined>): string => {
  if (!/^[0-9a-f]{8,}$/i.test(sha)) return sha;
  const others = beside.filter((b): b is string => !!b && b.toLowerCase() !== sha.toLowerCase());
  const keep = Math.max(7, ...others.map((b) => sharedPrefix(sha, b) + 1));
  return sha.slice(0, Math.min(keep, sha.length));
};

/** A commit the repository lacks, in twelve: its seven may name one it holds (ISS-1300 r4). */
export const absentCommit = (sha: string): string =>
  sha.replace(/^([0-9a-f]{12})[0-9a-f]+$/i, '$1');
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
  return /^Forge can read .+? again:/.test(once)
    ? 'Mark it again once Forge can read the repository'
    : `Mark it again once ${once}`;
}

/** What checks it, in a sentence of ours; the host's own fix travels in the quoted reason. */
export function checkStep(u: { why?: string; clears: string; noReader: boolean }): string {
  if (!u.noReader) return markAgainOnce(u.clears);
  const fix = u.why ?? '';
  if (/\bset an SSH clone URL/i.test(fix)) {
    return "Set the repository's SSH clone URL and a deploy key, then mark it again";
  }
  return /\bconnect the repository\b/.test(fix)
    ? 'Attach a deploy key or connect the repository, then mark it again'
    : 'Attach a deploy key, then mark it again';
}

/** Another part of Forge's words, quoted on a line of their own so they never run on inside ours. */
export function quoted(words: string): string {
  return `> ${words.replace(/\s+/g, ' ').trim()}`;
}

/** A refusal quoted beneath ours: its sentences on one quoted line, each host line after it whole as code. */
export function quotedRefusal(why: string): string {
  const [ours = '', ...host] = why.trim().split('\n');
  const said = ours
    .trim()
    .replace(/([^.!?])$/, '$1.')
    .replace(/^[a-z](?=[a-z]*\s)/, (c) => c.toUpperCase());
  const code = host.flatMap((l) => (l.trim() ? [`>\n> \`${l.trim().replace(/`/g, "'")}\``] : []));
  return [quoted(said), ...code].join('\n');
}

/** Our sentences, then the reason another part of Forge gave, quoted beneath them (criterion 63). */
export function withReason(sentences: string, why: string | null | undefined): string {
  return why?.trim() ? `${sentences}\n${quotedRefusal(shortenCommits(why))}` : sentences;
}

/** A repository's address as code, so `git@host:org/repo` or `user@host` is never a mail link. */
export function addressesAsCode(text: string): string {
  return text.replace(
    /(`[^`\n]*`)|((?:ssh|git|https?):\/\/[^\s`'"<>()]*[^\s`'"<>().,;:]|[\w.-]+@[\w-]+(?:\.[\w-]+)*(?::[^\s`'"<>()]*[^\s`'"<>().,;:])?)/g,
    (whole, code: string | undefined, address: string | undefined) =>
      code ? whole : `\`${address}\``,
  );
}

/** A repeat beside the claim the row keeps: why it is unchecked, or what records the other commit. */
export function keptClaimRepeat(u: Unverified): string {
  const named = u.notKept ? shortCommit(u.notKept, u.commit) : null;
  return named
    ? `Commit ${named} was not recorded, because the first claim, ${shortCommit(u.commit, u.notKept)}, stands. To record ${named} instead, use Unmark, then Mark merged again.`
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
  /** The repository holding a person's stamped commit, and the commit it replaced (ISS-1300 r3). */
  stated?: { repository: string; replaced: string | null } | null;
}): string {
  if (args.kind === 'unmarked') {
    return 'This issue is not marked merged, so nothing here says the work landed.';
  }
  if (args.kind === 'landed') {
    return `Marked as landed outside git, at ${args.landing ?? 'the landing it was given'}. ${LANDING_UNSEEN}`;
  }
  if (args.kind === 'observed') {
    // Against the COLUMN, not the row this call selected: docs/modules/issues/merge-mark.md.
    const differs =
      !!args.claimedCommit &&
      args.claimedCommit.toLowerCase() !== (args.commitSha ?? '').toLowerCase();
    const at = args.commitSha
      ? shortCommit(args.commitSha, args.claimedCommit)
      : 'the commit it landed at';
    const source = args.readFrom
      ? `on ${args.readFrom.branch} of ${args.readFrom.repository}`
      : 'in the pull request or the repository';
    // The column holds the merge Forge saw, and the CHECK keeps no claim beside it.
    const overruled = differs
      ? ` Commit ${shortCommit(args.claimedCommit as string, args.commitSha)}, named in this mark, was not recorded.`
      : '';
    return `Forge saw this merge land at commit ${at}, ${source}.${overruled}`;
  }
  if (args.stated && args.commitSha) {
    const { repository, replaced } = args.stated;
    const at = shortCommit(args.commitSha, replaced);
    const said = replaced
      ? `Commit ${at}, which ${repository} holds, replaces commit ${shortCommit(replaced, args.commitSha)}, which it does not.`
      : `Commit ${at} is in ${repository}, and is recorded as where this work landed.`;
    return `${said} ${MARK_UNSEEN}`;
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
    return `No commit was named. ${MARK_UNSEEN}`;
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
      mergedCommitStated: issues.mergedCommitStated,
    })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  return {
    mergedAt: row?.mergedAt ?? null,
    commitSha: row?.mergedCommitSha ?? null,
    landing: row?.mergedLanding ?? null,
    claimedCommit: row?.mergedClaimedCommit ?? null,
    stated: row?.mergedCommitStated === true,
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
    /** Where a git mark said the work landed: written by this same guarded statement, so it lands
     *  only with the mark it describes, never on a mark another request recorded (ISS-1421 r36). */
    target?: string | undefined;
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
  // way an observed write may replace one: the first stamp still wins `merged_at`, a stated one's too.
  const claimsOnly =
    (evidence.kind === 'asserted' && Boolean(evidence.unverifiedCommit)) ||
    evidence.kind === 'stated';
  const withCommit = evidence.kind === 'observed' || evidence.kind === 'stated';
  const supersedes = withCommit ? (evidence.supersedes ?? null) : null;
  // A merge Forge reads at the very commit a person stated turns their claim into its record.
  const promotes =
    evidence.kind === 'observed'
      ? and(
          eq(issues.mergedCommitStated, true),
          sql`lower(${issues.mergedCommitSha}) = lower(${evidence.commitSha})`,
        )
      : undefined;
  const gate = withCommit
    ? supersedes
      ? eq(issues.mergedCommitSha, supersedes)
      : promotes
        ? or(isNull(issues.mergedCommitSha), promotes)
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
  const landing =
    evidence.kind === 'asserted' || evidence.kind === 'stated' ? null : (evidence.landing ?? null);

  const [wrote] = await executor
    .update(issues)
    .set({
      mergedAt: claimsOnly ? sql`coalesce(${issues.mergedAt}, ${stampExpr})` : stampExpr,
      // When the mark was first set, which the owed-close sweep counts from; a later write keeps it.
      mergeMarkedAt: sql`coalesce(${issues.mergeMarkedAt}, now())`,
      ...(args.target ? { mergedTarget: args.target } : {}),
      // A commit replaces any claim here: the CHECK holds a claim beside no commit.
      ...(withCommit
        ? {
            mergedCommitSha: evidence.commitSha,
            mergedClaimedCommit: null,
            mergedCommitStated: evidence.kind === 'stated',
          }
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
      mergedCommitStated: issues.mergedCommitStated,
    });

  if (wrote) {
    return {
      wrote: true,
      mergedAt: wrote.mergedAt,
      commitSha: wrote.mergedCommitSha,
      landing: wrote.mergedLanding,
      claimedCommit: wrote.mergedClaimedCommit,
      stated: wrote.mergedCommitStated,
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
      mergeMarkedAt: null,
      mergedCommitSha: null,
      mergedLanding: null,
      mergedClaimedCommit: null,
      mergedCommitStated: false,
      mergedTarget: null,
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

/** The act the hold names, owed where a blank Commit could have recorded the landing (ISS-1300 r4). */
export const NAME_THE_COMMIT = `To record the commit that landed, use ${LATER_MERGE_ACTION} and name it under ${COMMIT_FIELD}.`;

export interface AbsentRecord {
  readonly commit: string;
  readonly from: 'merge' | 'landing';
  readonly repository: string | null;
}

export function absentStays(absent: AbsentRecord): string {
  const named = absentCommit(absent.commit);
  return absent.from === 'merge'
    ? `The mark stays at commit ${named}, which its repository does not hold.`
    : `The landing record names commit ${named}, which its repository does not hold.`;
}

/** A person's first mark naming no commit, over a landing the repository lacks (ISS-1300 r5). */
export function namesNoCommitRefusal(absent: AbsentRecord): string {
  const record = absent.from === 'merge' ? 'merge mark' : 'landing record';
  const holder = absent.repository ?? 'its repository';
  return (
    `Nothing was marked, because this issue's ${record} names commit ${absentCommit(absent.commit)}, ` +
    `which ${holder} does not hold, and a mark naming no commit leaves that record as it is. ` +
    `Name the commit that landed under ${COMMIT_FIELD}.`
  );
}

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
  if (args.op !== 'mark') return ['Merge mark removed.', note].filter(Boolean).join('\n\n');
  const labelled = args.stamp.commitSha ?? args.claimedCommit ?? args.stamp.claimedCommit;
  const named = labelled ? shortCommit(labelled) : null;
  const at = named && !args.markDetail.includes(named) ? `, at commit ${named}` : '';
  const into = args.target ? ` into ${args.target}` : '';
  const said = `Marked merged${into}${at}.\n${addressesAsCode(args.markDetail)}`;
  return note ? `${said}\n\n${note}` : said;
}
