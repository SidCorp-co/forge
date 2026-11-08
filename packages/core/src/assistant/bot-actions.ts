// The Forge bot's thread operations an MCP client calls (REQ-91), served by the product door's
// `forge_bot` (`product-door/bot-tool.ts`), which judges the input and declares the grant.
//
// No second bot: a thread is a web room, a message is taken in by the very send the Forge UI's chat
// takes (`conversation-send.ts`, with its refusals from `conversation-send-checks.ts`), and its turn
// is the chat assistant's, under the caller's own credential (ISS-17: the turn's grant is the
// intersection of the person's role and the token they reached Forge with). What is added is the
// wait an MCP call can afford: a turn that outlasts it is answered `processing` with its handle, and
// read later by that handle without a second turn. A retried send under the same `clientKey` is
// taken in once: the room's own transport-id column holds the key, checked under the room's lock.

import type { UiPageItem } from '@forge/contracts/ui-actions';
import {
  listableRooms,
  listConversationsInProject,
  refuseConversation,
  writableConversation,
} from '../conversations/index.js';
import { type ConversationMode, conversationModes } from '../db/schema-conversations.js';
import { logger } from '../lib/logger.js';
import {
  askedBy,
  type BotTurn,
  isSettled,
  latestAsked,
  messagesAfter,
  rememberAbout,
  threadIn,
  threadShown,
  turnOf,
} from './bot-thread.js';
import { acceptWebConversationMessage, routeOneWebWindow } from './conversation-send.js';
import { webSendSubject } from './conversation-send-checks.js';
import { isTurnRunning, nothingHereToStop, stopConversationTurns } from './conversation-stops.js';
import { speakerLabelOf } from './read.js';
import { openWebConversation } from './service.js';

/** How long a call waits for a turn by default, and at most: under an MCP client's tool deadline. */
export const BOT_WAIT_DEFAULT_S = 20;
export const BOT_WAIT_MAX_S = 50;
export const BOT_READ_MAX = 100;
/** The modes a thread's first message may name: the room's own. */
export const BOT_MODES = conversationModes;
const POLL_MS = 1_000;
/** The prefix a client's key takes in the room's transport-id column, apart from every transport's own. */
const KEY_PREFIX = 'mcp:';

/** Who calls: the person a token acts for, and that token, which bounds the turn (ISS-17). */
export interface BotCaller {
  userId: string;
  tokenId: string;
}

/** The arguments of one call, as the door judged them; each action reads its own. */
export interface BotArgs {
  projectId: string;
  thread?: string | undefined;
  title?: string | undefined;
  about?: UiPageItem | undefined;
  message?: string | undefined;
  clientKey?: string | undefined;
  mode?: ConversationMode | undefined;
  turn?: string | undefined;
  after?: number | undefined;
  waitSeconds?: number | undefined;
  limit?: number | undefined;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until `done` or the deadline, re-reading every second; the last read is answered either way. */
async function waitFor<T>(
  seconds: number,
  read: () => Promise<T>,
  done: (value: T) => boolean,
  settled?: Promise<unknown>,
): Promise<T> {
  const until = Date.now() + seconds * 1_000;
  let value = await read();
  while (!done(value) && Date.now() < until) {
    await Promise.race([sleep(Math.min(POLL_MS, until - Date.now())), settled]);
    value = await read();
  }
  return value;
}

export async function botThreads(caller: BotCaller, i: BotArgs) {
  const userId = caller.userId;
  const rows = await listConversationsInProject(i.projectId, { archived: false });
  const mine = (await listableRooms(rows, userId)).filter(
    (r) => r.adapter === 'web' && r.shape === 'direct',
  );
  return {
    threads: mine.slice(0, i.limit ?? 20).map(threadShown),
    next: 'bot.open { projectId, thread } resumes one.',
  };
}

export async function botOpen(caller: BotCaller, i: BotArgs) {
  const userId = caller.userId;
  const about = i.about;
  const room = i.thread
    ? await threadIn(i.projectId, i.thread, userId)
    : await openWebConversation({
        projectId: i.projectId,
        title: i.title ?? null,
        ecosystemId: null,
        userId,
        handles: [],
        people: [],
      });
  if (about) rememberAbout(room.id, about);
  const messages = await messagesAfter(room, -1, 10, userId, 'newest');
  const asked = await latestAsked(room);
  return {
    ...threadShown(room),
    resumed: Boolean(i.thread),
    messages,
    cursor: messages.at(-1)?.seq ?? -1,
    turn: asked ? await turnOf(room, asked, userId) : null,
    next: 'bot.send { projectId, thread, message, clientKey } says something in it.',
  };
}

/** The turn and what the room holds after its message, as a send or a read answers them. */
async function answer(
  caller: BotCaller,
  i: BotArgs,
  room: Awaited<ReturnType<typeof threadIn>>,
  turn: BotTurn,
  after: number,
) {
  const messages = await messagesAfter(room, after, i.limit ?? BOT_READ_MAX, caller.userId);
  const processing = !isSettled(turn.state);
  return {
    thread: room.id,
    turn,
    processing,
    messages,
    cursor: messages.at(-1)?.seq ?? after,
    ...(processing
      ? { next: `bot.read { projectId, thread, turn: "${turn.id}", after: cursor, waitSeconds }` }
      : {}),
  };
}

export async function botSend(
  caller: BotCaller,
  i: BotArgs & { thread: string; message: string; clientKey: string },
) {
  const { thread, message, clientKey } = i;
  const userId = caller.userId;
  const about = i.about;
  await threadIn(i.projectId, thread, userId);
  const { conversation, projectId, asking } = await webSendSubject({
    id: thread,
    userId,
    mode: i.mode,
  });
  if (about) rememberAbout(conversation.id, about);

  const accepted = await acceptWebConversationMessage({
    room: { id: conversation.id, externalId: conversation.externalId, shape: conversation.shape },
    projectId,
    userId,
    viaTokenId: caller.tokenId,
    userLabel: await speakerLabelOf(userId),
    content: message,
    mode: asking,
    namedMode: i.mode !== undefined,
    externalMessageId: `${KEY_PREFIX}${clientKey}`,
  });
  if (accepted.kind === 'duplicate' && accepted.content !== message) {
    throw refuseConversation(
      'BOT_CLIENT_KEY_REUSED',
      `clientKey ${clientKey} already sent message ${accepted.messageId} in thread ${thread} with other text; a key names one message, so this one was not taken in — send it under a new key`,
      '/clientKey',
    );
  }
  let settled: Promise<unknown> | undefined;
  if (accepted.kind === 'accepted') {
    // the turn runs on past this call; a core that stops under it leaves its window to the web drain
    settled = routeOneWebWindow(conversation.externalId, `mcp:${userId}`).catch((err: unknown) =>
      logger.error(
        { err, conversationId: conversation.id },
        'forge_bot: routing a sent message failed',
      ),
    );
  }
  const asked = { id: accepted.messageId, seq: accepted.seq };
  const turn = await waitFor(
    i.waitSeconds ?? BOT_WAIT_DEFAULT_S,
    () => turnOf(conversation, asked, userId),
    (t) => isSettled(t.state),
    settled,
  );
  return {
    ...(await answer(caller, i, conversation, turn, accepted.seq)),
    duplicate: accepted.kind === 'duplicate',
  };
}

export async function botRead(caller: BotCaller, i: BotArgs & { thread: string }) {
  const { thread } = i;
  const userId = caller.userId;
  const room = await threadIn(i.projectId, thread, userId);
  const asked = i.turn ? await askedBy(room, i.turn) : await latestAsked(room);
  const after = i.after ?? asked?.seq ?? -1;
  const state = async () => ({
    turn: asked ? await turnOf(room, asked, userId) : null,
    fresh: (await messagesAfter(room, after, 1, userId)).length > 0,
  });
  const seen = await waitFor(
    i.waitSeconds ?? BOT_WAIT_DEFAULT_S,
    state,
    (s) => s.fresh || !s.turn || isSettled(s.turn.state),
  );
  if (!seen.turn) {
    const messages = await messagesAfter(room, after, i.limit ?? BOT_READ_MAX, userId);
    return {
      thread: room.id,
      turn: null,
      processing: false,
      messages,
      cursor: messages.at(-1)?.seq ?? after,
    };
  }
  return answer(caller, i, room, seen.turn, after);
}

export async function botCancel(caller: BotCaller, i: BotArgs & { thread: string }) {
  const { thread } = i;
  const userId = caller.userId;
  await threadIn(i.projectId, thread, userId);
  await writableConversation(thread, userId);
  if (!isTurnRunning(thread)) {
    const refusal = await nothingHereToStop(thread);
    if (refusal) throw refusal;
  }
  return { thread, stopped: stopConversationTurns(thread) };
}
