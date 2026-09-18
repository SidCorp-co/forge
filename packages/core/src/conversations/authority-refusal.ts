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

/**
 * What a one-to-one room is told when nobody can be answered as.
 */
// cm:guard the FALLBACK, used only when `RouteWindowArgs.refusalFor` names nothing — an adapter that supplies none, or a speaker the row kept no transport key for. It names the generic remedy — link the account — and deliberately not the endpoints that do it, because those are the speaker port's to name and a copy here would drift the day they move; this module asks for that wording rather than holding one (ISS-987, ISS-1004).
export const AUTHORITY_REFUSED_REPLY =
  'I cannot answer in this room: the account speaking here is not linked to a Forge user, so there is nobody for me to act as. Link your chat account to your Forge account and ask again.';

/**
 * Refuse a one-to-one room by name, durably and at most once.
 */
// cm:guard the refusal is DELIVERED and not merely decided, and it goes out under the window's own delivery key with the reservation before it: `authority-refused` used to be a decision nobody outside the database could read, so a person whose synchronous refusal failed to send was left with silence and nothing retryable behind it (ISS-1004, review pass 1 F3).
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
  // cm:guard the wording is settled BEFORE the reservation and the reservation immediately before the send: `refusalFor` asks a directory, so it can fail or hang, and a reservation burned by a lookup that sent nothing leaves the window `undetermined` for good with the person never told (ISS-1004, review of the plan F1).
  const text =
    (await args.refusalFor?.(speaker ?? { authorKey: null, authorLabel: null })) ??
    AUTHORITY_REFUSED_REPLY;
  if (!(await reserveDelivery(window.id, claim))) {
    return { decision: 'undetermined', detail: { ...detail, superseded: true } };
  }
  try {
    const receipt = await transport.deliver(venue, codeAuthored(text));
    // cm:guard the proof says WHICH decision sent it, so a crash before the close cannot be read as an ordinary answer: without it the next claimant saw a delivery, knew nothing of what it was, and wrote `answered` over a room that had been refused (ISS-1004 rule 4).
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
    // cm:guard a refusal the door would not take is `undetermined` and NOT `authority-refused`: the window stays a record that nobody was told, and the reservation above is what stops the next claim saying it twice (ISS-1004 rule 4).
    logger.error(
      { err, windowId: window.id, adapter: venue.adapter, externalId: venue.externalId },
      'conversations: the authority refusal could not be delivered',
    );
    return { decision: 'undetermined', detail: { ...detail, told: false, attempted: true } };
  }
}
