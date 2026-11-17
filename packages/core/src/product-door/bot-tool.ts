// `forge_bot`: an MCP client converses with the Forge bot in a persistent project thread (REQ-91).
// The door judges the input and declares what each action needs; the thread, its turns and the wait
// are the assistant's own (`assistant/bot-actions.ts`), over the room the Forge UI's chat uses.

import type { CapabilityCardBody } from '@forge/contracts/capability-cards';
import { BOT_TOOL_ACTIONS } from '@forge/contracts/mcp-product';
import { UI_PAGE_ITEM_KINDS, uiPageItemSchema } from '@forge/contracts/ui-actions';
import { z } from 'zod';
import {
  BOT_MODES,
  BOT_READ_MAX,
  BOT_WAIT_DEFAULT_S,
  BOT_WAIT_MAX_S,
  type BotArgs,
  botCancel,
  botOpen,
  botRead,
  botSend,
  botThreads,
} from '../assistant/index.js';
import { RefusalError, requestRefusals } from '../lib/refusal.js';
import { type ContextScopedMcpToolFactory, sourceOf, zodToMcpSchema } from '../lib/tool.js';
import { need } from '../lib/tool-args.js';
import { byRule, onArg } from '../permissions/index.js';

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
  mode: z.enum(BOT_MODES).optional().describe('send: the first message only'),
  turn: z.uuid().optional().describe('read: the turn.id a send answered'),
  after: z.number().int().min(-1).optional().describe('read: the cursor an answer gave'),
  waitSeconds: z.number().int().min(0).max(BOT_WAIT_MAX_S).optional(),
  limit: z.number().int().min(1).max(BOT_READ_MAX).optional(),
});
type Input = z.infer<typeof input>;

const SHAPE =
  '{ action, projectId, thread?, title?, about?, message?, clientKey?, mode?, turn?, after?, waitSeconds?, limit? }';

const DESCRIPTION = `Converse with the Forge bot (the project's chat assistant, the one in the Forge UI's chat) in a persistent project thread. It answers status questions from live reads of the project as you, naming its sources, and routes work through Feedback, Requirements and triage within your own permissions; you never act as anyone else. A thread is a chat room of the project, readable in the Forge UI too.
- action=threads { projectId, limit? }: your threads in this project, most recent first, to resume one.
- action=open { projectId, thread?, title?, about? }: opens a new thread, or resumes \`thread\`; \`about\` ({ kind: requirement|issue|feedback|release|workflow|mockup, key }) names the record the next turns are about. Answers the thread, its newest messages and \`cursor\`.
- action=send { projectId, thread, message, clientKey, about?, mode?, waitSeconds? }: says \`message\` and waits up to \`waitSeconds\` (default ${BOT_WAIT_DEFAULT_S}, at most ${BOT_WAIT_MAX_S}) for the bot's turn. Answers \`turn\` { id, state, reason } and the replies so far: state is queued, running, completed, failed or needs-input (the bot asked you something: answer with another send in the same thread). \`processing: true\` means the turn is still working: follow it with bot.read { turn, after: cursor }, never by sending again. \`clientKey\` is your own id for this message: a retry under the same key starts no second turn and answers the first one's; the same key with other text is refused BOT_CLIENT_KEY_REUSED.
- action=read { projectId, thread, turn?, after?, waitSeconds?, limit? }: the messages after \`after\` (the cursor an answer gave), waiting up to \`waitSeconds\` for one, and the state of \`turn\` (default: your newest message's). Reading never starts a turn.
- action=cancel { projectId, thread }: ends the turn this thread is running, here or on the paired box answering it; a turn another server runs is refused by name.`;

/**
 * When a product role reaches for the Forge bot (ISS-1251), from how it was taught (`product-role`)
 * and used over MCP (FB-600, ISS-1189): a report or a job of several steps, never a single read.
 */
const CARDS = {
  threads: {
    purpose: 'Lists your own threads with the Forge bot in this project, most recent first.',
    situations: [
      {
        when: 'a person wants to go on with a conversation they had with the bot earlier, here or in the Forge UI chat',
        do: 'read threads, then bot.open with that thread, so the bot keeps what was already said',
      },
    ],
    practice: ['A thread is a chat room of the project: the same one the Forge UI chat shows.'],
    example: { projectId: '<project uuid>', limit: 10 },
    redFlag:
      'Opening a new thread to follow up on one already under way, so the bot loses what was said.',
    family: 'product.bot',
    audience: ['person'],
    scenarios: ['a follow-up with the bot opened in its earlier thread'],
  },
  open: {
    purpose: 'Opens a thread with the Forge bot, or resumes one, optionally about one record.',
    situations: [
      {
        when: 'a person wants a report drawn from several reads, or a job of several steps no single action does',
        do: 'open a thread (about the requirement, issue, release or feedback item it concerns), then bot.send the ask',
        watch:
          'for one read or one write, call that action yourself: it is cheaper and answers the same',
      },
      {
        when: 'a person wants to follow up on a conversation already under way',
        do: 'open with the thread bot.threads or an earlier open answered, never a new one',
      },
    ],
    practice: [
      'about takes { kind, key } with the key a person reads (REQ-90, ISS-12, FB-600), and scopes the next turns.',
    ],
    example: {
      projectId: '<project uuid>',
      title: 'REQ-90 blockers',
      about: { kind: 'requirement', key: 'REQ-90' },
    },
    redFlag: 'Opening a bot thread for one read or one write the action itself does.',
    family: 'product.bot',
    audience: ['person'],
    scenarios: ['a report drawn from several reads asked of the bot in a thread'],
  },
  send: {
    purpose: 'Says one message to the Forge bot in a thread and waits a while for its turn.',
    situations: [
      {
        when: 'a person asks for a status report, a draft from a thread, or to act on what waits on them, and a thread is open',
        do: 'send the ask in their words with a clientKey of your own, and relay the replies with the source each names',
        // ISS-1189: the bot said no release record existed for the live version while the list held it
        watch:
          'a "none" or "not available" in the reply is checked against the read it names (releases.get) before you repeat it',
      },
      {
        when: 'the turn answered state needs-input: the bot asked something back',
        do: 'put its question to the person and send their answer in the same thread',
      },
      {
        when: 'a send answered processing: true, or your call timed out',
        do: 'follow the turn with bot.read { turn, after: cursor }; never send it again',
      },
    ],
    practice: [
      'The bot acts as you, within your permissions: it cannot do what your credential cannot.',
      'A retry under the same clientKey starts no second turn and answers the first one.',
    ],
    example: {
      projectId: '<project uuid>',
      thread: '<thread uuid>',
      message: 'Which release is live right now, and what did it ship?',
      clientKey: 'live-release-1',
      waitSeconds: 30,
    },
    // bot-actions.ts BOT_CLIENT_KEY_REUSED, written for REQ-91 BC-6 (ISS-1115): one key reused for a new message
    redFlag:
      'Reusing one clientKey for a different message: it is refused BOT_CLIENT_KEY_REUSED and the message is not taken in; each new message takes a new key.',
    family: 'product.bot',
    audience: ['person'],
    scenarios: ['one clientKey reused for a new message: BOT_CLIENT_KEY_REUSED (ISS-1115)'],
  },
  read: {
    purpose: 'Reads the messages after a cursor in a bot thread, and the state of a turn.',
    situations: [
      {
        when: 'a send answered processing: true, or the person asks whether the bot has answered yet',
        do: 'read with the turn id and the cursor the send gave, waiting up to waitSeconds; reading never starts a turn',
      },
      {
        when: 'you resume a thread and need what was said since you last read it',
        do: 'read after the cursor you last held, and page with limit',
      },
    ],
    practice: [
      'A turn is queued, running, completed, failed or needs-input: answer needs-input with bot.send in the same thread.',
    ],
    example: {
      projectId: '<project uuid>',
      thread: '<thread uuid>',
      turn: '<turn uuid>',
      after: 12,
      waitSeconds: 30,
    },
    redFlag: 'Sending the message again while its turn is processing, where read follows it.',
    family: 'product.bot',
    audience: ['person'],
    scenarios: ['a bot turn still processing followed with read, never sent again'],
  },
  cancel: {
    purpose: 'Ends the turn a bot thread is running, where this server runs it.',
    situations: [
      {
        when: 'a person tells you to stop what the bot is doing, or the running turn works on an ask they have since changed',
        do: 'cancel the thread’s turn, then send the corrected ask as a new message',
        watch:
          'a turn handed to a paired box or another server is refused by name: tell the person it runs on there',
      },
    ],
    practice: [
      'Cancel stops the turn, not what it already wrote: read the thread for what it did.',
    ],
    example: { projectId: '<project uuid>', thread: '<thread uuid>' },
    redFlag:
      'Reading a cancel as undoing the turn: what it already wrote stays, so read the thread.',
    family: 'product.bot',
    audience: ['person'],
    scenarios: ['a bot turn working on a changed ask cancelled, then the new ask sent'],
  },
} satisfies Record<(typeof BOT_TOOL_ACTIONS)[number], CapabilityCardBody>;

function parse(args: unknown): Input {
  const parsed = input.safeParse(args);
  if (parsed.success) return parsed.data;
  throw new RefusalError(requestRefusals('BAD_REQUEST', SHAPE, parsed.error), 'BAD_REQUEST', SHAPE);
}

/** The arguments as the assistant takes them: `about` judged by the UI's own page-item contract. */
function argsOf(i: Input): BotArgs {
  const { action: _action, about, ...rest } = i;
  if (!about) return rest;
  const parsed = uiPageItemSchema.safeParse(about);
  if (parsed.success) return { ...rest, about: parsed.data };
  throw new RefusalError(
    requestRefusals('BAD_REQUEST', '{ kind, key }', parsed.error).map((r) => ({
      ...r,
      path: `/about${r.path}`,
    })),
    'BAD_REQUEST',
  );
}

const ROOM_RULE = 'conversations/access.ts';

export const forgeBotTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_bot',
  description: DESCRIPTION,
  inputSchema: zodToMcpSchema(input),
  cards: CARDS,
  source: sourceOf(import.meta.url),
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
  handler: async (raw) => {
    const i = parse(raw);
    const caller = { userId: ctx.principal.userId, tokenId: ctx.principal.tokenId };
    const args = argsOf(i);
    if (i.action === 'threads') return botThreads(caller, args);
    if (i.action === 'open') return botOpen(caller, args);
    if (i.action === 'send') {
      const sent = need(i, 'send', 'thread', 'message', 'clientKey');
      if (sent.message.trim().length === 0) {
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
      return botSend(caller, {
        ...args,
        thread: sent.thread,
        message: sent.message,
        clientKey: sent.clientKey,
      });
    }
    const { thread } = need(i, i.action, 'thread');
    if (i.action === 'read') return botRead(caller, { ...args, thread });
    return botCancel(caller, { ...args, thread });
  },
});
