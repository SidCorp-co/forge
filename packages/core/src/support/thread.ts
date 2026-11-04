// One thread of a support group: the conversation it is recorded in, and the one way a line is
// posted into it — through the Rocket.Chat outbound door, scrubbed of the bot's token and of every
// credential the room's tools hold, then recorded as the room's own row (REQ-75 BC-17, BC-18).

import { scrubLogText } from '@forge/observability';
import { noteAppliedLessons } from '../assistant/index.js';
import { appendMessages, type ConversationRow, openConversation } from '../conversations/index.js';
import {
  FIXED_REPLY_CONSTANT,
  namespaceFromServerUrl,
  projectThreadsOf,
  type ReplySendProof,
  type RocketChatButtonAttachment,
  type RocketChatRestAuth,
  resolveRoomPostAuth,
  sendFixedReply,
} from '../integrations/rocketchat/index.js';
import { activeSupportApi, credentialValuesOf } from '../integrations/support-api/index.js';
import { findProjectSlugs } from '../projects/index.js';
import { no, type Outcome } from './outcome.js';
import { supportVenueId } from './rules.js';
import type { RoomRow } from './store.js';

/** The bot's credential for a room's connection, and the namespace its venues are keyed under. */
export async function roomAuth(
  room: RoomRow,
): Promise<{ auth: RocketChatRestAuth; namespace: string }> {
  const auth = await resolveRoomPostAuth(room.connectionId, { roomId: room.id });
  if (!auth) {
    throw new Error(
      `support: room ${room.rid}'s Rocket.Chat connection ${room.connectionId} holds no usable bot credential`,
    );
  }
  const namespace = namespaceFromServerUrl(auth.serverUrl);
  if (!namespace) {
    throw new Error(`support: ${auth.serverUrl} cannot be read as a Rocket.Chat server identity`);
  }
  return { auth, namespace };
}

export async function threadConversationOf(
  room: RoomRow,
  namespace: string,
  thread: string,
): Promise<ConversationRow> {
  return openConversation({
    adapter: 'rocketchat',
    externalId: supportVenueId(namespace, room.rid, thread),
    shape: 'group',
    projectId: room.projectId,
    title: 'Support thread',
  });
}

/** Every value a line posted in this room must never carry: the room's tool credential. */
export async function roomSecrets(room: RoomRow): Promise<string[]> {
  const api = await activeSupportApi(room.projectId).catch(() => null);
  return api ? credentialValuesOf(api.headers) : [];
}

/** Text with every secret the room holds, and every pattern the scrubber knows, taken out. */
export async function scrubbedForRoom(room: RoomRow, text: string, extra: readonly string[] = []) {
  const { auth } = await roomAuth(room);
  return scrubLogText(text, [auth.authToken, ...(await roomSecrets(room)), ...extra]);
}

/**
 * Post one line into a thread and record it on the thread's conversation as the room's own row.
 * `proof` is the screen's for a line the session wrote, minted over text the caller already scrubbed
 * (`scrubbedForRoom`); a line core wrote posts under the constant and is scrubbed here, since it may
 * carry a member's or a tool's words.
 */
export async function postInThread(input: {
  room: RoomRow;
  thread: string;
  text: string;
  proof?: ReplySendProof;
  attachments?: readonly RocketChatButtonAttachment[];
}): Promise<{ messageId: string | null; conversationId: string; text: string }> {
  const { auth, namespace } = await roomAuth(input.room);
  const conversation = await threadConversationOf(input.room, namespace, input.thread);
  const text = input.proof ? input.text : await scrubbedForRoom(input.room, input.text);
  const { messageId } = await sendFixedReply(
    {
      kind: 'rest',
      auth,
      rid: input.room.rid,
      tmid: input.thread,
      ...(input.attachments ? { attachments: input.attachments } : {}),
    },
    text,
    input.proof ?? FIXED_REPLY_CONSTANT,
  );
  const written = await appendMessages({
    conversationId: conversation.id,
    messages: [
      {
        role: 'assistant',
        content: text,
        authorUserId: input.room.principalUserId,
        externalId: messageId,
        deliveryProof: {
          messageId,
          door: input.proof
            ? input.room.kind === 'operations'
              ? 'operations-reply'
              : 'support-reply'
            : 'code-authored',
        },
      },
    ],
  });
  // the session's line keeps its `Lessons applied:` as a chat answer does (REQ-50 BC-4)
  await noteAppliedLessons(input.room.projectId, written);
  return { messageId, conversationId: conversation.id, text };
}

/** Record an action as a `system` line of the thread's conversation, so Forge shows it in place. */
export async function noteInThread(conversationId: string, line: string): Promise<void> {
  await appendMessages({
    conversationId,
    messages: [{ role: 'system', content: line }],
  });
}

/** The venue the channel's top-level posts are recorded under. */
export const TOP_LEVEL = 'top';

/**
 * The project's own thread in an operations room (ISS-934), as the room's binding records it in
 * `operations.threads[rid][slug]`; null for any other room, or where none is recorded.
 */
export async function projectThreadOfRoom(room: RoomRow): Promise<string | null> {
  if (room.kind !== 'operations') return null;
  const slug = (await findProjectSlugs([room.projectId])).get(room.projectId);
  if (!slug) return null;
  const recorded = await projectThreadsOf(room.projectId, slug);
  return recorded.find((t) => t.bindingId === room.bindingId && t.rid === room.rid)?.thread ?? null;
}

/**
 * Where a line bound for a room's top level lands (ISS-933, ISS-934): an operations room recording
 * the project's own thread takes it there; one every project of the organization shares (`forge`
 * scope) and recording none takes it nowhere, refused by name with the binding key that records it;
 * any other room at its top level (null).
 */
export async function topLevelThreadOf(room: RoomRow): Promise<Outcome<string | null>> {
  const thread = await projectThreadOfRoom(room);
  if (thread) return { ok: true, value: thread };
  if (room.kind !== 'operations' || room.scope !== 'forge') return { ok: true, value: null };
  const slug = (await findProjectSlugs([room.projectId])).get(room.projectId) ?? room.projectId;
  return no(
    'SUPPORT_PROJECT_THREAD_UNRECORDED',
    '/thread',
    `${room.rid} is an operations room every project of the organization shares, one thread per project, and its binding records no thread for ${slug}, so the post would land at its top level. A project admin records the project's thread as \`operations.threads["${room.rid}"]["${slug}"]\` on binding ${room.bindingId} (PUT /api/projects/${room.projectId}/bindings/${room.bindingId}). Nothing was posted.`,
  );
}

/**
 * Post one line for a room's top level (REQ-75 r6 BC-39), screened by the caller: where
 * {@link topLevelThreadOf} says, so a shared operations room takes it only in the project's own
 * thread. `thread` is that thread, or null for the top level itself. Resolve `to` first where the
 * caller claims something before posting, so a refusal leaves nothing claimed.
 */
export async function postForTopLevel(input: {
  room: RoomRow;
  text: string;
  proof: ReplySendProof;
  to?: string | null;
}): Promise<Outcome<{ messageId: string | null; conversationId: string; thread: string | null }>> {
  let thread = input.to;
  if (thread === undefined) {
    const where = await topLevelThreadOf(input.room);
    if (!where.ok) return where;
    thread = where.value;
  }
  if (thread) {
    const posted = await postInThread({
      room: input.room,
      thread,
      text: input.text,
      proof: input.proof,
    });
    return { ok: true, value: { ...posted, thread } };
  }
  const posted = await postTopLevel(input);
  return { ok: true, value: { ...posted, thread: null } };
}

/**
 * Post one line at the channel's top level, outside any thread (REQ-75 r6 BC-39), reached only
 * through {@link postForTopLevel}. Recorded on the channel's top-level conversation.
 */
async function postTopLevel(input: {
  room: RoomRow;
  text: string;
  proof: ReplySendProof;
}): Promise<{ messageId: string | null; conversationId: string }> {
  const { auth, namespace } = await roomAuth(input.room);
  const conversation = await threadConversationOf(input.room, namespace, TOP_LEVEL);
  const { messageId } = await sendFixedReply(
    { kind: 'rest', auth, rid: input.room.rid },
    input.text,
    input.proof,
  );
  const written = await appendMessages({
    conversationId: conversation.id,
    messages: [
      {
        role: 'assistant',
        content: input.text,
        authorUserId: input.room.principalUserId,
        externalId: messageId,
        deliveryProof: { messageId, door: 'support-reply' },
      },
    ],
  });
  await noteAppliedLessons(input.room.projectId, written);
  return { messageId, conversationId: conversation.id };
}
