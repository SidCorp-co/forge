/**
 * One conversation turn, with no transport in it.
 *
 * A caller hands over a venue its own ports resolved, the person the turn
 * acts as, and the door the reply goes out of. This opens the
 * conversation, runs the model, screens what came back, sends it through the
 * one outbound port and records what the venue was shown.
 */

import {
  claimLastResort,
  codeAuthored,
  conversationTransport,
  openConversation,
  recordDeliveredReply,
  releaseLastResort,
  threadVenueOf,
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
import { registerTurnStop, STOPPED_BY_A_PERSON, TURN_TIMED_OUT } from './conversation-stops.js';
import { assertAnswerableDoor } from './screened-reply.js';
import { composeReply, type TurnContext } from './turn-compose.js';
import { turnFailureReason } from './turn-failure.js';
import {
  type ContinuedEntry,
  type ConversationTurnRequest,
  REPLY_NOT_DELIVERED,
  REPLY_NOT_DELIVERED_REASON,
  type TurnBudget,
  type TurnOutcome,
  type TurnReply,
} from './turn-request.js';
import { TurnBlockStage } from './turn-stage.js';

export type {
  ConversationTurnRequest,
  TurnHookContext,
  TurnInputs,
  TurnOutcome,
  TurnReply,
} from './turn-request.js';

/**
 * When a turn still answering lets its window go and keeps working: inside the window's claim
 * lease, so no other holder takes the window while the turn runs on.
 */
const PARTIAL_AFTER_MS = 90_000;
/** The most a turn that keeps working may run, from its start; inside its token's life. */
const CONTINUED_CEILING_MS = 8 * 60 * 1000;
/** A turn past its abort that has not returned is given up this much later. */
const HANDLE_GRACE_MS = 30_000;
/**
 * How long past its abort and grace a continued turn's delivery is waited on before its window's
 * record says the rest never settled: the two writes it makes (the message and its record).
 */
const CONTINUED_DELIVERY_GRACE_MS = 30_000;
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
 * A turn that outran its first ceiling: the work still running. Nothing is posted for it in the
 * meantime — no line core wrote stands in for the agent's own (owner ruling agent-is-the-voice,
 * ISS-857); the room's acknowledgement is the transport's own mark, not words.
 */
interface ContinuingTurn {
  rest: Promise<TurnReply | TurnOutcome>;
  /** End the work still running: the right to answer moved on, so nothing may follow. */
  cancel: () => void;
  /** Point the work's stream at the entry the rest is recorded under. */
  continueIn: (entry: ContinuedEntry | null) => void;
  /** The latest the rest can settle: the turn's ceiling from its start, its handle's grace, its delivery's. */
  continuesUntil: Date;
}

type Composed = TurnReply | TurnOutcome | ContinuingTurn;

/** A turn whose answer is the model's reply can work past its window; one that answers only through `room_send` cannot. */
function budgetOf(req: ConversationTurnRequest): TurnBudget & { continues: boolean } {
  const continues = req.sendMode !== 'tool';
  const partialAfterMs = req.budget?.partialAfterMs ?? PARTIAL_AFTER_MS;
  return {
    continues,
    partialAfterMs,
    ceilingMs: continues ? (req.budget?.ceilingMs ?? CONTINUED_CEILING_MS) : partialAfterMs,
  };
}

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
  const stage = new TurnBlockStage();
  const reply = await composeWithin(req, conversation.id, stage);
  if ('rest' in reply) return continueQuietly(req, transport, conversation.id, reply, stage);
  return withDrops(req, stage, await settledOutcome(req, transport, conversation.id, reply, stage));
}

/** How a composed turn that did not work past its window ends: delivered, or the reason it was not. */
async function settledOutcome(
  req: ConversationTurnRequest,
  transport: Transport,
  conversationId: string,
  reply: TurnReply | TurnOutcome,
  stage: TurnBlockStage,
): Promise<TurnOutcome> {
  if ('kind' in reply) return reply;
  if (!reply.send) {
    if (reply.ended === 'failed') {
      return { kind: 'failed', code: reply.code, reason: reply.reason, cause: reply.cause };
    }
    return { kind: reply.ended ?? 'diverted', reason: reply.reason };
  }
  return deliverReply(req, transport, conversationId, reply, stage);
}

/** The outcome with the blocks the turn drew and nobody will see named on it, and logged. */
function withDrops(
  req: ConversationTurnRequest,
  stage: TurnBlockStage,
  outcome: TurnOutcome,
): TurnOutcome {
  const dropped = stage.dropped();
  if (dropped.length === 0) return outcome;
  logger.warn(
    { ...req.log, outcome: outcome.kind, dropped },
    'conversations: blocks this turn drew are dropped, unseen',
  );
  return { ...outcome, droppedBlocks: dropped };
}

/**
 * Compose under the turn's ceilings, its abort and its token; a stop from the room wins every arm.
 * A turn still running at its first ceiling hands back the work still running and keeps going; its
 * token, its abort and its stop stay held until the rest has settled.
 */
async function composeWithin(
  req: ConversationTurnRequest,
  conversationId: string,
  stage: TurnBlockStage,
): Promise<Composed> {
  const budget = budgetOf(req);
  const startedAt = Date.now();
  const abort = new AbortController();
  const credential = turnCredentialHolder(req.authority);
  const ceiling = setTimeout(() => abort.abort(TURN_TIMED_OUT), budget.ceilingMs);
  ceiling.unref?.();
  const onExternalStop = () => abort.abort(STOPPED_BY_A_PERSON);
  req.externalStop?.addEventListener('abort', onExternalStop, { once: true });
  const stream = { current: req.onTurnEvent };
  let phase = 'start';
  let timedOut = false;
  const stopped = () => {
    logger.info({ ...req.log, phase }, 'conversations: a person stopped this turn');
    return STOPPED;
  };
  const ctx: TurnContext = {
    req: req.onTurnEvent ? { ...req, onTurnEvent: (event) => stream.current?.(event) } : req,
    conversationId,
    abort,
    setPhase: (p: string) => {
      phase = p;
    },
    credential: credential.get,
    writes: null,
    draft: { text: '' },
    stage,
  };
  const settle = async () => {
    clearTimeout(ceiling);
    req.externalStop?.removeEventListener('abort', onExternalStop);
    await credential.release();
    await req.dispose?.();
  };
  const work: Promise<TurnReply | TurnOutcome> = (async () => {
    try {
      if (req.externalStop?.aborted) return stopped();
      const reply = await withTimeout(composeReply(ctx), budget.ceilingMs + HANDLE_GRACE_MS, () => {
        timedOut = true;
      });
      // A provider can END on a cancellation instead of throwing on it; the reply is not delivered.
      return abort.signal.reason === STOPPED_BY_A_PERSON || req.externalStop?.aborted
        ? stopped()
        : reply;
    } catch (err) {
      abort.abort();
      if (req.externalStop?.aborted || abort.signal.reason === STOPPED_BY_A_PERSON)
        return stopped();
      return failedTurn(ctx, err, phase, timedOut || abort.signal.reason === TURN_TIMED_OUT);
    }
  })();

  const first = budget.continues ? await settledWithin(work, budget.partialAfterMs) : await work;
  if (first !== OUTRAN) {
    await settle();
    return first;
  }
  // a room that may stay silent keeps a turn past its first ceiling only when the turn already
  // changed something in it: a write that landed, or one held for the person's go-ahead, whose card
  // the room now shows (REQ-30 BC-4: a chat's write lands only on that press, so a held one is the
  // change a chat makes); otherwise the turn ends at the first ceiling, as a turn there always has
  const changed =
    (ctx.writes?.calls().some((c) => c.write) ?? false) || (ctx.writes?.held().length ?? 0) > 0;
  if (req.fallbacks === 'silence' && !changed) {
    abort.abort(TURN_TIMED_OUT);
    const ended = await work;
    await settle();
    return ended;
  }
  logger.info(
    { ...req.log, phase, partialAfterMs: budget.partialAfterMs },
    'conversations: the turn outran its first ceiling; letting its window go and working on',
  );
  return {
    rest: work.finally(settle),
    cancel: () => abort.abort(STOPPED_BY_A_PERSON),
    continueIn: (entry) => {
      stream.current = entry?.onTurnEvent;
    },
    continuesUntil: new Date(
      startedAt + budget.ceilingMs + HANDLE_GRACE_MS + CONTINUED_DELIVERY_GRACE_MS,
    ),
  };
}

const OUTRAN = Symbol('outran');

/** The work's result if it settles within `ms`, else {@link OUTRAN}; the work keeps running. */
function settledWithin<T>(work: Promise<T>, ms: number): Promise<T | typeof OUTRAN> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(OUTRAN), ms);
    t.unref?.();
    work.then((value) => {
      clearTimeout(t);
      resolve(value);
    });
  });
}

/**
 * How a turn that threw ends: the coded failure its window records, the person told only core's
 * turn-failed line for it. A model nobody configured is such a failure too: its refusal is the
 * record's reason, never a line in the room (ISS-875).
 */
async function failedTurn(
  ctx: TurnContext,
  err: unknown,
  phase: string,
  timedOut: boolean,
): Promise<TurnReply> {
  const { req } = ctx;
  logger.error({ err, ...req.log, phase, timedOut }, 'conversations: turn failed');
  reportFailure(err, {
    tags: { area: 'conversations', phase, timed_out: String(timedOut) },
    extra: { adapter: req.venue.adapter, externalId: req.venue.externalId, ...req.log },
  });
  const unconfigured = isRefusal(err)
    ? err.refusals.find((r) => r.code === 'ASSISTANT_MODEL_NOT_CONFIGURED')
    : undefined;
  const code = timedOut ? 'ASSISTANT_TURN_TIMED_OUT' : 'ASSISTANT_TURN_FAILED';
  return {
    send: false,
    ended: 'failed',
    code,
    cause: timedOut ? 'timeout' : 'crash',
    reason: unconfigured
      ? `${unconfigured.code}: ${unconfigured.detail}`
      : turnFailureReason(code, req.handleName),
  };
}

/**
 * Let the window go while the turn works on: the right to answer is reserved under the window's
 * claim, the window closes on the continuation, and the rest is delivered as the turn's one message
 * once it settles. Nothing is posted in the meantime. A reservation the claim no longer holds ends
 * the work: another holder answers now.
 */
async function continueQuietly(
  req: ConversationTurnRequest,
  transport: Transport,
  conversationId: string,
  reply: ContinuingTurn,
  stage: TurnBlockStage,
): Promise<TurnOutcome> {
  if (req.onBeforeDeliver && !(await req.onBeforeDeliver())) {
    reply.cancel();
    void reply.rest.catch(() => undefined);
    return withDrops(req, stage, {
      kind: 'superseded',
      reason: 'the right to answer here moved to another holder',
    });
  }
  const entry = req.continueEntry?.() ?? null;
  reply.continueIn(entry);
  return {
    kind: 'delivered',
    messageId: null,
    continuation: {
      rest: continueInThread(req, transport, conversationId, reply, entry, stage).then((rest) =>
        withDrops(req, stage, rest),
      ),
      until: reply.continuesUntil,
    },
  };
}

/**
 * The rest of a turn that worked past its window, delivered into the same thread as its own message:
 * the agent's answer, core's one turn-failed line where it failed and the thread was told none yet,
 * or nothing where it chose to say nothing.
 */
async function continueInThread(
  req: ConversationTurnRequest,
  transport: Transport,
  conversationId: string,
  reply: ContinuingTurn,
  entry: ContinuedEntry | null,
  stage: TurnBlockStage,
): Promise<TurnOutcome> {
  const stop = registerTurnStop(conversationId);
  const onStop = () => reply.cancel();
  stop.signal.addEventListener('abort', onStop, { once: true });
  const where = { ...req.log, adapter: req.venue.adapter, externalId: req.venue.externalId };
  try {
    const rest = await reply.rest;
    if ('kind' in rest) return rest;
    if (!rest.send && rest.ended !== 'failed') {
      return { kind: rest.ended ?? 'diverted', reason: rest.reason };
    }
    if (!rest.send) {
      await tellTurnFailed(req, transport, conversationId, entry);
      return { kind: 'failed', code: rest.code, reason: rest.reason, cause: rest.cause };
    }
    const message = rest.message;
    entry?.onSettled?.({
      text: message.text,
      screenReplaced: rest.screenReplaced,
      ...(message.held ? { heldPart: true } : {}),
    });
    const blocks = rest.blocks ?? [];
    const receipt = await transport.deliver(req.venue, message, {
      addressee: req.addressee ?? null,
      ...(blocks.length > 0 ? { blocks } : {}),
    });
    stage.released(blocks);
    const row = entry?.replyEntry?.(message.text);
    await recordDeliveredReply({
      conversationId,
      projectId: req.venue.projectId,
      text: receipt.deliveredText ?? message.text,
      receipt,
      ...(req.deliveryKey ? { deliveryKey: req.deliveryKey } : {}),
      askedBy: req.authority.userId,
      awaitsReplyFrom: awaitsReplyFrom(req, rest.awaitsReply === true),
      ...(row ? { messageId: row.id, blocks: row.blocks } : {}),
    });
    await transport.notifySettled?.(req.venue).catch(() => undefined);
    return { kind: 'delivered', messageId: receipt.messageId };
  } catch (err) {
    logger.error(
      { err, ...where },
      'conversations: the rest of a continued turn was not delivered',
    );
    reportFailure(err, { tags: { area: 'conversations', phase: 'continue' }, extra: where });
    return {
      kind: 'undeliverable',
      code: REPLY_NOT_DELIVERED,
      reason: REPLY_NOT_DELIVERED_REASON,
      reply: '',
    };
  } finally {
    stop.signal.removeEventListener('abort', onStop);
    stop.release();
    await entry?.close();
  }
}

/**
 * Tell the thread a continued turn failed in, in core's one last-resort line for it, where it was
 * told none yet; a delivery that throws gives the claim back.
 */
async function tellTurnFailed(
  req: ConversationTurnRequest,
  transport: Transport,
  conversationId: string,
  entry: ContinuedEntry | null,
): Promise<void> {
  const place = { adapter: req.venue.adapter, venue: threadVenueOf(transport, req.venue, null) };
  const line = await claimLastResort(place, 'turn_failed');
  if (!line) return;
  try {
    const message = codeAuthored(line);
    entry?.onSettled?.({ text: line, screenReplaced: false });
    const receipt = await transport.deliver(req.venue, message);
    await recordDeliveredReply({
      conversationId,
      projectId: req.venue.projectId,
      text: receipt.deliveredText ?? line,
      receipt,
      ...(req.deliveryKey ? { deliveryKey: req.deliveryKey } : {}),
    });
  } catch (err) {
    await releaseLastResort(place);
    throw err;
  }
}

/**
 * The person a reply that awaits an answer waits on: the one this turn answered and acts as, the
 * author of the message that started it or the starter an onboarding hand-off acts for. Never the
 * newest person to write before the reply lands, who may have written while the turn was out
 * (ISS-277, probe P7).
 */
function awaitsReplyFrom(req: ConversationTurnRequest, awaits: boolean): string | null {
  return awaits ? req.authority.userId : null;
}

async function deliverReply(
  req: ConversationTurnRequest,
  transport: Transport,
  conversationId: string,
  reply: Extract<TurnReply, { send: true }>,
  stage: TurnBlockStage,
): Promise<TurnOutcome> {
  const where = { ...req.log, adapter: req.venue.adapter, externalId: req.venue.externalId };
  let receipt: Awaited<ReturnType<Transport['deliver']>>;
  try {
    if (req.onBeforeDeliver && !(await req.onBeforeDeliver())) {
      return { kind: 'superseded', reason: 'the right to answer here moved to another holder' };
    }
    req.onSettled?.({
      text: reply.message.text,
      screenReplaced: reply.screenReplaced,
      ...(reply.message.held ? { heldPart: true } : {}),
    });
    const blocks = reply.blocks ?? [];
    receipt = await transport.deliver(req.venue, reply.message, {
      addressee: req.addressee ?? null,
      ...(blocks.length > 0 ? { blocks } : {}),
    });
    stage.released(blocks);
  } catch (err) {
    logger.error(
      { err, ...where },
      'conversations: the reply could not be delivered; it is kept on the window, unrecorded',
    );
    reportFailure(err, { tags: { area: 'conversations', phase: 'deliver' }, extra: where });
    return {
      kind: 'undeliverable',
      code: REPLY_NOT_DELIVERED,
      reason: REPLY_NOT_DELIVERED_REASON,
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
      awaitsReplyFrom: awaitsReplyFrom(req, reply.awaitsReply === true),
      askedBy: req.authority.userId,
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
