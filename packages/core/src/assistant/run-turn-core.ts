/**
 * ISS-604 (P2a) — transport-agnostic tool-calling turn loop: one assistant turn,
 * executing and feeding back tools for as long as the model asks for them, up to
 * {@link MAX_TOOL_ITERATIONS}. Shared so neither consumer owns a private copy —
 * `external-chat.ts`
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
  ChatResponseFormat,
  ChatStreamEvent,
  ChatStreamUsage,
} from './providers/types.js';
import { type ChatToolset, toolError, toolResultText } from './tools/mcp-adapter.js';

export const MAX_TOOL_ITERATIONS = 16;

/** What `chat_logs.tool_calls` keeps of a result: enough to see what the model was shown, never the full 24k body. */
const RESULT_PREVIEW_CHARS = 500;
const RESULT_ISSUE_REF_RE = /\b[A-Za-z][A-Za-z0-9]{1,5}-\d{1,6}\b/g;

/** Every issue-shaped reference a tool result named, de-duplicated. */
function issueRefsIn(text: string): string[] {
  const seen = new Set<string>();
  for (const m of text.matchAll(RESULT_ISSUE_REF_RE)) seen.add((m[0] as string).toUpperCase());
  return [...seen];
}

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
  responseFormat?: ChatResponseFormat | undefined;
  reasoningEffort?: string | undefined;
  signal?: AbortSignal | undefined;
  /**
   * Read before a tool call is executed; a result returned stands in for the call (recorded with
   * its own `isError`) and the tool never runs. Null lets the call through (ISS-1064).
   */
  preCall?: PreCall | undefined;
}

export interface PreCallContext {
  /** The provider messages so far: system, history, the person's newest turn, this turn's rounds. */
  messages: readonly ChatMessage[];
  /** The tool calls this turn has made so far, refused ones included. */
  toolCalls: readonly ToolCallRecord[];
}

export type PreCall = (
  call: { name: string; arguments: string },
  ctx: PreCallContext,
) => Promise<CallToolResult | null>;

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
  resultIssueRefs: string[];
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
  id: string;
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

async function executeToolRound(
  toolset: ChatToolset,
  calls: CollectedToolCall[],
  round: number,
  gate?: (
    call: CollectedToolCall,
    completed: readonly ToolCallRecord[],
  ) => Promise<CallToolResult | null>,
): Promise<ExecutedCall[]> {
  const out: ExecutedCall[] = [];
  const completed = (): ToolCallRecord[] => out.flatMap((e) => (e ? [e.record] : []));
  const byName = new Map<string, number[]>();
  for (const [i, tc] of calls.entries()) byName.set(tc.name, [...(byName.get(tc.name) ?? []), i]);
  await Promise.all(
    [...byName.values()].map(async (indices) => {
      for (const i of indices) {
        const call = calls[i] as CollectedToolCall;
        const startedAt = Date.now();
        const held = gate
          ? await gate(call, completed()).catch((err: unknown) =>
              toolError(
                `pre-call gate failed: ${err instanceof Error ? err.message : String(err)}`,
              ),
            )
          : null;
        const result = held ?? (await safeExecute(toolset, call));
        const text = toolResultText(result);
        out[i] = {
          id: call.id,
          text,
          record: {
            name: call.name,
            arguments: call.arguments,
            round,
            isError: result.isError === true,
            durationMs: Date.now() - startedAt,
            resultPreview: text.slice(0, RESULT_PREVIEW_CHARS),
            resultIssueRefs: issueRefsIn(text),
          },
        };
      }
    }),
  );
  return out;
}

const USAGE_KEYS = [
  'promptTokens',
  'completionTokens',
  'totalTokens',
  'cachedPromptTokens',
] as const;

function addUsage(into: ChatStreamUsage, from: ChatStreamUsage): void {
  for (const key of USAGE_KEYS) {
    const n = from[key];
    if (n !== undefined) into[key] = (into[key] ?? 0) + n;
  }
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
        responseFormat: offered ? undefined : args.responseFormat,
        ...(args.reasoningEffort ? { reasoningEffort: args.reasoningEffort } : {}),
        signal,
      })) {
        if (event.type === 'chunk') {
          turnText += event.text;
          yield event;
        } else if (event.type === 'reasoning') {
          yield event;
        } else if (event.type === 'tool_call') {
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
          yield event;
          break;
        }
      }

      if (terminal === 'error') break;

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

      const gate = args.preCall
        ? (tc: CollectedToolCall, completed: readonly ToolCallRecord[]) =>
            (args.preCall as PreCall)(
              { name: tc.name, arguments: tc.arguments },
              { messages, toolCalls: [...toolCalls, ...completed] },
            )
        : undefined;
      for (const { id, record, text } of await executeToolRound(
        offered,
        turnToolCalls,
        iterations,
        gate,
      )) {
        toolCalls.push(record);
        yield {
          type: 'tool_result',
          id,
          result: text,
          isError: record.isError,
          durationMs: record.durationMs,
        };
        messages.push({ role: 'tool', tool_call_id: id, content: text });
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
