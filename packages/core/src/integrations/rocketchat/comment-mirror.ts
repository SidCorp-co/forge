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
import { comments, issues } from '../../db/schema.js';
import {
  rocketchatCommentMirrorState,
  rocketchatCommentMirrors,
  rocketchatThreadOpenings,
} from '../../db/schema-rocketchat.js';
import { logger } from '../../logger.js';
import type { HooksBus } from '../../pipeline/hooks.js';
import { drainOwedAnnouncements } from './comment-inbound.js';
import { threadRootText } from './comment-render.js';
import { FIXED_REPLY_CONSTANT, sendFixedReply } from './outbound.js';
import { type RoomBinding, roomForProject } from './question-delivery.js';
import { screenCarriedComment } from './reply-guard.js';
import { type RoomPostAuth, resolveRoomPostAuth } from './room-delivery.js';
import {
  type IssueThread,
  liveThreadForIssue,
  registerThread,
  retireIssueThread,
} from './thread-registry.js';

const RETRY_BACKOFF_MS = 60_000;
// cm:guard the backoff is CAPPED, and the attempt count is what it feeds — never a limit on how many times a comment may be tried. A cap on attempts ends with the comment quietly ceasing to be owed while its room was merely unreachable, which is the loss this lane exists to prevent; only `delivered` and `refused` are terminal (ISS-981 criteria 22, 26).
const MAX_BACKOFF_MS = 3_600_000;
const DRAIN_INTERVAL_MS = 30_000;
const OPENING_LEASE_MS = 60_000;
// cm:guard the drain takes a BOUNDED slice per tick, and the bound is what keeps a backlog from becoming a single unbounded pass: an unbound project's comments stay owed for ever by design, so `owedComments` over a busy month is every one of them, materialised and walked every thirty seconds. What is left over is not lost — it is owed, and the next tick takes the next slice (ISS-981).
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
// cm:guard read and never written here — the migration seeds the single row, so a deployment that has not migrated has no watermark and this returns null, which owes the room nothing rather than owing it the whole comment history (ISS-981 criterion 21).
export async function mirrorWatermark(): Promise<Date | null> {
  const [row] = await db
    .select({ since: rocketchatCommentMirrorState.since })
    .from(rocketchatCommentMirrorState);
  return row?.since ?? null;
}

/**
 * Every comment a room is still owed.
 */
// cm:guard bounded at the WATERMARK end only. A comment after it stays owed however long delivery takes and whichever connection ends up carrying it, because an obligation that expires with time is a comment lost in silence — which is the failure this whole lane exists to make impossible (ISS-981 criteria 22, 26, 32).
// cm:guard an `inbound` mirror row excludes the comment, and that is the echo guard: a comment this mirror wrote FROM a room must never be posted back into it. The bot's own messages are dropped by `inbound-gate.ts`'s `own-message` branch, but that branch cannot see this direction, whose author is the mapped person rather than the bot (ISS-981 criteria 8, 9).
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
// cm:guard the drain asks THIS first and reads bodies second, because an unbound project's comments are owed for ever by design: a project nobody has bound would otherwise fill every bounded slice with comments that cannot be posted, and starve the bound projects behind it for as long as the binding is missing (ISS-981).
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
    // cm:guard OLDEST first, which is what makes the bounded slice a queue rather than a sample: ordered any other way a steady stream of new comments keeps the oldest one out of every batch, and the comment that waits longest is the one nobody is ever told about (ISS-981 criterion 26).
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
// cm:guard ONE statement, and the `setWhere` on the conflict branch is what makes it a claim: the drain runs on EVERY core instance, and the DDP connection's advisory lock guards the socket rather than this table. Two instances deriving the same owed comment and both posting is one comment said twice in a room (ISS-978 criterion 5).
// cm:guard serialise to ISO and cast before binding — postgres-js throws on a raw `Date` param at bind time, so the claim fails rather than mis-selecting and the whole drain is lost.
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

// cm:guard TERMINAL, unlike `noteFailure`: a screen refusal is deterministic, so leaving the row retryable spends eight more posts on a body that cannot change and then drops the comment when the attempts run out — silently, which is the failure mode this whole lane is built against (ISS-981).
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
// cm:guard NO database transaction and NO lock is held across the post: `sendFixedReply` is an HTTP call to another host, the pool is ten connections wide and `idle_in_transaction_session_timeout` is set, so ten issues opening their first thread against a slow Rocket.Chat would hold ten pooled transactions and starve every other query — and a transaction Postgres then kills mid-flight loses the registration for a root the server already accepted (ISS-981).
// cm:guard what keeps one root per issue is therefore the LEASE below, committed before the post and released after the registration, plus the partial unique and the read-back behind it. Two workers claiming different comments on the same issue in the same tick is the ordinary case, not the rare one — the drain derives the same owed set on every instance (ISS-981 criterion 33).
// cm:guard a thread whose room is no longer this project's is RETIRED by identity before a replacement opens; retiring by issue alone would let a stale worker retire the replacement another just registered (ISS-981 criterion 32).
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

  try {
    if (existing) await retireIssueThread(issueId, existing);

    const [issue] = await db
      .select({ issSeq: issues.issSeq, title: issues.title })
      .from(issues)
      .where(eq(issues.id, issueId))
      .limit(1);
    if (!issue) return { failure: 'the issue is no longer on the record' };

    const root = await sendFixedReply(
      { kind: 'rest', auth, rid: room.rid },
      threadRootText(`ISS-${issue.issSeq}`, issue.title),
      FIXED_REPLY_CONSTANT,
    );
    if (!root.messageId) return { failure: 'the root post named no message id' };

    const ref = { connectionId: room.connectionId, rid: room.rid, tmid: root.messageId };
    await registerThread({ issueId }, ref);
    // cm:guard the row is READ BACK rather than the local ref returned: the insert absorbs a conflict silently, so a worker whose root lost a race the lease could not cover — an expired lease, a rolled-back peer — would otherwise send its comment into a root no row names, and a reply left there resolves to nothing (ISS-981 criterion 33).
    return (await liveThreadForIssue(issueId)) ?? ref;
  } finally {
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
// cm:guard the ORDER is the contract: claim, then post, then mark delivered. Claiming first stops a second core instance posting the same comment; marking last is what keeps `delivered` a statement about a post that returned rather than about one that was attempted (ISS-981 criterion 30).
// cm:guard a thread whose room is no longer this project's is RETIRED before a new one opens, which is what the partial unique on the live issue row requires: without the retirement the replacement registration is refused and every later comment fails against a room nobody is bound to (ISS-981 criterion 32).
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

  // cm:guard the body is screened BEFORE the thread is opened, so a refused comment does not leave an empty root in the room naming an issue nobody will see a comment about (ISS-981).
  const verdict = screenCarriedComment(owed.body);
  if (!verdict.ok) {
    logger.error(
      { commentId: owed.commentId, problems: verdict.problems },
      'rocketchat.comment-mirror: the comment was refused by the screen; not posted',
    );
    await settleRefused(owed.commentId, verdict.problems.join('; '), now);
    return 'refused';
  }

  try {
    const thread = await threadForIssueIn(owed.issueId, room, auth, now);
    if ('failure' in thread) {
      await noteFailure(owed.commentId, thread.failure, now);
      return 'failed';
    }
    const tmid = thread.tmid;

    const receipt = await sendFixedReply({ kind: 'rest', auth, rid: room.rid, tmid }, owed.body, {
      ok: true,
      problems: verdict.problems,
    });
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

// cm:guard the room is resolved ONCE per project and BEFORE any comment body is read: the projects come from a grouped count, the unbound ones are counted undeliverable without being visited, and only the bound ones' comments are fetched — bounded, oldest first. Re-deriving a binding lookup per comment every thirty seconds is what the naive shape costs; materialising an unbound project's whole backlog to discard it is what it costs twice (ISS-981).
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
  // cm:guard what the slice left behind is DEFERRED, never dropped: it is still derived as owed, so the next tick takes it. The count is here so a backlog that never shrinks is visible in the drain line rather than inferred from a room going quiet (ISS-981).
  result.deferred = result.owed - result.undeliverable - batch.length;
  return result;
}

// cm:guard module-level and shared by the timer AND the hook nudge, never one flag per loop: two drains overlapping re-derive the same owed comments and post one twice, because a comment is not marked until its post returns.
let draining = false;

// cm:guard the INBOUND announcements are drained on this same tick, and both halves run whatever the other does: an outbound room that is unreachable must not stop a comment already written from reaching the parked session it was written to wake, which is the direction that carries a person's words into a run (ISS-981 criterion 12).
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
// cm:guard the subscriber STARTS a drain and never awaits one, and that is the whole of why it is safe: `HooksBus.emit` awaits its subscribers, so a drain awaited here would hold the comment write open for as long as a Rocket.Chat post takes and fail it when the room is unreachable. The hook is a wake-up hint; the delivery record is the derivation in `owedComments`, which finds the comment whether or not this ever fired (ISS-981).
export function registerCommentMirror(bus: HooksBus): void {
  bus.on(
    'commentCreated',
    async () => {
      runDrain(bus);
    },
    { name: 'rocketchat-comment-mirror' },
  );
}
