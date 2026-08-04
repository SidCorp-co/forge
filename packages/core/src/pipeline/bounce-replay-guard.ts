// Refuse to replay a step the issue already walked out of via a bounce state,
// when nothing has changed since.
//
// ISS-158 (pixelight) needed a capability the project simply did not have. The
// clarify step and the first code attempt both concluded that and set `waiting`.
// A later run picked the issue back up at `approved` with no new comment, tool
// or capability recorded in between — so the second code attempt could only
// spend a full agent run re-deriving the identical blocked conclusion.
//
// "Nothing has changed" is deliberately generous: ANY comment or activity after
// the bounce counts as new input. A human answering the question, a tool being
// wired, even another step's note all release the guard. Only true silence
// blocks, so this can never strand an issue a human actually responded to.

import { and, desc, eq, gt, ne, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type IssueStatus, activityLog, comments } from '../db/schema.js';
import { logger } from '../logger.js';

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
    const [row] = await db
      .select({ payload: activityLog.payload, createdAt: activityLog.createdAt })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.issueId, issueId),
          eq(activityLog.action, 'issue.statusChanged'),
          sql`${activityLog.payload}->>'from' = ${stage}`,
        ),
      )
      .orderBy(desc(activityLog.createdAt))
      .limit(1);
    if (!row) return null;

    const to = (row.payload as { to?: string } | null)?.to;
    if (!to || !isBounce(to)) return null;

    if (await hasInputSince(issueId, row.createdAt)) return null;
    return { bounced: to, at: row.createdAt };
  } catch (err) {
    // cm:guard fail OPEN — a broken guard must let the pipeline run, never silently freeze every dispatch
    logger.warn({ err, issueId, stage }, 'bounce-guard: check failed, allowing dispatch');
    return null;
  }
}

// cm:why a comment OR any activity counts — the guard's job is to catch true silence, so anything a human or another step recorded since the bounce must release it
async function hasInputSince(issueId: string, since: Date): Promise<boolean> {
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
