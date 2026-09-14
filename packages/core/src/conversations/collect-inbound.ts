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
import { logger } from '../logger.js';
import {
  type ConversationAdapterPorts,
  type ConversationVenue,
  codeAuthored,
  conversationTransport,
} from './ports.js';
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
// cm:guard `venue-unresolved` ends BEFORE anything is written: a frame nobody could place has no conversation to write into. `speaker-refused` is the same ONLY when the refusal was delivered — where it was not, the message is collected anyway so the window can refuse durably, because a refusal nobody received and nothing retries is the silence rule 4 forbids (ISS-1004, review pass 1 F3).
export type CollectOutcome =
  | { kind: 'collected'; conversationId: string; windowId: string; seq: number }
  | { kind: 'venue-unresolved' }
  | { kind: 'speaker-refused'; code: string; refusal: string; delivered: boolean };

// cm:guard the refusal goes out the SAME door an answer would have, looked up by the VENUE's adapter: a second outbound path for authority refusals is the copy the extraction removed, and a door that refuses this is logged rather than thrown because the turn was never going to run.
async function refuse(
  venue: ConversationVenue,
  refusal: { code: string; message: string },
): Promise<CollectOutcome | null> {
  const base = { kind: 'speaker-refused' as const, code: refusal.code, refusal: refusal.message };
  try {
    const transport = conversationTransport(venue.adapter);
    if (!transport) throw new Error(`no transport is registered for adapter "${venue.adapter}"`);
    await transport.deliver(venue, codeAuthored(refusal.message));
    // cm:guard a refusal that reached the person is still RECORDED, and the log is the only place it can be: it happens before any conversation row exists, so there is no window to carry the decision and no transcript to hold the text. An operator asking why a room fell quiet must find this line rather than nothing, which is what rule 4 asks of every silence (ISS-1004, review pass 1 F3).
    logger.info(
      { adapter: venue.adapter, externalId: venue.externalId, code: refusal.code },
      'conversations: the speaker was refused and told so; nothing was collected',
    );
    return { ...base, delivered: true };
  } catch (err) {
    // cm:guard a refusal the door would not take hands the message BACK to the collector rather than ending here: the window then holds it, and `route-window.ts` refuses again under a delivery key that cannot say it twice. Dropping it left a person who was owed an answer with neither one nor a record that they were (ISS-1004, review pass 1 F3).
    logger.error(
      { err, adapter: venue.adapter, externalId: venue.externalId, code: refusal.code },
      'conversations: the refusal could not be delivered; collecting it for the window to refuse',
    );
    return null;
  }
}

/**
 * Take one inbound frame into its conversation and its window.
 */
// cm:guard the authority follows the venue's SHAPE, the same rule `inbound-turn.ts` holds: a one-to-one venue has exactly one human and runs as them, a many-speaker venue runs under the binding's principal because there is no single authority to be (ISS-987).
// cm:guard ATTRIBUTION is the resolved SPEAKER and not the authority, and the two are different questions: filing every group-room message under the binding's principal makes a second agent's message look like a person's, which blinds the loop breaker to the exact case it exists for. A speaker nothing has linked is filed as nobody plus the label the transport gave, which is a fact rather than a gap (ISS-1003, ISS-1004).
// cm:guard the append and the window are ONE transaction: a message durable with no window is owed an answer nothing knows to give, and a window with no message is a decision about nothing (ISS-1004 review F3).
export async function collectInboundMessage<Frame>(
  inbound: InboundCollection<Frame>,
): Promise<CollectOutcome> {
  const venue = await inbound.ports.resolveVenue(inbound.frame);
  if (!venue) return { kind: 'venue-unresolved' };

  const speaker = await inbound.ports.resolveSpeaker(inbound.frame);
  if (venue.shape === 'direct' && !speaker.linked) {
    const told = await refuse(venue, speaker.refusal as { code: string; message: string });
    if (told) return told;
  }

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
