import type { AgentMessage, ContentBlock } from '../lib/agent-stream-parser.js';
import { logger } from '../logger.js';
import {
  publishToConversationReaders,
  WEB_CONVERSATION_PROGRESS_EVENT,
} from './conversation-adapter.js';
import type { ChatStreamEvent } from './providers/types.js';
import { createTranscriptAccumulator, ENTRY_FLUSH_MS } from './transcript-entry.js';

/** What a watcher hands back to the turn that is being watched. */
export interface ConversationProgress {
  /** Fold one turn event in, and publish if the window or a tool boundary says to. */
  onTurnEvent: (event: ChatStreamEvent) => void;
  /** The text the screen admitted, before it is delivered. */
  onSettled: (settled: { text: string; screenReplaced: boolean }) => void;
  /**
   * The blocks to STORE beside a delivered reply, given the text that went out.
   */
  blocksForRecord: (deliveredText: string) => ContentBlock[] | null;
  /** The one id the frames, the delivered message and the stored row all share. */
  entryId: string;
  /**
   * Stop watching, and wait for every frame already queued to be published.
   */
  close: () => Promise<void>;
}

/** Everything published under one conversation, so a client can order what it receives. */
export interface ConversationProgressFrame {
  conversationId: string;
  /** Monotonic per turn. A client ignores a frame below the highest it has drawn. */
  rev: number;
  entry: AgentMessage;
  /**
   * Set when the text that went out is NOT the prose these frames streamed.
   */
  replaced?: { draft: string };
}

/**
 * Watch one turn in one room.
 */
export function startConversationProgress(args: {
  conversationId: string;
  entryId: string;
  /** Swapped in tests; the room's own fan-out otherwise. */
  publish?: (conversationId: string, envelope: { event: string; data: unknown }) => Promise<number>;
  now?: () => number;
}): ConversationProgress {
  const publish = args.publish ?? publishToConversationReaders;
  const now = args.now ?? (() => Date.now());
  const acc = createTranscriptAccumulator({ id: args.entryId });
  let lastFlush = 0;
  let rev = 0;
  let closed = false;
  let tail: Promise<unknown> = Promise.resolve();

  /** The entry as it stands right now, detached from the accumulator that keeps folding into it. */
  const freeze = (entry: AgentMessage): AgentMessage => ({
    ...entry,
    blocks: (entry.blocks ?? []).map((b) => ({
      ...b,
      ...(b.toolCall ? { toolCall: { ...b.toolCall } } : {}),
      ...(b.todos ? { todos: b.todos.map((t) => ({ ...t })) } : {}),
    })),
    ...(entry.toolCalls ? { toolCalls: entry.toolCalls.map((t) => ({ ...t })) } : {}),
  });

  const send = (frame: Omit<ConversationProgressFrame, 'conversationId' | 'rev'>): void => {
    if (closed) return;
    rev += 1;
    const data: ConversationProgressFrame = {
      conversationId: args.conversationId,
      rev,
      ...frame,
      entry: freeze(frame.entry),
    };
    tail = tail
      .then(() => publish(args.conversationId, { event: WEB_CONVERSATION_PROGRESS_EVENT, data }))
      .catch((err: unknown) => {
        logger.warn(
          { err, conversationId: args.conversationId, rev: data.rev },
          'conversations: a turn-progress frame was not published',
        );
      });
  };

  /**
   * The blocks that belong to a given final text.
   */
  const blocksFor = (finalText: string): ContentBlock[] | null => {
    const blocks = acc.blocks();
    if (!blocks) return null;
    const draft = (acc.entry()?.content ?? '').trim();
    if (draft === finalText.trim()) return blocks;
    const kept = blocks.filter((b) => b.type === 'tool' || b.type === 'thinking');
    if (kept.length === 0) return null;
    return [...kept, { type: 'text', text: finalText }];
  };

  const flush = (): void => {
    const entry = acc.entry();
    if (!entry) return;
    lastFlush = now();
    send({ entry });
  };

  return {
    entryId: args.entryId,

    close: async () => {
      closed = true;
      await tail;
    },

    blocksForRecord: (deliveredText) => blocksFor(deliveredText),

    onTurnEvent: (event) => {
      acc.apply(event);
      const boundary = event.type === 'tool_call' || event.type === 'tool_result';
      if (boundary || now() - lastFlush >= ENTRY_FLUSH_MS) flush();
    },

    onSettled: ({ text, screenReplaced }) => {
      const entry = acc.entry();
      const draft = (entry?.content ?? '').trim();
      const settled = text.trim();
      if (draft === settled) return;
      if (!draft) return;
      const corrected: AgentMessage = {
        ...(entry ?? { id: args.entryId, type: 'assistant', timestamp: now() }),
        content: settled,
        blocks: blocksFor(settled) ?? [{ type: 'text', text: settled }],
      };
      send({ entry: corrected, ...(screenReplaced ? { replaced: { draft } } : {}) });
    },
  };
}
