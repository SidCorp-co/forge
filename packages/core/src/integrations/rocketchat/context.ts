/**
 * ISS-609 (Lane A intelligence, piece A) — conversation-context seeding +
 * the bounded `rocketchat_history` chat tool.
 *
 * On a bot mention we SEED the turn with the last ~20 room messages (plus the
 * full thread when the mention is threaded), formatted `[user]: text`. Deeper
 * recall is agentic, not hardcoded: the model gets `rocketchat_history` (cap
 * 50 msgs/call, 3 calls/turn; overall bounded by the tool-loop iteration cap)
 * and decides itself when the discussion references older matter.
 */

import type { ChatTool } from '../../chat/providers/types.js';
import type { ChatToolset } from '../../chat/tools/mcp-adapter.js';
import {
  type RocketChatRestAuth,
  type RocketChatRestMessage,
  buildMessagePermalink,
  fetchMessage,
  fetchRoomHistory,
  fetchThreadMessages,
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

/**
 * Render REST messages as `[user]: text` lines (oldest first), dropping system
 * messages, the bot's own replies (unless `includeBot` — a thread's earlier
 * bot turns ARE the conversation), empty bodies, and the triggering mention
 * itself (it is the turn's user message). Returns null when nothing remains.
 */
export function formatConversationLines(
  messages: RocketChatRestMessage[],
  opts: { botUserId: string; excludeMessageId?: string | undefined; includeBot?: boolean },
): string | null {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const m of messages) {
    if (m.isSystem || (m.userId === opts.botUserId && !opts.includeBot)) continue;
    if (m.id === opts.excludeMessageId || seen.has(m.id)) continue;
    if (!m.text.trim()) continue;
    seen.add(m.id);
    lines.push(`[${m.username}]: ${clip(m.text.trim(), MESSAGE_CHAR_CAP)}`);
  }
  if (lines.length === 0) return null;
  let block = lines.join('\n');
  // Keep the TAIL when over cap — the most recent lines matter most.
  if (block.length > BLOCK_CHAR_CAP)
    block = `… [older messages truncated]\n${block.slice(-BLOCK_CHAR_CAP)}`;
  return block;
}

/**
 * Build the seed context for one mention: last {@link SEED_MESSAGE_COUNT} room
 * messages, plus the full thread when the mention is threaded. Best-effort —
 * any fetch failure degrades to null (the turn still runs, just contextless).
 */
export async function buildConversationContext(
  auth: RocketChatRestAuth,
  opts: { rid: string; tmid?: string | undefined; excludeMessageId: string },
): Promise<string | null> {
  try {
    const [room, thread, threadRoot, permalink] = await Promise.all([
      fetchRoomHistory(auth, opts.rid, { count: SEED_MESSAGE_COUNT }),
      opts.tmid ? fetchThreadMessages(auth, opts.tmid, HISTORY_MAX_PER_CALL) : Promise.resolve([]),
      // getThreadMessages returns REPLIES only — without the root message the
      // thing the thread is about is missing, and "the task above" in a
      // threaded mention resolves against unrelated room noise.
      opts.tmid ? fetchMessage(auth, opts.tmid) : Promise.resolve(null),
      // Deterministic source link for issues the bot files — the model can
      // only cite the chat if the permalink is handed to it.
      buildMessagePermalink(auth, opts.rid, opts.tmid ?? opts.excludeMessageId).catch(() => null),
    ]);
    const roomBlock = formatConversationLines(room, {
      botUserId: auth.userId,
      excludeMessageId: opts.excludeMessageId,
    });
    const threadMessages = threadRoot ? [threadRoot, ...thread] : thread;
    const threadBlock =
      threadMessages.length > 0
        ? formatConversationLines(threadMessages, {
            botUserId: auth.userId,
            excludeMessageId: opts.excludeMessageId,
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
        `The mention was posted INSIDE A THREAD — the thread below (root message first) is what the user is referring to:\n${threadBlock}`,
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

/**
 * The RC-scoped read tool offered alongside the forge_* toolset: page back
 * through this room's history. `rid` is pinned server-side (the model never
 * addresses another room); calls are capped per turn.
 */
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
  async function execute(name: string, argsJson: string): Promise<string> {
    if (name !== 'rocketchat_history') {
      return JSON.stringify({ error: `unknown tool "${name}"` });
    }
    calls += 1;
    if (calls > HISTORY_MAX_CALLS_PER_TURN) {
      return JSON.stringify({
        error: `rocketchat_history is capped at ${HISTORY_MAX_CALLS_PER_TURN} calls per turn — answer with what you have`,
      });
    }
    let args: { before?: string; count?: number } = {};
    try {
      args = argsJson.trim() ? (JSON.parse(argsJson) as typeof args) : {};
    } catch {
      return JSON.stringify({ error: 'arguments were not valid JSON' });
    }
    const count = Math.min(
      Math.max(1, typeof args.count === 'number' ? Math.floor(args.count) : HISTORY_MAX_PER_CALL),
      HISTORY_MAX_PER_CALL,
    );
    const messages = await fetchRoomHistory(auth, rid, {
      count,
      before: typeof args.before === 'string' ? args.before : undefined,
    });
    return JSON.stringify({
      messages: messages
        .filter((m) => !m.isSystem && m.text.trim().length > 0)
        .map((m) => ({ ts: m.ts, user: m.username, text: clip(m.text, MESSAGE_CHAR_CAP) })),
      oldestTs: messages[0]?.ts ?? null,
    });
  }

  return { tools: [tool], execute };
}
