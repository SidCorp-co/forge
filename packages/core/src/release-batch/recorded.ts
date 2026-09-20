// A release that already happened, written down from its evidence.
//
// `createReleaseBatch` is the normal path and stays the normal path. It was
// also the ONLY path: `viaReleasePath: true` is what passes the agent close
// gate in `issues/release-gate-hold.ts`, and every writer of it lived behind
// batch creation. So a runner label nobody declared, a box that was offline and
// a batch already in flight were each, silently, a reason a release that had
// shipped could not be recorded (ISS-1129).
//
// The gate here is evidence and not machinery: the application answers, every
// probe agrees on one commit, and that commit is the one the caller claims. No
// runner, no label, no job. What this does NOT establish is per-issue ancestry
// — that each named issue's merge is in the commit that is live — because
// seeing that needs a git provider, and requiring one would put the coupling
// straight back. `merged_at` is required instead, the per-issue merge evidence
// is persisted beside the live identity, and the residual is priced on ISS-1129
// rather than implied here.

import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { comments, type IssueStatus, issues, pipelineRuns } from '../db/schema.js';
import { releaseAttempts } from '../db/schema-release-ledger.js';
import { TransitionError, transitionIssueStatus } from '../issues/apply-transition.js';
import { issuesMissingReleaseRecord } from '../issues/release-record-required.js';
import { logger } from '../logger.js';
import { closeRunIfOneShot, openOneShotRun } from '../pipeline/runs.js';
import { resolveReleaseChannels } from './channel.js';
import {
  ClaimConflictError,
  NoReleaseGateError,
  ReleaseMultiChannelUnsupportedError,
  ReleaseNotVerifiedError,
  ReleaseProbesUndeclaredError,
  ReleaseRecordMissingError,
  ReleaseWorkUnmergedError,
} from './errors.js';
import { resolveReleaseGate } from './gate.js';
import { type ServingNowOutcome, verifyServingNow } from './verify.js';

/** What `metadata.source` reads on the run a recorded release writes. */
export const RELEASE_RECORD_SOURCE = 'release-record';

/** The one ledger key a recorded release writes under. */
const RECORD_ATTEMPT_KEY = 'release-record';

export interface RecordPerformedReleaseArgs {
  projectId: string;
  issueIds: string[];
  /** The commit the caller says production is serving. */
  commit: string;
  /** How the release was performed, and why it was not a batch. */
  account: string;
  /** The provider's own handle on the act — a deployment uuid, a tag. Never the evidence. */
  providerRef?: string | undefined;
  userId: string;
}

/** One issue as the record found it, so the claim stays checkable afterwards. */
export interface RecordedIssue {
  id: string;
  mergedAt: string | null;
  mergedCommitSha: string | null;
}

export interface RecordPerformedReleaseResult {
  runId: string;
  /** What the caller claimed, normalized by nothing. */
  commit: string;
  /** What every probe agreed the deployment is serving. */
  identity: string;
  readings: string[];
  closed: string[];
  failed: Array<{ id: string; reason: string }>;
  issues: RecordedIssue[];
}

/**
 * The one verification config this project's live channel declares.
 *
 * THROWS `ReleaseProbesUndeclaredError` where nothing could be read, and
 * `ReleaseMultiChannelUnsupportedError` where one reading would have to answer
 * for two endpoints — the same two refusals, by the same names, that a batch
 * meets at the same point.
 */
async function soleVerifyConfig(projectId: string) {
  const channels = await resolveReleaseChannels(projectId);
  if (channels.length > 1) throw new ReleaseMultiChannelUnsupportedError(channels.length);
  const verify = channels[0]?.verify ?? null;
  if (!verify) throw new ReleaseProbesUndeclaredError();
  return verify;
}

/**
 * Every issue this record may close, read once and refused by name.
 *
 * The order is what a caller should learn first: an issue that is not at the
 * gate is a different mistake from one that has shipped nothing written about
 * it, and both are different from work nobody merged.
 */
async function admissibleIssues(
  projectId: string,
  issueIds: string[],
  gateStatus: IssueStatus,
): Promise<RecordedIssue[]> {
  const rows = await db
    .select({
      id: issues.id,
      status: issues.status,
      releaseBatchRunId: issues.releaseBatchRunId,
      mergedAt: issues.mergedAt,
      mergedCommitSha: issues.mergedCommitSha,
    })
    .from(issues)
    .where(and(eq(issues.projectId, projectId), inArray(issues.id, issueIds)));

  const found = new Set(rows.map((r) => r.id));
  const notFound = issueIds.filter((id) => !found.has(id));
  if (notFound.length > 0) throw new ClaimConflictError(notFound);

  const notClaimable = rows.filter((r) => r.status !== gateStatus || r.releaseBatchRunId !== null);
  if (notClaimable.length > 0) throw new ClaimConflictError(notClaimable.map((r) => r.id));

  const unrecorded = await issuesMissingReleaseRecord(issueIds);
  if (unrecorded.length > 0) throw new ReleaseRecordMissingError(unrecorded);

  const unmerged = rows.filter((r) => r.mergedAt === null).map((r) => r.id);
  if (unmerged.length > 0) throw new ReleaseWorkUnmergedError(unmerged);

  return rows.map((r) => ({
    id: r.id,
    mergedAt: r.mergedAt ? r.mergedAt.toISOString() : null,
    mergedCommitSha: r.mergedCommitSha,
  }));
}

/** The account, as the issue itself will carry it. */
function issueNote(args: {
  commit: string;
  identity: string;
  account: string;
  providerRef: string | null;
}): string {
  const handle = args.providerRef ? ` The provider's handle on it: \`${args.providerRef}\`.` : '';
  return (
    `Released outside a release batch, and recorded from what production is serving.\n\n` +
    `- commit claimed: \`${args.commit}\`\n` +
    `- deployment identity read back from the live probes: \`${args.identity}\`\n\n` +
    `${args.account}${handle}`
  );
}

/**
 * Record a release that has already happened, and close what it carried.
 *
 * The probes are read BEFORE anything is claimed, so a record that cannot be
 * earned leaves every issue exactly where it stood.
 */
export async function recordPerformedRelease(
  args: RecordPerformedReleaseArgs,
): Promise<RecordPerformedReleaseResult> {
  const { projectId, issueIds, commit, account, userId } = args;
  const providerRef = args.providerRef ?? null;

  const gateStatus = await resolveReleaseGate(projectId);
  if (!gateStatus) throw new NoReleaseGateError();

  const verify = await soleVerifyConfig(projectId);
  const roster = await admissibleIssues(projectId, issueIds, gateStatus);

  const outcome = await verifyServingNow({ cfg: verify, expected: commit });
  if (!outcome.ok) throw new ReleaseNotVerifiedError(outcome.reason, outcome.live);

  const run = await openOneShotRun({
    projectId,
    kind: 'system',
    metadata: {
      source: RELEASE_RECORD_SOURCE,
      gateStatus,
      issueIds,
      commit,
      identity: outcome.identity,
      providerRef,
      recordedBy: userId,
      issues: roster,
    },
  });

  const claimed = await db.execute<{ id: string }>(sql`
    UPDATE issues
    SET release_batch_run_id = ${run.id}, updated_at = now()
    WHERE project_id = ${projectId}
      AND id IN (${sql.join(
        issueIds.map((id) => sql`${id}`),
        sql`, `,
      )})
      AND status = ${gateStatus}
      AND release_batch_run_id IS NULL
    RETURNING id
  `);

  if (claimed.length !== issueIds.length) {
    await closeRunIfOneShot(run.id, 'cancelled');
    throw new ClaimConflictError(issueIds.filter((id) => !claimed.some((r) => r.id === id)));
  }

  await writeLedger(run.id, { commit, outcome, account, providerRef });

  const note = issueNote({ commit, identity: outcome.identity, account, providerRef });
  const closed: string[] = [];
  const failed: Array<{ id: string; reason: string }> = [];

  for (const issue of roster) {
    try {
      await db.insert(comments).values({ issueId: issue.id, authorId: userId, body: note });
    } catch (err) {
      logger.warn({ err, issueId: issue.id, runId: run.id }, 'release-record: comment failed');
    }
    try {
      await transitionIssueStatus(
        { id: issue.id, projectId, status: gateStatus, reopenCount: 0 },
        'closed',
        { type: 'user', id: userId },
        { viaReleasePath: true, reason: account },
      );
      closed.push(issue.id);
    } catch (err) {
      if (err instanceof TransitionError && err.code === 'NO_OP') {
        closed.push(issue.id);
      } else {
        logger.warn({ err, issueId: issue.id, runId: run.id }, 'release-record: could not close');
        failed.push({ id: issue.id, reason: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  // The claim column is the LOCK this write holds, never the index onto what
  // the record carried — `metadata.issues` is that, and it survives. Leaving a
  // claim behind on an issue that could not close would wedge it out of every
  // future batch, which claims only where the column is null. `finishReleaseBatch`
  // clears it the same way and for the same reason.
  await db.execute(sql`
    UPDATE issues SET release_batch_run_id = NULL, updated_at = now()
    WHERE release_batch_run_id = ${run.id}
  `);

  await closeRunIfOneShot(run.id, failed.length > 0 ? 'failed' : 'completed');

  return {
    runId: run.id,
    commit,
    identity: outcome.identity,
    readings: outcome.readings,
    closed,
    failed,
    issues: roster,
  };
}

/** The ledger row: the intent, the account, and what the probes said, in that order. */
async function writeLedger(
  runId: string,
  args: {
    commit: string;
    outcome: Extract<ServingNowOutcome, { ok: true }>;
    account: string;
    providerRef: string | null;
  },
): Promise<void> {
  await db.insert(releaseAttempts).values({
    runId,
    stage: 'verify',
    idempotencyKey: RECORD_ATTEMPT_KEY,
    commit: args.commit,
    providerRef: args.providerRef,
    account: args.account,
    health: 'up',
    identity: args.outcome.identity,
    readings: args.outcome.readings,
    verdict: 'ok',
    verdictReason: `every probe agrees the deployment is serving ${args.outcome.identity}, which is the commit this record claims`,
    settledAt: new Date(),
  });
}

export interface ReleaseRecordView {
  runId: string;
  projectId: string;
  recordedAt: string | null;
  commit: string | null;
  identity: string | null;
  providerRef: string | null;
  account: string | null;
  readings: string[];
  issues: RecordedIssue[];
}

/**
 * One recorded release, read back.
 *
 * `null` for a run this project does not own, and for a batch run — a batch is
 * read through its own endpoints, and answering for one here would make
 * "how was this released" unanswerable from the reply.
 */
export async function readReleaseRecord(
  projectId: string,
  runId: string,
): Promise<ReleaseRecordView | null> {
  const [run] = await db
    .select({
      id: pipelineRuns.id,
      projectId: pipelineRuns.projectId,
      startedAt: pipelineRuns.startedAt,
      metadata: pipelineRuns.metadata,
    })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, runId))
    .limit(1);
  if (!run || run.projectId !== projectId) return null;

  const meta = (run.metadata ?? {}) as Record<string, unknown>;
  if (meta.source !== RELEASE_RECORD_SOURCE) return null;

  const [attempt] = await db
    .select({
      account: releaseAttempts.account,
      identity: releaseAttempts.identity,
      readings: releaseAttempts.readings,
      providerRef: releaseAttempts.providerRef,
    })
    .from(releaseAttempts)
    .where(
      and(eq(releaseAttempts.runId, runId), eq(releaseAttempts.idempotencyKey, RECORD_ATTEMPT_KEY)),
    )
    .limit(1);

  return {
    runId: run.id,
    projectId: run.projectId,
    recordedAt: run.startedAt ? run.startedAt.toISOString() : null,
    commit: typeof meta.commit === 'string' ? meta.commit : null,
    identity: attempt?.identity ?? (typeof meta.identity === 'string' ? meta.identity : null),
    providerRef: attempt?.providerRef ?? null,
    account: attempt?.account ?? null,
    readings: attempt?.readings ?? [],
    issues: Array.isArray(meta.issues) ? (meta.issues as RecordedIssue[]) : [],
  };
}
