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
}

/**
 * How collecting a frame ended.
 */
export type CollectOutcome =
  | { kind: 'collected'; conversationId: string; windowId: string; seq: number }
  | { kind: 'venue-unresolved' };

/**
 * Take one inbound frame into its conversation and its window.
 */
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
    return {
      kind: 'collected' as const,
      conversationId: conversation.id,
      windowId: window.id,
      seq: row.seq,
    };
  });
}
