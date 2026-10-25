import type { LandingArtifact, ReadPaths } from '@forge/contracts/landing-artifacts';
import type { MergeStampVia, OutboxActor } from '@forge/contracts/outbox-events';
import { and, asc, eq, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import type { Db, Tx } from '../db/client.js';
import { issues } from '../db/schema.js';
import { repoPullRequestIssues, repoPullRequests } from '../db/schema-repo-projection.js';
import { sqlTimestamp } from '../db/sql-timestamp.js';
import { emitEvent } from '../outbox/index.js';
import { answerMergeQuestions } from './ports.js';

/** The pool or a caller's open transaction. A close stamps inside one; a mark does not. */
export type MergeRecordExecutor = Pick<Db, 'update' | 'select'>;

type MergeEvidence =
  | {
      kind: 'observed';
      commitSha: string;
      mergedAt: Date;
      /** Where the work also landed outside git, on a project whose landing is named. */
      landing?: string | null;
      artifacts?: LandingArtifact[] | null;
    }
  | { kind: 'landed'; landing: string; at?: Date | null; artifacts?: LandingArtifact[] | null }
  | { kind: 'asserted'; at?: Date | null };

export interface MergeRecord {
  /** Whether THIS call moved the row. Every caller has to pass this on. */
  wrote: boolean;
  mergedAt: Date | null;
  commitSha: string | null;
  landing: string | null;
  /** What the landing names it changed; null where it names nothing structured. */
  artifacts: LandingArtifact[] | null;
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

/** The stamp a design approval alone wrote on a git row (`recordDesignLanding`): no commit, no
 *  landing, no box-read paths, and every artifact a `design` one. A code mark is never shadowed by it. */
export function designOnlyStamp(
  row: MergeMarkColumns & {
    mergedArtifacts: readonly LandingArtifact[] | null;
    mergedPaths: ReadPaths | null;
  },
): string[] | null {
  if (mergeMarkKindOf(row) !== 'asserted' || row.mergedPaths) return null;
  const artifacts = row.mergedArtifacts ?? [];
  if (artifacts.length === 0 || artifacts.some((a) => a.surface !== 'design')) return null;
  return artifacts.map((a) => a.ref);
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
): Promise<Omit<MergeRecord, 'wrote'>> {
  const [row] = await executor
    .select({
      mergedAt: issues.mergedAt,
      mergedCommitSha: issues.mergedCommitSha,
      mergedLanding: issues.mergedLanding,
      mergedArtifacts: issues.mergedArtifacts,
    })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  return {
    mergedAt: row?.mergedAt ?? null,
    commitSha: row?.mergedCommitSha ?? null,
    landing: row?.mergedLanding ?? null,
    artifacts: row?.mergedArtifacts ?? null,
  };
}

const STAMP_FIELDS = ['mergedAt', 'mergedCommitSha', 'mergedLanding', 'mergedArtifacts'];

const stampColumns = {
  mergedAt: issues.mergedAt,
  mergedCommitSha: issues.mergedCommitSha,
  mergedLanding: issues.mergedLanding,
  mergedArtifacts: issues.mergedArtifacts,
};

/**
 * Write the merge onto the issue, or report the stamp that was already there. A stamp written
 * answers the questions parked on this issue's mark, in the same transaction.
 *
 * Call it inside the same transaction as whatever else has to hold with it — the
 * status UPDATE for a close, the projection row for a kernel merge — so a
 * rollback drops both together.
 */
export async function recordIssueMerge(
  executor: Tx,
  args: {
    issueId: string;
    evidence: MergeEvidence;
    actor: OutboxActor | null;
    /** The route the merge arrived by, carried on the stamp's `issue.updated`. */
    via: MergeStampVia;
  },
): Promise<MergeRecord> {
  const { issueId, evidence } = args;
  const [prior] = await executor
    .select({ projectId: issues.projectId, ...stampColumns })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  const stampExpr =
    evidence.kind === 'observed'
      ? sqlTimestamp(evidence.mergedAt)
      : evidence.at
        ? sqlTimestamp(evidence.at)
        : sql`now()`;

  const gate =
    evidence.kind === 'observed' ? isNull(issues.mergedCommitSha) : isNull(issues.mergedAt);
  const landing = evidence.kind === 'asserted' ? null : (evidence.landing ?? null);
  const artifacts = evidence.kind === 'asserted' ? null : (evidence.artifacts ?? null);

  const [wrote] = await executor
    .update(issues)
    .set({
      mergedAt: stampExpr,
      ...(evidence.kind === 'observed' ? { mergedCommitSha: evidence.commitSha } : {}),
      ...(landing ? { mergedLanding: landing } : {}),
      ...(artifacts ? { mergedArtifacts: artifacts } : {}),
      updatedAt: sql`now()`,
    })
    .where(and(eq(issues.id, issueId), gate))
    .returning(stampColumns);

  if (wrote && prior && args.actor) {
    // every writer of the stamp tells its readers in the stamp's own transaction
    const { projectId, ...before } = prior;
    await emitEvent(executor, 'issue.updated', {
      issueId,
      projectId,
      actor: args.actor,
      fields: STAMP_FIELDS,
      via: args.via,
      before,
      after: { ...wrote },
    });
  }
  if (wrote) {
    await answerMergeQuestions(executor, {
      issueId,
      mark: {
        mergedAt: wrote.mergedAt,
        commitSha: wrote.mergedCommitSha,
        landing: wrote.mergedLanding,
      },
      actor: args.actor,
    });
    return {
      wrote: true,
      mergedAt: wrote.mergedAt,
      commitSha: wrote.mergedCommitSha,
      landing: wrote.mergedLanding,
      artifacts: wrote.mergedArtifacts,
    };
  }
  const held = await readBack(executor, issueId);
  return { wrote: false, ...held };
}

/** The flow a design artifact's `<flow>@rev<n>` ref names. */
const flowOfRef = (ref: string) => ref.replace(/@rev\d+$/u, '');

/**
 * The design artifacts a mark carries once `artifact` joins them: where the mark already names design
 * revisions alone, the approved one is added beside them, replacing only the earlier revision of its
 * own flow (FB-140); any other mark is replaced by the approved revision alone.
 */
export function joinedDesignArtifacts(
  held: readonly LandingArtifact[] | null,
  artifact: LandingArtifact,
): LandingArtifact[] {
  const designs = held ?? [];
  if (designs.length === 0 || designs.some((a) => a.surface !== 'design')) return [artifact];
  const flow = flowOfRef(artifact.ref);
  return [...designs.filter((a) => flowOfRef(a.ref) !== flow), artifact];
}

/**
 * The landing the approval of a design revision records on the issue that drew it (ISS-262). An issue
 * drawing several designs keeps each approved one on its mark (FB-140): the approved revision joins
 * the design revisions a design-only mark already names (`joinedDesignArtifacts`). On a shape that
 * names landings (`landingOf` given) the landing is written over an unmarked row, a mark resting on
 * somebody's word or a design-only mark, and names every approved revision the mark then carries; a
 * merge Forge observed is never written over, and neither is a landing whose artifacts name anything
 * but design: that is the code the issue landed, and taking it for the design would leave the issue
 * design-only, which `awaiting_release` refuses (`merged-at.ts:mergeNotRecorded`). Where no landing
 * is named (git) it stamps a row that carries no mark, and adds to one a design approval alone wrote
 * (`designOnlyStamp`), keeping its time. Called in the decision's transaction:
 * docs/modules/issues/merge-mark.md.
 */
export async function recordDesignLanding(
  executor: Tx,
  args: {
    issueId: string;
    /** The landing text naming the design artifacts the mark carries; null on a git project. */
    landingOf: ((artifacts: readonly LandingArtifact[]) => string) | null;
    /** The approved revision's artifact, written on either shape: a revision deploys nothing. */
    artifact: LandingArtifact;
    actor: OutboxActor;
  },
): Promise<MergeRecord & { before: MergeMarkColumns & { artifacts: LandingArtifact[] | null } }> {
  const { issueId, landingOf } = args;
  const [prior] = await executor
    .select({ projectId: issues.projectId, mergedPaths: issues.mergedPaths, ...stampColumns })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  const before = {
    mergedAt: prior?.mergedAt ?? null,
    mergedCommitSha: prior?.mergedCommitSha ?? null,
    mergedLanding: prior?.mergedLanding ?? null,
    artifacts: prior?.mergedArtifacts ?? null,
  };
  const designStamp =
    landingOf === null
      ? prior !== undefined &&
        designOnlyStamp({ ...prior, mergedArtifacts: prior.mergedArtifacts ?? null }) !== null
      : (prior?.mergedArtifacts ?? []).every((a) => a.surface === 'design');
  const artifacts = joinedDesignArtifacts(
    designStamp ? (prior?.mergedArtifacts ?? null) : null,
    args.artifact,
  );
  const designOnly = sql`NOT EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(${issues.mergedArtifacts}, '[]'::jsonb)) a
                           WHERE a->>'surface' IS DISTINCT FROM 'design')`;
  // the row as it was read, so a stamp written between the read and this write is not overwritten
  const unchanged = prior?.mergedArtifacts
    ? sql`${issues.mergedArtifacts} = ${JSON.stringify(prior.mergedArtifacts)}::jsonb`
    : isNull(issues.mergedArtifacts);
  const gate =
    landingOf === null
      ? designStamp
        ? and(isNotNull(issues.mergedAt), unchanged)
        : isNull(issues.mergedAt)
      : and(sql`coalesce(trim(${issues.mergedCommitSha}), '') = ''`, designOnly, unchanged);
  const [wrote] = await executor
    .update(issues)
    .set({
      // a git stamp a design approval alone wrote keeps its time; any other is written now
      ...(landingOf === null && designStamp ? {} : { mergedAt: sql`now()` }),
      ...(landingOf === null ? {} : { mergedLanding: landingOf(artifacts) }),
      mergedArtifacts: artifacts,
      updatedAt: sql`now()`,
    })
    .where(and(eq(issues.id, issueId), gate))
    .returning(stampColumns);
  if (!wrote) return { wrote: false, ...(await readBack(executor, issueId)), before };
  await answerMergeQuestions(executor, {
    issueId,
    mark: {
      mergedAt: wrote.mergedAt,
      commitSha: wrote.mergedCommitSha,
      landing: wrote.mergedLanding,
    },
    actor: args.actor,
  });
  if (prior) {
    await emitEvent(executor, 'issue.updated', {
      issueId,
      projectId: prior.projectId,
      actor: args.actor,
      fields: STAMP_FIELDS,
      via: 'design',
      before: {
        mergedAt: before.mergedAt,
        mergedCommitSha: before.mergedCommitSha,
        mergedLanding: before.mergedLanding,
        mergedArtifacts: prior.mergedArtifacts,
      },
      after: { ...wrote },
    });
  }
  return {
    wrote: true,
    mergedAt: wrote.mergedAt,
    commitSha: wrote.mergedCommitSha,
    landing: wrote.mergedLanding,
    artifacts: wrote.mergedArtifacts,
    before,
  };
}

/**
 * The paths a box read for the landing commit from its own checkout, written onto a stamped row that
 * holds none: the first reading stands, as the first stamp does. Called in the mark's transaction
 * after the stamp, so a mark refused later drops it too: docs/modules/issues/merge-mark.md.
 */
export async function recordReadPaths(
  executor: Tx,
  args: { issueId: string; paths: ReadPaths; actor: OutboxActor },
): Promise<{ wrote: boolean; held: ReadPaths | null }> {
  const [wrote] = await executor
    .update(issues)
    .set({ mergedPaths: args.paths, updatedAt: sql`now()` })
    .where(and(eq(issues.id, args.issueId), isNotNull(issues.mergedAt), isNull(issues.mergedPaths)))
    .returning({ projectId: issues.projectId });
  if (wrote) {
    await emitEvent(executor, 'issue.updated', {
      issueId: args.issueId,
      projectId: wrote.projectId,
      actor: args.actor,
      fields: ['mergedPaths'],
      via: 'mark',
      before: { mergedPaths: null },
      after: { mergedPaths: args.paths },
    });
    return { wrote: true, held: args.paths };
  }
  const [row] = await executor
    .select({ mergedPaths: issues.mergedPaths })
    .from(issues)
    .where(eq(issues.id, args.issueId))
    .limit(1);
  return { wrote: false, held: row?.mergedPaths ?? null };
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
      mergedArtifacts: null,
      mergedPaths: null,
      mergedTarget: null,
      updatedAt: sql`now()`,
    })
    .where(and(eq(issues.id, issueId), ne(issues.status, 'closed')))
    .returning({ id: issues.id });
  return rows.length > 0;
}

/**
 * A reopened issue on a project that releases through change requests no longer stands on the merge
 * it had: the stamp is cleared in the reopen's transaction, its old values kept on `issue.updated`,
 * so the next merge of its change request records the host's commit (REQ-63 BC-3).
 */
export async function supersedeMergeOnReopen(
  executor: Tx,
  args: { issueId: string; actor: OutboxActor },
): Promise<boolean> {
  const [prior] = await executor
    .select({
      projectId: issues.projectId,
      mergedPaths: issues.mergedPaths,
      mergedTarget: issues.mergedTarget,
      ...stampColumns,
    })
    .from(issues)
    .where(and(eq(issues.id, args.issueId), isNotNull(issues.mergedAt)))
    .limit(1);
  if (!prior) return false;
  const cleared = await clearIssueMerge(executor, args.issueId);
  if (!cleared) return false;
  const { projectId, ...before } = prior;
  await emitEvent(executor, 'issue.updated', {
    issueId: args.issueId,
    projectId,
    actor: args.actor,
    fields: [...STAMP_FIELDS, 'mergedPaths', 'mergedTarget'],
    before,
    after: {
      mergedAt: null,
      mergedCommitSha: null,
      mergedLanding: null,
      mergedArtifacts: null,
      mergedPaths: null,
      mergedTarget: null,
    },
  });
  return true;
}

// the first target named on a standing mark is the branch the work landed on; a later mark
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

/** The earliest merge the host reports of a change request linking the issue, into `base` where named. */
export async function observedMergeForIssue(
  executor: MergeRecordExecutor,
  issueId: string,
  base?: string,
): Promise<{ commitSha: string; mergedAt: Date } | null> {
  const [row] = await executor
    .select({ sha: repoPullRequests.mergeCommitSha, at: repoPullRequests.mergedAt })
    .from(repoPullRequestIssues)
    .innerJoin(repoPullRequests, eq(repoPullRequests.id, repoPullRequestIssues.pullRequestId))
    .where(
      and(
        eq(repoPullRequestIssues.issueId, issueId),
        eq(repoPullRequests.state, 'merged'),
        isNotNull(repoPullRequests.mergeCommitSha),
        isNotNull(repoPullRequests.mergedAt),
        base === undefined ? undefined : eq(repoPullRequests.baseRef, base),
      ),
    )
    .orderBy(asc(repoPullRequests.mergedAt))
    .limit(1);
  if (!row?.sha || !row.at) return null;
  return { commitSha: row.sha, mergedAt: row.at };
}
