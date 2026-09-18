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

/**
 * How long one acknowledgement call may take before the lifecycle moves on without it.
 */
// cm:guard BOUNDED, because `settle()` is awaited on the route between the turn and the window's close: a transport call that never returns would otherwise hold the status and the close hostage to decoration, which the turn's own timeout does not cover. The call is abandoned, not cancelled — the transport may still complete it — and the abandonment is logged (whole-set review, pass A F2).
export const ACK_TIMEOUT_MS = 5000;

class AckDeadlineError extends Error {
  constructor(ms: number) {
    super(`the acknowledgement did not return within ${ms}ms`);
    this.name = 'AckDeadlineError';
  }
}

function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new AckDeadlineError(ms)), ms);
    t.unref?.();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

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
  let settled = false;
  const warn = (err: unknown, ackArg: unknown, msg: string) =>
    logger.warn({ err, ...args.log, ack: ackArg, externalId: args.venue.externalId }, msg);
  const tell = (
    ackArg: Parameters<NonNullable<ConversationTransport['acknowledge']>>[1],
  ): Promise<void> => {
    const call = ack.call(transport, args.venue, ackArg);
    let abandoned = false;
    // cm:guard an ON that completes AFTER its deadline and after settle has put a signal on the room that nothing is scheduled to take back — the off went out while it was still pending — so it is followed by its own off the moment it lands (whole-set review, pass 2A F2). A late OFF needs nothing: off is the resting state.
    if (ackArg.on) {
      call.then(
        () => {
          if (abandoned && settled) {
            ack
              .call(transport, args.venue, { ...ackArg, on: false })
              .catch((err: unknown) =>
                warn(err, ackArg, 'conversations: a late acknowledgement could not be taken back'),
              );
          }
        },
        () => undefined,
      );
    }
    return withDeadline(call, ACK_TIMEOUT_MS).catch((err: unknown) => {
      if (err instanceof AckDeadlineError) abandoned = true;
      warn(err, ackArg, 'conversations: an acknowledgement could not be shown');
    });
  };

  let chain: Promise<void> = Promise.resolve();
  let queued = 0;
  const enqueue = (
    ackArg: Parameters<NonNullable<ConversationTransport['acknowledge']>>[1],
  ): void => {
    queued += 1;
    chain = chain
      .then(() => tell(ackArg))
      .finally(() => {
        queued -= 1;
      });
  };

  let receivedSet = false;
  const markReceived = () => {
    if (settled || !args.anchor.messageId) return;
    receivedSet = true;
    enqueue({ kind: 'received', messageId: args.anchor.messageId, on: true });
  };

  enqueue({ kind: 'working', on: true });
  // cm:guard a renewal is SKIPPED while an earlier call is still out: renewals queued behind a stalled transport would pile up and each spend its own deadline at settle, and a renewal that arrives after the previous one finally returned says nothing the previous one did not (whole-set review, pass A F2).
  const renew = setInterval(() => {
    if (queued === 0) enqueue({ kind: 'working', on: true });
  }, WORKING_RENEW_MS);
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
