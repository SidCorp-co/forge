/** Strip \u0000 null bytes that PostgreSQL JSONB rejects. */
export { sanitize as sanitizeForDb };
function sanitize(obj: unknown): unknown {
  if (typeof obj === 'string') return obj.replace(/\u0000/g, '');
  if (Array.isArray(obj)) return obj.map(sanitize);
  if (obj && typeof obj === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = sanitize(v);
    return out;
  }
  return obj;
}

// In-memory accumulator for streamed assistant content per session
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; tool: { id: string; name: string; input?: any; result?: string; isError?: boolean } }
  | { type: 'todos'; todos: { content: string; status: string; activeForm?: string }[] };

export interface SessionUsage {
  contextUsed: number;   // Last turn's full context (input + cacheRead + cacheWrite)
  inputTotal: number;    // Cumulative non-cached input tokens
  outputTotal: number;   // Cumulative output tokens
  cacheRead: number;     // Cumulative cache-read tokens
  cacheWrite: number;    // Cumulative cache-creation tokens
  turns: number;
}

export interface SessionStream {
  text: string;
  claudeSessionId?: string;
  toolCalls: { id: string; name: string; input?: any; result?: string; isError?: boolean }[];
  contentBlocks: ContentBlock[];
  flushTimer: ReturnType<typeof setTimeout> | null;
  usage: SessionUsage;
  _lastMsgId: string | null; // Dedup: CLI sends multiple entries per API turn (same message.id)
  _lastActivity: number;
  _needsSeed?: boolean; // True when stream was just created and needs DB usage seeded
}

const FLUSH_INTERVAL = 3000; // persist every 3 seconds
const SESSION_TTL = 30 * 60 * 1000; // 30 minutes — auto-cleanup orphaned streams
const EMPTY_USAGE: SessionUsage = { contextUsed: 0, inputTotal: 0, outputTotal: 0, cacheRead: 0, cacheWrite: 0, turns: 0 };

export const sessionStreams = new Map<string, SessionStream>();

// Periodic cleanup of stale session streams (orphaned due to missed agent:complete)
setInterval(() => {
  const now = Date.now();
  for (const [sid, stream] of sessionStreams) {
    if (now - stream._lastActivity > SESSION_TTL) {
      if (stream.flushTimer) clearTimeout(stream.flushTimer);
      sessionStreams.delete(sid);
    }
  }
}, 5 * 60 * 1000); // check every 5 minutes

export function getStream(sessionId: string): SessionStream {
  let s = sessionStreams.get(sessionId);
  if (!s) {
    s = { text: '', toolCalls: [], contentBlocks: [], flushTimer: null, usage: { contextUsed: 0, inputTotal: 0, outputTotal: 0, cacheRead: 0, cacheWrite: 0, turns: 0 }, _lastMsgId: null, _lastActivity: Date.now(), _needsSeed: true };
    sessionStreams.set(sessionId, s);
  }
  return s;
}

/**
 * Seed a new stream with existing DB usage so multi-turn sessions
 * don't lose accumulated tokens when the stream is recreated.
 */
async function seedUsageFromDb(strapi: any, sessionId: string, stream: SessionStream, UID: any) {
  if (!stream._needsSeed) return;
  stream._needsSeed = false;
  try {
    const session: any = await strapi.documents(UID).findOne({ documentId: sessionId });
    const stored = session?.usage;
    if (stored && stored.turns > 0) {
      stream.usage.inputTotal = stored.inputTotal || 0;
      stream.usage.outputTotal = stored.outputTotal || 0;
      stream.usage.cacheRead = stored.cacheRead || 0;
      stream.usage.cacheWrite = stored.cacheWrite || 0;
      stream.usage.turns = stored.turns || 0;
      stream.usage.contextUsed = stored.contextUsed || 0;
    }
  } catch { /* ignore seed errors */ }
}

export async function flushStream(strapi: any, sessionId: string, UID: any) {
  const stream = sessionStreams.get(sessionId);
  if (!stream || (!stream.text && stream.toolCalls.length === 0)) return;

  const { upsertAssistantMessage } = await import('./message-utils');

  try {
    const session: any = await strapi.documents(UID).findOne({ documentId: sessionId });
    if (!session) return;

    const messages = [...(session.messages as any[] || [])];
    upsertAssistantMessage(messages, stream.text, stream.toolCalls, stream.contentBlocks, { streaming: true });

    const updateData: any = { messages: sanitize(messages) };
    if (stream.claudeSessionId) updateData.claudeSessionId = stream.claudeSessionId;
    if (stream.usage.turns > 0) updateData.usage = stream.usage;
    await strapi.documents(UID).update({ documentId: sessionId, data: updateData });
  } catch { /* ignore flush errors */ }
}

export function scheduleFlush(strapi: any, sessionId: string, UID: any) {
  const stream = getStream(sessionId);
  if (stream.flushTimer) return;
  stream.flushTimer = setTimeout(async () => {
    stream.flushTimer = null;
    await flushStream(strapi, sessionId, UID);
  }, FLUSH_INTERVAL);
}

export function accumulateMessage(strapi: any, sessionId: string, agentData: any, UID: any) {
  const stream = getStream(sessionId);

  // Seed usage from DB when stream was just created (e.g., after agent:complete deleted it)
  // so multi-turn sessions don't lose previously accumulated tokens.
  if (stream._needsSeed) {
    seedUsageFromDb(strapi, sessionId, stream, UID);
  }

  const type = agentData.type;
  const content = agentData.message?.content;
  const textSnippet = Array.isArray(content) ? content.find((b: any) => b.type === 'text')?.text?.slice(0, 60) : '';
  strapi.log.debug(`[accumulate] sid=${sessionId.slice(0,8)} type=${type} textLen=${stream.text.length} snippet="${textSnippet}"`);

  // Claude CLI sends message.content as an array of blocks
  if (type === 'assistant' && Array.isArray(content)) {
    for (const block of content) {
      if (block.type === 'text' && block.text) {
        stream.text += block.text;
        // Merge consecutive text blocks
        const last = stream.contentBlocks[stream.contentBlocks.length - 1];
        if (last?.type === 'text') {
          last.text += block.text;
        } else {
          stream.contentBlocks.push({ type: 'text', text: block.text });
        }
      } else if (block.type === 'tool_use' && block.name === 'TodoWrite') {
        const todos = (block.input?.todos as { content: string; status: string; activeForm?: string }[]) ?? [];
        // Replace existing todos block or add new one
        const existingIdx = stream.contentBlocks.findIndex((b) => b.type === 'todos');
        const todosBlock = {
          type: 'todos' as const,
          todos: todos.map((t) => ({
            content: t.content,
            status: (t.status as 'pending' | 'in_progress' | 'completed') ?? 'pending',
            activeForm: t.activeForm,
          })),
        };
        if (existingIdx >= 0) {
          stream.contentBlocks[existingIdx] = todosBlock;
        } else {
          stream.contentBlocks.push(todosBlock);
        }
        // Still track as toolCall for result matching
        stream.toolCalls.push({ id: block.id, name: block.name, input: block.input });
      } else if (block.type === 'tool_use') {
        const tc = { id: block.id, name: block.name, input: block.input };
        stream.toolCalls.push(tc);
        stream.contentBlocks.push({ type: 'tool_use', tool: tc });
      }
    }
  } else if (type === 'user' && Array.isArray(content)) {
    // tool_result blocks come as user messages
    for (const block of content) {
      if (block.type === 'tool_result') {
        const tc = stream.toolCalls.find((t) => t.id === block.tool_use_id);
        if (tc) {
          tc.result = block.content;
          tc.isError = block.is_error;
        }
        // Also update in contentBlocks
        const cb = stream.contentBlocks.find(
          (b): b is Extract<ContentBlock, { type: 'tool_use' }> =>
            b.type === 'tool_use' && b.tool.id === block.tool_use_id
        );
        if (cb) {
          cb.tool.result = block.content;
          cb.tool.isError = block.is_error;
        }
      }
    }
  }

  // Track usage from assistant messages (usage may be at top level or inside message).
  // Claude CLI sends multiple entries per API turn with the same message.id
  // (one per content block: thinking, text, tool_use). Each carries the same usage
  // snapshot, so we deduplicate by message.id to avoid overcounting.
  const msgId = agentData.message?.id;
  const usageData = agentData.usage || agentData.message?.usage;
  if (type === 'assistant' && usageData) {
    const u = usageData;
    const inp = u.input_tokens || 0;
    const cr  = u.cache_read_input_tokens || 0;
    const cw  = u.cache_creation_input_tokens || 0;
    // contextUsed = last turn's full context window (always update, overwrite is fine)
    stream.usage.contextUsed = inp + cr + cw;

    // Only accumulate cumulative counters once per unique message (API turn)
    if (!msgId || msgId !== stream._lastMsgId) {
      stream._lastMsgId = msgId ?? null;
      stream.usage.inputTotal += inp;
      stream.usage.outputTotal += u.output_tokens || 0;
      stream.usage.cacheRead += cr;
      stream.usage.cacheWrite += cw;
      stream.usage.turns += 1;
    }
  }

  if (agentData.session_id) {
    stream.claudeSessionId = agentData.session_id;
  }
  stream._lastActivity = Date.now();
  scheduleFlush(strapi, sessionId, UID);
}
