// Refuse to replay a step the issue already walked out of via a bounce state,
// when nothing has changed since.
//
// ISS-158 (pixelight): clarify and the first code attempt both concluded the
// project lacked a capability and set `waiting`. A later run picked the issue
// back up at `approved` with nothing recorded in between, so the second code
// attempt could only re-derive the identical blocked conclusion.
//
// `waiting`/`on_hold` release stays deliberately generous: ANY comment or
// activity after the bounce counts as new input. `needs_info` is different
// (ISS-820): its premise is "a human must answer a question", so an agent's own
// comment must not release its own bounce (that let a fabricated "the owner
// decided" note override a real human answer) — release needs a HUMAN comment
// (isAi=false AND authorDeviceId IS NULL), with no activity fallback.
// `reopenEnteredFromNeedsInfo` (ISS-819) obeys that same human-only rule.
//
// A CAPACITY park is exempt from needing an answer at all: it never reached a
// conclusion to replay (park-reasons.ts), so the fleet recovering releases it.

import { and, desc, eq, gt, isNull, lt, ne, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type IssueStatus, activityLog, comments, pipelineRuns } from '../db/schema.js';
import { logger } from '../logger.js';
import { onlineCapableDeviceIds } from '../runners/select.js';
import { isCapacityParkReason } from './park-reasons.js';
import { PARKED_STATUSES } from './park-states.js';
import { WORKING_STATUS_BY_STATUS } from './registry.js';

/** Statuses that mean "a human must act before this issue can progress". */
// cm:why derived, not re-listed: a bounce is "a human must act before this can progress", so every park is one by definition — written as a second literal, a park added to park-states.ts would leave this guard blind to it
export const BOUNCE_STATUSES = [...PARKED_STATUSES, 'needs_info'] as const;
export type BounceStatus = (typeof BOUNCE_STATUSES)[number];

function isBounce(status: string): status is BounceStatus {
  return (BOUNCE_STATUSES as readonly string[]).includes(status);
}

export interface BounceReplay {
  /** The bounce the issue previously landed on when leaving this stage. */
  bounced: BounceStatus;
  /** When that bounce happened. */
  at: Date;
}

/**
 * Did the issue leave `stage` for a bounce state, with no new input since?
 * Returns the bounce to route back to, or null to dispatch normally.
 */
export async function findUnansweredBounce(
  issueId: string,
  stage: IssueStatus,
): Promise<BounceReplay | null> {
  try {
    // cm:why the most recent departure from THIS stage only — an older bounce from a different stage says nothing about whether this one can succeed now
    let row = await lastDepartureFrom(issueId, stage);
    if (!row) return null;
    let to = departureTarget(row);

    // cm:guard code/fix flip the issue to `in_progress` at forge_step_start, so the departure FROM the trigger status is ALWAYS the in-flight hop, never the bounce — without following that hop the guard silently never fires for the two most expensive stages (ISS-85 sid-desk looped 7 times past a guard that could not see the bounce)
    const inFlight = WORKING_STATUS_BY_STATUS[stage];
    if (inFlight && to === inFlight) {
      const hop = await lastDepartureFrom(issueId, inFlight, row.createdAt);
      if (!hop) return null;
      row = hop;
      to = departureTarget(hop);
    }

    if (!to || !isBounce(to)) return null;

    const answered =
      to === 'needs_info'
        ? await hasHumanAnswerSince(issueId, row.createdAt)
        : await hasAnyInputSince(issueId, row.createdAt);
    if (answered) return null;
    // cm:guard `waiting` ONLY — finalize-failure is the sole writer of a capacity park, and it only ever parks at `waiting`. Without this narrowing, a parkReason left on the latest run by an EARLIER capacity park would release a LATER `needs_info` bounce, breaking ISS-820's human-answer rule (and `on_hold`, a deliberate user pause).
    if (to === 'waiting' && (await capacityParkCleared(issueId))) {
      logger.info(
        { issueId, stage, bounced: to },
        'bounce-guard: capacity park and the fleet recovered, allowing dispatch',
      );
      return null;
    }
    return { bounced: to, at: row.createdAt };
  } catch (err) {
    // cm:guard fail OPEN — a broken guard must let the pipeline run, never silently freeze every dispatch
    logger.warn({ err, issueId, stage }, 'bounce-guard: check failed, allowing dispatch');
    return null;
  }
}

/**
 * Did this `reopen` arrive directly from `needs_info` with the question still
 * unanswered (ISS-819 requirement 5)? A fix cannot be scoped from an unanswered
 * question. Only a HUMAN comment since the `needs_info` entry releases it — the
 * same rule `findUnansweredBounce` applies to that status, so an agent's own
 * note (including this guard's own comment) can never count as the answer.
 */
// cm:guard fail OPEN — a broken guard must let the pipeline run, never silently freeze every dispatch
export async function reopenEnteredFromNeedsInfo(issueId: string): Promise<boolean> {
  try {
    const [entered] = await db
      .select({ payload: activityLog.payload, createdAt: activityLog.createdAt })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.issueId, issueId),
          eq(activityLog.action, 'issue.statusChanged'),
          sql`${activityLog.payload}->>'to' = 'reopen'`,
        ),
      )
      .orderBy(desc(activityLog.createdAt))
      .limit(1);
    if (!entered) return false;
    if ((entered.payload as { from?: string } | null)?.from !== 'needs_info') return false;

    const [needsInfoEntry] = await db
      .select({ createdAt: activityLog.createdAt })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.issueId, issueId),
          eq(activityLog.action, 'issue.statusChanged'),
          sql`${activityLog.payload}->>'to' = 'needs_info'`,
          lt(activityLog.createdAt, entered.createdAt),
        ),
      )
      .orderBy(desc(activityLog.createdAt))
      .limit(1);
    const since = needsInfoEntry?.createdAt ?? entered.createdAt;
    if (await hasHumanAnswerSince(issueId, since)) return false;
    return true;
  } catch (err) {
    logger.warn(
      { err, issueId },
      'bounce-replay-guard: reopen-entered-from-needs_info check failed, allowing dispatch',
    );
    return false;
  }
}

/**
 * Was this park a capacity park whose blocking condition has since cleared?
 * A step cut off by provider quota reached no conclusion, so there is nothing
 * to replay — the useful move is to run it, and only the fleet can say whether
 * that is possible yet.
 */
// cm:edge contract -> packages/core/src/jobs/finalize-failure.ts — `recordParkReason` writes the key this reads; anchoring on the LATEST issue-run is only sound because each park writes its own reason and then closes its own run
// cm:guard fail CLOSED here, unlike the callers' fail-open: an error must leave the existing refusal standing, never invent a release the fleet has not earned
async function capacityParkCleared(issueId: string): Promise<boolean> {
  try {
    const [run] = await db
      .select({
        projectId: pipelineRuns.projectId,
        parkReason: sql<string | null>`(${pipelineRuns.metadata}->>'parkReason')`,
      })
      .from(pipelineRuns)
      .where(and(eq(pipelineRuns.issueId, issueId), eq(pipelineRuns.kind, 'issue')))
      .orderBy(desc(pipelineRuns.startedAt))
      .limit(1);
    if (!run || !isCapacityParkReason(run.parkReason)) return false;

    // cm:why checked WITHOUT the parked job's requiredCapabilities — those live on a job payload this guard does not load, so it asks the weaker "is ANY box healthy" question. Over-allowing is the safe direction: dispatch re-checks capability, and an all-limited fleet now defers to the rotation instead of re-parking (retry.ts).
    const healthy = await onlineCapableDeviceIds(run.projectId);
    return healthy.length > 0;
  } catch (err) {
    logger.warn({ err, issueId }, 'bounce-guard: capacity-park check failed, keeping the bounce');
    return false;
  }
}

type Departure = { payload: unknown; createdAt: Date };

const departureTarget = (row: Departure): string | undefined =>
  (row.payload as { to?: string } | null)?.to;

/** Most recent status departure FROM `status`, optionally constrained to after `after`. */
async function lastDepartureFrom(
  issueId: string,
  status: string,
  after?: Date,
): Promise<Departure | undefined> {
  const [row] = await db
    .select({ payload: activityLog.payload, createdAt: activityLog.createdAt })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.issueId, issueId),
        eq(activityLog.action, 'issue.statusChanged'),
        sql`${activityLog.payload}->>'from' = ${status}`,
        ...(after ? [gt(activityLog.createdAt, after)] : []),
      ),
    )
    .orderBy(desc(activityLog.createdAt))
    .limit(1);
  return row;
}

// cm:why used by waiting/on_hold only — a comment OR any activity counts, since the guard's job there is to catch true silence: anything a human or another step recorded since the bounce releases it
// cm:guard ISS-820's rule extended to the parks: a SYSTEM comment (isAi) must not release the bounce it is explaining. postSkippedParkExitComment fires from the post-commit transition hook, i.e. AFTER the departure this window is anchored on, so counting it would let the park-exit explanation hand the issue straight back to the reconciler. Environment signals a step records still release the park through the activity leg below — this only excludes the machine narrating itself.
async function hasAnyInputSince(issueId: string, since: Date): Promise<boolean> {
  const [newComment] = await db
    .select({ id: comments.id })
    .from(comments)
    .where(
      and(eq(comments.issueId, issueId), gt(comments.createdAt, since), eq(comments.isAi, false)),
    )
    .limit(1);
  if (newComment) return true;

  const [newActivity] = await db
    .select({ id: activityLog.id })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.issueId, issueId),
        gt(activityLog.createdAt, since),
        // cm:guard status hops must NOT count as new input — re-entering the stage is itself an `issue.statusChanged` row, so counting it would mean the guard never fires
        ne(activityLog.action, 'issue.statusChanged'),
      ),
    )
    .limit(1);
  return newActivity !== undefined;
}

// cm:guard ISS-820 — the two needs_info callers only (findUnansweredBounce + reopenEnteredFromNeedsInfo): a HUMAN-authored comment, never an activity-log fallback. Activity is never a human answering a question, and an agent's own comment (isAi=true) must not release its own bounce — that is the exact fabrication mechanism this issue closes.
async function hasHumanAnswerSince(issueId: string, since: Date): Promise<boolean> {
  const [humanComment] = await db
    .select({ id: comments.id })
    .from(comments)
    .where(
      and(
        eq(comments.issueId, issueId),
        gt(comments.createdAt, since),
        eq(comments.isAi, false),
        isNull(comments.authorDeviceId),
      ),
    )
    .limit(1);
  return humanComment !== undefined;
}
