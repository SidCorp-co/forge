import { and, eq, sql } from 'drizzle-orm';
import { postIssueNotice } from '../comments/index.js';
import { db, type Tx } from '../db/client.js';
import { type IssueStatus, issues, pipelineRuns, projects } from '../db/schema.js';
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
   *  `settlePromotedRoster` settles one anyway, a shipped run holds nothing, and `destination` is
   *  what moved. */
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

/**
 * Did this run record its ship? A finish stamps it once production is verified serving the release
 * (`stampReleaseShipped`), so what is on production is known, and nothing is left for a person to
 * settle by holding the roster.
 */
async function runRecordedShip(runId: string): Promise<boolean> {
  const [row] = await db
    .select({ at: pipelineRuns.releaseReleasedAt })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, runId))
    .limit(1);
  return row?.at != null;
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
  /** The release verified production serving but wrote no ship stamp, because its finish closed
   *  none of its roster (ISS-811): what production serves is known, so the roster is let go like a
   *  shipped release's, and each issue is told it was not closed rather than that it shipped. */
  verifiedLive?: boolean;
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
    shipped: boolean;
    destination: IssueStatus;
  },
): Promise<boolean> {
  const { runId, options, promoted, shipped, destination } = ctx;
  if (options.comment && options.actorUserId) {
    try {
      await postIssueNotice({
        issueId: issue.id,
        authorId: options.actorUserId,
        body: shipped
          ? `${options.reason}. ${shippedNote(issue.projectId, runId, destination)}`
          : promoted
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
 * A run that promoted holds its roster at the release step for a person, unless it also recorded
 * its ship: then what production serves is known, and an issue the finish could not close goes
 * back to the gate unclaimed, so the next release can carry it. A closed issue of a shipped run
 * keeps its claim, the record of the release that carried it, until the sweep lets it go.
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
  const shipped = promoted && (await runRecordedShip(runId));
  const known = shipped || options.verifiedLive === true;
  if (promoted && !known && options.settlePromotedRoster !== true) {
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
    if (await recoverOne(issue, { runId, options, promoted, shipped: known, destination }))
      recovered.push(issue.id);
  }

  const { fence } = options;
  const open = known ? claimed.filter((r) => r.status !== 'closed').map((r) => r.id) : undefined;
  const released = await db.transaction(async (tx) => {
    if (fence) await fence(tx);
    return releaseClaims(tx, runId, open);
  });

  if (recovered.length > 0) {
    logger.warn(
      { runId, recovered: recovered.length, shipped: known, reason: options.reason },
      known
        ? 'release-batch: issues a shipped release could not close, let go of their release step'
        : 'release-batch: issues rescued from their release step by a batch that wrote no outcome',
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

/** Release every claim on `runId` (or only those on `only`), and in the same transaction add the
 *  closed ones to the run's `metadata.rosterClosed`: without the claim, that is the only record this
 *  batch closed them. */
export async function releaseClaims(
  tx: Tx,
  runId: string,
  only?: readonly string[],
): Promise<{ cleared: string[]; closed: string[] }> {
  const rows = await releaseRunClaims(runId, tx, only);
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

/** What an issue a release could not close is told: its claim is let go, and where the reason is. */
function shippedNote(projectId: string, runId: string, destination: IssueStatus): string {
  return (
    `This issue did not close with the release: it is at \`${destination}\` with its claim ` +
    `released, and no automatic release carries it until the hold on it is cleared. Why it did ` +
    `not close is on the release's finish: GET /api/projects/${projectId}/release-batches/${runId}/state.`
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
