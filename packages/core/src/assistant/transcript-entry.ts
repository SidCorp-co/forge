/**
 * One assistant turn's canonical transcript entry, accumulated from the events
 * the turn loop yields (ISS-1029).
 *
 * The Claude Code CLI path gets this shape for free: `lib/agent-stream-parser.ts`
 * builds an `AgentMessage` per stream-json line, and the web formatter
 * (`features/session/types.ts parseMessages`) reads exactly that. The assistant
 * path's upstream is a different wire — the OpenAI Chat Completions events in
 * `providers/types.ts` — so this module is what makes the two paths END in the
 * same entry: same ordered `blocks`, same `toolCalls`, one formatter.
 *
 * It is a PRODUCER of the canonical shape, never a second definition of it. The
 * shape, and the merge that settles a result onto its call, both come from
 * `agent-stream-parser.ts` and are imported rather than restated here.
 */

import {
  type AgentMessage,
  type ContentBlock,
  mergeMessages,
  type ToolCall,
} from '../lib/agent-stream-parser.js';
import type { ChatStreamEvent } from './providers/types.js';

/**
 * How long a growing entry waits before it is re-sent while a turn streams.
 */
// cm:why a coalescing window rather than a frame per event: both streaming paths send the WHOLE
// entry on every frame, so emitting per chunk re-sends every settled tool output on every token. A
// tool call or its result flushes immediately regardless — those are the frames a reader is waiting
// on, and there are few of them.
// cm:guard the window lives HERE, beside the accumulator both paths drive, rather than in either
// caller: the decision that fixed it at 120ms stated its undo as raising or lowering one shared
// constant. It had a copy in `run-turn.ts` and a second in `conversation-progress.ts` for exactly
// one commit (ISS-1078), which is how two surfaces start coalescing differently while a comment
// says they cannot.
export const ENTRY_FLUSH_MS = 120;

export interface TranscriptAccumulator {
  /** Fold one loop event into the entry. */
  apply(event: ChatStreamEvent): void;
  /** The entry as it stands, or null while the turn has produced nothing. */
  entry(): AgentMessage | null;
  /** Just the blocks, for the column — null while nothing has accumulated. */
  blocks(): ContentBlock[] | null;
}

/**
 * The model's `arguments` string as the canonical `input` object.
 */
// cm:guard a string that is not a JSON object is kept under `arguments` rather than dropped or
// guessed at: `ToolCall.input` is typed `Record<string, unknown>`, the raw text is what the model
// actually sent, and the executor (`run-turn-core.ts safeExecute`) has already been handed the same
// string — so the transcript recording `{}` would say the model called the tool with no arguments,
// which is a different and false claim. The key collides with nothing, because this branch is only
// reached when the payload did not parse as an object at all.
function toInput(raw: string): Record<string, unknown> {
  if (raw.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // falls through to the raw form below
  }
  return { arguments: raw };
}

export function createTranscriptAccumulator(
  opts: { id?: string; now?: () => number } = {},
): TranscriptAccumulator {
  const now = opts.now ?? (() => Date.now());
  const id = opts.id ?? 'pending';
  let entry: AgentMessage | null = null;
  /** Index of the text block still being appended to, or -1 when a tool closed it. */
  let openText = -1;

  const ensure = (): AgentMessage => {
    entry ??= { id, type: 'assistant', timestamp: now(), blocks: [], toolCalls: [] };
    return entry;
  };

  const applyChunk = (text: string): void => {
    if (text.length === 0) return;
    const e = ensure();
    const blocks = e.blocks as ContentBlock[];
    // cm:guard chunks COALESCE into the open text block instead of each becoming one: this wire
    // streams token by token, and `mergeMessages` appends every text block it is given — feeding it
    // per-token would put one block per token in the column. The CLI path never hits this because a
    // stream-json line already carries a whole block.
    if (openText >= 0) {
      const b = blocks[openText] as { type: 'text'; text: string };
      b.text += text;
    } else {
      blocks.push({ type: 'text', text });
      openText = blocks.length - 1;
    }
    e.content = blocks
      .filter((b): b is ContentBlock & { text: string } => b.type === 'text' && !!b.text)
      .map((b) => b.text)
      .join('');
  };

  const applyToolCall = (ev: { id: string; name: string; arguments: unknown }): void => {
    const e = ensure();
    const call: ToolCall = {
      id: ev.id,
      name: ev.name,
      input: toInput(typeof ev.arguments === 'string' ? ev.arguments : ''),
    };
    (e.blocks as ContentBlock[]).push({ type: 'tool', toolCall: call });
    (e.toolCalls as ToolCall[]).push(call);
    // cm:why the open text block is CLOSED here and not merged with whatever prose follows: the
    // order prose/tool/prose is the readable record of what the turn did, and joining the two ends
    // of it around the call is what loses it.
    openText = -1;
  };

  const applyToolResult = (ev: {
    id: string;
    result: unknown;
    isError?: boolean;
    durationMs?: number;
  }): void => {
    const e = entry;
    const known = (e?.toolCalls ?? []).some((t) => t.id === ev.id);
    // cm:guard a result naming no call this entry holds is REFUSED by name, never dropped: the loop
    // pairs every result with the call it executed, so an unmatched id means the pairing broke
    // upstream — and `mergeMessages` would answer it by appending a stray `tool_result` message
    // that renders as a tool nobody called (ISS-1029 criterion 14).
    if (!e || !known) {
      throw new Error(
        `transcript: tool result for ${ev.id} names no tool call this turn made (calls: ${
          (e?.toolCalls ?? []).map((t) => t.id).join(', ') || 'none'
        })`,
      );
    }
    // cm:why `mergeMessages` and not a local copy — settling `output`/`isError`/`durationMs` onto
    // the matching call, on the message AND on its block, is exactly what it already does for the
    // CLI path, and it reads no stream-json field to do it.
    const holder: AgentMessage[] = [e];
    mergeMessages(holder, [
      {
        id: `${ev.id}-result`,
        type: 'tool_result',
        timestamp: now(),
        toolName: ev.id,
        toolOutput: typeof ev.result === 'string' ? ev.result : JSON.stringify(ev.result ?? ''),
        ...(ev.isError === true ? { isError: true } : {}),
        ...(ev.durationMs !== undefined ? { durationMs: ev.durationMs } : {}),
      },
    ]);
    entry = holder[holder.length - 1] as AgentMessage;
  };

  return {
    apply(event: ChatStreamEvent): void {
      if (event.type === 'chunk') applyChunk(event.text);
      else if (event.type === 'tool_call') applyToolCall(event);
      else if (event.type === 'tool_result') applyToolResult(event);
    },
    entry: () => entry,
    blocks: () => {
      const b = entry?.blocks;
      return b && b.length > 0 ? b : null;
    },
  };
}
