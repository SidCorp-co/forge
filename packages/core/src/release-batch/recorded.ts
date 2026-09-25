// A release that already happened, written down from its evidence.
//
// `createReleaseBatch` is the normal path and stays it. This one is gated on
// evidence rather than machinery — the application answers, every probe agrees
// on one commit, and that commit is the one the caller claims — so no runner,
// label or job is needed to record a release that shipped (ISS-1129).
//
// It does NOT establish per-issue ancestry: that needs a git provider, and
// requiring one would put the coupling straight back. `merged_at` is required
// instead, and the residual is priced on ISS-1129.

import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { comments, issues, pipelineRuns } from '../db/schema.js';
import { releaseAttempts } from '../db/schema-release-ledger.js';
import { TransitionError, transitionIssueStatus } from '../issues/apply-transition.js';
import { logger } from '../logger.js';
import { closeRunIfOneShot, openOneShotRun } from '../pipeline/runs.js';
import { collectReleaseBlockers, releaseBlockerError } from './blockers.js';
import type { ReleaseChannel } from './channel.js';
import { claimConflictAt, RELEASE_RECORD_SOURCE } from './claim-conflicts.js';
import {
  NoReleaseGateError,
  ReleaseNotVerifiedError,
  ReleaseProbesUndeclaredError,
} from './errors.js';
import { RELEASE_GATE_STATUS } from './gate.js';
import { type ServingNowOutcome, verifyServingNow } from './verify.js';

/** The one ledger key a recorded release writes under. */
const RECORD_ATTEMPT_KEY = 'release-record';

export interface RecordPerformedReleaseArgs {
  projectId: string;
  issueIds: string[];
  /** The whole sha the caller says production is serving. */
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

/** The one verification config, taken from the report rather than read again:
 *  a second read would refuse in its own order (ISS-1127). */
function soleVerifyConfig(channels: ReleaseChannel[] | null) {
  const verify = channels?.[0]?.verify ?? null;
  if (!verify) throw new ReleaseProbesUndeclaredError();
  return verify;
}

/** Every issue this record may close, read once and refused by name. */
async function admissibleIssues(projectId: string, issueIds: string[]): Promise<RecordedIssue[]> {
  const rows = await db
    .select({ id: issues.id, mergedAt: issues.mergedAt, mergedCommitSha: issues.mergedCommitSha })
    .from(issues)
    .where(and(eq(issues.projectId, projectId), inArray(issues.id, issueIds)));

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
 * Record a release that has already happened, and close what it carried. The
 * probes are read BEFORE anything is claimed, so a record that cannot be earned
 * leaves every issue where it stood.
 */
export async function recordPerformedRelease(
  args: RecordPerformedReleaseArgs,
): Promise<RecordPerformedReleaseResult> {
  const { projectId, issueIds, commit, account, userId } = args;
  const providerRef = args.providerRef ?? null;

  // ONE pass before anything refuses, so probes, notes and merges arrive together (ISS-1127).
  const report = await collectReleaseBlockers(projectId, { issueIds, door: 'record' });
  if (!report.projectExists) throw new NoReleaseGateError();
  const refusal = releaseBlockerError(report);
  if (refusal) throw refusal;

  const gateStatus = RELEASE_GATE_STATUS;
  const verify = soleVerifyConfig(report.channels);
  const roster = await admissibleIssues(projectId, issueIds);

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
    throw await claimConflictAt(projectId, gateStatus, issueIds, claimed);
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
