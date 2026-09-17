/**
 * The lifecycle of one explicit request's acknowledgement: admitted → `working`
 * shown and renewed → `received` set once the request is old enough → settled.
 *
 * The kernel owns WHEN; the transport owns WITH WHAT. This module knows nothing
 * about reactions or typing indicators, only that a venue can be told a request
 * was received and that work on it is under way, and that both must be taken
 * back when the turn ends however it ends (ISS-1088).
 */

import { logger } from '../logger.js';
import type { ConversationTransport, ConversationVenue } from './ports.js';

/**
 * How old a request must be before it is marked received.
 */
// cm:guard a FLOOR from receipt and not a delay from admission: a turn that answers inside it needs no receipt, because the answer is the receipt — marking and unmarking a message in the same breath is a flicker the person reads as a bug. Five seconds is the point at which a person starts to wonder whether they were heard (ISS-1088 criteria 3, 4).
export const RECEIVED_FLOOR_MS = 5000;

/**
 * How often `working` is renewed while the turn runs.
 */
// cm:guard sits UNDER the 15-second expiry the Rocket.Chat client applies to an activity it stops hearing about (`UserAction.ts` TIMEOUT) and at the client's own renewal rate (TIMEOUT / 3), so a core that dies mid-turn leaves no indicator past that expiry and a live one never lets it lapse (ISS-1088 criterion 6).
export const WORKING_RENEW_MS = 5000;

export interface AcknowledgeArgs {
  transport: Pick<ConversationTransport, 'acknowledge'> | undefined;
  venue: ConversationVenue;
  /** The message the request is anchored on, and when it arrived. */
  anchor: { messageId: string | null; receivedAt: Date };
  now?: () => number;
  log?: Record<string, unknown>;
}

export interface RequestAcknowledgement {
  /** Take every signal back; resolves once the transport has been told. */
  settle(): Promise<void>;
}

const NOOP: RequestAcknowledgement = { settle: async () => undefined };

/**
 * Start acknowledging an admitted request.
 */
// cm:guard called AFTER the mention gate and the proactivity guards admitted a turn and never before: a window the guards close was never going to be answered, and telling the room it was received is a promise this core is not going to keep (ISS-1088 criterion 5).
// cm:guard every transport call is awaited in ORDER on one chain and its rejection LOGGED, never thrown: the acknowledgement is decoration on the turn, and a reaction the server refused must not turn an answer into a failure (ISS-1088 criterion 17 in spirit; criterion 6).
export function acknowledgeRequest(args: AcknowledgeArgs): RequestAcknowledgement {
  const ack = args.transport?.acknowledge;
  if (!ack) return NOOP;
  const transport = args.transport as ConversationTransport;
  const now = args.now ?? Date.now;
  const tell = (
    ackArg: Parameters<NonNullable<ConversationTransport['acknowledge']>>[1],
  ): Promise<void> =>
    ack.call(transport, args.venue, ackArg).catch((err: unknown) => {
      logger.warn(
        { err, ...args.log, ack: ackArg, externalId: args.venue.externalId },
        'conversations: an acknowledgement could not be shown',
      );
    });

  let chain: Promise<void> = Promise.resolve();
  const enqueue = (
    ackArg: Parameters<NonNullable<ConversationTransport['acknowledge']>>[1],
  ): void => {
    chain = chain.then(() => tell(ackArg));
  };

  let receivedSet = false;
  let settled = false;
  const markReceived = () => {
    if (settled || !args.anchor.messageId) return;
    receivedSet = true;
    enqueue({ kind: 'received', messageId: args.anchor.messageId, on: true });
  };

  enqueue({ kind: 'working', on: true });
  const renew = setInterval(() => enqueue({ kind: 'working', on: true }), WORKING_RENEW_MS);
  renew.unref?.();

  // cm:guard measured from RECEIPT: a request admitted seven seconds after it arrived is marked at once, one admitted four seconds after it arrived waits the remaining second, and one whose turn settles before the floor is never marked at all (ISS-1088 criteria 3, 4, 31).
  const wait = Math.max(0, RECEIVED_FLOOR_MS - (now() - args.anchor.receivedAt.getTime()));
  let receivedTimer: ReturnType<typeof setTimeout> | null = null;
  if (wait === 0) markReceived();
  else {
    receivedTimer = setTimeout(markReceived, wait);
    receivedTimer.unref?.();
  }

  return {
    async settle() {
      if (settled) return chain;
      settled = true;
      clearInterval(renew);
      if (receivedTimer) clearTimeout(receivedTimer);
      enqueue({ kind: 'working', on: false });
      if (receivedSet && args.anchor.messageId) {
        enqueue({ kind: 'received', messageId: args.anchor.messageId, on: false });
      }
      return chain;
    },
  };
}
