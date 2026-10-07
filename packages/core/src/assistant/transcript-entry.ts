/**
 * One assistant turn's canonical transcript entry, accumulated from the events
 * the turn loop yields (ISS-1029).
 *
 * The Claude Code CLI path gets this shape for free: `lib/agent-stream-parser.ts`
 * builds an `AgentMessage` per stream-json line, and the web formatter
 * (`features/session/types.ts parseMessages`) reads exactly that. The assistant
 * path's upstream is a different wire — the OpenAI Chat Completions events in
 * `integrations/llm/types.ts` — so this module is what makes the two paths END in the
 * same entry: same ordered `blocks`, same `toolCalls`, one formatter.
 *
 * It is a PRODUCER of the canonical shape, never a second definition of it. The
 * shape, and the merge that settles a result onto its call, both come from
 * `agent-stream-parser.ts` and are imported rather than restated here.
 */

import type { ChatStreamEvent } from '../integrations/llm/index.js';
import {
  type AgentMessage,
  type ContentBlock,
  mergeMessages,
  type ToolCall,
} from '../lib/agent-stream-parser.js';

/**
 * How long a growing entry waits before it is re-sent while a turn streams.
 */
export const ENTRY_FLUSH_MS = 120;

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

/** Folds one turn's loop events into its entry. */
export class TranscriptAccumulator {
  #entry: AgentMessage | null = null;
  /** Index of the text block still being appended to, or -1 when a tool closed it. */
  #openText = -1;
  #openThinking = -1;
  /** When the open thinking block took its first delta, for the duration stamped on the close. */
  #thinkingOpenedAt = 0;

  constructor(private readonly id: string) {}

  apply(event: ChatStreamEvent): void {
    if (event.type === 'reasoning') {
      this.#reasoning(event);
      return;
    }
    this.#closeThinking();
    if (event.type === 'chunk') this.#chunk(event.text);
    else if (event.type === 'tool_call') this.#toolCall(event);
    else if (event.type === 'tool_result') this.#toolResult(event);
    else if (event.type === 'round_retry') this.#dropRound();
  }

  /** The entry as it stands, or null while the turn has produced nothing. */
  entry(): AgentMessage | null {
    return this.#entry;
  }

  /** Just the blocks, for the column — null while nothing has accumulated. */
  blocks(): ContentBlock[] | null {
    const b = this.#entry?.blocks;
    return b && b.length > 0 ? b : null;
  }

  #blocks(): ContentBlock[] {
    this.#entry ??= {
      id: this.id,
      type: 'assistant',
      timestamp: Date.now(),
      blocks: [],
      toolCalls: [],
    };
    return this.#entry.blocks as ContentBlock[];
  }

  #closeThinking(): void {
    if (this.#openThinking < 0 || !this.#entry) return;
    const b = (this.#entry.blocks as ContentBlock[])[this.#openThinking] as ContentBlock;
    b.durationMs = Date.now() - this.#thinkingOpenedAt;
    this.#openThinking = -1;
  }

  #reasoning(ev: { text: string; redacted?: true }): void {
    const blocks = this.#blocks();
    if (ev.redacted === true) {
      this.#closeThinking();
      blocks.push({ type: 'thinking' });
      this.#openText = -1;
      return;
    }
    if (ev.text.length === 0) return;
    if (this.#openThinking >= 0) {
      const b = blocks[this.#openThinking] as ContentBlock;
      b.thinking = (b.thinking ?? '') + ev.text;
      return;
    }
    blocks.push({ type: 'thinking', thinking: ev.text });
    this.#openThinking = blocks.length - 1;
    this.#thinkingOpenedAt = Date.now();
    this.#openText = -1;
  }

  /** A round asked again: the prose and thinking it streamed after the last tool are taken back. */
  #dropRound(): void {
    const blocks = this.#entry?.blocks;
    if (!blocks) return;
    while (blocks.length > 0 && (blocks.at(-1) as ContentBlock).type !== 'tool') blocks.pop();
    this.#openText = -1;
    this.#openThinking = -1;
    this.#settleContent();
  }

  #settleContent(): void {
    (this.#entry as AgentMessage).content = this.#blocks()
      .filter((b): b is ContentBlock & { text: string } => b.type === 'text' && !!b.text)
      .map((b) => b.text)
      .join('');
  }

  #chunk(text: string): void {
    if (text.length === 0) return;
    const blocks = this.#blocks();
    if (this.#openText >= 0) {
      (blocks[this.#openText] as { type: 'text'; text: string }).text += text;
    } else {
      blocks.push({ type: 'text', text });
      this.#openText = blocks.length - 1;
    }
    this.#settleContent();
  }

  #toolCall(ev: { id: string; name: string; arguments: unknown }): void {
    const blocks = this.#blocks();
    const call: ToolCall = {
      id: ev.id,
      name: ev.name,
      input: toInput(typeof ev.arguments === 'string' ? ev.arguments : ''),
    };
    blocks.push({ type: 'tool', toolCall: call });
    ((this.#entry as AgentMessage).toolCalls as ToolCall[]).push(call);
    this.#openText = -1;
  }

  #toolResult(ev: { id: string; result: unknown; isError?: boolean; durationMs?: number }): void {
    const e = this.#entry;
    const calls = e?.toolCalls ?? [];
    if (!e || !calls.some((t) => t.id === ev.id)) {
      throw new Error(
        `transcript: tool result for ${ev.id} names no tool call this turn made (calls: ${
          calls.map((t) => t.id).join(', ') || 'none'
        })`,
      );
    }
    const holder: AgentMessage[] = [e];
    mergeMessages(holder, [
      {
        id: `${ev.id}-result`,
        type: 'tool_result',
        timestamp: Date.now(),
        toolName: ev.id,
        toolOutput: typeof ev.result === 'string' ? ev.result : JSON.stringify(ev.result ?? ''),
        ...(ev.isError === true ? { isError: true } : {}),
        ...(ev.durationMs !== undefined ? { durationMs: ev.durationMs } : {}),
      },
    ]);
    this.#entry = holder[holder.length - 1] as AgentMessage;
  }
}
