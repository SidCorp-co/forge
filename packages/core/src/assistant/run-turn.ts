/**
 * SSE transport for the cookie-auth `/api/chat` (PR-B) route: drives the shared
 * tool-calling loop ({@link runTurnEvents}) and forwards each event to the
 * browser, then persists the final assistant text + a `chat_logs` audit row.
 *
 * ISS-604 — the loop itself lives in `run-turn-core.ts` so the Rocket.Chat
 * (non-streaming) path can reuse it. Only the FINAL assistant text is written
 * to the conversation; intra-turn tool round-trips are ephemeral + audited.
 */

import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { db } from '../db/client.js';
import { chatLogs } from '../db/schema.js';
import {
  appendAssistantMessage,
  appendSilence,
  type ConversationTurn,
  persistMessages,
} from './conversation-turn.js';
import type { ChatMessage, ChatProvider, ChatStreamEvent } from './providers/types.js';
import { runTurnEvents, type TurnCoreResult, usageForLog } from './run-turn-core.js';
import type { ChatToolset } from './tools/mcp-adapter.js';

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
    // cm:guard buffering is off for Traefik and nginx, or a proxy holds the events until the turn
    // ends and a stream the client reads token by token arrives as one block at the end.
    c.header('X-Accel-Buffering', 'no');
    // cm:why the conversation is echoed back so the client can stash it for the next turn
    // without parsing a separate REST response
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
    let step = await gen.next();
    while (!step.done) {
      await writeEvent(stream, step.value);
      step = await gen.next();
    }
    const result: TurnCoreResult = step.value;

    const durationMs = Date.now() - startedAt;
    if (result.elided.overBudget) {
      console.warn('chat: request exceeds the context budget even after elision', result.elided);
    }

    if (result.terminal === 'done' && result.finalText.length > 0) {
      appendAssistantMessage(turn, result.finalText);
    } else {
      // cm:guard the user's message is written even when the turn failed, and the failure is written BESIDE it rather than left absent: a transcript that stops without saying why reads to the next person as a message nobody answered (ISS-1001 invariant 7).
      appendSilence(turn, result.errorMessage ?? result.terminal);
    }
    await persistMessages(turn);

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
      // cm:why `chat_logs` is best-effort audit: an INSERT error (a pool exhausted, say) must not fail a request whose SSE stream has already been delivered.
      console.error('chat_logs insert failed', err);
    }
  });
}

async function writeEvent(
  stream: { writeSSE: (msg: { event: string; data: string }) => Promise<void> },
  event: ChatStreamEvent,
): Promise<void> {
  const { type, ...rest } = event;
  await stream.writeSSE({ event: type, data: JSON.stringify(rest) });
}
