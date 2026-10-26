import type { LandingArtifact, MergedHead, ReadPaths } from '@forge/contracts/landing-artifacts';
import type { MergeStampVia, OutboxActor } from '@forge/contracts/outbox-events';
import { and, desc, eq, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import type { Db, Tx } from '../db/client.js';
import { issues } from '../db/schema.js';
import { repoPullRequestIssues, repoPullRequests } from '../db/schema-repo-projection.js';
import { sqlTimestamp } from '../db/sql-timestamp.js';
import { emitEvent } from '../outbox/index.js';
import {
  designOnlyStamp,
  joinedDesignArtifacts,
  keptMergedHead,
  type MergeMarkColumns,
} from './merge-mark-kind.js';
import { answerMergeQuestions } from './ports.js';

/** The pool or a caller's open transaction. A close stamps inside one; a mark does not. */
export type MergeRecordExecutor = Pick<Db, 'update' | 'select'>;

type MergeEvidence =
  | {
      kind: 'observed';
      commitSha: string;
      mergedAt: Date;
      /**
       * The branch the commit landed on, read where the commit was: the request's base for a host
       * merge, the branch the repository holds it on otherwise. An observed stamp names its commit
       * and its target together, and a blank one is refused rather than written (`observedTarget`).
       */
      target: string;
      /**
       * A host's merge of a change request delivering the issue. A later one supersedes the stamp an
       * earlier merge (or any earlier mark) left, since an issue delivered across several requests
       * lands at the last of them; any other observed stamp stands first.
       */
      hostMerge?: { head: MergedHead | null } | null;
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
  /** The branch the row says the work landed on. */
  target: string | null;
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
      mergedTarget: issues.mergedTarget,
    })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  return {
    mergedAt: row?.mergedAt ?? null,
    commitSha: row?.mergedCommitSha ?? null,
    landing: row?.mergedLanding ?? null,
    artifacts: row?.mergedArtifacts ?? null,
    target: row?.mergedTarget ?? null,
  };
}

const STAMP_FIELDS = ['mergedAt', 'mergedCommitSha', 'mergedLanding', 'mergedArtifacts'];
const OBSERVED_FIELDS = [...STAMP_FIELDS, 'mergedTarget', 'mergedHead'];

const stampColumns = {
  mergedAt: issues.mergedAt,
  mergedCommitSha: issues.mergedCommitSha,
  mergedLanding: issues.mergedLanding,
  mergedArtifacts: issues.mergedArtifacts,
};

const observedColumns = {
  ...stampColumns,
  mergedTarget: issues.mergedTarget,
  mergedHead: issues.mergedHead,
};

/** The target an observed stamp writes, refused by name where the caller read none: kernel input. */
function observedTarget(issueId: string, evidence: { commitSha: string; target: string }): string {
  const target = typeof evidence.target === 'string' ? evidence.target.trim() : '';
  if (target === '') {
    throw new Error(
      `recordIssueMerge: an observed merge of issue ${issueId} at ${evidence.commitSha} names no target branch; ` +
        'the stamp records the commit and the branch it landed on together, so it is not written without one',
    );
  }
  return target;
}

/**
 * Where the row already holds this very commit, the target and head the observation read are
 * written over what it holds: a stamp left with no target (or a mark's word for one) beside a commit
 * the host merged into another branch is corrected by the next reading of that merge, never kept.
 */
async function correctObserved(
  executor: Tx,
  args: { issueId: string; commitSha: string; target: string; head: MergedHead | null | undefined },
  actor: OutboxActor | null,
  via: MergeStampVia,
): Promise<void> {
  const [prior] = await executor
    .select({
      projectId: issues.projectId,
      mergedTarget: issues.mergedTarget,
      mergedHead: issues.mergedHead,
    })
    .from(issues)
    .where(
      and(
        eq(issues.id, args.issueId),
        sql`lower(${issues.mergedCommitSha}) = ${args.commitSha.toLowerCase()}`,
      ),
    )
    .limit(1);
  if (!prior) return;
  const head = keptMergedHead(prior.mergedHead ?? null, args.head);
  const sameHead = JSON.stringify(head ?? null) === JSON.stringify(prior.mergedHead ?? null);
  if (prior.mergedTarget === args.target && sameHead) return;
  await executor
    .update(issues)
    .set({ mergedTarget: args.target, mergedHead: head ?? null, updatedAt: sql`now()` })
    .where(eq(issues.id, args.issueId));
  if (!actor) return;
  await emitEvent(executor, 'issue.updated', {
    issueId: args.issueId,
    projectId: prior.projectId,
    actor,
    fields: ['mergedTarget', 'mergedHead'],
    via,
    before: { mergedTarget: prior.mergedTarget, mergedHead: prior.mergedHead },
    after: { mergedTarget: args.target, mergedHead: head ?? null },
  });
}

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
  const observed = evidence.kind === 'observed';
  const target = observed ? observedTarget(issueId, evidence) : null;
  const hostMerge = observed ? (evidence.hostMerge ?? null) : null;
  const [prior] = await executor
    .select({ projectId: issues.projectId, ...observedColumns })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  const stampExpr =
    evidence.kind === 'observed'
      ? sqlTimestamp(evidence.mergedAt)
      : evidence.at
        ? sqlTimestamp(evidence.at)
        : sql`now()`;

  // a later host merge of another commit supersedes what the row holds (REQ-63: the last request
  // delivering an issue is its landing); every other observed stamp is first-wins, as before
  const gate =
    evidence.kind !== 'observed'
      ? isNull(issues.mergedAt)
      : hostMerge
        ? or(
            isNull(issues.mergedCommitSha),
            and(
              sql`${issues.mergedAt} < ${stampExpr}`,
              sql`lower(${issues.mergedCommitSha}) <> ${evidence.commitSha.toLowerCase()}`,
            ),
          )
        : isNull(issues.mergedCommitSha);
  const landing = evidence.kind === 'asserted' ? null : (evidence.landing ?? null);
  const artifacts = evidence.kind === 'asserted' ? null : (evidence.artifacts ?? null);

  const [wrote] = await executor
    .update(issues)
    .set({
      mergedAt: stampExpr,
      ...(evidence.kind === 'observed'
        ? {
            mergedCommitSha: evidence.commitSha,
            mergedTarget: target,
            mergedHead: hostMerge?.head ?? null,
          }
        : {}),
      ...(landing ? { mergedLanding: landing } : {}),
      ...(artifacts ? { mergedArtifacts: artifacts } : {}),
      updatedAt: sql`now()`,
    })
    .where(and(eq(issues.id, issueId), gate))
    .returning(observedColumns);

  if (wrote && prior && args.actor) {
    // every writer of the stamp tells its readers in the stamp's own transaction
    const { projectId, mergedTarget, mergedHead, ...before } = prior;
    const { mergedTarget: afterTarget, mergedHead: afterHead, ...after } = wrote;
    await emitEvent(executor, 'issue.updated', {
      issueId,
      projectId,
      actor: args.actor,
      fields: observed ? OBSERVED_FIELDS : STAMP_FIELDS,
      via: args.via,
      before: observed ? { ...before, mergedTarget, mergedHead } : before,
      after: observed ? { ...after, mergedTarget: afterTarget, mergedHead: afterHead } : after,
    });
  }
  if (!wrote && evidence.kind === 'observed' && target) {
    await correctObserved(
      executor,
      {
        issueId,
        commitSha: evidence.commitSha,
        target,
        head: hostMerge ? hostMerge.head : undefined,
      },
      args.actor,
      args.via,
    );
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
      target: wrote.mergedTarget,
    };
  }
  const held = await readBack(executor, issueId);
  return { wrote: false, ...held };
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
    .select({
      projectId: issues.projectId,
      mergedPaths: issues.mergedPaths,
      mergedTarget: issues.mergedTarget,
      ...stampColumns,
    })
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
    target: prior?.mergedTarget ?? null,
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
      mergedHead: null,
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
      mergedHead: issues.mergedHead,
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
    fields: [...STAMP_FIELDS, 'mergedPaths', 'mergedTarget', 'mergedHead'],
    before,
    after: {
      mergedAt: null,
      mergedCommitSha: null,
      mergedLanding: null,
      mergedArtifacts: null,
      mergedPaths: null,
      mergedTarget: null,
      mergedHead: null,
    },
  });
  return true;
}

// the first target named on a standing mark that Forge did not observe is the branch the work
// landed on; a later mark with another target does not move it, as a later stamp does not move
// merged_at. A row holding an observed commit holds the target that observation read
// (`recordIssueMerge`), and a mark's word never stands in for it (catalog-fe ISS-11..19, 2026-10-26:
// `release/stg` written by a mark beside merges GitLab made into `dev`).
export async function recordMergeTarget(
  executor: MergeRecordExecutor,
  issueId: string,
  target: string,
): Promise<void> {
  await executor
    .update(issues)
    .set({ mergedTarget: target })
    .where(
      and(
        eq(issues.id, issueId),
        isNotNull(issues.mergedAt),
        isNull(issues.mergedTarget),
        sql`coalesce(trim(${issues.mergedCommitSha}), '') = ''`,
      ),
    );
}

/**
 * The latest merge the host reports of a change request linking the issue, into `base` where named,
 * with the branch it merged into: an issue delivered across several requests lands at the last.
 */
export async function observedMergeForIssue(
  executor: MergeRecordExecutor,
  issueId: string,
  base?: string,
): Promise<{ commitSha: string; mergedAt: Date; target: string } | null> {
  const [row] = await executor
    .select({
      sha: repoPullRequests.mergeCommitSha,
      at: repoPullRequests.mergedAt,
      base: repoPullRequests.baseRef,
    })
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
    .orderBy(desc(repoPullRequests.mergedAt))
    .limit(1);
  if (!row?.sha || !row.at) return null;
  return { commitSha: row.sha, mergedAt: row.at, target: row.base };
}
