/**
 * What a one-to-one room is told when nobody can be answered as, and how it is told once.
 *
 * Moved out of `route-window.ts` by ISS-1088, which put the request's
 * acknowledgement and status beside the decision and left that module over
 * its line ceiling; nothing here changed in the move.
 */

import { logger } from '../logger.js';
import { type ConversationVenue, codeAuthored, conversationTransport } from './ports.js';
import type { RoutedWindow, RouteWindowArgs } from './route-window.js';
import { recordDeliveredReply } from './transcript.js';
import { type ConversationWindowRow, reserveDelivery, type WindowClaim } from './windows.js';

export const AUTHORITY_REFUSED_REPLY =
  'I cannot answer in this room: the account speaking here is not linked to a Forge user, so there is nobody for me to act as. Link your chat account to your Forge account and ask again.';

/**
 * Refuse a one-to-one room by name, durably and at most once.
 */
export async function refuseAuthority(
  args: RouteWindowArgs,
  venue: ConversationVenue,
  window: ConversationWindowRow,
  deliveryKey: string,
  claim: WindowClaim,
  speaker?: { authorKey: string | null; authorLabel: string | null },
): Promise<RoutedWindow> {
  const detail = { reason: 'the speaker in this one-to-one room is linked to no Forge user' };
  const transport = conversationTransport(venue.adapter);
  if (!transport) return { decision: 'authority-refused', detail: { ...detail, told: false } };
  const text =
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
