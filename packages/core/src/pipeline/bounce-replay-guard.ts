// Refuse to replay a step the issue already walked out of via a bounce state,
// when nothing has changed since.
//
// ISS-158 (pixelight) needed a capability the project simply did not have. The
// clarify step and the first code attempt both concluded that and set `waiting`.
// A later run picked the issue back up at `approved` with no new comment, tool
// or capability recorded in between — so the second code attempt could only
// spend a full agent run re-deriving the identical blocked conclusion.
//
// `waiting`/`on_hold` release rule stays deliberately generous: ANY comment or
// activity after the bounce counts as new input — a tool being wired, even
// another step's note. `needs_info` is different (ISS-820): its whole premise
// is "a human must answer a question", so an agent's own comment must not
// release its own bounce (that let a fabricated "the owner decided" comment
// override a real human answer). needs_info release requires a HUMAN comment
// — isAi=false AND authorDeviceId IS NULL — with no activity fallback.

import { and, desc, eq, gt, isNull, ne, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type IssueStatus, activityLog, comments } from '../db/schema.js';
import { logger } from '../logger.js';
import { WORKING_STATUS_BY_STATUS } from './registry.js';

/** Statuses that mean "a human must act before this issue can progress". */
export const BOUNCE_STATUSES = ['waiting', 'needs_info', 'on_hold'] as const;
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
    return { bounced: to, at: row.createdAt };
  } catch (err) {
    // cm:guard fail OPEN — a broken guard must let the pipeline run, never silently freeze every dispatch
    logger.warn({ err, issueId, stage }, 'bounce-guard: check failed, allowing dispatch');
    return null;
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
async function hasAnyInputSince(issueId: string, since: Date): Promise<boolean> {
  const [newComment] = await db
    .select({ id: comments.id })
    .from(comments)
    .where(and(eq(comments.issueId, issueId), gt(comments.createdAt, since)))
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

// cm:guard ISS-820 — needs_info only: a HUMAN-authored comment, never an activity-log fallback. Activity is never a human answering a question, and an agent's own comment (isAi=true) must not release its own bounce — that is the exact fabrication mechanism this issue closes.
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
