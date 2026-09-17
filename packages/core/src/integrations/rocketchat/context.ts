/**
 * ISS-609 — conversation-context seeding + the bounded `rocketchat_history` chat tool. A turn is
 * SEEDED with the last ~20 room messages (plus the full thread when threaded); deeper recall
 * is agentic — the model gets `rocketchat_history` (50 msgs/call, 3 calls/turn) and decides itself.
 */

import type { ChatTool } from '../../assistant/providers/types.js';
import { type ChatToolset, toolError } from '../../assistant/tools/mcp-adapter.js';
import type { CallToolResult } from '../../mcp/tool-result.js';
import {
  buildMessagePermalink,
  fetchMessage,
  fetchMessagesBeside,
  fetchRoomHistory,
  fetchThreadMessages,
  type RocketChatRestAuth,
  type RocketChatRestMessage,
} from './rest-client.js';

export const SEED_MESSAGE_COUNT = 20;
const HISTORY_MAX_PER_CALL = 50;
const HISTORY_MAX_CALLS_PER_TURN = 3;
/** Per-message + whole-block caps so a pasted log can't blow up the prompt. */
const MESSAGE_CHAR_CAP = 600;
const BLOCK_CHAR_CAP = 10_000;

function clip(s: string, cap: number): string {
  return s.length > cap ? `${s.slice(0, cap)}… [truncated]` : s;
}

/** A quote-reply (`[ ](…?msg=<id>)`) embeds only the parent's `msg` snippet and loses its attachments; these ids let the seed fetch the referenced messages in full. */
const QUOTED_MSG_ID_RE = /\?msg=([A-Za-z0-9]+)/g;
const MAX_QUOTED_FETCHES = 3;

export function extractQuotedMessageIds(
  texts: Array<string | undefined>,
  exclude: ReadonlySet<string>,
): string[] {
  const ids: string[] = [];
  for (const text of texts) {
    if (!text) continue;
    for (const match of text.matchAll(QUOTED_MSG_ID_RE)) {
      const id = match[1] as string;
      if (!exclude.has(id) && !ids.includes(id)) ids.push(id);
      if (ids.length >= MAX_QUOTED_FETCHES) return ids;
    }
  }
  return ids;
}

/** Render REST messages as `[user]: text` lines (oldest first), dropping system messages, the bot's own replies unless `includeBot`, empty bodies and the messages that triggered this turn. Null when nothing remains. */
// cm:guard a SET of ids and not one, because a turn is now taken over a window of messages rather than over the single one that named the bot: excluding only the newest would seed the model with the rest of its own question, which it is about to be shown again as its own transcript (ISS-1004).
export function formatConversationLines(
  messages: RocketChatRestMessage[],
  opts: { botUserId: string; excludeMessageIds?: readonly string[]; includeBot?: boolean },
): string | null {
  const excluded = new Set(opts.excludeMessageIds ?? []);
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const m of messages) {
    if (m.isSystem || (m.userId === opts.botUserId && !opts.includeBot)) continue;
    if (excluded.has(m.id) || seen.has(m.id)) continue;
    if (!m.text.trim()) continue;
    seen.add(m.id);
    lines.push(`[${m.username}]: ${clip(m.text.trim(), MESSAGE_CHAR_CAP)}`);
  }
  if (lines.length === 0) return null;
  let block = lines.join('\n');
  // cm:guard keep the TAIL, never the head — the newest lines are the ones the turn is about, so slicing the other way hands the model a transcript that stops before the question it was asked
  if (block.length > BLOCK_CHAR_CAP)
    block = `… [older messages truncated]\n${block.slice(-BLOCK_CHAR_CAP)}`;
  return block;
}

/** Seed context for one turn: last {@link SEED_MESSAGE_COUNT} room messages plus the full thread when threaded. Best-effort — a fetch failure degrades to null. */
export async function buildConversationContext(
  auth: RocketChatRestAuth,
  opts: {
    rid: string;
    tmid?: string | undefined;
    /** The messages this turn was triggered by, newest last; excluded from the seed. */
    excludeMessageIds: readonly string[];
    /** The triggering text — scanned for quote-links so the quoted
     *  messages can be fetched in full. */
    triggerText?: string | undefined;
  },
): Promise<string | null> {
  // cm:guard the permalink anchors on the NEWEST triggering message, which is the one a person clicking the link expects to land on; a window's oldest message would open the room scrolled above the thing that was actually answered (ISS-1004).
  const newest = opts.excludeMessageIds[opts.excludeMessageIds.length - 1];
  try {
    const [room, thread, threadRoot, permalink] = await Promise.all([
      fetchRoomHistory(auth, opts.rid, { count: SEED_MESSAGE_COUNT }),
      opts.tmid ? fetchThreadMessages(auth, opts.tmid, HISTORY_MAX_PER_CALL) : Promise.resolve([]),
      // cm:why getThreadMessages returns REPLIES only — without the root message, "the task above" in a threaded mention resolves against unrelated room noise
      opts.tmid ? fetchMessage(auth, opts.tmid) : Promise.resolve(null),
      // cm:why the model can only cite the chat if the permalink is handed to it, so an issue the bot files carries a source link rather than a description of where it came from.
      newest || opts.tmid
        ? buildMessagePermalink(auth, opts.rid, opts.tmid ?? (newest as string)).catch(() => null)
        : Promise.resolve(null),
    ]);
    // cm:why a quote-reply carries only the parent's `msg` snippet, so the referenced messages are fetched in full or a quoted webhook card's body and task link never reach the model
    const quotedIds = extractQuotedMessageIds(
      [opts.triggerText, threadRoot?.text, ...thread.map((t) => t.text)],
      new Set([...opts.excludeMessageIds, ...(opts.tmid ? [opts.tmid] : [])]),
    );
    const quoted = (await Promise.all(quotedIds.map((id) => fetchMessage(auth, id)))).filter(
      (q): q is RocketChatRestMessage => q !== null,
    );

    const roomBlock = formatConversationLines(room, {
      botUserId: auth.userId,
      excludeMessageIds: opts.excludeMessageIds,
    });
    const threadMessages = threadRoot ? [threadRoot, ...thread] : thread;
    const threadBlock =
      threadMessages.length > 0
        ? formatConversationLines(threadMessages, {
            botUserId: auth.userId,
            excludeMessageIds: opts.excludeMessageIds,
            // The bot's earlier replies in the thread are part of the dialogue.
            includeBot: true,
          })
        : null;
    const parts: string[] = [];
    if (permalink) {
      parts.push(
        `Permalink to this conversation (cite it as the source when you file an issue): ${permalink}`,
      );
    }
    // Thread first — it is what the user is talking about; the room stream is
    // background and often webhook noise.
    if (threadBlock) {
      parts.push(
        `The message was posted INSIDE A THREAD — the thread below (root message first) is what the user is referring to:\n${threadBlock}`,
      );
    }
    const quotedBlock =
      quoted.length > 0
        ? formatConversationLines(quoted, { botUserId: auth.userId, includeBot: true })
        : null;
    if (quotedBlock) {
      parts.push(
        `Full content of the message(s) QUOTED in the conversation (the quote itself only carries a snippet):\n${quotedBlock}`,
      );
    }
    if (roomBlock) {
      parts.push(
        threadBlock
          ? `Recent channel messages (background only — may be unrelated to the thread):\n${roomBlock}`
          : `Recent channel messages (oldest first):\n${roomBlock}`,
      );
    }
    return parts.length > 0 ? parts.join('\n\n') : null;
  } catch {
    return null;
  }
}

/** Page back through THIS room's history; `rid` is pinned server-side and calls are capped per turn. */
export function buildRocketChatHistoryToolset(auth: RocketChatRestAuth, rid: string): ChatToolset {
  const tool: ChatTool = {
    type: 'function',
    function: {
      name: 'rocketchat_history',
      description: `Page back through older messages in THIS Rocket.Chat room (the recent messages are already in your context). Use when the discussion references older matter before concluding. Returns up to ${HISTORY_MAX_PER_CALL} messages oldest-first; pass "before" (an ISO timestamp, e.g. the oldest you have seen) to go further back. Max ${HISTORY_MAX_CALLS_PER_TURN} calls per turn.`,
      parameters: {
        type: 'object',
        properties: {
          before: {
            type: 'string',
            description: 'Only return messages older than this ISO timestamp.',
          },
          count: {
            type: 'number',
            description: `How many messages (1-${HISTORY_MAX_PER_CALL}, default ${HISTORY_MAX_PER_CALL}).`,
          },
        },
      },
    },
  };

  let calls = 0;
  async function execute(name: string, argsJson: string): Promise<CallToolResult> {
    if (name !== 'rocketchat_history') return toolError(`unknown tool "${name}"`);
    calls += 1;
    if (calls > HISTORY_MAX_CALLS_PER_TURN) {
      return toolError(
        `rocketchat_history is capped at ${HISTORY_MAX_CALLS_PER_TURN} calls per turn — answer with what you have`,
      );
    }
    let args: { before?: string; count?: number } = {};
    try {
      args = argsJson.trim() ? (JSON.parse(argsJson) as typeof args) : {};
    } catch {
      return toolError('arguments were not valid JSON');
    }
    const count = Math.min(
      Math.max(1, typeof args.count === 'number' ? Math.floor(args.count) : HISTORY_MAX_PER_CALL),
      HISTORY_MAX_PER_CALL,
    );
    const messages = await fetchRoomHistory(auth, rid, {
      count,
      before: typeof args.before === 'string' ? args.before : undefined,
    });
    const page = {
      messages: messages
        .filter((m) => !m.isSystem && m.text.trim().length > 0)
        .map((m) => ({ ts: m.ts, user: m.username, text: clip(m.text, MESSAGE_CHAR_CAP) })),
      oldestTs: messages[0]?.ts ?? null,
    };
    return { content: [{ type: 'text', text: JSON.stringify(page) }] };
  }

  return { tools: [tool], execute };
}

/** The quote-neighbour tool's bounds, every one enforced here and none by the model (ISS-1087). */
export const QUOTE_CONTEXT_TOOL_NAME = 'rocketchat_quote_context';
export const QUOTE_TARGETS_PER_TURN = 2;
export const QUOTE_NEIGHBOURS_EACH_SIDE = 2;
export const QUOTE_MESSAGES_PER_TURN = 10;
export const QUOTE_TOKENS_PER_TURN = 2000;
/** Replies fetched for a thread anchor; an anchor past this page is a stated limitation. */
const QUOTE_THREAD_PAGE = 50;

const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

interface QuoteNeighbourhood {
  before: RocketChatRestMessage[];
  after: RocketChatRestMessage[];
  limitation: string | null;
}

// cm:guard the THREAD is preferred when the anchor sits in one: "this is still wrong" quoted from a thread means the two replies before it in that thread, and the room stream around the same instant is other people's conversation. The root is put first so an anchor that is the first reply still has a neighbour before it.
async function threadNeighbourhood(
  auth: RocketChatRestAuth,
  anchor: RocketChatRestMessage & { tmid: string },
): Promise<QuoteNeighbourhood> {
  const [root, replies] = await Promise.all([
    fetchMessage(auth, anchor.tmid),
    fetchThreadMessages(auth, anchor.tmid, QUOTE_THREAD_PAGE),
  ]);
  const thread = root ? [root, ...replies] : replies;
  const at = thread.findIndex((m) => m.id === anchor.id);
  if (at < 0) {
    return {
      before: [],
      after: [],
      limitation: `the quoted message lies beyond the first ${QUOTE_THREAD_PAGE} replies of its thread, so its neighbours could not be read`,
    };
  }
  return {
    before: thread.slice(Math.max(0, at - QUOTE_NEIGHBOURS_EACH_SIDE), at),
    after: thread.slice(at + 1, at + 1 + QUOTE_NEIGHBOURS_EACH_SIDE),
    limitation: null,
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
  return { before, after, limitation: null };
}

/**
 * Expand a quoted message to the two messages either side of it, bounded per turn.
 */
// cm:guard a TOOL and not automatic inclusion, with every bound enforced HERE: two targets a turn, two neighbours a side, ten messages and ~2000 estimated tokens across all expansions, no expansion of a neighbour's own quotes, and an anchor outside the pinned room refused by name. A bound the model is asked to keep is not a bound, and unavailable material is a stated limitation and never a guessed neighbour (ISS-1087 criteria 25-31, 36).
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
    let args: { messageId?: unknown } = {};
    try {
      args = argsJson.trim() ? (JSON.parse(argsJson) as typeof args) : {};
    } catch {
      return toolError('arguments were not valid JSON');
    }
    const messageId = typeof args.messageId === 'string' ? args.messageId.trim() : '';
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
    // cm:guard the anchor's room is checked on EVERY fetch and an outsider is refused by name with nothing of it returned: a message id is global on a Rocket.Chat server, and a quote link pasted from another room would otherwise read that room's text into this one (ISS-1087 criterion 29).
    if (anchor.rid !== undefined && anchor.rid !== rid) {
      return toolError(
        `message ${messageId} is not in this room; only this room's messages can be expanded`,
      );
    }
    const hood = anchor.tmid
      ? await threadNeighbourhood(auth, { ...anchor, tmid: anchor.tmid })
      : await roomNeighbourhood(auth, anchor, rid);

    const shape = (m: RocketChatRestMessage) => ({
      id: m.id,
      user: m.username,
      ts: m.ts,
      text: clip(m.text, MESSAGE_CHAR_CAP),
    });
    // cm:guard the anchor is admitted first and the neighbours nearest it next, so a budget that cuts the set cuts the FARTHEST ones, and the result says it was cut rather than presenting a narrower neighbourhood as the whole (ISS-1087 criterion 28).
    const ranked = [
      anchor,
      ...[...hood.before].reverse().flatMap((b, i) => (hood.after[i] ? [b, hood.after[i]] : [b])),
      ...hood.after.slice(hood.before.length),
    ] as RocketChatRestMessage[];
    const kept: RocketChatRestMessage[] = [];
    let cut = false;
    for (const m of ranked) {
      const cost = estimateTokens(clip(m.text, MESSAGE_CHAR_CAP));
      if (
        messagesUsed + kept.length >= QUOTE_MESSAGES_PER_TURN ||
        tokensUsed + cost > QUOTE_TOKENS_PER_TURN
      ) {
        cut = true;
        continue;
      }
      kept.push(m);
      tokensUsed += cost;
    }
    messagesUsed += kept.length;
    const messages = kept.sort((a, b) => a.ts.localeCompare(b.ts)).map(shape);
    const limitation =
      hood.limitation ??
      (cut
        ? `the neighbourhood was cut to fit this turn's budget of ${QUOTE_MESSAGES_PER_TURN} messages / ${QUOTE_TOKENS_PER_TURN} tokens`
        : null);
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

  return { tools: [tool], execute };
}
