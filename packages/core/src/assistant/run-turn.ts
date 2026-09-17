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
import { memoryNoteGateFor } from './tools/memory-note-gate-deps.js';
import { createTranscriptAccumulator, ENTRY_FLUSH_MS } from './transcript-entry.js';

export interface RunTurnArgs {
  c: Context;
  turn: ConversationTurn;
  /** The project the room is scoped to; the memory-note gate reads the project's notes by it (ISS-1064). */
  projectId: string;
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
  projectId,
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
      preCall: memoryNoteGateFor(projectId),
      contextBudgetTokens,
      reasoningEffort,
      signal: ac.signal,
    });
    // cm:guard ONE vocabulary on this route: every frame is a `message` carrying a canonical
    // transcript entry, the same `AgentMessage` the Claude Code path produces, so a client renders
    // it with `features/session/types.ts parseMessages` and needs no second formatter. The
    // provider's own chunk/tool_call/tool_result events stay what they are — the adapter contract —
    // and end here, at the turn layer, rather than reaching a browser (ISS-1029).
    // cm:guard the entry's id is minted HERE, once, and carried into the row the turn writes, so
    // every frame this route emits and the row it settles as share ONE identity. A client keyed by
    // `id` must reduce the growing frames and the final one to a single assistant turn; letting the
    // column mint its own gave the 19 growing frames one id and the settled frame another, and a
    // reducer saw two turns for one answer (ISS-1029 review F1, confirmed on beta before the fix).
    const entryId = randomUUID();
    const acc = createTranscriptAccumulator({ id: entryId });
    let lastFlush = 0;
    // cm:guard the accumulator's refusal — a tool result naming no call this turn made — ends the
    // TURN, loudly, and does NOT escape this callback: the user's own message is still in
    // `turn.pending` at this point and only `persistMessages` below writes it, so a throw here
    // would answer a broken pairing by deleting the question as well. The refusal becomes the
    // turn's failure, named verbatim in `silence_reason`, which is loud where a reader will see it
    // (ISS-1001 invariant 7, and the reason ISS-1029 refuses a silent drop in the first place).
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

    // cm:guard `content` stays the FINAL text and never the accumulated prose: it is what
    // `toProviderMessages` replays to the model, so storing the pre-tool commentary there would
    // feed a turn's own thinking back to it as a second answer. The full ordered record — that
    // commentary included — is what `blocks` is for, and the web formatter reads `blocks` when they
    // are there, so nothing renders twice (ISS-1029).
    const blocks = acc.blocks();
    if (result.terminal === 'done' && result.finalText.length > 0) {
      appendAssistantMessage(turn, result.finalText, { blocks, id: entryId });
    } else {
      // cm:guard the user's message is written even when the turn failed, and the failure is written BESIDE it rather than left absent: a transcript that stops without saying why reads to the next person as a message nobody answered (ISS-1001 invariant 7).
      // cm:guard the blocks go with it: a turn that ran tools and then said nothing keeps the
      // record of what it ran, which is the only thing that makes such a turn diagnosable (ISS-1029).
      appendSilence(turn, result.errorMessage ?? result.terminal, { blocks, id: entryId });
    }
    const written = await persistMessages(turn);

    // cm:why a failed turn gets its own canonical `system` entry rather than an `error` event: the
    // reason is part of the transcript the reader sees, and `subtype` is how the canonical shape
    // already says what a non-assistant entry is (`agent-stream-parser.ts` uses it for the CLI's
    // `result` line). The row keeps `silence_reason` exactly as it did.
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

    // cm:guard the LAST frame is the PERSISTED row, read back through the one mapper: that is what
    // makes "the stream and the transcript agree" an equality a test can assert rather than a
    // resemblance two code paths happen to share (ISS-1029 criterion 13).
    // cm:why a backwards scan rather than `findLast` — this package's `lib` target predates it, and
    // raising it for one call would change what every other file in core may reach for.
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
      // cm:why `chat_logs` is best-effort audit: an INSERT error (a pool exhausted, say) must not fail a request whose SSE stream has already been delivered.
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
