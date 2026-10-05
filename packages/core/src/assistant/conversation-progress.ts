import type { ChatStreamEvent } from '../integrations/llm/index.js';
import type { AgentMessage, ContentBlock } from '../lib/agent-stream-parser.js';
import { logger } from '../lib/logger.js';
import {
  publishEphemeralToConversationReaders,
  WEB_CONVERSATION_PROGRESS_EVENT,
} from './conversation-adapter.js';
import { ENTRY_FLUSH_MS, TranscriptAccumulator } from './transcript-entry.js';

/** Everything published under one conversation, so a client can order what it receives. */
interface ConversationProgressFrame {
  conversationId: string;
  /** Monotonic per turn. A client ignores a frame below the highest it has drawn. */
  rev: number;
  entry: AgentMessage;
  /**
   * Set when the text that went out is NOT the prose these frames streamed.
   */
  replaced?: { draft: string };
}

/** The entry as it stands right now, detached from the accumulator that keeps folding into it. */
function freeze(entry: AgentMessage): AgentMessage {
  return {
    ...entry,
    blocks: (entry.blocks ?? []).map((b) => ({
      ...b,
      ...(b.toolCall ? { toolCall: { ...b.toolCall } } : {}),
      ...(b.todos ? { todos: b.todos.map((t) => ({ ...t })) } : {}),
    })),
    ...(entry.toolCalls ? { toolCalls: entry.toolCalls.map((t) => ({ ...t })) } : {}),
  };
}

/** Watches one turn in one room, publishing its growing entry to the room's readers. */
export class ConversationProgress {
  readonly #acc: TranscriptAccumulator;
  #lastFlush = 0;
  #rev = 0;
  #closed = false;
  #tail: Promise<unknown> = Promise.resolve();

  /** `entryId` is the one id the frames, the delivered message and the stored row all share. */
  constructor(
    private readonly conversationId: string,
    readonly entryId: string,
  ) {
    this.#acc = new TranscriptAccumulator(entryId);
  }

  /** Fold one turn event in, and publish if the window or a tool boundary says to. */
  onTurnEvent = (event: ChatStreamEvent): void => {
    this.#acc.apply(event);
    const boundary = event.type === 'tool_call' || event.type === 'tool_result';
    if (!boundary && Date.now() - this.#lastFlush < ENTRY_FLUSH_MS) return;
    const entry = this.#acc.entry();
    if (!entry) return;
    this.#lastFlush = Date.now();
    this.#send({ entry });
  };

  /** The text the screen admitted, before it is delivered. */
  onSettled = ({ text, screenReplaced }: { text: string; screenReplaced: boolean }): void => {
    const entry = this.#acc.entry();
    const draft = (entry?.content ?? '').trim();
    const settled = text.trim();
    if (draft === settled || !draft) return;
    const corrected: AgentMessage = {
      ...(entry ?? { id: this.entryId, type: 'assistant', timestamp: Date.now() }),
      content: settled,
      blocks: this.blocksForRecord(settled) ?? [{ type: 'text', text: settled }],
    };
    this.#send({ entry: corrected, ...(screenReplaced ? { replaced: { draft } } : {}) });
  };

  /** The blocks to STORE beside a delivered reply, given the text that went out. */
  blocksForRecord = (finalText: string): ContentBlock[] | null => {
    const blocks = this.#acc.blocks();
    if (!blocks) return null;
    const draft = (this.#acc.entry()?.content ?? '').trim();
    if (draft === finalText.trim()) return blocks;
    const kept = blocks.filter((b) => b.type === 'tool' || b.type === 'thinking');
    if (kept.length === 0) return null;
    return [...kept, { type: 'text', text: finalText }];
  };

  /** Stop watching, and wait for every frame already queued to be published. */
  async close(): Promise<void> {
    this.#closed = true;
    await this.#tail;
  }

  #send(frame: Omit<ConversationProgressFrame, 'conversationId' | 'rev'>): void {
    if (this.#closed) return;
    this.#rev += 1;
    const data: ConversationProgressFrame = {
      conversationId: this.conversationId,
      rev: this.#rev,
      ...frame,
      entry: freeze(frame.entry),
    };
    this.#tail = this.#tail
      .then(() =>
        publishEphemeralToConversationReaders(this.conversationId, {
          event: WEB_CONVERSATION_PROGRESS_EVENT,
          data,
        }),
      )
      .catch((err: unknown) => {
        logger.warn(
          { err, conversationId: this.conversationId, rev: data.rev },
          'conversations: a turn-progress frame was not published',
        );
      });
  }
}
