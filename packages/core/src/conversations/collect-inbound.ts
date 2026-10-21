import { db } from '../db/client.js';
import { carriesAnAddress } from '../lib/person-name.js';
import { logger } from '../logger.js';
import type { Executor } from './db-executor.js';
import type { ConversationAdapterPorts } from './ports.js';
import { appendMessagesIn, type ConversationImage, openConversation } from './store.js';
import { openOrExtendWindow } from './windows.js';

export interface InboundCollection<Frame> {
  ports: ConversationAdapterPorts<Frame>;
  frame: Frame;
  /** What was said. */
  message: string;
  /** The transport's own id for the speaker, for the audit row. */
  speakerKey: string;
  /** The transport's own id for this message, so a later turn can tell the room what it has seen. */
  externalMessageId?: string | null;
  /** The transport's own id for the message this one replies to or quotes, where it named one (ISS-1087). */
  replyToExternalId?: string | null;
  /** The name the transport shows for the speaker; none where the speaker is a Forge person on Forge's
   *  own surface, whose name is read from their row when the room is read (ISS-1229 r25). */
  speakerLabel?: string | null;
  /** Image references as the transport names them — no bytes, which are fetched at route time. */
  images?: readonly ConversationImage[];
  /** Whose authority a turn runs under in a venue that has many speakers. */
  manySpeakersPrincipalUserId: string;
  /**
   * One more write the caller wants committed with this message, or not at all.
   */
  withinCollection?: (
    tx: Executor,
    collected: { conversationId: string; seq: number },
  ) => Promise<void>;
}

/**
 * How collecting a frame ended.
 */
export type CollectOutcome =
  | {
      kind: 'collected';
      conversationId: string;
      windowId: string;
      seq: number;
      /** The row this message became, so a caller can name it before the turn runs (ISS-1078). */
      messageId: string;
    }
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
          authorLabel: transportLabel(
            inbound.speakerLabel ?? (authorUserId ? null : inbound.speakerKey),
          ),
          authorKey: inbound.speakerKey,
          externalId: inbound.externalMessageId ?? null,
          replyToExternalId: inbound.replyToExternalId ?? null,
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
    await inbound.withinCollection?.(tx as unknown as Executor, {
      conversationId: conversation.id,
      seq: row.seq,
    });
    return {
      kind: 'collected' as const,
      conversationId: conversation.id,
      windowId: window.id,
      seq: row.seq,
      messageId: row.id,
    };
  });
}

/** A transport's handle for its speaker, dropped where it holds an address (ISS-1229 r25). */
function transportLabel(label: string | null): string | null {
  if (label === null || !carriesAnAddress(label)) return label;
  logger.warn(
    'conversations: a transport named its speaker by an email address, so no label was stored',
  );
  return null;
}
