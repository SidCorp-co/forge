/**
 * The bounded `rocketchat_quote_context` chat tool: a quoted message's neighbours either side,
 * every bound enforced here and none by the model (ISS-1087).
 */

import type { ChatTool } from '../../integrations/llm/index.js';
import {
  fetchMessage,
  fetchMessagesBeside,
  fetchThreadMessages,
  type RocketChatRestAuth,
  type RocketChatRestMessage,
} from '../../integrations/rocketchat/index.js';
import type { CallToolResult } from '../../lib/tool-result.js';
import { type ChatToolset, toolError } from '../tools/mcp-adapter.js';
import { clip, MESSAGE_CHAR_CAP, readToolArgs } from './context.js';

const QUOTE_CONTEXT_TOOL_NAME = 'rocketchat_quote_context';
const QUOTE_TARGETS_PER_TURN = 2;
const QUOTE_NEIGHBOURS_EACH_SIDE = 2;
const QUOTE_MESSAGES_PER_TURN = 10;
const QUOTE_TOKENS_PER_TURN = 2000;
/** Replies fetched for a thread anchor; an anchor past this page is a stated limitation. */
const QUOTE_THREAD_PAGE = 50;

const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

interface QuoteNeighbourhood {
  before: RocketChatRestMessage[];
  after: RocketChatRestMessage[];
  limitation: string | null;
}

async function threadNeighbourhood(
  auth: RocketChatRestAuth,
  anchor: RocketChatRestMessage & { tmid: string },
): Promise<QuoteNeighbourhood> {
  const [root, replies] = await Promise.all([
    fetchMessage(auth, anchor.tmid),
    fetchThreadMessages(auth, anchor.tmid, QUOTE_THREAD_PAGE),
  ]);
  if (replies === null) {
    return {
      before: [],
      after: [],
      limitation:
        'the thread’s replies could not be read from the server, so the quoted message’s neighbours are missing',
    };
  }
  const thread = root ? [root, ...replies] : replies;
  const at = thread.findIndex((m) => m.id === anchor.id);
  if (at < 0) {
    return {
      before: [],
      after: [],
      limitation: `the quoted message lies beyond the first ${QUOTE_THREAD_PAGE} replies of its thread, so its neighbours could not be read`,
    };
  }
  const after = thread.slice(at + 1, at + 1 + QUOTE_NEIGHBOURS_EACH_SIDE);
  const limits: string[] = [];
  if (!root && at < QUOTE_NEIGHBOURS_EACH_SIDE)
    limits.push(
      'the thread’s root could not be read, so what stood before its first replies is missing',
    );
  if (replies.length >= QUOTE_THREAD_PAGE && after.length < QUOTE_NEIGHBOURS_EACH_SIDE)
    limits.push(
      `the thread was read to its first ${QUOTE_THREAD_PAGE} replies and the quoted message sits at the end of that page, so later replies may be missing`,
    );
  return {
    before: thread.slice(Math.max(0, at - QUOTE_NEIGHBOURS_EACH_SIDE), at),
    after,
    limitation: limits.length ? limits.join('; ') : null,
  };
}

async function roomNeighbourhood(
  auth: RocketChatRestAuth,
  anchor: RocketChatRestMessage,
  rid: string,
): Promise<QuoteNeighbourhood> {
  const [before, after] = await Promise.all([
    fetchMessagesBeside(auth, rid, anchor.ts, 'before', QUOTE_NEIGHBOURS_EACH_SIDE),
    fetchMessagesBeside(auth, rid, anchor.ts, 'after', QUOTE_NEIGHBOURS_EACH_SIDE),
  ]);
  const refused = [before === null ? 'before' : null, after === null ? 'after' : null].filter(
    (s): s is 'before' | 'after' => s !== null,
  );
  return {
    before: before ?? [],
    after: after ?? [],
    limitation: refused.length
      ? `the room refused the read of the messages ${refused.join(' and ')} it, so that side is missing here rather than empty`
      : null,
  };
}

const shape = (m: RocketChatRestMessage) => ({
  id: m.id,
  user: m.username,
  ts: m.ts,
  text: clip(m.text, MESSAGE_CHAR_CAP),
});

/** The anchor, then its neighbours nearest first, kept while the turn's budget allows. */
function fitToBudget(
  anchor: RocketChatRestMessage,
  hood: QuoteNeighbourhood,
  messagesUsed: number,
  tokensUsed: number,
): { kept: RocketChatRestMessage[]; tokens: number; cut: boolean } {
  const ranked = [
    anchor,
    ...[...hood.before].reverse().flatMap((b, i) => (hood.after[i] ? [b, hood.after[i]] : [b])),
    ...hood.after.slice(hood.before.length),
  ] as RocketChatRestMessage[];
  const kept: RocketChatRestMessage[] = [];
  let tokens = 0;
  let cut = false;
  for (const m of ranked) {
    const cost = estimateTokens(clip(m.text, MESSAGE_CHAR_CAP));
    if (
      messagesUsed + kept.length >= QUOTE_MESSAGES_PER_TURN ||
      tokensUsed + tokens + cost > QUOTE_TOKENS_PER_TURN
    ) {
      cut = true;
      continue;
    }
    kept.push(m);
    tokens += cost;
  }
  return { kept, tokens, cut };
}

/**
 * Expand a quoted message to the two messages either side of it, bounded per turn.
 */
export function buildRocketChatQuoteContextToolset(
  auth: RocketChatRestAuth,
  rid: string,
): ChatToolset {
  const tool: ChatTool = {
    type: 'function',
    function: {
      name: QUOTE_CONTEXT_TOOL_NAME,
      description: `Read the two messages before and after a QUOTED message in THIS room (the quote itself is already in your context). Use when a quote like "this is still wrong" only makes sense with what was said around it. At most ${QUOTE_TARGETS_PER_TURN} quoted messages per turn and ${QUOTE_MESSAGES_PER_TURN} messages in total; neighbours' own quotes are not expanded.`,
      parameters: {
        type: 'object',
        properties: {
          messageId: {
            type: 'string',
            description: 'The id of the quoted message — the `msg=` value of its quote link.',
          },
        },
        required: ['messageId'],
        additionalProperties: false,
      },
    },
  };

  const targets = new Set<string>();
  let messagesUsed = 0;
  let tokensUsed = 0;

  async function execute(name: string, argsJson: string): Promise<CallToolResult> {
    if (name !== QUOTE_CONTEXT_TOOL_NAME) return toolError(`unknown tool "${name}"`);
    const read = readToolArgs<{ messageId?: unknown }>(argsJson);
    if ('error' in read) return toolError(read.error);
    const messageId = typeof read.args.messageId === 'string' ? read.args.messageId.trim() : '';
    if (!messageId) return toolError(`${QUOTE_CONTEXT_TOOL_NAME} needs a \`messageId\``);
    if (!targets.has(messageId) && targets.size >= QUOTE_TARGETS_PER_TURN) {
      return toolError(
        `${QUOTE_CONTEXT_TOOL_NAME} is capped at ${QUOTE_TARGETS_PER_TURN} quoted messages per turn — answer with what you have`,
      );
    }
    if (messagesUsed >= QUOTE_MESSAGES_PER_TURN || tokensUsed >= QUOTE_TOKENS_PER_TURN) {
      return toolError(
        `${QUOTE_CONTEXT_TOOL_NAME} has spent its ${QUOTE_MESSAGES_PER_TURN}-message / ${QUOTE_TOKENS_PER_TURN}-token budget for this turn — answer with what you have`,
      );
    }
    targets.add(messageId);

    const anchor = await fetchMessage(auth, messageId);
    if (!anchor) {
      return toolError(`message ${messageId} was not found, or the bot cannot see it`);
    }
    if (anchor.rid !== rid) {
      return toolError(
        anchor.rid === undefined
          ? `the server did not say which room message ${messageId} is in, so it cannot be read as this room's`
          : `message ${messageId} is not in this room; only this room's messages can be expanded`,
      );
    }
    const hood = anchor.tmid
      ? await threadNeighbourhood(auth, { ...anchor, tmid: anchor.tmid })
      : await roomNeighbourhood(auth, anchor, rid);

    const fit = fitToBudget(anchor, hood, messagesUsed, tokensUsed);
    messagesUsed += fit.kept.length;
    tokensUsed += fit.tokens;
    const messages = fit.kept.sort((a, b) => a.ts.localeCompare(b.ts)).map(shape);
    const limitation =
      [
        hood.limitation,
        fit.cut
          ? `the neighbourhood was cut to fit this turn's budget of ${QUOTE_MESSAGES_PER_TURN} messages / ${QUOTE_TOKENS_PER_TURN} tokens`
          : null,
      ]
        .filter((l): l is string => l !== null)
        .join('; ') || null;
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            anchor: anchor.id,
            messages,
            ...(limitation ? { limitation } : {}),
          }),
        },
      ],
    };
  }

  return { tools: [tool], execute, ranAs: () => null };
}
