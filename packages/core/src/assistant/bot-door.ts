// `forge_bot`: an MCP client converses with the Forge bot in a persistent project thread (REQ-91).
//
// No second bot: a thread is a web room, a message is taken in by the very send the Forge UI's chat
// takes (`conversation-send.ts`, with its refusals from `conversation-send-checks.ts`), and its turn
// is the chat assistant's, under the caller's own credential (ISS-17: the turn's grant is the
// intersection of the person's role and the token they reached Forge with). What the door adds is the
// wait an MCP call can afford: a turn that outlasts it is answered `processing` with its handle, and
// read later by that handle without a second turn. A retried send under the same `clientKey` is
// taken in once: the room's own transport-id column holds the key, checked under the room's lock.

import { BOT_TOOL_ACTIONS } from '@forge/contracts/mcp-product';
import { UI_PAGE_ITEM_KINDS, uiPageItemSchema } from '@forge/contracts/ui-actions';
import { z } from 'zod';
import {
  listableRooms,
  listConversationsInProject,
  refuseConversation,
  writableConversation,
} from '../conversations/index.js';
import { conversationModes } from '../db/schema-conversations.js';
import { logger } from '../lib/logger.js';
import { RefusalError, requestRefusals } from '../lib/refusal.js';
import { type ContextScopedMcpToolFactory, type McpContext, zodToMcpSchema } from '../lib/tool.js';
import { need } from '../lib/tool-args.js';
import { byRule, onArg } from '../middleware/declared-permission.js';
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
const WAIT_DEFAULT_S = 20;
const WAIT_MAX_S = 50;
const POLL_MS = 1_000;
const READ_MAX = 100;
/** The prefix a client's key takes in the room's transport-id column, apart from every transport's own. */
const KEY_PREFIX = 'mcp:';

const input = z.strictObject({
  action: z.enum(BOT_TOOL_ACTIONS),
  projectId: z.uuid(),
  thread: z.uuid().optional().describe('open, send, read, cancel: the thread bot.open answered'),
  title: z.string().trim().min(1).max(200).optional().describe('open: a new thread’s title'),
  about: z
    .strictObject({
      kind: z.enum(UI_PAGE_ITEM_KINDS),
      key: z.string().trim().min(1).max(80),
    })
    .optional()
    .describe(
      'open, send: the record the conversation is about, e.g. { kind: "requirement", key: "REQ-90" }',
    ),
  message: z.string().max(40_000).optional().describe('send: what you say'),
  clientKey: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe('send: your own id for this message; a retry under it starts no second turn'),
  mode: z.enum(conversationModes).optional().describe('send: the first message only'),
  turn: z.uuid().optional().describe('read: the turn.id a send answered'),
  after: z.number().int().min(-1).optional().describe('read: the cursor an answer gave'),
  waitSeconds: z.number().int().min(0).max(WAIT_MAX_S).optional(),
  limit: z.number().int().min(1).max(READ_MAX).optional(),
});
type Input = z.infer<typeof input>;

const SHAPE =
  '{ action, projectId, thread?, title?, about?, message?, clientKey?, mode?, turn?, after?, waitSeconds?, limit? }';

const DESCRIPTION = `Converse with the Forge bot (the project's chat assistant, the one in the Forge UI's chat) in a persistent project thread. It answers status questions from live reads of the project as you, naming its sources, and routes work through Feedback, Requirements and triage within your own permissions; you never act as anyone else. A thread is a chat room of the project, readable in the Forge UI too.
- action=threads { projectId, limit? }: your threads in this project, most recent first, to resume one.
- action=open { projectId, thread?, title?, about? }: opens a new thread, or resumes \`thread\`; \`about\` ({ kind: requirement|issue|feedback|release|workflow|mockup, key }) names the record the next turns are about. Answers the thread, its newest messages and \`cursor\`.
- action=send { projectId, thread, message, clientKey, about?, mode?, waitSeconds? }: says \`message\` and waits up to \`waitSeconds\` (default ${WAIT_DEFAULT_S}, at most ${WAIT_MAX_S}) for the bot's turn. Answers \`turn\` { id, state, reason } and the replies so far: state is queued, running, completed, failed or needs-input (the bot asked you something: answer with another send in the same thread). \`processing: true\` means the turn is still working: follow it with bot.read { turn, after: cursor }, never by sending again. \`clientKey\` is your own id for this message: a retry under the same key starts no second turn and answers the first one's; the same key with other text is refused BOT_CLIENT_KEY_REUSED.
- action=read { projectId, thread, turn?, after?, waitSeconds?, limit? }: the messages after \`after\` (the cursor an answer gave), waiting up to \`waitSeconds\` for one, and the state of \`turn\` (default: your newest message's). Reading never starts a turn.
- action=cancel { projectId, thread }: ends the turn this thread is running, where this server runs it; a turn handed to a paired box or another server is refused by name.`;

function parse(args: unknown): Input {
  const parsed = input.safeParse(args);
  if (parsed.success) return parsed.data;
  throw new RefusalError(requestRefusals('BAD_REQUEST', SHAPE, parsed.error), 'BAD_REQUEST', SHAPE);
}

/** `about` judged by the UI's own page-item contract, so a key of the wrong shape is refused by name. */
function aboutOf(i: Input) {
  if (!i.about) return undefined;
  const parsed = uiPageItemSchema.safeParse(i.about);
  if (parsed.success) return parsed.data;
  throw new RefusalError(
    requestRefusals('BAD_REQUEST', '{ kind, key }', parsed.error).map((r) => ({
      ...r,
      path: `/about${r.path}`,
    })),
    'BAD_REQUEST',
  );
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

async function threads(ctx: McpContext, i: Input) {
  const userId = ctx.principal.userId;
  const rows = await listConversationsInProject(i.projectId, { archived: false });
  const mine = (await listableRooms(rows, userId)).filter(
    (r) => r.adapter === 'web' && r.shape === 'direct',
  );
  return {
    threads: mine.slice(0, i.limit ?? 20).map(threadShown),
    next: 'bot.open { projectId, thread } resumes one.',
  };
}

async function open(ctx: McpContext, i: Input) {
  const userId = ctx.principal.userId;
  const about = aboutOf(i);
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
  ctx: McpContext,
  i: Input,
  room: Awaited<ReturnType<typeof threadIn>>,
  turn: BotTurn,
  after: number,
) {
  const messages = await messagesAfter(room, after, i.limit ?? READ_MAX, ctx.principal.userId);
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

async function send(ctx: McpContext, i: Input) {
  const { thread, message, clientKey } = need(i, 'send', 'thread', 'message', 'clientKey');
  if (message.trim().length === 0) {
    throw new RefusalError(
      [
        {
          code: 'BAD_REQUEST',
          path: '/message',
          detail: 'send: a message carries text, and this one is empty',
        },
      ],
      'BAD_REQUEST',
    );
  }
  const userId = ctx.principal.userId;
  const about = aboutOf(i);
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
    viaTokenId: ctx.principal.tokenId,
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
    i.waitSeconds ?? WAIT_DEFAULT_S,
    () => turnOf(conversation, asked, userId),
    (t) => isSettled(t.state),
    settled,
  );
  return {
    ...(await answer(ctx, i, conversation, turn, accepted.seq)),
    duplicate: accepted.kind === 'duplicate',
  };
}

async function read(ctx: McpContext, i: Input) {
  const { thread } = need(i, 'read', 'thread');
  const userId = ctx.principal.userId;
  const room = await threadIn(i.projectId, thread, userId);
  const asked = i.turn ? await askedBy(room, i.turn) : await latestAsked(room);
  const after = i.after ?? asked?.seq ?? -1;
  const state = async () => ({
    turn: asked ? await turnOf(room, asked, userId) : null,
    fresh: (await messagesAfter(room, after, 1, userId)).length > 0,
  });
  const seen = await waitFor(
    i.waitSeconds ?? WAIT_DEFAULT_S,
    state,
    (s) => s.fresh || !s.turn || isSettled(s.turn.state),
  );
  if (!seen.turn) {
    const messages = await messagesAfter(room, after, i.limit ?? READ_MAX, userId);
    return {
      thread: room.id,
      turn: null,
      processing: false,
      messages,
      cursor: messages.at(-1)?.seq ?? after,
    };
  }
  return answer(ctx, i, room, seen.turn, after);
}

async function cancel(ctx: McpContext, i: Input) {
  const { thread } = need(i, 'cancel', 'thread');
  const userId = ctx.principal.userId;
  await threadIn(i.projectId, thread, userId);
  await writableConversation(thread, userId);
  if (!isTurnRunning(thread)) {
    const refusal = await nothingHereToStop(thread);
    if (refusal) throw refusal;
  }
  return { thread, stopped: stopConversationTurns(thread) };
}

const ROOM_RULE = 'conversations/access.ts';

export const forgeBotTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_bot',
  description: DESCRIPTION,
  inputSchema: zodToMcpSchema(input),
  reach: 'project',
  route: '/api/conversations',
  grant: {
    byAction: {
      threads: 'assistant:read',
      read: 'assistant:read',
      open: 'assistant:write',
      send: 'assistant:write',
      cancel: 'assistant:write',
    },
  },
  // the REST twins: GET/POST /api/conversations and /api/conversations/:id/messages|stop
  permission: {
    byAction: {
      threads: onArg('project.read'),
      open: onArg('project.write'),
      read: byRule(
        `${ROOM_RULE}:readableConversation`,
        'a reader of the thread: a role reaching its project, and only its own people',
        { permission: 'project.read', on: { arg: 'projectId' } },
      ),
      send: byRule(
        `${ROOM_RULE}:writableConversation`,
        'a writer in the thread: a writing role on its project, and only its own people',
        { permission: 'project.write', on: { arg: 'projectId' } },
      ),
      cancel: byRule(
        `${ROOM_RULE}:writableConversation`,
        'a writer in the thread: a writing role on its project, and only its own people',
        { permission: 'project.write', on: { arg: 'projectId' } },
      ),
    },
  },
  handler: async (args) => {
    const i = parse(args);
    if (i.action === 'threads') return threads(ctx, i);
    if (i.action === 'open') return open(ctx, i);
    if (i.action === 'send') return send(ctx, i);
    if (i.action === 'read') return read(ctx, i);
    return cancel(ctx, i);
  },
});
