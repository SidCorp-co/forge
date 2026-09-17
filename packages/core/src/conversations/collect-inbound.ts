/**
 * One inbound message, taken in rather than answered.
 *
 * This is the half of `inbound-turn.ts` that runs at the edge: which venue this
 * frame is, who spoke, whose authority a turn here would run under — and then
 * the message goes into the conversation's log and into its collecting window,
 * under one commit. The answer is somebody else's job, taken later over
 * everything the window accumulated (`route-window.ts`).
 *
 * Nothing is gated here. A message that names nobody is collected exactly like
 * one that names the bot; what bounds a room's cost is the window and the
 * guards, which is the argument ISS-1004 makes for removing the @-mention gate.
 */

import { db } from '../db/client.js';
import type { Executor } from './db-executor.js';
import type { ConversationAdapterPorts } from './ports.js';
import { appendMessagesIn, type ConversationImage, openConversation } from './store.js';
import { openOrExtendWindow } from './windows.js';

export interface InboundCollection<Frame> {
  ports: ConversationAdapterPorts<Frame>;
  /** The transport's own message, in its own terms. */
  frame: Frame;
  /** What was said. */
  message: string;
  /** The transport's own id for the speaker, for the audit row. */
  speakerKey: string;
  /** The transport's own id for this message, so a later turn can tell the room what it has seen. */
  externalMessageId?: string | null;
  /** The name the transport shows for the speaker. */
  speakerLabel?: string | null;
  /** Image references as the transport names them — no bytes, which are fetched at route time. */
  images?: readonly ConversationImage[];
  /** Whose authority a turn runs under in a venue that has many speakers. */
  manySpeakersPrincipalUserId: string;
  /**
   * One more write the caller wants committed with this message, or not at all.
   */
  // cm:guard it is handed the transaction and told NOTHING about what it writes, which is the whole of why it is here rather than a branch in this function: the adapter that needs a second write knows what it is, and a collector that knew would be a collector with an adapter's decision in it. A throw from it takes the message and its window with it, which is the point — a caller whose own write lost has not collected anything (ISS-1039, plan consult F2).
  withinCollection?: (
    tx: Executor,
    collected: { conversationId: string; seq: number },
  ) => Promise<void>;
}

/**
 * How collecting a frame ended.
 */
// cm:guard `venue-unresolved` is the ONLY ending before anything is written: a frame nobody could place has no conversation to write into. An unlinked speaker is NOT one of them any more — the message is collected and `route-window.ts` refuses it under the window's delivery key, which is the only arrangement that sends the refusal exactly once. Refusing here first meant a transport that accepted the text and then dropped the connection got a second refusal from the window (ISS-1004, review pass 1 F3 and the plan's own read).
export type CollectOutcome =
  | {
      kind: 'collected';
      conversationId: string;
      windowId: string;
      /**
       * The row the message became.
       */
      // cm:guard answered here and not read back by a second query: the id is what the Forge UI's
      // `conversation.accepted` frame carries so a browser can tell its own unsent copy from the
      // durable one, and a caller that re-read the newest row to find it would sometimes find a
      // different message (ISS-1078).
      messageId: string;
      seq: number;
    }
  | { kind: 'venue-unresolved' };

/**
 * Take one inbound frame into its conversation and its window.
 */
// cm:guard the authority follows the venue's SHAPE and is settled at ROUTE time, not here: a one-to-one venue has exactly one human and runs as them, a many-speaker venue runs under the binding's principal because there is no single authority to be (ISS-987). What this does is remember who spoke, as the transport names them, so the window can ask the directory the same question.
// cm:guard ATTRIBUTION is the resolved SPEAKER and not the authority, and the two are different questions: filing every group-room message under the binding's principal makes a second agent's message look like a person's, which blinds the loop breaker to the exact case it exists for. A speaker nothing has linked is filed as nobody plus the label the transport gave, which is a fact rather than a gap (ISS-1003, ISS-1004).
// cm:guard the append and the window are ONE transaction: a message durable with no window is owed an answer nothing knows to give, and a window with no message is a decision about nothing (ISS-1004 review F3).
export async function collectInboundMessage<Frame>(
  inbound: InboundCollection<Frame>,
): Promise<CollectOutcome> {
  const venue = await inbound.ports.resolveVenue(inbound.frame);
  if (!venue) return { kind: 'venue-unresolved' };

  const speaker = await inbound.ports.resolveSpeaker(inbound.frame);

  const conversation = await openConversation(venue);
  const authorUserId = speaker.linked ? speaker.userId : null;

  return db.transaction(async (tx) => {
    const [row] = await appendMessagesIn(tx, {
      conversationId: conversation.id,
      messages: [
        {
          role: 'user',
          content: inbound.message,
          authorUserId,
          authorLabel: inbound.speakerLabel ?? inbound.speakerKey,
          authorKey: inbound.speakerKey,
          externalId: inbound.externalMessageId ?? null,
          ...(inbound.images && inbound.images.length > 0 ? { images: inbound.images } : {}),
        },
      ],
    });
    if (!row) throw new Error('conversations: collecting a message returned no row');

    const window = await openOrExtendWindow(
      {
        conversationId: conversation.id,
        projectId: venue.projectId,
        adapter: venue.adapter,
        seq: row.seq,
      },
      tx,
    );
    // cm:guard AFTER the message and the window and inside the same transaction: the caller's write is about a message that exists, and it is still free to throw and take both back out with it.
    await inbound.withinCollection?.(tx as unknown as Executor, {
      conversationId: conversation.id,
      seq: row.seq,
    });
    return {
      kind: 'collected' as const,
      conversationId: conversation.id,
      windowId: window.id,
      messageId: row.id,
      seq: row.seq,
    };
  });
}
