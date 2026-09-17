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
  ChatResponseFormat,
  ChatStreamEvent,
  ChatStreamUsage,
} from './providers/types.js';
import { type ChatToolset, toolError, toolResultText } from './tools/mcp-adapter.js';

// cm:guard 8 (was 5, ISS-609 follow-up) because investigating an external hub takes multi-hop chains — issue-search retries, schema introspection, query, act — and it counts PROVIDER rounds, not tool rounds: the final round MUST be invoked with NO tools (so 7 of the 8 carry them) — a model offered them on the round the loop will not iterate past answers with tool calls and no prose, and finalizing on THAT round returns '' as a `done` turn: seven round-trips of tool work billed, a chat_logs row that reads like a healthy answer. What the cap buys is that the eighth round is SPENT on an answer instead of being discarded; it does NOT make a last-round tool call visible — that round carries no schemas and a call invented there is dropped, which is the rule of the guard on the tool_call branch below, not this one's to restate
// cm:guard 16 (was 8) because the CLI tool's method is a READ before every act — `forge -h`, then `forge <verb> -h`, then the verb, then the refusal it printed, then the verb again — and a measured filing turn on 2026-09-15 spent all seven tool rounds reaching the first `forge new` and reported failure on the eighth with nothing left to retry. The cost of a round the model does not need is nothing; the cost of one it needed and lacked was the filing (ISS-1009).
export const MAX_TOOL_ITERATIONS = 16;

/** What `chat_logs.tool_calls` keeps of a result: enough to see what the model was shown, never the full 24k body. */
const RESULT_PREVIEW_CHARS = 500;
// cm:guard NO cap in memory, and the cap lives on the AUDIT WRITE instead (`external-chat.ts`):
// the reply screen reads this to answer "did this turn look that id up?", so a set truncated here
// refuses a citation the model genuinely saw — the same false refusal this whole change exists to
// remove, arriving once a listing passes the cap. What must be bounded is the jsonb column, and
// that is bounded where it is written (codex F1 of the whole-set read).
// cm:guard deliberately wider than any one project's prefixes, exactly as `gather.ts` is: this
// records what the result SAID, and the rule that reads it narrows to the project's own prefixes.
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
  // cm:guard taken as an ARGUMENT and never read from env here: `config/env.js` validates at import time and throws without DATABASE_URL, so importing it into the turn loop makes three provider-mocked suites fail to load — the doors already hold env, and this file stays testable without one (ISS-1009).
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
  /**
   * Every issue-shaped reference the WHOLE result named, bounded, taken before the preview is cut.
   */
  // cm:guard taken from the full text and NOT from `resultPreview`: the preview is 500 characters
  // and 186 of 356 calls in beta's QA window hit that cap, so a listing that names an issue late
  // would be invisible to the reply screen — which reads this to answer "did this turn look that
  // id up?" and would otherwise refuse a reply quoting a row the model really was shown
  // (ISS-1057, codex F1).
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

// cm:guard calls that share a tool NAME run sequentially in model order and only distinct names run concurrently — the `forge` tool's `new` is a neighbour read then an insert with no uniqueness constraint behind it, so two concurrent `forge new` would both pass the fold, and the RC history toolset's per-turn call counter is the same shape; a toolset that needed serial execution across DIFFERENT names would need a flag here, not a wider lock
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
  // cm:guard the gate reads the calls this ROUND has finished, not only earlier rounds': same-name calls run one after another and `toolCalls` is appended only once the round is over, so a second note in the same round would otherwise be counted against zero (codex F1 on the ISS-1064 diff)
  const completed = (): ToolCallRecord[] => out.flatMap((e) => (e ? [e.record] : []));
  const byName = new Map<string, number[]>();
  for (const [i, tc] of calls.entries()) byName.set(tc.name, [...(byName.get(tc.name) ?? []), i]);
  await Promise.all(
    [...byName.values()].map(async (indices) => {
      for (const i of indices) {
        const call = calls[i] as CollectedToolCall;
        const startedAt = Date.now();
        // cm:guard a gate that throws refuses the call rather than letting it run ungated or ending the turn: the model reads why, the row carries isError, and the write the gate stood before never happens (ISS-1064)
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
        // cm:guard `response_format` goes only on a round that offers NO tools — Gemini rejects function calling combined with a JSON response schema, and on a tool round the schema would constrain the prose-with-tool-calls shape this loop reads; a tool-less turn gets it on its single round, a tool turn on the final one
        responseFormat: offered ? undefined : args.responseFormat,
        ...(args.reasoningEffort ? { reasoningEffort: args.reasoningEffort } : {}),
        signal,
      })) {
        if (event.type === 'chunk') {
          turnText += event.text;
          yield event;
        } else if (event.type === 'reasoning') {
          // cm:guard reasoning is forwarded and NOT added to `turnText`: `turnText` becomes the
          // turn's answer and the reply the door screens, and a model's thinking is neither. The arm
          // exists at all because this chain has no final `else yield event` — a member of the union
          // with no arm here is dropped between the adapter and every observer, silently, which is
          // how the whole of ISS-1079 could have passed its adapter tests and shown nothing.
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

      // cm:why results are yielded and fed back in MODEL order once the whole round has completed — every tool_call_id gets exactly one reply and the SSE pairing stays deterministic whatever finished first
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
        // cm:guard the error flag and the measured duration ride the event the transcript reads,
        // not just the audit row: without them a transcript cannot say which tool failed or how
        // long it took, which is the whole of ISS-1029 criteria 5 and 6.
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
