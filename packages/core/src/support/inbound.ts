// A message in a support group or an operations room (REQ-75 BC-11, BC-13, BC-18, BC-20): recorded on its thread's conversation
// and as a `message_in` action, marked received, and handed to the group's session — unless it is a
// `confirm`/`cancel` naming a fix, which core answers itself, or the writer is past the hourly limit.

import type { SupportRoomConfig } from '@forge/contracts/support';
import { containsSecret, scrubLogText } from '@forge/observability';
import { linkCodeIn } from '../assistant/index.js';
import { appendMessagesIn } from '../conversations/index.js';
import { db } from '../db/client.js';
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
import { answerConfirm } from './fixes.js';
import { answerLinkCode } from './link-code.js';
import { ensureSupportRoom } from './rooms.js';
import { clipMessage, limitsOf, parseConfirm, threadOf } from './rules.js';
import { insertAction, limitToldSince, memberMessagesSince, type RoomRow } from './store.js';
import { postInThread, roomAuth, threadConversationOf } from './thread.js';

const RECEIVED_EMOJI = 'eyes';

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
  // an operations room runs under the default limits and takes no confirm: it proposes nothing
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
    opts: { deliver: boolean; maxChars?: number },
  ): Promise<boolean> => {
    const fresh = await recordInbound(room, conversation.id, thread, message, by, opts);
    if (fresh && secret) await flagSecret(room, conversation.id, thread, m.id, by);
    return fresh;
  };

  const confirm = room.kind !== 'operations' ? parseConfirm(input.m.text) : null;
  if (confirm) {
    await recordAndFlag(m, author, { deliver: false });
    await answerConfirm({
      room,
      config,
      ...confirm,
      author,
      thread,
      conversationId: conversation.id,
    });
    // what became of the fix waits for the session as a note: hand it on now, not at the next drain
    await deliverWaiting(room.id);
    return;
  }

  // a member linking their chat account to the Forge user who minted the code: core answers it, and
  // the code is never kept or shown to the session, since anyone in the room could read it there
  const linkCode = linkCodeIn(input.m.text);
  if (linkCode) {
    await recordAndFlag({ ...m, text: 'link ********' }, author, {
      deliver: false,
    });
    await answerLinkCode(room, namespace, thread, author, linkCode);
    return;
  }

  // a room that answers only mentions keeps every other message as the thread's context (REQ-75 r5)
  if (config.answers === 'mentions' && !m.mentions.includes(input.ac.botUserId)) {
    await recordAndFlag(m, author, { deliver: false });
    return;
  }

  const limits = limitsOf(config);
  const hourAgo = new Date(Date.now() - 60 * 60_000);
  if ((await memberMessagesSince(room.id, author.key, hourAgo)) >= limits.messagesPerUserPerHour) {
    await recordAndFlag(m, author, { deliver: false });
    if (!(await limitToldSince(room.id, author.key, hourAgo))) {
      const posted = await postInThread({
        room,
        thread,
        text: `@${author.label ?? 'there'} you have sent ${limits.messagesPerUserPerHour} messages this hour, the limit in this group. Please wait a little; your messages are recorded.`,
      });
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
        externalId: posted.messageId,
      });
    }
    return;
  }

  const fresh = await recordAndFlag(m, author, {
    deliver: true,
    maxChars: limits.messageMaxChars,
  });
  if (!fresh) return;
  void reactToMessage(auth, m.id, RECEIVED_EMOJI, true).catch(() => {});
  await deliverWaiting(room.id);
}

/**
 * The message as the thread's conversation row and the room's `message_in` action, in one write.
 * False when this message was already taken (a redelivered frame). A message that is not for the
 * session (a confirm, one past the limit) is recorded as already delivered.
 */
async function recordInbound(
  room: RoomRow,
  conversationId: string,
  thread: string,
  m: RocketChatIncomingMessage,
  author: { key: string; label: string | null },
  opts: { deliver: boolean; maxChars?: number },
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
        input: m.ts ? { text, ts: m.ts } : { text },
        externalId: m.id,
        deliveredAt: opts.deliver ? null : new Date(),
      },
      tx,
    );
    if (!action) return false;
    await appendMessagesIn(tx, {
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
    return true;
  });
}
