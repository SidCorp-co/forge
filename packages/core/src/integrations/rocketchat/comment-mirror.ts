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

import { and, eq, gte, isNull, lte, or, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { comments, issues } from '../../db/schema.js';
import {
  rocketchatCommentMirrorState,
  rocketchatCommentMirrors,
} from '../../db/schema-rocketchat.js';
import { logger } from '../../logger.js';
import type { HooksBus } from '../../pipeline/hooks.js';
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
export async function owedComments(now: Date = new Date()): Promise<OwedComment[]> {
  const since = await mirrorWatermark();
  if (!since) return [];
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
    .where(
      and(
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
      ),
    );
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
// cm:guard the whole check-and-open runs under a per-issue advisory lock, which is what makes one root per issue TRUE rather than merely likely: without it two instances delivering an issue's first two comments each find no thread, each post a root, and the loser's root stays in the room unregistered — a thread a person can reply in whose replies resolve to nothing (ISS-981 criterion 33).
// cm:guard the lock is transaction-scoped, so it is released when this transaction ends and a process that dies holding it blocks nobody — the same property `drop-cascade.ts` and `events-routes.ts` rely on.
// cm:guard a thread whose room is no longer this project's is RETIRED by identity before a replacement opens, which is what the partial unique on the live issue row requires; retiring by issue alone would let a stale worker retire the replacement another just registered (ISS-981 criterion 32).
async function threadForIssueIn(
  issueId: string,
  room: { connectionId: string; rid: string },
  auth: RoomPostAuth,
): Promise<IssueThread | ThreadFailure> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${issueId}))`);

    const existing = await liveThreadForIssue(issueId, tx);
    if (existing && existing.connectionId === room.connectionId && existing.rid === room.rid) {
      return existing;
    }
    if (existing) await retireIssueThread(issueId, existing, tx);

    const [issue] = await tx
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
    await registerThread({ issueId }, ref, tx);
    // cm:guard the row is READ BACK rather than the local ref returned: the insert absorbs a conflict silently, so a registration that lost to a writer outside this lock would otherwise send the comment into a root no row names (ISS-981 criterion 33).
    return (await liveThreadForIssue(issueId, tx)) ?? ref;
  });
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
    const thread = await threadForIssueIn(owed.issueId, room, auth);
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
}

// cm:guard the room is resolved ONCE per project and an unbound project's comments are counted without being visited: a project nobody has bound keeps every comment owed for ever, which is right, and re-deriving a binding lookup per comment every thirty seconds for ever is what that correctness would otherwise cost (ISS-981).
export async function drainCommentMirror(now: Date = new Date()): Promise<CommentMirrorResult> {
  const owed = await owedComments(now);
  const result: CommentMirrorResult = {
    owed: owed.length,
    delivered: 0,
    failed: 0,
    undeliverable: 0,
    held: 0,
    refused: 0,
  };
  const rooms = new Map<string, RoomBinding | null>();
  for (const comment of owed) {
    let room = rooms.get(comment.projectId);
    if (room === undefined) {
      room = await roomForProject(comment.projectId);
      rooms.set(comment.projectId, room);
    }
    if (!room) {
      result.undeliverable += 1;
      continue;
    }
    result[await deliverOwedComment(comment, now, room)] += 1;
  }
  return result;
}

// cm:guard module-level and shared by the timer AND the hook nudge, never one flag per loop: two drains overlapping re-derive the same owed comments and post one twice, because a comment is not marked until its post returns.
let draining = false;

function runDrain(): void {
  if (draining) return;
  draining = true;
  void drainCommentMirror()
    .then((r) => {
      if (r.owed > 0) logger.info({ ...r }, 'rocketchat: comment mirror drain');
    })
    .catch((err) => logger.error({ err }, 'rocketchat: comment mirror drain failed'))
    .finally(() => {
      draining = false;
    });
}

/**
 * Run the drain on a timer until the returned stopper is called.
 */
export function startCommentMirrorLoop(alive: () => boolean): () => void {
  const tick = (): void => {
    if (alive()) runDrain();
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
      runDrain();
    },
    { name: 'rocketchat-comment-mirror' },
  );
}
