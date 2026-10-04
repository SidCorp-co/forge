/**
 * The lifecycle of one explicit request's acknowledgement: admitted → `working`
 * shown and renewed → `received` set once the request is old enough → settled.
 *
 * The kernel owns WHEN; the transport owns WITH WHAT. This module knows nothing
 * about reactions or typing indicators, only that a venue can be told a request
 * was received and that work on it is under way, and that both must be taken
 * back when the turn ends however it ends (ISS-1088).
 */

import { logger } from '../observability/logger.js';
import type { ConversationTransport, ConversationVenue } from './ports.js';

/** How old a request must be before it is marked received. */
const RECEIVED_FLOOR_MS = 5000;
/** How often `working` is renewed while the turn runs. */
const WORKING_RENEW_MS = 5000;
/** How long one acknowledgement call may take before the lifecycle moves on without it. */
const ACK_TIMEOUT_MS = 5000;

/** Settles `late` once `ms` passes with the call still out, so the caller can take it back later. */
function withDeadline(p: Promise<unknown>, ms: number): Promise<'done' | 'late'> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve('late'), ms);
    t.unref?.();
    p.then(
      () => {
        clearTimeout(t);
        resolve('done');
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

interface AcknowledgeArgs {
  transport: Pick<ConversationTransport, 'acknowledge'> | undefined;
  venue: ConversationVenue;
  /** The message the request is anchored on, and when it arrived. */
  anchor: { messageId: string | null; receivedAt: Date };
  log?: Record<string, unknown>;
}

interface RequestAcknowledgement {
  /** Take every signal back; resolves once the transport has been told. */
  settle(): Promise<void>;
}

const NOOP: RequestAcknowledgement = { settle: async () => undefined };

type Ack = NonNullable<ConversationTransport['acknowledge']>;

/** One transport call, bounded by {@link ACK_TIMEOUT_MS}; an `on` that lands late, after the settle, is taken back. */
function tell(args: AcknowledgeArgs, ack: Ack, ackArg: Parameters<Ack>[1], settled: () => boolean) {
  const transport = args.transport as ConversationTransport;
  const warn = (err: unknown, msg: string) =>
    logger.warn({ err, ...args.log, ack: ackArg, externalId: args.venue.externalId }, msg);
  const call = ack.call(transport, args.venue, ackArg);
  let abandoned = false;
  if (ackArg.on) {
    call.then(
      () => {
        if (abandoned && settled()) {
          ack
            .call(transport, args.venue, { ...ackArg, on: false })
            .catch((err: unknown) =>
              warn(err, 'conversations: a late acknowledgement could not be taken back'),
            );
        }
      },
      () => undefined,
    );
  }
  return withDeadline(call, ACK_TIMEOUT_MS).then(
    (outcome) => {
      if (outcome === 'done') return;
      abandoned = true;
      warn(
        new Error(`the acknowledgement did not return within ${ACK_TIMEOUT_MS}ms`),
        'conversations: an acknowledgement could not be shown',
      );
    },
    (err: unknown) => warn(err, 'conversations: an acknowledgement could not be shown'),
  );
}

/** Start acknowledging an admitted request. */
export function acknowledgeRequest(args: AcknowledgeArgs): RequestAcknowledgement {
  const ack = args.transport?.acknowledge;
  if (!ack) return NOOP;
  let settled = false;
  let chain: Promise<void> = Promise.resolve();
  let queued = 0;
  const enqueue = (ackArg: Parameters<Ack>[1]): void => {
    queued += 1;
    chain = chain
      .then(() => tell(args, ack, ackArg, () => settled))
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

  const wait = Math.max(0, RECEIVED_FLOOR_MS - (Date.now() - args.anchor.receivedAt.getTime()));
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
