/**
 * SSE transport for the cookie-auth `/api/chat` (PR-B) route: drives the shared
 * tool-calling loop ({@link runTurnEvents}), folds its events into one canonical
 * transcript entry, streams that entry, and persists it + a `chat_logs` audit row.
 *
 * ISS-604 — the loop itself lives in `run-turn-core.ts` so the Rocket.Chat
 * (non-streaming) path can reuse it.
 *
 * ISS-1029 — this route speaks ONE event kind, `message`, carrying the same
 * `AgentMessage` that `lib/agent-stream-parser.ts` produces for the Claude Code
 * CLI path, so a client renders both with `features/session/types.ts
 * parseMessages` and no second formatter. The provider's own
 * chunk/tool_call/tool_result events are the adapter contract and stop here.
 * The tool round-trips are no longer ephemeral: they are in the entry's blocks,
 * beside the `chat_logs` row that still audits them.
 */

import { randomUUID } from 'node:crypto';
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { db } from '../db/client.js';
import { chatLogs } from '../db/schema.js';
import type { AgentMessage } from '../lib/agent-stream-parser.js';
import {
  appendAssistantMessage,
  appendSilence,
  type ConversationTurn,
  persistMessages,
  toCanonicalEntry,
} from './conversation-turn.js';
import type { ChatMessage, ChatProvider } from './providers/types.js';
import { runTurnEvents, type TurnCoreResult, usageForLog } from './run-turn-core.js';
import type { ChatToolset } from './tools/mcp-adapter.js';
import { createTranscriptAccumulator } from './transcript-entry.js';

/**
 * How often a growing entry is re-sent while text streams in.
 */
const ENTRY_FLUSH_MS = 120;

export interface RunTurnArgs {
  c: Context;
  turn: ConversationTurn;
  /** Resolved provider + model (already chosen by `resolveForProject`). */
  resolved: { provider: ChatProvider; model: string };
  /** The full message array (system + history + new user turn). */
  providerMessages: ChatMessage[];
  /** Optional toolset (ISS-604). Omit for a plain completion. */
  tools?: ChatToolset | undefined;
  /** Project slug for `chat_logs.project_slug`. */
  projectSlug: string;
  /** The new user message text — written verbatim into `chat_logs.query`. */
  userMessage: string;
  /** Caller key for `chat_logs.user_key` (userId for web, null for widget). */
  userKey: string | null;
  /** The transport this turn arrived on, for `chat_logs.source`. */
  adapter: string;
  /** Estimated-token cap on each provider request (`env.CHAT_CONTEXT_BUDGET_TOKENS`). */
  contextBudgetTokens?: number | undefined;
  reasoningEffort?: string | undefined;
}

export function runChatTurn({
  c,
  turn,
  resolved,
  providerMessages,
  tools,
  projectSlug,
  userMessage,
  userKey,
  adapter,
  contextBudgetTokens,
  reasoningEffort,
}: RunTurnArgs) {
  return streamSSE(c, async (stream) => {
    c.header('X-Accel-Buffering', 'no');
    await stream.writeSSE({
      event: 'conversation',
      data: JSON.stringify({ conversationId: turn.conversationId }),
    });

    const ac = new AbortController();
    stream.onAbort(() => ac.abort());

    const startedAt = Date.now();

    const gen = runTurnEvents({
      provider: resolved.provider,
      model: resolved.model,
      messages: providerMessages,
      tools,
      contextBudgetTokens,
      reasoningEffort,
      signal: ac.signal,
    });
    const entryId = randomUUID();
    const acc = createTranscriptAccumulator({ id: entryId });
    let lastFlush = 0;
    let refusal: string | null = null;
    let step = await gen.next();
    while (!step.done) {
      const event = step.value;
      try {
        acc.apply(event);
      } catch (err) {
        refusal = err instanceof Error ? err.message : String(err);
        await gen.return(undefined as never).catch(() => undefined);
        break;
      }
      const settling = event.type === 'tool_call' || event.type === 'tool_result';
      const at = Date.now();
      if (settling || at - lastFlush >= ENTRY_FLUSH_MS) {
        lastFlush = at;
        await writeEntry(stream, acc.entry());
      }
      step = await gen.next();
    }
    const result: TurnCoreResult = refusal
      ? {
          finalText: '',
          usage: {},
          iterations: 0,
          toolCalls: [],
          elided: { historyMessages: 0, truncatedToolResults: 0, overBudget: false },
          terminal: 'error',
          errorMessage: refusal,
        }
      : (step.value as TurnCoreResult);

    const durationMs = Date.now() - startedAt;
    if (result.elided.overBudget) {
      console.warn('chat: request exceeds the context budget even after elision', result.elided);
    }

    const blocks = acc.blocks();
    if (result.terminal === 'done' && result.finalText.length > 0) {
      appendAssistantMessage(turn, result.finalText, { blocks, id: entryId });
    } else {
      appendSilence(turn, result.errorMessage ?? result.terminal, { blocks, id: entryId });
    }
    const written = await persistMessages(turn);

    if (result.terminal !== 'done') {
      await writeEntry(stream, {
        id: `${turn.conversationId}-error`,
        type: 'system',
        timestamp: Date.now(),
        subtype: 'error',
        content: result.errorMessage ?? result.terminal,
        isError: true,
      });
    }

    let assistantRow: (typeof written)[number] | undefined;
    for (let i = written.length - 1; i >= 0; i--) {
      const row = written[i];
      if (row && row.role === 'assistant') {
        assistantRow = row;
        break;
      }
    }
    if (assistantRow) await writeEntry(stream, toCanonicalEntry(assistantRow));

    try {
      await db.insert(chatLogs).values({
        sessionId: turn.conversationId,
        projectSlug,
        userKey,
        query: userMessage,
        reply: result.finalText.length > 0 ? result.finalText : null,
        model: resolved.model,
        toolCalls: result.toolCalls as never,
        usage: usageForLog(result) as never,
        iterations: result.iterations,
        durationMs,
        error: result.errorMessage,
        source: adapter,
      });
    } catch (err) {
      console.error('chat_logs insert failed', err);
    }
  });
}

/** One canonical transcript entry, as the single event kind this route speaks. */
async function writeEntry(
  stream: { writeSSE: (msg: { event: string; data: string }) => Promise<void> },
  entry: AgentMessage | null,
): Promise<void> {
  if (!entry) return;
  await stream.writeSSE({ event: 'message', data: JSON.stringify(entry) });
}
