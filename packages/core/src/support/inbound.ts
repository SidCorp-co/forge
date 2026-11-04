// A message in a support group or an operations room (REQ-75 BC-11, BC-13, BC-18, BC-20): recorded on its thread's conversation
// and as a `message_in` action, marked received, and handed to the group's session — unless the
// writer is past the hourly limit, who is told so once in the thread. A person's answer to a proposal ("ok", "confirm …") is an ordinary
// message: the session cites it to `agree` (ISS-845).

import type { SupportRoomConfig } from '@forge/contracts/support';
import { containsSecret, scrubLogText } from '@forge/observability';
import { pushProjectNow } from '../agent-sessions/index.js';
import { appendMessagesIn } from '../conversations/index.js';
import { db } from '../db/client.js';
import { meetRoomConfirmWaits } from '../feedback/index.js';
import {
  type ActiveConnection,
  type RocketChatIncomingMessage,
  type RoomShape,
  type Route,
  reactToMessage,
} from '../integrations/rocketchat/index.js';
import { logger } from '../lib/logger.js';
import { flagSecret } from './channel.js';
import { deliverWaiting } from './dispatch.js';
import { answersOfConfig } from './grants.js';
import { tellLastResort } from './last-resort.js';
import { settleOwnerAnswer } from './owner-ask.js';
import { noteRoomMessage } from './room-replies.js';
import { ensureSupportRoom } from './rooms.js';
import { clipMessage, limitsOf, threadOf } from './rules.js';
import { insertAction, memberMessagesSince, type RoomRow } from './store.js';
import { roomAuth, threadConversationOf } from './thread.js';

const RECEIVED_EMOJI = 'eyes';

/**
 * Whom a message is for, as the chat server parsed its mentions (REQ-77 BC-6): the bot, someone else
 * (and not the bot), or nobody in particular. A fact for the session to read, never its text's claim.
 */
export type Addressed = 'you' | 'others' | 'nobody';

export function addressedOf(mentions: readonly string[], botUserId: string): Addressed {
  if (mentions.includes(botUserId)) return 'you';
  return mentions.length > 0 ? 'others' : 'nobody';
}

export async function handleSupportMessage(input: {
  connectionId: string;
  ac: ActiveConnection;
  route: Route;
  m: RocketChatIncomingMessage;
  shape: RoomShape;
}): Promise<void> {
  const { route } = input;
  // a posted secret is never kept: the message is recorded and handed on without it (REQ-75 r6 BC-40)
  const secret = containsSecret(input.m.text);
  const m = secret ? { ...input.m, text: scrubLogText(input.m.text) } : input.m;
  // an operations room runs under the default limits
  const config: SupportRoomConfig = route.support ?? route.agent ?? {};
  if (input.shape !== 'group') {
    // a support binding names a group; a direct room bound so is refused, never answered as one
    logger.error(
      { connectionId: input.connectionId, rid: m.rid, projectId: route.projectId },
      'support: a support binding names a direct room; the message is refused, not answered',
    );
    return;
  }
  const room = await ensureSupportRoom({
    projectId: route.projectId,
    bindingId: route.bindingId,
    connectionId: input.connectionId,
    rid: m.rid,
    room: route.operations
      ? { kind: 'operations', scope: route.operations.scope }
      : route.agent
        ? { kind: 'agent', agent: route.agent }
        : { kind: 'support', support: config },
  });
  const { auth, namespace } = await roomAuth(room);
  const thread = threadOf(m);
  const conversation = await threadConversationOf(room, namespace, thread);
  const author = { key: m.userId, label: m.username ?? null };
  const recordAndFlag = async (
    message: RocketChatIncomingMessage,
    by: { key: string; label: string | null },
    opts: { deliver: boolean; maxChars?: number; addressed?: Addressed },
  ): Promise<boolean> => {
    const fresh = await recordInbound(room, conversation.id, thread, message, by, opts);
    if (fresh && secret) await flagSecret(room, conversation.id, thread, m.id, by);
    return fresh;
  };

  // the owner's message in a thread that asked them something is the answer to it, and is handed to
  // the asking session whatever the room's answering mode (REQ-77 BC-12)
  const ownerAnswer = await settleOwnerAnswer({
    room,
    thread,
    message: { id: m.id, text: m.text },
    author,
  });

  // a room that answers only mentions keeps every other message as the thread's context (REQ-75 r5);
  // a channel agent's group may say so for itself (ISS-874); an operations room answers only when
  // addressed unless its binding says otherwise (ISS-933)
  if (
    answersOfConfig(room, config, route.operations) === 'mentions' &&
    !m.mentions.includes(input.ac.botUserId) &&
    !ownerAnswer
  ) {
    await recordAndFlag(m, author, { deliver: false });
    return;
  }

  const limits = limitsOf(config);
  const hourAgo = new Date(Date.now() - 60 * 60_000);
  if ((await memberMessagesSince(room.id, author.key, hourAgo)) >= limits.messagesPerUserPerHour) {
    await recordAndFlag(m, author, { deliver: false });
    // the member is told once in this thread, in core's last-resort line (ISS-875)
    const told = await tellLastResort(room, thread, 'rate_limited');
    if (told.posted) {
      await insertAction({
        roomId: room.id,
        projectId: room.projectId,
        conversationId: conversation.id,
        thread,
        kind: 'refused',
        actorKind: 'member',
        actorKey: author.key,
        actorLabel: author.label,
        tool: 'limit',
        output: { messagesPerUserPerHour: limits.messagesPerUserPerHour },
        externalId: told.messageId,
      });
    }
    return;
  }

  const fresh = await recordAndFlag(m, author, {
    deliver: true,
    maxChars: limits.messageMaxChars,
    addressed: addressedOf(m.mentions, input.ac.botUserId),
  });
  if (!fresh) return;
  void reactToMessage(auth, m.id, RECEIVED_EMOJI, true).catch(() => {});
  await deliverWaiting(room.id);
}

/**
 * The message as the thread's conversation row and the room's `message_in` action, in one write.
 * False when this message was already taken (a redelivered frame). A message that is not for the
 * session (one past the limit) is recorded as already delivered.
 */
async function recordInbound(
  room: RoomRow,
  conversationId: string,
  thread: string,
  m: RocketChatIncomingMessage,
  author: { key: string; label: string | null },
  opts: { deliver: boolean; maxChars?: number; addressed?: Addressed },
): Promise<boolean> {
  const text = opts.maxChars ? clipMessage(m.text, opts.maxChars) : m.text;
  return db.transaction(async (tx) => {
    const action = await insertAction(
      {
        roomId: room.id,
        projectId: room.projectId,
        conversationId,
        thread,
        kind: 'message_in',
        actorKind: 'member',
        actorKey: author.key,
        actorLabel: author.label,
        // the server's own timestamp, which the room's latency is read from (BC-11)
        input: {
          text,
          ...(m.ts ? { ts: m.ts } : {}),
          ...(opts.addressed ? { addressed: opts.addressed } : {}),
        },
        externalId: m.id,
        deliveredAt: opts.deliver ? null : new Date(),
      },
      tx,
    );
    if (!action) return false;
    // a member's message is the event a confirm waiting on the next room message waits for (ISS-902)
    await meetRoomConfirmWaits(tx, room.projectId, new Date());
    // the bar on the project's pages reads the room's waiting message (REQ-15 BC-10)
    await pushProjectNow(tx, room.projectId, 'rooms');
    const written = await appendMessagesIn(tx, {
      conversationId,
      messages: [
        {
          role: 'user',
          content: m.text,
          authorUserId: null,
          authorLabel: author.label ?? author.key,
          authorKey: author.key,
          externalId: m.id,
          replyToExternalId: m.replyToId ?? null,
        },
      ],
    });
    // a message handed to the session, and not for others, that follows the bot's answer is read
    // for a correction (REQ-50 BC-1, room source); its text is the scrubbed text stored here
    if (opts.deliver && opts.addressed !== 'others') {
      await noteRoomMessage(tx, room, conversationId, written);
    }
    return true;
  });
}
