/**
 * ISS-604 (P2a) — transport-agnostic tool-calling turn loop: one assistant turn,
 * executing and feeding back tools for as long as the model asks for them, up to
 * {@link MAX_TOOL_ITERATIONS}. Shared so neither consumer owns a private copy —
 * `run-turn.ts` (SSE) forwards each event to the browser, `external-chat.ts`
 * (Rocket.Chat) drains them and sends the final text as one message. NO SSE and
 * NO DB writes here; the caller owns transport and persistence.
 */

import type { CallToolResult } from '../mcp/tool-result.js';
import {
  addElision,
  applyContextBudget,
  DEFAULT_CONTEXT_BUDGET_TOKENS,
  type ElisionReport,
  emptyElision,
} from './context-budget.js';
import type {
  ChatMessage,
  ChatProvider,
  ChatStreamEvent,
  ChatStreamUsage,
} from './providers/types.js';
import { type ChatToolset, toolError, toolResultText } from './tools/mcp-adapter.js';

// cm:guard 8 (was 5, ISS-609 follow-up) because investigating an external hub takes multi-hop chains — issue-search retries, schema introspection, query, act — and it counts PROVIDER rounds, not tool rounds: the final round MUST be invoked with NO tools (so 7 of the 8 carry them) — a model offered them on the round the loop will not iterate past answers with tool calls and no prose, and finalizing on THAT round returns '' as a `done` turn: seven round-trips of tool work billed, a chat_logs row that reads like a healthy answer. What the cap buys is that the eighth round is SPENT on an answer instead of being discarded; it does NOT make a last-round tool call visible — that round carries no schemas and a call invented there is dropped, which is the rule of the guard on the tool_call branch below, not this one's to restate
export const MAX_TOOL_ITERATIONS = 8;

/** What `chat_logs.tool_calls` keeps of a result: enough to see what the model was shown, never the full 24k body. */
const RESULT_PREVIEW_CHARS = 500;

export interface TurnCoreArgs {
  provider: ChatProvider;
  model: string;
  /** system + history + new user turn. Copied internally, not mutated. */
  messages: ChatMessage[];
  tools?: ChatToolset | undefined;
  temperature?: number | undefined;
  /** `tool_choice:'required'` on the FIRST round only, so a lazy model cannot
   *  answer without investigating and the loop can still terminate. */
  requireInitialToolUse?: boolean | undefined;
  /** Estimated-token cap on each provider request; `context-budget.ts` elides to fit. */
  contextBudgetTokens?: number | undefined;
  signal?: AbortSignal | undefined;
}

/** One tool call as audited in `chat_logs.tool_calls`; `name`/`arguments` are what the model emitted, the rest is what happened to it. */
export interface ToolCallRecord {
  name: string;
  arguments: string;
  /** 1-based provider round the call was made on. */
  round: number;
  /** MCP's own flag on the result — a guard rejection, a thrown handler, an external server's error. */
  isError: boolean;
  durationMs: number;
  /** First {@link RESULT_PREVIEW_CHARS} of the text the model read. */
  resultPreview: string;
}

export interface TurnCoreResult {
  /** The final assistant text (the round that requested no tools). */
  finalText: string;
  usage: ChatStreamUsage;
  iterations: number;
  toolCalls: ToolCallRecord[];
  /** What the context budget removed over the whole turn. */
  elided: ElisionReport;
  terminal: 'done' | 'error';
  errorMessage: string | null;
}

/** The `chat_logs.usage` jsonb: token counts plus, only when something was elided, the report — a row with no `elided` key means nothing was. */
export function usageForLog(result: TurnCoreResult): Record<string, unknown> | null {
  const { historyMessages, truncatedToolResults, overBudget } = result.elided;
  const elided = historyMessages > 0 || truncatedToolResults > 0 || overBudget;
  const out = { ...result.usage, ...(elided ? { elided: result.elided } : {}) };
  return Object.keys(out).length > 0 ? out : null;
}

interface CollectedToolCall {
  id: string;
  name: string;
  arguments: string;
}

interface ExecutedCall {
  call: CollectedToolCall;
  record: ToolCallRecord;
  /** What the model reads back — the flattened result. */
  text: string;
}

/** A toolset that throws (none do by contract, every implementer returns `toolError`) still yields one result per call, so `Promise.all` over a round cannot drop the other calls' results or turn the turn into a terminal `error`. */
async function safeExecute(toolset: ChatToolset, tc: CollectedToolCall): Promise<CallToolResult> {
  try {
    return await toolset.execute(tc.name, tc.arguments);
  } catch (err) {
    return toolError(err instanceof Error ? err.message : String(err));
  }
}

// cm:guard calls that share a tool NAME run sequentially in model order and only distinct names run concurrently — `tools/registry.ts:guardIssueWritesDeduped` is a SELECT-then-INSERT with no uniqueness constraint behind it, so two concurrent `forge_issues create` would both pass `findDuplicateIssue`, and the RC history toolset's per-turn call counter is the same shape; a toolset that needed serial execution across DIFFERENT names would need a flag here, not a wider lock
async function executeToolRound(
  toolset: ChatToolset,
  calls: CollectedToolCall[],
  round: number,
): Promise<ExecutedCall[]> {
  const out: ExecutedCall[] = [];
  const byName = new Map<string, number[]>();
  calls.forEach((tc, i) => {
    const group = byName.get(tc.name);
    if (group) group.push(i);
    else byName.set(tc.name, [i]);
  });
  await Promise.all(
    [...byName.values()].map(async (indices) => {
      for (const i of indices) {
        const call = calls[i] as CollectedToolCall;
        const startedAt = Date.now();
        const result = await safeExecute(toolset, call);
        const text = toolResultText(result);
        out[i] = {
          call,
          text,
          record: {
            name: call.name,
            arguments: call.arguments,
            round,
            isError: result.isError === true,
            durationMs: Date.now() - startedAt,
            resultPreview: text.slice(0, RESULT_PREVIEW_CHARS),
          },
        };
      }
    }),
  );
  return out;
}

function addUsage(into: ChatStreamUsage, from: ChatStreamUsage): void {
  if (from.promptTokens !== undefined)
    into.promptTokens = (into.promptTokens ?? 0) + from.promptTokens;
  if (from.completionTokens !== undefined)
    into.completionTokens = (into.completionTokens ?? 0) + from.completionTokens;
  if (from.totalTokens !== undefined) into.totalTokens = (into.totalTokens ?? 0) + from.totalTokens;
}

/**
 * Yields client-facing events (chunk / tool_call / tool_result / usage, then
 * exactly one terminal `done` or `error`; the provider's own per-round `done` is
 * swallowed). Never throws — provider and tool errors become that `error`.
 */
export async function* runTurnEvents(
  args: TurnCoreArgs,
): AsyncGenerator<ChatStreamEvent, TurnCoreResult> {
  const { provider, model, tools, temperature, signal } = args;
  const budgetTokens = args.contextBudgetTokens ?? DEFAULT_CONTEXT_BUDGET_TOKENS;
  let messages: ChatMessage[] = [...args.messages];
  const usage: ChatStreamUsage = {};
  const toolCalls: ToolCallRecord[] = [];
  const elided = emptyElision();
  let finalText = '';
  let errorMessage: string | null = null;
  let terminal: 'done' | 'error' | null = null;
  let iterations = 0;

  try {
    for (;;) {
      iterations++;
      const offered = iterations < MAX_TOOL_ITERATIONS ? tools : undefined;
      let turnText = '';
      const turnToolCalls: CollectedToolCall[] = [];
      let sawError = false;

      // cm:why applied to the CARRIED array, not a per-round copy — elisions accumulate, so rounds 2..8 see a byte-identical prefix (where implicit prompt caching pays) instead of re-deciding what to drop each round
      const bounded = applyContextBudget(messages, {
        budgetTokens,
        reservedTokens: Math.ceil(JSON.stringify(offered?.tools ?? []).length / 4),
      });
      messages = bounded.messages;
      addElision(elided, bounded.elided);

      for await (const event of provider.stream({
        model,
        messages,
        tools: offered?.tools,
        temperature,
        toolChoice:
          args.requireInitialToolUse && iterations === 1 && offered ? 'required' : undefined,
        signal,
      })) {
        if (event.type === 'chunk') {
          turnText += event.text;
          yield event;
        } else if (event.type === 'tool_call') {
          // cm:guard a tool call arriving on the terminal round is dropped, not forwarded and not recorded — that round is invoked with NO tool schemas, so nothing will execute it and no `tool_result` can ever follow: yielding it hands the SSE client exactly the dangling pair this cap exists to prevent, and putting it in `toolCalls` tells external-chat.ts an `escalate` ran when nothing ran. The round's prose is still the answer; a round that emitted only this is an empty answer, and that is the model's fact to own rather than the loop's to hide
          if (!offered) continue;
          turnToolCalls.push({
            id: event.id,
            name: event.name,
            arguments: typeof event.arguments === 'string' ? event.arguments : '',
          });
          yield event;
        } else if (event.type === 'usage') {
          addUsage(usage, event.usage);
          yield event;
        } else if (event.type === 'error') {
          errorMessage = event.message;
          terminal = 'error';
          sawError = true;
          yield event;
          break;
        }
      }

      if (sawError) break;

      if (turnToolCalls.length === 0 || !offered) {
        finalText = turnText;
        terminal = 'done';
        yield { type: 'done' };
        break;
      }

      messages.push({
        role: 'assistant',
        content: turnText.length > 0 ? turnText : null,
        tool_calls: turnToolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: tc.arguments },
        })),
      });

      // cm:why results are yielded and fed back in MODEL order once the whole round has completed — every tool_call_id gets exactly one reply and the SSE pairing stays deterministic whatever finished first
      for (const { call, record, text } of await executeToolRound(
        offered,
        turnToolCalls,
        iterations,
      )) {
        toolCalls.push(record);
        yield { type: 'tool_result', id: call.id, result: text };
        messages.push({ role: 'tool', tool_call_id: call.id, content: text });
      }
    }
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
    terminal = 'error';
    yield { type: 'error', message: errorMessage };
  }

  return {
    finalText,
    usage,
    iterations,
    toolCalls,
    elided,
    terminal: terminal ?? 'done',
    errorMessage,
  };
}
