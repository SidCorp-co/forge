import { FILTERED, scrubLogText } from '@forge/observability';
import type { AgentMessage, ContentBlock } from '../lib/agent-stream-parser.js';
import { logger } from '../logger.js';
import { readsAsCredential } from '../messaging/text-rules.js';
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
  /**
   * The draft the reply screen withdrew in this turn, stored beside the reply that replaced it so the
   * room still says so after a reload (ISS-1229 r36, judge-97); null where nothing was kept.
   */
  withdrawnDraft: () => string | null;
  withdrawnFor: () => WithdrawnFor | null;
  /** The one id the frames, the delivered message and the stored row all share. */
  entryId: string;
  /**
   * Stop watching, and wait for every frame already queued to be published.
   */
  close: () => Promise<void>;
}

/** Why a withdrawn draft keeps no text: it read as a credential (ISS-1229 r43). */
export type WithdrawnFor = 'credential';

/** Everything published under one conversation, so a client can order what it receives. */
export interface ConversationProgressFrame {
  conversationId: string;
  /** Monotonic per turn. A client ignores a frame below the highest it has drawn. */
  rev: number;
  entry: AgentMessage;
  /**
   * Set when the text that went out is NOT the prose these frames streamed.
   */
  replaced?: { draft: string } | { draft: null; for: WithdrawnFor };
}

const PEM_HEADER = /-----BEGIN (?:[A-Z]{1,12} ){0,3}PRIVATE KEY-----/;

/**
 * Prose as a reader may see it while it is still being written: scrubbed, and cut at a private key's
 * header, whose body the scrubber only matches once 16 characters of it exist (ISS-1229 r43).
 */
function shownWhileWritten(text: string): string {
  const key = PEM_HEADER.exec(text);
  return scrubLogText(key ? text.slice(0, key.index) + FILTERED : text);
}

type ProseKind = 'text' | 'thinking';

/**
 * Blocks with no credential in their prose. A tool call splits one run of prose into blocks, so a key
 * and its value can sit in two: where the run joined up reads as a credential, it is shown as one
 * scrubbed block after the others rather than block by block.
 */
function withoutCredentials(blocks: readonly ContentBlock[]): ContentBlock[] {
  let out = blocks.map((b) => ({ ...b }));
  for (const kind of ['text', 'thinking'] as const satisfies readonly ProseKind[]) {
    const prose = out.filter((b) => b.type === kind && b[kind] !== undefined);
    const joined = prose.map((b) => b[kind]).join('');
    const shown = shownWhileWritten(joined);
    if (shown !== joined && prose.length > 1) {
      out = [...out.filter((b) => !prose.includes(b)), { type: kind, [kind]: shown }];
    } else {
      for (const b of prose) b[kind] = shownWhileWritten(b[kind] as string);
    }
  }
  return out;
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
  let withdrawn: string | null = null;
  let withdrawnFor: WithdrawnFor | null = null;
  let tail: Promise<unknown> = Promise.resolve();

  /** The entry as it stands right now, detached from the accumulator that keeps folding into it. */
  const freeze = (entry: AgentMessage): AgentMessage => ({
    ...entry,
    ...(entry.content !== undefined ? { content: shownWhileWritten(entry.content) } : {}),
    blocks: withoutCredentials(entry.blocks ?? []).map((b) => ({
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

    blocksForRecord: (deliveredText) => {
      const blocks = blocksFor(deliveredText);
      return blocks ? withoutCredentials(blocks) : null;
    },

    withdrawnDraft: () => withdrawn,

    withdrawnFor: () => withdrawnFor,

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
      if (!screenReplaced) {
        send({ entry: corrected });
        return;
      }
      if (readsAsCredential(draft)) {
        withdrawnFor = 'credential';
        send({ entry: corrected, replaced: { draft: null, for: 'credential' } });
        return;
      }
      withdrawn = draft;
      send({ entry: corrected, replaced: { draft } });
    },
  };
}
