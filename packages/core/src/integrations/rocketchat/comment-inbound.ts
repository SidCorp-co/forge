// A reply in an issue's thread becomes a comment on that issue, by the person who typed it.
//
// The reply is written through `insertComment` and announced on `commentCreated`,
// so `pipeline/answer-resume.ts` sees a room reply exactly as it sees one typed
// on the web — which is the whole point: that subscriber is what carries a
// human's words into a parked agent session, and it is already load-bearing.
//
// Every path here consumes the message. A registered thread never falls through
// to the conversation handler, refusals included.

import { and, eq, isNull } from 'drizzle-orm';
import { namespaceFromServerUrl } from '../../assistant/identity/directory.js';
import { resolveSpeaker, unlinkedMessage } from '../../assistant/identity/speaker-link.js';
import { insertComment } from '../../comments/service.js';
import { db } from '../../db/client.js';
import { issues } from '../../db/schema.js';
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
// cm:guard the two writes share ONE transaction and that is the whole of the idempotency: Rocket.Chat re-emits a message after server-side enrichment, and a restart or a delivery-owner handoff replays it, so a comment committed without its mirror row is written again on the next delivery. Two comments from one message is two resume intents at `answer-resume.ts` — the agent runs twice, on the same worktree (ISS-981 criteria 10, 11).
// cm:guard the mirror insert is `onConflictDoNothing().returning()` INSIDE the transaction rather than a read before it: a read-then-write leaves the window between them, and two deliveries arriving together both find nothing and both insert a comment.
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
          // cm:guard `human` and never a device agency: the person typed this in a chat room, and an agent agency here would both exempt it from the body mandate and drop it out of the number that decides the mandate (ISS-969).
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
    // cm:guard a redelivery still owes the announcement when the first delivery died before making it: treating `created: false` as proof the bus was told is how a committed comment never reaches the parked session it was written to wake (ISS-981 criterion 12).
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
// cm:guard EVERY return is a consumed message, refusals included — the caller must not fall through to the conversation handler on any of them, which is why this returns void rather than a handled/unhandled flag somebody could forget to read (ISS-978 criterion 20).
// cm:guard authorship is the MAPPED user or nothing is written. `answer-resume.ts` returns early unless the comment's actor is a user, so the mapping is not attribution here, it is the mechanism that carries the reply into the parked session; and a comment attributed to the bot would clear the `unseenDrafts` bucket as if a person had read the draft (ISS-981 criteria 5, 7).
// cm:guard nothing here answers a question. A prose reply can resume a parked session through the path a comment already travels, and it can never stand in for choosing an option on a structured question — that authority lives in `answerAs` and reaching it from prose would grant a permission nobody selected (ISS-981 criterion 29).
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
  const resolution = await resolveSpeaker(ref);
  // cm:guard an unmapped speaker is refused with ISS-977's own text and not a local rewording: the way out — the two endpoints, and that the person links themselves — is that module's contract, and a second copy of it drifts silently (ISS-978 criterion 12).
  if (!resolution.linked) {
    await say(
      transport,
      resolution.refusal.code === 'SPEAKER_UNLINKED'
        ? unlinkedMessage(ref)
        : resolution.refusal.message,
    );
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
  // cm:guard the stamp is a CLAIM taken BEFORE the emit, not a receipt written after it: two redeliveries racing both read `announced_at IS NULL`, and both emitting puts two answers into the session `answer-resume.ts` sends to — the agent acts twice on one sentence, which the body names as the reason this lane is idempotent at all. The conditional update makes exactly one of them the announcer (ISS-981 criteria 10, 11, 12).
  // cm:guard this trades the other way deliberately: a process dying between the claim and the emit loses that announcement, so the parked session is not woken by this reply and the comment waits on the issue where a person can see it. Announcing twice is an agent acting on its own echo; announcing zero times is a message somebody has to notice — the second is the recoverable one.
  const claimed = await db
    .update(rocketchatCommentMirrors)
    .set({ announcedAt: new Date() })
    .where(
      and(
        eq(rocketchatCommentMirrors.commentId, written.commentId),
        isNull(rocketchatCommentMirrors.announcedAt),
      ),
    )
    .returning({ commentId: rocketchatCommentMirrors.commentId });
  if (claimed.length === 0) return;

  await args.hooks.emit('commentCreated', {
    issueId: issue.id,
    projectId: issue.projectId,
    // cm:guard a `user` actor, because that is what `answer-resume.ts` requires before it will carry the words into the parked session — a device actor there is how the driver's own question would resume the issue it just parked.
    actor: { type: 'user', id: resolution.userId, agency: 'human' },
    commentId: written.commentId,
    body: m.text,
    parentId: null,
  });
}

/**
 * The connection manager's half: build the transport, hand the reply over, and
 * say nothing back — the message is consumed either way.
 */
// cm:guard lives here rather than inside `connection-manager.route()` because that file is over its size budget and this is the whole of what `route` would otherwise hold: the caller returns immediately after calling it, and a `return` it forgets is a comment delivered as an LLM turn (ISS-978 criterion 20).
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
