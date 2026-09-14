/**
 * A transport's own message, carried to a turn by its four ports and nothing
 * else.
 *
 * `turn-runner.ts` takes a venue and a principal already settled. This is the
 * half in front of it: which venue this frame is, who spoke, and — the decision
 * the ports do not carry — whose authority the turn runs under. That last one
 * follows from the VENUE's shape rather than from whatever field is nearest, and
 * it lived inside the first adapter until ISS-1002 (ISS-987 decided the rule).
 */

import { logger } from '../logger.js';
import {
  type ConversationAdapterPorts,
  type ConversationVenue,
  codeAuthored,
  conversationTransport,
} from './ports.js';
import {
  type ConversationTurnRequest,
  runConversationTurn,
  type TurnOutcome,
} from './turn-runner.js';

export interface InboundTurn<Frame> {
  ports: ConversationAdapterPorts<Frame>;
  /** The transport's own message, in its own terms. */
  frame: Frame;
  /** What was said. */
  message: string;
  /** The transport's own id for the speaker, for the audit row. */
  speakerKey: string;
  /**
   * Whose authority a turn runs under in a venue that has many speakers.
   */
  // cm:guard a many-speaker venue is left on a principal the BINDING names and never re-pointed at whoever spoke last, and the price is stated rather than discovered: somebody in a channel who is not a collaborator receives answers computed with that principal's read access. Re-pointing it is a decision about what a channel binding grants, which ISS-987 put out of scope on purpose.
  manySpeakersPrincipalUserId: string;
  /** Everything the turn itself takes, bar what this resolves. */
  turn: Omit<ConversationTurnRequest, 'venue' | 'principalUserId' | 'speakerKey' | 'message'>;
}

/**
 * How an inbound frame ended, including the two ways it never became a turn.
 */
// cm:guard both endings happen BEFORE the venue is opened, so a frame nobody could place and a speaker nobody could name leave no conversation row behind for a turn that was never had (ISS-1001).
// cm:guard `venue-unresolved` posts NOTHING and must not borrow the speaker's refusal to have something to say: a frame that cannot be placed is a fault about the venue, and telling a many-speaker room "nothing can be answered as you" names a problem it does not have and offers a repair that would not help. An adapter that owes its own reader a reason for it owes one written for that fault.
export type InboundOutcome =
  | TurnOutcome
  | { kind: 'venue-unresolved' }
  | { kind: 'speaker-refused'; code: string; refusal: string; delivered: boolean };

/**
 * Carry one inbound frame to a delivered turn, over the adapter's four ports.
 */
// cm:guard the authority follows the venue's SHAPE: a one-to-one venue has exactly one human and runs as them, so answering it under a binding's principal would answer a stranger with somebody else's read access; a many-speaker venue has no single authority to run as, and resolving the speaker there would change whose access the room sees between two messages (ISS-987).
// cm:guard the refusal goes out the SAME door the answer would have, looked up by the VENUE's adapter rather than taken from the object the caller handed in — the rule `runConversationTurn` holds, for the same reason: a second outbound path for authority refusals is the copy this extraction removes.
// cm:guard its text is the PORT's own — a local rewording drifts from the way out that module owns, which is a person told to do something that has moved (ISS-977).
// cm:guard a door that refuses this is logged and NOT thrown: the turn was never going to run, and turning a refusal nobody could deliver into an exception loses the reason as well as the reply.
async function refuse(
  venue: ConversationVenue,
  refusal: { code: string; message: string },
): Promise<InboundOutcome> {
  const base = { kind: 'speaker-refused' as const, code: refusal.code, refusal: refusal.message };
  try {
    const transport = conversationTransport(venue.adapter);
    if (!transport) throw new Error(`no transport is registered for adapter "${venue.adapter}"`);
    await transport.deliver(venue, codeAuthored(refusal.message));
    return { ...base, delivered: true };
  } catch (err) {
    logger.error(
      { err, adapter: venue.adapter, externalId: venue.externalId, code: refusal.code },
      'conversations: the speaker was refused and the refusal could not be delivered',
    );
    return { ...base, delivered: false };
  }
}

export async function runInboundTurn<Frame>(inbound: InboundTurn<Frame>): Promise<InboundOutcome> {
  const venue = await inbound.ports.resolveVenue(inbound.frame);
  if (!venue) return { kind: 'venue-unresolved' };

  let principalUserId = inbound.manySpeakersPrincipalUserId;
  if (venue.shape === 'direct') {
    const speaker = await inbound.ports.resolveSpeaker(inbound.frame);
    if (!speaker.linked) {
      return refuse(venue, speaker.refusal as { code: string; message: string });
    }
    principalUserId = speaker.userId;
  }

  return runConversationTurn({
    ...inbound.turn,
    venue,
    principalUserId,
    speakerKey: inbound.speakerKey,
    message: inbound.message,
  });
}
