/**
 * One conversation turn, with no transport in it.
 *
 * A caller hands over a venue its own ports resolved, the person the turn
 * acts as, and the door the reply goes out of. This opens the
 * conversation, runs the model, screens what came back, sends it through the
 * one outbound port and records what the venue was shown.
 */

import {
  codeAuthored,
  conversationTransport,
  errorFallbackReply,
  openConversation,
  recordDeliveredReply,
} from '../conversations/index.js';
import {
  CHAT_TURN_MENU,
  mintTurnCredential,
  type TurnAuthority,
  type TurnCredential,
} from '../credentials/turn-credential.js';
import { reportFailure } from '../lib/error-tracking.js';
import { logger } from '../lib/logger.js';
import { isRefusal } from '../lib/refusal.js';
import { STOPPED_BY_A_PERSON } from './conversation-stops.js';
import { assertAnswerableDoor } from './screened-reply.js';
import { composeReply, silence } from './turn-compose.js';
import type { ConversationTurnRequest, TurnOutcome, TurnReply } from './turn-request.js';

export type {
  ConversationTurnRequest,
  TurnHookContext,
  TurnInputs,
  TurnOutcome,
  TurnReply,
} from './turn-request.js';

const TURN_TIMEOUT_MS = 90_000;
const HANDLE_TIMEOUT_MS = 120_000;
/** The turn's token outlives the turn's own ceiling and a CLI call begun at its edge; it is revoked when the turn ends. */
const CREDENTIAL_TTL_MS = 10 * 60 * 1000;

function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      onTimeout();
      reject(new Error(`conversation turn timed out after ${ms}ms`));
    }, ms);
    t.unref?.();
    p.then(resolve, reject).finally(() => clearTimeout(t));
  });
}

/** One token per turn, minted when first asked for; `release` revokes it if it was. */
function turnCredentialHolder(authority: TurnAuthority) {
  let minted: Promise<TurnCredential> | null = null;
  let released = false;
  return {
    get: (): Promise<TurnCredential> => {
      if (released) return Promise.reject(new Error('this turn has ended, and its token with it'));
      minted ??= mintTurnCredential({ authority, menu: CHAT_TURN_MENU, ttlMs: CREDENTIAL_TTL_MS });
      return minted;
    },
    release: async () => {
      released = true;
      const held = await minted?.catch(() => null);
      await held?.revoke();
    },
  };
}

type Transport = NonNullable<ReturnType<typeof conversationTransport>>;

const STOPPED: TurnOutcome = { kind: 'stopped', reason: STOPPED_BY_A_PERSON };

/**
 * Take one turn in a venue, and deliver what it produced.
 */
export async function runConversationTurn(req: ConversationTurnRequest): Promise<TurnOutcome> {
  assertAnswerableDoor(req.door);
  const transport = conversationTransport(req.venue.adapter);
  if (!transport) {
    throw new Error(
      `conversations: no transport is registered for adapter "${req.venue.adapter}", so a turn in ${req.venue.externalId} has nowhere to be delivered — call registerConversationTransport when that adapter starts`,
    );
  }
  const conversation = await openConversation(req.venue);
  const reply = await composeWithin(req, conversation.id);
  if ('kind' in reply) return reply;
  if (!reply.send) {
    return { kind: reply.ended ?? 'diverted', reason: reply.reason };
  }
  return deliverReply(req, transport, conversation.id, reply);
}

/** Compose under the turn's timeout, its abort and its token; a stop from the room wins every arm. */
async function composeWithin(
  req: ConversationTurnRequest,
  conversationId: string,
): Promise<TurnReply | TurnOutcome> {
  const abort = new AbortController();
  const credential = turnCredentialHolder(req.authority);
  const timer = setTimeout(() => abort.abort(), TURN_TIMEOUT_MS);
  timer.unref?.();
  const onExternalStop = () => abort.abort(STOPPED_BY_A_PERSON);
  req.externalStop?.addEventListener('abort', onExternalStop, { once: true });
  let phase = 'start';
  let timedOut = false;
  const stopped = () => {
    logger.info({ ...req.log, phase }, 'conversations: a person stopped this turn');
    return STOPPED;
  };
  const ctx = {
    req,
    conversationId,
    abort,
    setPhase: (p: string) => {
      phase = p;
    },
    credential: credential.get,
  };
  try {
    if (req.externalStop?.aborted) return stopped();
    const reply = await withTimeout(composeReply(ctx), HANDLE_TIMEOUT_MS, () => {
      timedOut = true;
    });
    // A provider can END on a cancellation instead of throwing on it; the reply is not delivered.
    return req.externalStop?.aborted ? stopped() : reply;
  } catch (err) {
    abort.abort();
    if (req.externalStop?.aborted) return stopped();
    logger.error({ err, ...req.log, phase, timedOut }, 'conversations: turn failed');
    reportFailure(err, {
      tags: { area: 'conversations', phase, timed_out: String(timedOut) },
      extra: { adapter: req.venue.adapter, externalId: req.venue.externalId, ...req.log },
    });
    if (req.sendMode === 'tool' || req.fallbacks === 'silence') return silence(ctx, 'turn-failed');
    const unconfigured = isRefusal(err)
      ? err.refusals.find((r) => r.code === 'ASSISTANT_MODEL_NOT_CONFIGURED')
      : undefined;
    const text = unconfigured
      ? `${unconfigured.code}: ${unconfigured.detail}`
      : errorFallbackReply(req.handleName);
    return { send: true, message: codeAuthored(text), screenReplaced: true };
  } finally {
    clearTimeout(timer);
    req.externalStop?.removeEventListener('abort', onExternalStop);
    await credential.release();
    await req.dispose?.();
  }
}

async function deliverReply(
  req: ConversationTurnRequest,
  transport: Transport,
  conversationId: string,
  reply: Extract<TurnReply, { send: true }>,
): Promise<TurnOutcome> {
  const where = { ...req.log, adapter: req.venue.adapter, externalId: req.venue.externalId };
  let receipt: Awaited<ReturnType<Transport['deliver']>>;
  try {
    if (req.onBeforeDeliver && !(await req.onBeforeDeliver())) {
      return { kind: 'superseded', reason: 'the right to answer here moved to another holder' };
    }
    req.onSettled?.({ text: reply.message.text, screenReplaced: reply.screenReplaced });
    receipt = await transport.deliver(req.venue, reply.message, {
      addressee: req.addressee ?? null,
    });
  } catch (err) {
    logger.error(
      { err, ...where },
      'conversations: the reply could not be delivered; it is kept on the window, unrecorded',
    );
    reportFailure(err, { tags: { area: 'conversations', phase: 'deliver' }, extra: where });
    return {
      kind: 'undeliverable',
      reason: err instanceof Error ? err.message : String(err),
      reply: reply.message.text,
    };
  }

  try {
    const entry = req.replyEntry?.(reply.message.text);
    await recordDeliveredReply({
      conversationId,
      projectId: req.venue.projectId,
      text: receipt.deliveredText ?? reply.message.text,
      receipt,
      deliveryKey: req.deliveryKey,
      ...(entry ? { messageId: entry.id, blocks: entry.blocks } : {}),
    });
  } catch (err) {
    logger.error(
      { err, ...where },
      'conversations: delivered, but recording the reply failed; the outcome stays delivered',
    );
    reportFailure(err, { tags: { area: 'conversations', phase: 'record' } });
  }
  return { kind: 'delivered', messageId: receipt.messageId };
}
