// A reply in an issue's thread becomes a comment on that issue, by the person who typed it.
//
// The reply is written through `insertComment` with its `comment.created` outbox event in the same
// transaction, so every consumer sees a room reply exactly as it sees one typed on the web.
//
// Every path here consumes the message. A registered thread never falls through
// to the conversation handler, refusals included.

import { and, eq } from 'drizzle-orm';
import { namespaceFromServerUrl } from '../../assistant/identity/directory.js';
import { resolveSpeaker } from '../../assistant/identity/speaker-link.js';
import { insertComment } from '../../comments/index.js';
import { db } from '../../db/client.js';
import { issues } from '../../db/schema.js';
import { rocketchatCommentMirrors } from '../../db/schema-rocketchat.js';
import { logger } from '../../logger.js';
import { emitEvent } from '../../outbox/index.js';
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
}

/**
 * Write the comment and the row that makes this message's delivery unique, or
 * resolve to the comment an earlier delivery already wrote.
 */
export async function writeMirroredComment(args: {
  issueId: string;
  projectId: string;
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
      await emitEvent(tx, 'comment.created', {
        issueId: args.issueId,
        projectId: args.projectId,
        actor: { type: 'user', id: args.authorId, agency: 'human' },
        authored: 'human',
        commentId: row.id,
        body: args.body,
        parentId: null,
      });
      return { commentId: row.id, created: true };
    });
  } catch (err) {
    if (!(err instanceof DuplicateDelivery)) throw err;
    const [existing] = await db
      .select({ commentId: rocketchatCommentMirrors.commentId })
      .from(rocketchatCommentMirrors)
      .where(
        and(
          eq(rocketchatCommentMirrors.connectionId, args.connectionId),
          eq(rocketchatCommentMirrors.externalMessageId, args.externalMessageId),
        ),
      )
      .limit(1);
    if (!existing) throw err;
    return { commentId: existing.commentId, created: false };
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

  try {
    await writeMirroredComment({
      issueId: issue.id,
      projectId: issue.projectId,
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
  }
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
  }).catch((err) => logger.error({ ...at, err }, 'rocketchat: answering an issue reply failed'));
}
