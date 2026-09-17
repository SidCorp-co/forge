/**
 * A turn, published while it runs.
 *
 * The Forge UI used to learn a turn had happened and nothing about it happening:
 * `conversation.message` and `conversation.settled` carry a conversation id, so
 * a person pressing enter saw one spinner until the whole answer arrived at
 * once. This module is the other half — the same canonical entry
 * `transcript-entry.ts` accumulates, published to every reader of the room as it
 * grows, so the browser draws prose, tool calls and their results at the moment
 * they happen (ISS-1078).
 *
 * It is a WATCHER of a turn and never a participant in one. It cannot change
 * what the model is asked, what the screen admits or what the transcript keeps;
 * the one thing it owes upward is the accumulator's own refusal, which it does
 * not catch.
 */

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
  // cm:guard this is not `acc.blocks()` and must not become it: the accumulator's text blocks hold
  // the DRAFT, so writing them beside a replaced reply would put a refused draft into the transcript
  // through `blocks` — the one thing the socket-not-record boundary forbids. Where the text that went
  // out is the text that streamed, the full interleaving is stored, because it is true. Where the
  // screen replaced it, only the tool blocks are, and `content` carries the delivered text: the
  // interleaving of a reply nobody streamed is not known, and composing one would be a fabrication
  // (ISS-1078).
  blocksForRecord: (deliveredText: string) => ContentBlock[] | null;
  /** The one id the frames, the delivered message and the stored row all share. */
  entryId: string;
  /**
   * Stop watching, and wait for every frame already queued to be published.
   */
  // cm:guard awaited BEFORE `conversation.settled` goes out, because the settle is published by a
  // different call that never joined this chain: a progress frame still queued when the turn ended
  // would arrive AFTER the settle, and a client that clears its in-flight entry on the settle would
  // then have that frame resurrect a turn it had already finished drawing. Closing also refuses
  // anything later, so a late event cannot start the chain up again (ISS-1078, consult F1).
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
  // cm:guard the DRAFT is carried rather than dropped, because a reader watched it arrive: a frame
  // that silently swapped the text would be the screen's correction happening invisibly, which is the
  // one thing the owner's decision ruled out. The client draws the replacement marked as a
  // correction, and the draft is what it marks (ISS-1078).
  replaced?: { draft: string };
}

/**
 * Watch one turn in one room.
 */
// cm:hack ISS-1078 until:an incremental reply screen exists that can judge a partial message — the
// prose published here has NOT passed `screenReplyAtDoor`, because that screen judges a whole reply
// after the turn completes and there is no partial form of it. So a reader sees the model's draft
// before the door has admitted it, which reverses ISS-978's boundary for `web-chat-reply` and for
// that door alone. The price and the reason are on that door's own row in `messaging/doors.ts`. What
// is NOT reversed: the transcript still stores only the sentence that went out
// (`conversations/transcript.ts`), so the record never holds a refused draft. When an incremental
// screen lands, prose is screened as it streams and `replaced` above becomes dead code.
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
  // cm:guard publishes are CHAINED rather than each fired independently: every frame carries the whole
  // entry, and `publishToConversationReaders` reads the participant list per call, so two in flight
  // can land out of order and visibly rewind the text a reader is watching. `rev` is the client's
  // second defence, for the frames that cross a reconnect rather than each other.
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
      // cm:guard the entry is COPIED here, before the frame joins the chain, because `acc.entry()`
      // hands back the same mutable object every time and folds each later chunk into it: the
      // publish below runs a tick or more later, after `publishToConversationReaders` has resolved
      // the room's participants, so a frame queued behind a slow one serializes the turn as it
      // stands when the publish finally runs rather than at its own flush boundary. `rev` orders the
      // frames and cannot fix this — every one of them would carry the same, latest text, which is
      // the coalescing window buying nothing at all. Text is what mutates in place; a tool result
      // goes through `mergeMessages`, which returns a new object, so this is invisible on the tool
      // path and plain on the streaming one (ISS-1078 review F1).
      entry: freeze(frame.entry),
    };
    // cm:guard a failure to publish is CAUGHT here and nowhere else, which is the whole reason this
    // catch is not in `external-chat.ts`: a socket that went away must not end a turn the room is
    // still owed, while the accumulator's refusal above must. Separating them is what lets that file
    // rethrow everything it sees.
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
  // cm:guard a tools-only array is NOT a legal answer here, and this is the correction the plan's
  // first version got wrong twice — once for the record and once for the frame. The web formatter
  // (`features/session/types.ts assistantBlocks`) reads `blocks` EXCLUSIVELY when it is non-empty and
  // never falls back to `content`, so blocks holding tool cards and no text render a turn whose reply
  // has vanished. Where the screen replaced the draft, the tool blocks are kept in order and ONE text
  // block carrying the delivered text is appended: the true interleaving of a reply nobody streamed is
  // unknown, and "it ran these, then said this" is the honest reading rather than an invented one.
  // A turn with nothing else to keep returns null, because then `content` alone is the whole answer
  // and the formatter's null-blocks path draws it (ISS-1078, consult F3).
  // cm:guard what may not stand alone here is TEXT, and the kept set is therefore everything that is
  // not text — tool blocks and, since ISS-1079, thinking blocks. The filter read `type === 'tool'`
  // while that was a list of one, which silently dropped every turn's reasoning the moment the shape
  // grew a second non-text member (ISS-1079, plan consult F2).
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

    // cm:guard `acc.apply` is OUTSIDE the publish's catch and its throw is not caught at all: a tool
    // result naming no call this turn made is an upstream pairing break, and `external-chat.ts` ends
    // the turn on it (ISS-1029 criterion 14).
    onTurnEvent: (event) => {
      acc.apply(event);
      // cm:guard a tool call and a tool result flush IMMEDIATELY and never wait out the window: those
      // are the two frames a reader is actually waiting on, and there are few of them per turn.
      const boundary = event.type === 'tool_call' || event.type === 'tool_result';
      if (boundary || now() - lastFlush >= ENTRY_FLUSH_MS) flush();
    },

    // cm:guard the comparison is against the ACCUMULATED prose and not against the last frame sent,
    // because the coalescing window means the tail of a draft may never have been published — and a
    // draft nobody saw still differs from the text that went out. Comparing trimmed, because that is
    // what `screenedTurnReply` returns and what the transcript stores.
    // cm:guard whether this is a CORRECTION is the runner's answer and never this comparison's: on a
    // turn that called a tool the accumulated prose holds the model's preamble as well, so it differs
    // from the one reply that went out every single time. Marking those replaced told the reader of
    // every tool-using turn that their draft had failed the reply check, which it had not — measured
    // on a local walk, 2026-09-17. The frame still corrects the text, because the stored row holds the
    // delivered reply and the live turn has to end where that row starts (criterion 11).
    onSettled: ({ text, screenReplaced }) => {
      const entry = acc.entry();
      const draft = (entry?.content ?? '').trim();
      const settled = text.trim();
      if (draft === settled) return;
      // cm:guard NO draft means nothing to mark as replaced, and this is not the same test as the one
      // above: a turn that streamed only tool frames, a turn answered by the runner-hosted lane and a
      // turn whose reply is a code-authored fallback all reach here with empty prose and a non-empty
      // settled text. Marking those "replaced" would tell a reader their draft was corrected when they
      // never saw one. The delivered text reaches them as it always did, through the delivery and the
      // settle (ISS-1078).
      if (!draft) return;
      // cm:guard the entry published with the replacement carries the SETTLED text, so a client that
      // draws the frame draws what went out — `replaced.draft` is the thing it marks as corrected,
      // never the thing it shows as the answer.
      // cm:guard the blocks are REBUILT and never spread from the draft's entry: spreading kept the
      // draft's text blocks beside a replaced `content`, so one canonical entry described two
      // different answers and a block-consuming client drew the refused draft as the replacement. The
      // withdrawn prose lives in `replaced.draft` and nowhere else (consult F3).
      const corrected: AgentMessage = {
        ...(entry ?? { id: args.entryId, type: 'assistant', timestamp: now() }),
        content: settled,
        blocks: blocksFor(settled) ?? [{ type: 'text', text: settled }],
      };
      send({ entry: corrected, ...(screenReplaced ? { replaced: { draft } } : {}) });
    },
  };
}
