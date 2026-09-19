// A reply in an issue's thread becomes a comment on that issue, by the person who typed it.
//
// The reply is written through `insertComment` and announced on `commentCreated`,
// so `pipeline/answer-resume.ts` sees a room reply exactly as it sees one typed
// on the web — which is the whole point: that subscriber is what carries a
// human's words into a parked agent session, and it is already load-bearing.
//
// Every path here consumes the message. A registered thread never falls through
// to the conversation handler, refusals included.

import { and, eq, isNull, lte, or } from 'drizzle-orm';
import { namespaceFromServerUrl } from '../../assistant/identity/directory.js';
import { resolveSpeaker } from '../../assistant/identity/speaker-link.js';
import { insertComment } from '../../comments/service.js';
import { db } from '../../db/client.js';
import { comments, issues } from '../../db/schema.js';
import { rocketchatCommentMirrors } from '../../db/schema-rocketchat.js';
import { logger } from '../../logger.js';
import type { HooksBus } from '../../pipeline/hooks.js';
import type { RocketChatDdpClient, RocketChatIncomingMessage } from './ddp-client.js';
import { FIXED_REPLY_CONSTANT, type ReplyTransport, sendFixedReply } from './outbound.js';

async function say(transport: ReplyTransport, text: string): Promise<void> {
  try {
    await sendFixedReply(transport, text, FIXED_REPLY_CONSTANT);
  } catch (err) {
    logger.error(
      { err, rid: transport.rid },
      'rocketchat.comment-inbound: posting the outcome failed',
    );
  }
}

export const RETIRED_THREAD_REPLY =
  'This thread belonged to an issue whose project is now bound to a different room, so nothing written here reaches it. Open the issue in Forge, or say it in the room this project is bound to now.';

/** Raised inside the transaction when another delivery of this message already owns a comment. */
class DuplicateDelivery extends Error {}

export interface MirroredComment {
  commentId: string;
  /** False when this message had already been written as a comment. */
  created: boolean;
  /** True when nobody has announced this comment on the bus yet. */
  announcementOwed: boolean;
}

/**
 * Write the comment and the row that makes this message's delivery unique, or
 * resolve to the comment an earlier delivery already wrote.
 */
export async function writeMirroredComment(args: {
  issueId: string;
  authorId: string;
  connectionId: string;
  externalMessageId: string;
  body: string;
}): Promise<MirroredComment> {
  try {
    return await db.transaction(async (tx) => {
      const { row } = await insertComment(
        {
          issueId: args.issueId,
          authorId: args.authorId,
          authorDeviceId: null,
          authorAgency: 'human',
          body: args.body,
          parentId: null,
        },
        tx,
      );
      const [mirror] = await tx
        .insert(rocketchatCommentMirrors)
        .values({
          commentId: row.id,
          connectionId: args.connectionId,
          direction: 'inbound',
          status: 'delivered',
          externalMessageId: args.externalMessageId,
        })
        .onConflictDoNothing()
        .returning({ commentId: rocketchatCommentMirrors.commentId });
      if (!mirror) throw new DuplicateDelivery();
      return { commentId: row.id, created: true, announcementOwed: true };
    });
  } catch (err) {
    if (!(err instanceof DuplicateDelivery)) throw err;
    const [existing] = await db
      .select({
        commentId: rocketchatCommentMirrors.commentId,
        announcedAt: rocketchatCommentMirrors.announcedAt,
      })
      .from(rocketchatCommentMirrors)
      .where(
        and(
          eq(rocketchatCommentMirrors.connectionId, args.connectionId),
          eq(rocketchatCommentMirrors.externalMessageId, args.externalMessageId),
        ),
      )
      .limit(1);
    if (!existing) throw err;
    return {
      commentId: existing.commentId,
      created: false,
      announcementOwed: existing.announcedAt === null,
    };
  }
}

/**
 * Handle one reply in an issue's comment thread. Always consumes the message.
 */
export async function handleIssueThreadReply(args: {
  issueId: string;
  retired: boolean;
  connectionId: string;
  serverUrl: string;
  m: RocketChatIncomingMessage;
  transport: ReplyTransport;
  hooks: HooksBus;
}): Promise<void> {
  const { m, transport } = args;
  if (args.retired) {
    await say(transport, RETIRED_THREAD_REPLY);
    return;
  }

  const [issue] = await db
    .select({ id: issues.id, projectId: issues.projectId })
    .from(issues)
    .where(eq(issues.id, args.issueId))
    .limit(1);
  if (!issue) {
    await say(transport, 'That issue is no longer on the record, so nothing was written.');
    return;
  }

  const namespace = namespaceFromServerUrl(args.serverUrl);
  if (!namespace) {
    await say(
      transport,
      `This Rocket.Chat server's address (${args.serverUrl}) cannot be read as a channel identity, so nothing can be authored as you here.`,
    );
    return;
  }
  const ref = {
    source: 'rocketchat',
    namespace,
    externalId: m.userId,
    label: m.username ?? null,
  };
  const resolution = await resolveSpeaker(ref, issue.projectId);
  if (!resolution.linked) {
    await say(transport, resolution.refusal.message);
    return;
  }

  let written: MirroredComment;
  try {
    written = await writeMirroredComment({
      issueId: issue.id,
      authorId: resolution.userId,
      connectionId: args.connectionId,
      externalMessageId: m.id,
      body: m.text,
    });
  } catch (err) {
    logger.error(
      { err, issueId: args.issueId, rid: m.rid },
      'rocketchat.comment-inbound: writing the comment failed',
    );
    await say(transport, 'That could not be written as a comment. Nothing has changed.');
    return;
  }

  if (!written.announcementOwed) return;
  await announceComment(
    { commentId: written.commentId, issueId: issue.id, projectId: issue.projectId },
    { userId: resolution.userId, body: m.text },
    args.hooks,
  );
}

const ANNOUNCE_LEASE_MS = 60_000;

/**
 * Take the announcement of this comment, if nobody holds it and nobody made it.
 */
async function claimAnnouncement(commentId: string, now: Date): Promise<boolean> {
  const claimed = await db
    .update(rocketchatCommentMirrors)
    .set({ announceLeaseUntil: new Date(now.getTime() + ANNOUNCE_LEASE_MS) })
    .where(
      and(
        eq(rocketchatCommentMirrors.commentId, commentId),
        isNull(rocketchatCommentMirrors.announcedAt),
        or(
          isNull(rocketchatCommentMirrors.announceLeaseUntil),
          lte(rocketchatCommentMirrors.announceLeaseUntil, now),
        ),
      ),
    )
    .returning({ commentId: rocketchatCommentMirrors.commentId });
  return claimed.length > 0;
}

interface AnnounceTarget {
  commentId: string;
  issueId: string;
  projectId: string;
}

async function announceComment(
  target: AnnounceTarget,
  speaker: { userId: string; body: string },
  hooks: HooksBus,
  now: Date = new Date(),
): Promise<void> {
  if (!(await claimAnnouncement(target.commentId, now))) return;
  await hooks.emit('commentCreated', {
    issueId: target.issueId,
    projectId: target.projectId,
    actor: { type: 'user', id: speaker.userId, agency: 'human' },
    authored: 'human',
    commentId: target.commentId,
    body: speaker.body,
    parentId: null,
  });
  await db
    .update(rocketchatCommentMirrors)
    .set({ announcedAt: new Date() })
    .where(eq(rocketchatCommentMirrors.commentId, target.commentId));
}

/**
 * Announce every mirrored comment whose announcement nobody completed.
 */
export async function drainOwedAnnouncements(
  hooks: HooksBus,
  now: Date = new Date(),
): Promise<number> {
  const rows = await db
    .select({
      commentId: rocketchatCommentMirrors.commentId,
      issueId: comments.issueId,
      projectId: issues.projectId,
      authorId: comments.authorId,
      body: comments.body,
    })
    .from(rocketchatCommentMirrors)
    .innerJoin(comments, eq(comments.id, rocketchatCommentMirrors.commentId))
    .innerJoin(issues, eq(issues.id, comments.issueId))
    .where(
      and(
        eq(rocketchatCommentMirrors.direction, 'inbound'),
        isNull(rocketchatCommentMirrors.announcedAt),
        or(
          isNull(rocketchatCommentMirrors.announceLeaseUntil),
          lte(rocketchatCommentMirrors.announceLeaseUntil, now),
        ),
      ),
    );

  let announced = 0;
  for (const row of rows) {
    if (!row.authorId) continue;
    try {
      await announceComment(
        { commentId: row.commentId, issueId: row.issueId, projectId: row.projectId },
        { userId: row.authorId, body: row.body },
        hooks,
        now,
      );
      announced += 1;
    } catch (err) {
      logger.error(
        { err, commentId: row.commentId },
        'rocketchat.comment-inbound: announcing a mirrored comment failed',
      );
    }
  }
  return announced;
}

/**
 * The connection manager's half: build the transport, hand the reply over, and
 * say nothing back — the message is consumed either way.
 */
export interface CommentReplySocket {
  serverUrl: string;
  authToken: string;
  client?: RocketChatDdpClient | undefined;
}

export function consumeIssueThreadReply(args: {
  issueId: string;
  retired: boolean;
  connectionId: string;
  ac: CommentReplySocket;
  m: RocketChatIncomingMessage;
  hooks: HooksBus;
}): void {
  const { ac, m } = args;
  const at = { connectionId: args.connectionId, rid: m.rid, issueId: args.issueId };
  const client = ac.client;
  if (!client) {
    logger.error(at, 'rocketchat: an issue thread reply arrived with no live socket to answer on');
    return;
  }
  void handleIssueThreadReply({
    issueId: args.issueId,
    retired: args.retired,
    connectionId: args.connectionId,
    serverUrl: ac.serverUrl,
    m,
    transport: { kind: 'ddp', client, rid: m.rid, tmid: m.tmid, authToken: ac.authToken },
    hooks: args.hooks,
  }).catch((err) => logger.error({ ...at, err }, 'rocketchat: answering an issue reply failed'));
}
