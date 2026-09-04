/**
 * v1 EPIC 1 (ISS-270) — the chat adapter. Streams any OpenAI-compatible
 * `/v1/chat/completions` endpoint, which in production is a LiteLLM proxy
 * fanning out to several upstream models — so "Vertex" and "Gemini" below name
 * models reached THROUGH that proxy, not a second adapter. It is the only
 * adapter: one wire format every hosted model already speaks beats an adapter
 * per vendor, each with its own half-kept version of the tool-calling contract.
 */

import type { ChatProvider, ChatStreamEvent, ChatStreamRequest, ChatStreamUsage } from './types.js';

export interface OpenAIConfig {
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  /** Override the global `fetch` for tests. */
  fetchImpl?: typeof fetch;
  /** Backoff between pre-stream retries; tests pass [0] to skip waiting. */
  retryDelaysMs?: number[];
}

/** Transient upstream statuses worth a pre-stream retry (Vertex "high demand"
 *  surfaces as 503 through the proxy; 429 is straight rate limiting). */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 529]);
const DEFAULT_RETRY_DELAYS_MS = [1000, 3000];

interface OpenAIToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAIDelta {
  content?: string | null;
  role?: string;
  tool_calls?: OpenAIToolCallDelta[];
}

interface OpenAIChunk {
  choices?: Array<{ delta?: OpenAIDelta; finish_reason?: string | null }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

interface ToolCallAccumulator {
  id: string;
  name: string;
  args: string;
}

export function createOpenAIProvider(cfg: OpenAIConfig): ChatProvider {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const baseUrl = cfg.baseUrl.replace(/\/+$/, '');
  return {
    id: 'openai',
    defaultModel: cfg.defaultModel,
    async *stream(req: ChatStreamRequest): AsyncIterable<ChatStreamEvent> {
      const retryDelays = cfg.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
      // `tool_choice: 'required'` makes Vertex/Gemini compile ALL tool schemas
      // into a constrained-decoding grammar; a large toolset then 400s with
      // "too many states for serving". Degrade to auto and retry rather than
      // failing the turn — the post-turn reply guard still polices laziness.
      let toolChoice = req.toolChoice;
      const init = (): RequestInit => {
        const i: RequestInit = {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${cfg.apiKey}`,
            accept: 'text/event-stream',
          },
          body: JSON.stringify({
            model: req.model,
            messages: req.messages,
            stream: true,
            stream_options: { include_usage: true },
            ...(req.tools && req.tools.length > 0 ? { tools: req.tools } : {}),
            ...(req.tools && req.tools.length > 0 && toolChoice ? { tool_choice: toolChoice } : {}),
            ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          }),
        };
        if (req.signal) i.signal = req.signal;
        return i;
      };

      // Pre-stream retry: nothing has been consumed yet, so a transient 429/5xx
      // (or a network hiccup) is safely retried with backoff. Mid-stream errors
      // below are NOT retried — partial output may already have been yielded.
      let res: Response | null = null;
      let lastError = '';
      for (let attempt = 0; ; attempt++) {
        try {
          res = await fetchImpl(`${baseUrl}/v1/chat/completions`, init());
        } catch (err) {
          res = null;
          lastError = errorMessage(err);
        }
        if (res?.ok && res.body) break;
        if (res) {
          const body = await safeReadText(res);
          lastError = `openai http ${res.status}${body ? `: ${body.slice(0, 500)}` : ''}`;
          // Vertex constrained-decoding overflow on forced tool use — drop the
          // force and retry immediately (does not consume a backoff attempt).
          if (res.status === 400 && toolChoice && /too many states/i.test(body)) {
            toolChoice = undefined;
            attempt--;
            continue;
          }
          if (!RETRYABLE_STATUS.has(res.status)) {
            yield { type: 'error', message: lastError };
            return;
          }
        }
        if (attempt >= retryDelays.length || req.signal?.aborted) {
          yield { type: 'error', message: lastError };
          return;
        }
        await new Promise((r) => setTimeout(r, retryDelays[attempt]));
      }
      if (!res?.body) {
        // Unreachable (the loop only breaks with a body) — narrows for TS.
        yield { type: 'error', message: lastError };
        return;
      }

      // Tool-call deltas arrive fragmented across chunks, keyed by `index`.
      // Reassemble here and flush complete calls when `finish_reason` says so
      // (or at stream end as a fallback).
      const toolAcc = new Map<number, ToolCallAccumulator>();
      const flushToolCalls = function* (): Generator<ChatStreamEvent> {
        for (const [, acc] of [...toolAcc.entries()].sort((a, b) => a[0] - b[0])) {
          if (!acc.name) continue;
          yield { type: 'tool_call', id: acc.id, name: acc.name, arguments: acc.args };
        }
        toolAcc.clear();
      };

      try {
        for await (const event of parseSseStream(res.body)) {
          if (event === '[DONE]') break;
          let chunk: OpenAIChunk;
          try {
            chunk = JSON.parse(event) as OpenAIChunk;
          } catch {
            continue;
          }
          const choice = chunk.choices?.[0];
          const text = choice?.delta?.content;
          if (typeof text === 'string' && text.length > 0) {
            yield { type: 'chunk', text };
          }
          const toolDeltas = choice?.delta?.tool_calls;
          if (toolDeltas) {
            for (const td of toolDeltas) {
              const idx = td.index ?? 0;
              let acc = toolAcc.get(idx);
              if (!acc) {
                acc = { id: '', name: '', args: '' };
                toolAcc.set(idx, acc);
              }
              if (td.id) acc.id = td.id;
              if (td.function?.name) acc.name = td.function.name;
              if (td.function?.arguments) acc.args += td.function.arguments;
            }
          }
          if (choice?.finish_reason === 'tool_calls') {
            yield* flushToolCalls();
          }
          if (chunk.usage) {
            const usage: ChatStreamUsage = {};
            if (chunk.usage.prompt_tokens !== undefined) {
              usage.promptTokens = chunk.usage.prompt_tokens;
            }
            if (chunk.usage.completion_tokens !== undefined) {
              usage.completionTokens = chunk.usage.completion_tokens;
            }
            if (chunk.usage.total_tokens !== undefined) {
              usage.totalTokens = chunk.usage.total_tokens;
            }
            const cached = chunk.usage.prompt_tokens_details?.cached_tokens;
            if (typeof cached === 'number') usage.cachedPromptTokens = cached;
            yield { type: 'usage', usage };
          }
        }
        // cm:why some proxies end the stream without a `tool_calls` finish_reason, so anything still buffered is flushed before terminating
        yield* flushToolCalls();
        yield { type: 'done' };
      } catch (err) {
        yield { type: 'error', message: errorMessage(err) };
      }
    },
  };
}

// cm:guard no regex FLAGS newer than es2017 anywhere in packages/core — `pnpm --filter web-v2 build` type-checks core's SOURCES against web-v2's own lower target, so a flag core's tsconfig accepts compiles clean here and fails the WEB build; `[\s\S]` carries dotAll's meaning with no flag, which is why neither regex below is flagged. Broke the Coolify deploy of 2a1e19c0, 2026-08-31. It lived in the Gemini adapter until that file was deleted 2026-09-03 and is a whole-package rule, so it moved here rather than dying with its host.
// cm:guard an SSE boundary is ANY two consecutive line terminators, each independently CRLF, CR or LF — `\n\r\n` and `\r\n\r` are legal and a proxy that mixes them is not hypothetical, so matching only the three symmetric spellings glues frames together until the next recognized boundary or EOF and the turn returns an empty `done` indistinguishable from a model with nothing to say
// cm:guard the `(?!\n)` is load-bearing and greediness will NOT do its job: without it the engine backtracks a failed `\r\n` into the bare `\r` and `\n` branches, so ONE internal CRLF between two `data:` lines satisfies both repetitions and splits a multi-line frame in half — each half then fails JSON.parse and is dropped by the catch-continue, silently, and ONLY under CRLF, the spelling this regex exists to support. Verified 2026-09-03: the un-guarded pattern matches `data: a\r\ndata: b\r\n\r\n` at index 7 instead of 16
const FRAME_BOUNDARY = /(?:\r\n|\r(?!\n)|\n){2}/;

/** The `data:` payload of one SSE frame, or '' when it carries no data line. */
function frameData(raw: string): string {
  return raw
    .split(/\r\n|[\n\r]/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
}

async function* parseSseStream(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buf = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let boundary = FRAME_BOUNDARY.exec(buf);
      while (boundary) {
        const data = frameData(buf.slice(0, boundary.index));
        buf = buf.slice(boundary.index + boundary[0].length);
        if (data) yield data;
        boundary = FRAME_BOUNDARY.exec(buf);
      }
    }
    // cm:guard flush once more after the read loop — an upstream that closes without a final blank line still sent that frame, and dropping it loses the last delta or the `[DONE]`
    const tail = frameData(buf);
    if (tail) yield tail;
  } finally {
    // cm:guard cancel, don't just releaseLock — on the `[DONE]` break the body is left unread, and an uncancelled body holds its connection out of the pool for the socket's lifetime
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
