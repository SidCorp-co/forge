// Carrying an issue's comments into the room its project is bound to.
//
// The obligation is DERIVED, never inserted: a comment written after the
// mirror's rollout watermark with no delivered row here is a comment the room
// has not been told about. So the comment path writes nothing for this lane,
// and a core that dies between the comment and any emit leaves the work to be
// found on the next drain rather than lost.
//
// Delivery is at-least-once. The claim below counts attempts, never Rocket.Chat's
// acceptance, so a post the server took whose mark never landed is posted again.
// What that buys is that no comment is silently dropped.

import { and, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { comments, issues, projects } from '../../db/schema.js';
import {
  rocketchatCommentMirrorState,
  rocketchatCommentMirrors,
  rocketchatThreadOpenings,
} from '../../db/schema-rocketchat.js';
import { formatIssueRef } from '../../lib/issue-ref.js';
import { logger } from '../../logger.js';
import { problemsOf } from '../../messaging/contract.js';
import { proven, wholeAgentText } from '../../messaging/proven.js';
import type { HooksBus } from '../../pipeline/hooks.js';
import { screenCarriedComment } from './comment-carry.js';
import { drainOwedAnnouncements } from './comment-inbound.js';
import { threadRootText } from './comment-render.js';
import { FIXED_REPLY_CONSTANT, sendFixedReply } from './outbound.js';
import { type RoomBinding, roomForProject } from './project-room.js';
import { type RoomPostAuth, resolveRoomPostAuth } from './room-delivery.js';
import {
  type IssueThread,
  liveThreadForIssue,
  registerThread,
  retireIssueThread,
} from './thread-registry.js';

const RETRY_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 3_600_000;
const DRAIN_INTERVAL_MS = 30_000;
const OPENING_LEASE_MS = 60_000;
const OPENING_RENEW_MS = 20_000;
const DRAIN_BATCH = 200;

export interface OwedProject {
  projectId: string;
  owed: number;
}

export interface OwedComment {
  commentId: string;
  issueId: string;
  projectId: string;
  body: string;
  attempts: number;
}

/**
 * The instant the mirror started watching, below which nothing is owed.
 */
export async function mirrorWatermark(): Promise<Date | null> {
  const [row] = await db
    .select({ since: rocketchatCommentMirrorState.since })
    .from(rocketchatCommentMirrorState);
  return row?.since ?? null;
}

/**
 * Every comment a room is still owed.
 */
function owedWhere(since: Date, now: Date) {
  return and(
    gte(comments.createdAt, since),
    or(
      isNull(rocketchatCommentMirrors.commentId),
      and(
        eq(rocketchatCommentMirrors.direction, 'outbound'),
        sql`${rocketchatCommentMirrors.status} not in ('delivered', 'refused')`,
        or(
          isNull(rocketchatCommentMirrors.nextAttemptAt),
          lte(rocketchatCommentMirrors.nextAttemptAt, now),
        ),
      ),
    ),
  );
}

/**
 * How much each project is owed, without reading a single comment body.
 */
export async function owedProjects(now: Date = new Date()): Promise<OwedProject[]> {
  const since = await mirrorWatermark();
  if (!since) return [];
  return db
    .select({ projectId: issues.projectId, owed: sql<number>`count(*)::int` })
    .from(comments)
    .innerJoin(issues, eq(issues.id, comments.issueId))
    .leftJoin(rocketchatCommentMirrors, eq(rocketchatCommentMirrors.commentId, comments.id))
    .where(owedWhere(since, now))
    .groupBy(issues.projectId);
}

export async function owedComments(
  now: Date = new Date(),
  projectIds?: string[],
  limit = DRAIN_BATCH,
): Promise<OwedComment[]> {
  const since = await mirrorWatermark();
  if (!since) return [];
  if (projectIds && projectIds.length === 0) return [];
  const scope = projectIds
    ? and(owedWhere(since, now), inArray(issues.projectId, projectIds))
    : owedWhere(since, now);
  const rows = await db
    .select({
      commentId: comments.id,
      issueId: comments.issueId,
      projectId: issues.projectId,
      body: comments.body,
      attempts: rocketchatCommentMirrors.attempts,
    })
    .from(comments)
    .innerJoin(issues, eq(issues.id, comments.issueId))
    .leftJoin(rocketchatCommentMirrors, eq(rocketchatCommentMirrors.commentId, comments.id))
    .where(scope)
    .orderBy(comments.createdAt)
    .limit(limit);
  return rows.map((r) => ({
    commentId: r.commentId,
    issueId: r.issueId,
    projectId: r.projectId,
    body: r.body,
    attempts: r.attempts ?? 0,
  }));
}

/**
 * Take this comment, so no other core instance posts it too.
 */
async function claimComment(owed: OwedComment, connectionId: string, now: Date): Promise<boolean> {
  const attempts = owed.attempts + 1;
  const nextAttemptAt = new Date(
    now.getTime() + Math.min(RETRY_BACKOFF_MS * attempts, MAX_BACKOFF_MS),
  );
  const claimed = await db
    .insert(rocketchatCommentMirrors)
    .values({
      commentId: owed.commentId,
      connectionId,
      direction: 'outbound',
      status: 'claimed',
      attempts,
      nextAttemptAt,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: rocketchatCommentMirrors.commentId,
      set: { status: 'claimed', connectionId, attempts, nextAttemptAt, updatedAt: now },
      setWhere: sql`${rocketchatCommentMirrors.direction} = 'outbound' and ${rocketchatCommentMirrors.status} not in ('delivered', 'refused') and (${rocketchatCommentMirrors.nextAttemptAt} is null or ${rocketchatCommentMirrors.nextAttemptAt} <= ${now.toISOString()}::timestamptz)`,
    })
    .returning({ commentId: rocketchatCommentMirrors.commentId });
  return claimed.length > 0;
}

async function settleDelivered(
  commentId: string,
  externalMessageId: string | null,
  now: Date,
): Promise<void> {
  await db
    .update(rocketchatCommentMirrors)
    .set({
      status: 'delivered',
      externalMessageId,
      lastError: null,
      nextAttemptAt: null,
      updatedAt: now,
    })
    .where(eq(rocketchatCommentMirrors.commentId, commentId));
}

async function settleRefused(commentId: string, problems: string, now: Date): Promise<void> {
  await db
    .update(rocketchatCommentMirrors)
    .set({
      status: 'refused',
      lastError: `screen refused the comment: ${problems}`,
      nextAttemptAt: null,
      updatedAt: now,
    })
    .where(eq(rocketchatCommentMirrors.commentId, commentId));
}

async function noteFailure(commentId: string, lastError: string, now: Date): Promise<void> {
  await db
    .update(rocketchatCommentMirrors)
    .set({ lastError, updatedAt: now })
    .where(eq(rocketchatCommentMirrors.commentId, commentId));
}

interface ThreadFailure {
  failure: string;
}

/**
 * The thread this issue's comments go to in this room, opening one if needed.
 */
async function threadForIssueIn(
  issueId: string,
  room: { connectionId: string; rid: string },
  auth: RoomPostAuth,
  now: Date,
): Promise<IssueThread | ThreadFailure> {
  const existing = await liveThreadForIssue(issueId);
  if (existing && existing.connectionId === room.connectionId && existing.rid === room.rid) {
    return existing;
  }

  const lease = {
    issueId,
    connectionId: room.connectionId,
    rid: room.rid,
    claimedAt: now,
    expiresAt: new Date(now.getTime() + OPENING_LEASE_MS),
  };
  const held = await db
    .insert(rocketchatThreadOpenings)
    .values(lease)
    .onConflictDoUpdate({
      target: rocketchatThreadOpenings.issueId,
      set: lease,
      setWhere: lte(rocketchatThreadOpenings.expiresAt, now),
    })
    .returning({ issueId: rocketchatThreadOpenings.issueId });
  if (held.length === 0) return { failure: "another instance is opening this issue's thread" };

  const renew = setInterval(() => {
    void db
      .update(rocketchatThreadOpenings)
      .set({ expiresAt: new Date(Date.now() + OPENING_LEASE_MS) })
      .where(
        and(
          eq(rocketchatThreadOpenings.issueId, issueId),
          eq(rocketchatThreadOpenings.claimedAt, lease.claimedAt),
        ),
      )
      .catch((err) =>
        logger.warn({ err, issueId }, 'rocketchat: renewing the opening lease failed'),
      );
  }, OPENING_RENEW_MS);
  renew.unref?.();

  try {
    if (existing) await retireIssueThread(issueId, existing);

    const [issue] = await db
      .select({ issSeq: issues.issSeq, issuePrefix: projects.issuePrefix, title: issues.title })
      .from(issues)
      .innerJoin(projects, eq(projects.id, issues.projectId))
      .where(eq(issues.id, issueId))
      .limit(1);
    if (!issue) return { failure: 'the issue is no longer on the record' };

    const root = await sendFixedReply(
      { kind: 'rest', auth, rid: room.rid },
      threadRootText(formatIssueRef(issue.issuePrefix, issue.issSeq), issue.title),
      FIXED_REPLY_CONSTANT,
    );
    if (!root.messageId) return { failure: 'the root post named no message id' };

    const ref = { connectionId: room.connectionId, rid: room.rid, tmid: root.messageId };
    await registerThread({ issueId }, ref);
    const registered = (await liveThreadForIssue(issueId)) ?? ref;
    if (registered.connectionId !== room.connectionId || registered.rid !== room.rid) {
      return { failure: "this issue's thread was registered in another room" };
    }
    return registered;
  } finally {
    clearInterval(renew);
    await db
      .delete(rocketchatThreadOpenings)
      .where(
        and(
          eq(rocketchatThreadOpenings.issueId, issueId),
          eq(rocketchatThreadOpenings.claimedAt, lease.claimedAt),
        ),
      );
  }
}

export type CommentDeliveryOutcome = 'delivered' | 'failed' | 'undeliverable' | 'held' | 'refused';

/**
 * Deliver one owed comment. Never throws — a failure is a record, not an exception.
 */
export async function deliverOwedComment(
  owed: OwedComment,
  now: Date = new Date(),
  into?: RoomBinding,
): Promise<CommentDeliveryOutcome> {
  const room = into ?? (await roomForProject(owed.projectId));
  if (!room) return 'undeliverable';

  if (!(await claimComment(owed, room.connectionId, now))) return 'held';

  const auth = await resolveRoomPostAuth(room.connectionId, {
    source: 'rocketchat.comment-mirror',
    commentId: owed.commentId,
  });
  if (!auth) {
    await noteFailure(owed.commentId, 'the connection carries no usable credentials', now);
    return 'failed';
  }

  const verdict = screenCarriedComment(owed.body);
  const admitted = proven('comment-write', wholeAgentText(owed.body), verdict);
  if (!admitted) {
    const problems = problemsOf(verdict);
    logger.error(
      { commentId: owed.commentId, problems },
      'rocketchat.comment-mirror: the comment was refused by the screen; not posted',
    );
    await settleRefused(owed.commentId, problems.join('; '), now);
    return 'refused';
  }

  try {
    const thread = await threadForIssueIn(owed.issueId, room, auth, now);
    if ('failure' in thread) {
      await noteFailure(owed.commentId, thread.failure, now);
      return 'failed';
    }
    const tmid = thread.tmid;

    const receipt = await sendFixedReply(
      { kind: 'rest', auth, rid: room.rid, tmid },
      admitted.text,
      admitted,
    );
    await settleDelivered(owed.commentId, receipt.messageId, now);
    return 'delivered';
  } catch (err) {
    logger.error(
      { err, commentId: owed.commentId, issueId: owed.issueId, rid: room.rid },
      'rocketchat.comment-mirror: posting the comment failed',
    );
    await noteFailure(owed.commentId, err instanceof Error ? err.message : String(err), now);
    return 'failed';
  }
}

export interface CommentMirrorResult {
  owed: number;
  delivered: number;
  failed: number;
  undeliverable: number;
  held: number;
  refused: number;
  deferred: number;
}

export async function drainCommentMirror(now: Date = new Date()): Promise<CommentMirrorResult> {
  const projects = await owedProjects(now);
  const result: CommentMirrorResult = {
    owed: projects.reduce((n, p) => n + p.owed, 0),
    delivered: 0,
    failed: 0,
    undeliverable: 0,
    held: 0,
    refused: 0,
    deferred: 0,
  };
  const rooms = new Map<string, RoomBinding>();
  for (const project of projects) {
    const room = await roomForProject(project.projectId);
    if (room) rooms.set(project.projectId, room);
    else result.undeliverable += project.owed;
  }

  const batch = await owedComments(now, [...rooms.keys()]);
  for (const comment of batch) {
    const room = rooms.get(comment.projectId);
    if (!room) continue;
    result[await deliverOwedComment(comment, now, room)] += 1;
  }
  result.deferred = result.owed - result.undeliverable - batch.length;
  return result;
}

let draining = false;

function runDrain(bus: HooksBus): void {
  if (draining) return;
  draining = true;
  void Promise.allSettled([drainCommentMirror(), drainOwedAnnouncements(bus)])
    .then(([out, announced]) => {
      if (out.status === 'rejected')
        logger.error({ err: out.reason }, 'rocketchat: comment mirror drain failed');
      else if (out.value.owed > 0)
        logger.info({ ...out.value }, 'rocketchat: comment mirror drain');
      if (announced.status === 'rejected')
        logger.error({ err: announced.reason }, 'rocketchat: announcement drain failed');
      else if (announced.value > 0)
        logger.info({ announced: announced.value }, 'rocketchat: mirrored comments announced');
    })
    .catch((err) => logger.error({ err }, 'rocketchat: comment mirror drain failed'))
    .finally(() => {
      draining = false;
    });
}

/**
 * Run the drain on a timer until the returned stopper is called.
 */
export function startCommentMirrorLoop(alive: () => boolean, bus: HooksBus): () => void {
  const tick = (): void => {
    if (alive()) runDrain(bus);
  };
  const timer = setInterval(tick, DRAIN_INTERVAL_MS);
  timer.unref?.();
  tick();
  return () => clearInterval(timer);
}

/**
 * Register the wake-up. A new comment drains now instead of on the next tick.
 */
export function registerCommentMirror(bus: HooksBus): void {
  bus.on(
    'commentCreated',
    async () => {
      runDrain(bus);
    },
    { name: 'rocketchat-comment-mirror' },
  );
}
