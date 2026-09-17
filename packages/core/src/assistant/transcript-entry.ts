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
  /** Index of the thinking block still being appended to, or -1 when anything else closed it. */
  let openThinking = -1;
  /** When the open thinking block took its first delta, for the duration stamped on the close. */
  let thinkingOpenedAt = 0;

  const ensure = (): AgentMessage => {
    entry ??= { id, type: 'assistant', timestamp: now(), blocks: [], toolCalls: [] };
    return entry;
  };

  // cm:why the close STAMPS a duration rather than leaving the block bare: the collapsed line a
  // reader sees says how long the model thought, and the only clock that knows is this one. A block
  // no event ever closed keeps no duration, and the line then reads "Thought" — which is also what
  // the count-only form reads, so the renderer needs no third case.
  const closeThinking = (): void => {
    if (openThinking < 0 || !entry) return;
    const b = (entry.blocks as ContentBlock[])[openThinking] as ContentBlock;
    b.durationMs = now() - thinkingOpenedAt;
    openThinking = -1;
  };

  const applyReasoning = (ev: { text: string; redacted?: true }): void => {
    const e = ensure();
    // cm:guard an ENCRYPTED block becomes a thinking block with NO text, and is never opened for
    // appending. The thing a reader must not be given is an expander onto nothing, and what opens
    // onto nothing is a block holding the EMPTY STRING — a block holding no text at all is exactly
    // what "the model paused and left nothing readable" means, and the renderer draws it as a line
    // with no control. It is stored this way rather than counted on the entry because the durable
    // row holds `content` and `blocks` and has no column for a count: the count form was true while
    // the socket carried the live entry and gone the moment the stored row replaced it
    // (ISS-1079, whole-set read F1).
    if (ev.redacted === true) {
      closeThinking();
      (e.blocks as ContentBlock[]).push({ type: 'thinking' });
      openText = -1;
      return;
    }
    if (ev.text.length === 0) return;
    const blocks = e.blocks as ContentBlock[];
    // cm:why reasoning COALESCES exactly as prose does, and for the same reason the chunk guard
    // below states: this wire streams reasoning token by token, and a block per delta would put a
    // block per token in the column.
    if (openThinking >= 0) {
      const b = blocks[openThinking] as ContentBlock;
      b.thinking = (b.thinking ?? '') + ev.text;
      return;
    }
    blocks.push({ type: 'thinking', thinking: ev.text });
    openThinking = blocks.length - 1;
    thinkingOpenedAt = now();
    // cm:why the open TEXT block is closed here, exactly as `applyToolCall` closes it: a model that
    // says something, thinks, then says more has three blocks in that order, and leaving the text
    // block open would join the two halves of the prose into one block sitting BEFORE the thinking
    // — the same order loss that guard names, one block type along.
    openText = -1;
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
      if (event.type === 'reasoning') {
        applyReasoning(event);
        return;
      }
      // cm:guard the open thinking block is closed by the first event of ANY other kind — `done`
      // and `usage` included — rather than by prose alone: a turn that thought and then said
      // nothing still owes its duration, and the close is what stamps it.
      closeThinking();
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
