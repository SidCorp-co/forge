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
    if (!e || !known) {
      throw new Error(
        `transcript: tool result for ${ev.id} names no tool call this turn made (calls: ${
          (e?.toolCalls ?? []).map((t) => t.id).join(', ') || 'none'
        })`,
      );
    }
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
