/**
 * What a room is told when nobody can be answered as, and how it is told once.
 *
 * Moved out of `route-window.ts` by ISS-1088, which put the request's
 * acknowledgement and status beside the decision and left that module over
 * its line ceiling; nothing here changed in the move.
 */

import {
  type ConversationVenue,
  type ConversationWindowRow,
  codeAuthored,
  conversationTransport,
  recordDeliveredReply,
  reserveDelivery,
  type WindowClaim,
} from '../conversations/index.js';
import { logger } from '../observability/logger.js';
import type { RoutedWindow, RouteWindowArgs } from './route-window.js';

const AUTHORITY_REFUSED_REPLY =
  'I cannot answer in this room: the account speaking here is not linked to a Forge user, so there is nobody for me to act as. Link your chat account to your Forge account and ask again.';

/**
 * Refuse a turn by name, durably and at most once: a speaker linked to nobody, or one the
 * turn may not act as (`credentials/turn-credential.ts`).
 */
export async function refuseAuthority(
  args: RouteWindowArgs,
  venue: ConversationVenue,
  window: ConversationWindowRow,
  deliveryKey: string,
  claim: WindowClaim,
  speaker?: { authorKey: string | null; authorLabel: string | null },
  refusal?: { code: string; message: string },
): Promise<RoutedWindow> {
  const detail = refusal
    ? { reason: refusal.code }
    : { reason: 'the speaker is linked to no Forge user' };
  const transport = conversationTransport(venue.adapter);
  if (!transport) return { decision: 'authority-refused', detail: { ...detail, told: false } };
  const text =
    refusal?.message ??
    (await args.refusalFor?.(speaker ?? { authorKey: null, authorLabel: null })) ??
    AUTHORITY_REFUSED_REPLY;
  if (!(await reserveDelivery(window.id, claim))) {
    return { decision: 'undetermined', detail: { ...detail, superseded: true } };
  }
  try {
    const receipt = await transport.deliver(venue, codeAuthored(text));
    await recordDeliveredReply({
      conversationId: window.conversationId,
      projectId: window.projectId,
      text,
      receipt,
      deliveryKey,
      decision: 'authority-refused',
    });
    return { decision: 'authority-refused', detail: { ...detail, told: true } };
  } catch (err) {
    logger.error(
      { err, windowId: window.id, adapter: venue.adapter, externalId: venue.externalId },
      'conversations: the authority refusal could not be delivered',
    );
    return { decision: 'undetermined', detail: { ...detail, told: false, attempted: true } };
  }
}
