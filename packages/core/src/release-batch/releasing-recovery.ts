import { and, eq, sql } from 'drizzle-orm';
import { postIssueNotice } from '../comments/index.js';
import { db, type Tx } from '../db/client.js';
import { type IssueStatus, issues, projects } from '../db/schema.js';
import { releaseAttempts } from '../db/schema-release-ledger.js';
import type { TransitionActor } from '../issues/index.js';
import {
  accountActor,
  readWorkState,
  releaseRunClaims,
  setWorkStep,
  transitionIssueStatus,
} from '../issues/index.js';
import { logger } from '../lib/logger.js';
import { isRefusal } from '../lib/refusal.js';
import { writeRunMetadata } from '../pipeline/index.js';
import { resolveReleaseGate } from './gate.js';
import { FENCE_LOST } from './refuse.js';

export interface RecoverStrandedReleasingResult {
  /** Issues whose claim was cleared, closed ones included: the claim is a lock, not a status. */
  claimsCleared: string[];
  /** Claimed issues already `closed` when the roster was read: a finish closed them, and they stay. */
  alreadyClosed: string[];
  /** Issues a release still held at its `release` step (the old `releasing`), taken off it. */
  recovered: string[];
  /** Where the recovered issues went, or `null` when nothing moved. */
  destination: IssueStatus | null;
  /** True when the run recorded a promotion. On its own it does not say the roster stayed put:
   *  `settlePromotedRoster` settles one anyway, and `destination` is what moved. */
  promoted: boolean;
}

/**
 * Did this run put anything on production?
 *
 * A production `deploy` attempt EXISTS is the question, not whether it succeeded:
 * an act that was declared and never reported back is exactly the one that may have
 * landed, and reading an unsettled promotion as "nothing happened" is how a
 * roster gets walked back over code that is serving.
 */
export async function runRecordedPromotion(runId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: releaseAttempts.id })
    .from(releaseAttempts)
    .where(and(eq(releaseAttempts.runId, runId), eq(releaseAttempts.stage, 'deploy')))
    .limit(1);
  return row !== undefined;
}

/** The issues still claimed by `runId` that are `closed`: what its finish closed and nothing moved. */
export async function closedOnRoster(runId: string, executor: Tx = db): Promise<string[]> {
  const rows = await executor
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.releaseBatchRunId, runId), eq(issues.status, 'closed')));
  return rows.map((r) => r.id);
}

/** A release holds it mid-release: at the gate, its run at the `release` step (ISS-54). */
function heldMidRelease(issue: { status: string; step?: string | null }): boolean {
  return issue.status === 'awaiting_release' && issue.step === 'release';
}

interface RecoverStrandedReleasingOptions {
  /** Written onto the issue as the reason, and into a comment when an author is known. */
  reason: string;
  /** The person who caused this, when there is one. Absent for a machine sweep. */
  actorUserId?: string | undefined;
  /** Post a comment naming the reason. Off for a sweep nobody asked for. */
  comment?: boolean;
  /** Settle a roster whose run promoted instead of holding it — a person's word and never a
   *  sweep's, buying a batch that promoted and cannot verify a status some door closes from
   *  (ISS-1199). */
  settlePromotedRoster?: boolean;
  /** Run inside each write's own transaction before it writes; throws to stop the recovery. */
  fence?: ((tx: Tx) => Promise<void>) | undefined;
}

type ClaimedRow = {
  id: string;
  projectId: string;
  status: IssueStatus;
  reopenCount: number;
  projectCreatedBy: string | null;
  step: string | null;
};

/** One issue off its release step: told why, then moved to `destination` unless it stands there. */
async function recoverOne(
  issue: ClaimedRow,
  ctx: {
    runId: string;
    options: RecoverStrandedReleasingOptions;
    promoted: boolean;
    destination: IssueStatus;
  },
): Promise<boolean> {
  const { runId, options, promoted, destination } = ctx;
  if (options.comment && options.actorUserId) {
    try {
      await postIssueNotice({
        issueId: issue.id,
        authorId: options.actorUserId,
        body: promoted
          ? `${options.reason}. ${settledNote(issue.projectId, destination)}`
          : `${options.reason}. The issue is at \`${destination}\` — a person decides whether it goes back to work or into another batch.`,
      });
    } catch (err) {
      logger.warn({ err, issueId: issue.id, runId }, 'release-batch: recovery comment failed');
    }
  }

  // Back at the gate is where it already stands: releasing the claim and the step is the move.
  if (destination === issue.status) return true;

  const fallbackId = issue.projectCreatedBy ?? issue.projectId;
  const actor: TransitionActor = options.actorUserId
    ? await accountActor(options.actorUserId)
    : { type: 'device', id: fallbackId, ownerId: fallbackId };

  try {
    await transitionIssueStatus(
      {
        id: issue.id,
        projectId: issue.projectId,
        status: issue.status,
        reopenCount: issue.reopenCount,
      },
      destination,
      actor,
      {
        transitionReason: options.reason,
        ...(options.fence ? { beforeStatusWrite: options.fence } : {}),
      },
    );
    return true;
  } catch (err) {
    if (isRefusal(err, FENCE_LOST)) throw err;
    if (!isRefusal(err, 'NO_OP')) {
      logger.warn(
        { err, issueId: issue.id, runId },
        'release-batch: could not recover a stranded releasing issue',
      );
    }
  }
  return false;
}

/**
 * Release every claim on `runId` and rescue whatever it left mid-release.
 *
 * Ordered recover-then-clear: the claim column is the only index onto the
 * batch's issues, so clearing first leaves nothing to read them back by.
 */
export async function recoverStrandedReleasing(
  runId: string,
  options: RecoverStrandedReleasingOptions,
): Promise<RecoverStrandedReleasingResult> {
  const claimed = await db
    .select({
      id: issues.id,
      projectId: issues.projectId,
      status: issues.status,
      reopenCount: issues.reopenCount,
      projectCreatedBy: projects.createdBy,
      step: sql<
        string | null
      >`(SELECT w.step FROM issue_work_state w WHERE w.issue_id = ${issues.id})`,
    })
    .from(issues)
    .innerJoin(projects, eq(projects.id, issues.projectId))
    .where(eq(issues.releaseBatchRunId, runId));

  const alreadyClosed = claimed.filter((r) => r.status === 'closed').map((r) => r.id);
  const promoted = await runRecordedPromotion(runId);
  if (promoted && options.settlePromotedRoster !== true) {
    logger.warn(
      { runId, claimed: claimed.length, reason: options.reason },
      'release-batch: this run promoted, so its roster stays held at its release step for a person to settle',
    );
    await noteOnRoster(claimed, options, promotedNote(runId));
    return {
      claimsCleared: [],
      alreadyClosed,
      recovered: [],
      destination: null,
      promoted: true,
    };
  }

  const gateStatus = claimed[0] ? await resolveReleaseGate(claimed[0].projectId) : null;
  const destination: IssueStatus = gateStatus ?? 'reopen';

  const recovered: string[] = [];

  for (const issue of claimed) {
    if (!heldMidRelease(issue)) continue;
    if (await recoverOne(issue, { runId, options, promoted, destination }))
      recovered.push(issue.id);
  }

  const { fence } = options;
  const released = await db.transaction(async (tx) => {
    if (fence) await fence(tx);
    return releaseClaims(tx, runId);
  });

  if (recovered.length > 0) {
    logger.warn(
      { runId, recovered: recovered.length, reason: options.reason },
      'release-batch: issues rescued from their release step by a batch that wrote no outcome',
    );
  }

  // `promoted` and not `false`: a settled roster still came off a run that put
  // code on production, and this is the one fact the path exists to keep true.
  return {
    claimsCleared: released.cleared,
    alreadyClosed: released.closed,
    recovered,
    destination: recovered.length > 0 ? destination : null,
    promoted,
  };
}

/** Release every claim on `runId`, and in the same transaction add the closed ones to the run's
 *  `metadata.rosterClosed`: without the claim, that is the only record this batch closed them. */
async function releaseClaims(
  tx: Tx,
  runId: string,
): Promise<{ cleared: string[]; closed: string[] }> {
  const rows = await releaseRunClaims(runId, tx);
  // The claim held the release step; without the claim nothing is releasing it.
  for (const row of rows) {
    const work = await readWorkState(tx, row.id);
    if (work?.step === 'release') await setWorkStep(tx, row.id, null);
  }
  const closed = rows.filter((r) => r.status === 'closed').map((r) => r.id);
  if (closed.length > 0) {
    await writeRunMetadata(
      runId,
      {
        value: sql`jsonb_set(coalesce(metadata, '{}'::jsonb), '{rosterClosed}', (
          SELECT jsonb_agg(DISTINCT id) FROM jsonb_array_elements_text(
            coalesce(metadata -> 'rosterClosed', '[]'::jsonb) || ${JSON.stringify(closed)}::jsonb
          ) AS t(id)))`,
        touch: true,
      },
      tx,
    );
  }
  return { cleared: rows.map((r) => r.id), closed };
}

/** What a roster is told when an operator settles it although this run promoted. */
function settledNote(projectId: string, destination: IssueStatus): string {
  return (
    `This batch recorded a promotion, so the code it carried may be on production, and an operator ` +
    `settled the roster rather than leave it held at its release step — the issue is back at ` +
    `\`${destination}\`. If the release did land, record it with ` +
    `POST /api/projects/${projectId}/release-records, naming the commit production is serving and ` +
    `how it was released; that closes it against evidence instead of by hand.`
  );
}

function promotedNote(runId: string): (projectId: string) => string {
  return (projectId) =>
    `This batch recorded a promotion, so its issues stay held at \`awaiting_release\` at their release step and stay claimed: the code may be on production, and no other status here would be safe to claim. Read the run with \`GET /api/projects/${projectId}/release-batches/${runId}/state\`. To settle the issues, abort the batch with POST /api/projects/${projectId}/release-batches/${runId}/abort and a body of {"promotedRoster":"return-to-gate"}, which puts them back at the release gate, and then, if the release did land, record it with POST /api/projects/${projectId}/release-records; or settle each issue by hand.`;
}

/**
 * Say on each issue what happened, without moving it.
 */
async function noteOnRoster(
  claimed: Array<{ id: string; status: string; projectId: string; step: string | null }>,
  options: RecoverStrandedReleasingOptions,
  note: (projectId: string) => string,
): Promise<void> {
  if (!options.comment || !options.actorUserId) return;
  for (const issue of claimed) {
    if (!heldMidRelease(issue)) continue;
    try {
      await postIssueNotice({
        issueId: issue.id,
        authorId: options.actorUserId,
        body: `${options.reason}. ${note(issue.projectId)}`,
      });
    } catch (err) {
      logger.warn({ err, issueId: issue.id }, 'release-batch: promotion note failed');
    }
  }
}
