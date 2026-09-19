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
export const RECEIVED_FLOOR_MS = 5000;

/**
 * How often `working` is renewed while the turn runs.
 */
export const WORKING_RENEW_MS = 5000;

/**
 * How long one acknowledgement call may take before the lifecycle moves on without it.
 */
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
  const renew = setInterval(() => {
    if (queued === 0) enqueue({ kind: 'working', on: true });
  }, WORKING_RENEW_MS);
  renew.unref?.();

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
