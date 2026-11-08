// `forge_bot`: an MCP client converses with the Forge bot in a persistent project thread (REQ-91).
// The door judges the input and declares what each action needs; the thread, its turns and the wait
// are the assistant's own (`assistant/bot-actions.ts`), over the room the Forge UI's chat uses.

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
import { type ContextScopedMcpToolFactory, zodToMcpSchema } from '../lib/tool.js';
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
- action=cancel { projectId, thread }: ends the turn this thread is running, where this server runs it; a turn handed to a paired box or another server is refused by name.`;

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
