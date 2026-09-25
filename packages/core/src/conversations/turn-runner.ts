/**
 * One conversation turn, with no transport in it.
 *
 * A caller hands over a venue its own ports resolved, the principal the turn
 * computes under, and the door the reply goes out of. This opens the
 * conversation, runs the model, screens what came back, sends it through the
 * one outbound port and records what the venue was shown.
 *
 * ISS-1002 extracted it from the first adapter's own connection manager, where
 * it was that transport's; a second adapter is now the four ports and none of
 * this.
 */

import { type ExternalChatTurnResult, runExternalChatTurn } from '../assistant/external-chat.js';
import type { ChatStreamEvent } from '../assistant/providers/types.js';
import { type ChatToolset, mergeToolsets } from '../assistant/tools/mcp-adapter.js';
import type { ImageResolver, TurnImage } from '../assistant/vision.js';
import type { ContentBlock } from '../lib/agent-stream-parser.js';
import { logger } from '../logger.js';
import type { DoorId } from '../messaging/contract.js';
import { Sentry } from '../observability/sentry.js';
import { errorFallbackReply } from './fallback-replies.js';
import {
  type ConversationVenue,
  codeAuthored,
  conversationTransport,
  type ScreenedMessage,
} from './ports.js';
import { roomSendCapture } from './room-send-tool.js';
import {
  assertAnswerableDoor,
  declinedTail,
  declinedTurn,
  screenedTurnReply,
} from './screened-reply.js';
import { openConversation } from './store.js';
import { recordDeliveredReply, recordSilence } from './transcript.js';

const TURN_TIMEOUT_MS = 90_000;
const HANDLE_TIMEOUT_MS = 120_000;

class TurnTimeoutError extends Error {
  constructor(readonly ms: number) {
    super(`conversation turn timed out after ${ms}ms`);
    this.name = 'TurnTimeoutError';
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new TurnTimeoutError(ms)), ms);
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

/** What the transport contributes to a turn beyond the message itself. */
export interface TurnInputs {
  tools?: ChatToolset | undefined;
  persona?: string | null;
  conversationContext?: string | null;
  images?: readonly TurnImage[] | undefined;
  resolveImage?: ImageResolver | undefined;
}

/** What a hook is given: the phase name the report will carry, the turn's abort, and whose authority it runs under. */
export interface TurnHookContext {
  setPhase: (phase: string) => void;
  signal: AbortSignal;
  principalUserId: string;
  /** The linked author of the newest person message, or null when nobody Forge knows (ISS-1034). */
  speakerUserId: string | null;
  /** The room this turn answers in, for the tools that write on the speaker's behalf. */
  conversationId: string;
  /** The handle answering for the venue's project in this room, or null where none is in it. */
  handleUserId: string | null;
}

export type TurnReply =
  | { send: false; reason: string; declined?: boolean }
  | { send: true; message: ScreenedMessage; screenReplaced: boolean };

export interface ConversationTurnRequest {
  venue: ConversationVenue;
  /** The Forge principal whose access this turn reads and runs its tools under. */
  principalUserId: string;
  /** The transport's own id for the speaker, for the audit row. */
  speakerKey: string;
  speakerUserId?: string | null | undefined;
  handleUserId?: string | null | undefined;
  message: string;
  /** The door the reply goes out of; its row carries the pair and the repair budget. */
  door: DoorId;
  /**
   * The question is already a row, so this turn writes only its silence.
   */
  questionAlreadyRecorded?: boolean;
  /**
   * This turn is allowed to say nothing.
   */
  mayDecline?: boolean;
  /**
   * How the model's answer reaches the venue: as its reply, or only through `room_send`.
   */
  sendMode?: 'reply' | 'tool' | undefined;
  /**
   * What stands when the turn cannot post its answer: the code-authored apology, or nothing.
   */
  fallbacks?: 'post' | 'silence' | undefined;
  /**
   * The person this reply answers, by the label the transport shows for them.
   */
  addressee?: string | null | undefined;
  /**
   * The stable key this turn's delivery answers, so a retry of it delivers nothing.
   */
  deliveryKey?: string;
  /**
   * Called once, immediately before the text is handed to the transport.
   */
  onBeforeDeliver?: () => Promise<boolean>;
  /**
   * Called for each event of the FIRST attempt's turn loop, as it yields.
   */
  onTurnEvent?: ((event: ChatStreamEvent) => void) | undefined;
  /**
   * Called once with the text the screen admitted, before it is delivered.
   */
  onSettled?: ((settled: { text: string; screenReplaced: boolean }) => void) | undefined;
  /**
   * The identity and the blocks the delivered reply's row is written with.
   */
  replyEntry?:
    | ((deliveredText: string) => { id: string; blocks: readonly ContentBlock[] | null })
    | undefined;
  /** The answering handle's own name — the code-authored fallbacks speak as it. */
  handleName: string;
  /**
   * The transport's own inputs, built INSIDE the timeout.
   */
  prepare?: (ctx: TurnHookContext) => Promise<TurnInputs>;
  /**
   * The transport's chance to hand the turn elsewhere before the model runs.
   */
  divertBeforeTurn?: (ctx: TurnHookContext) => Promise<TurnReply | null>;
  /** ...and after it, on what the model actually called. */
  divertAfterTurn?: (
    result: ExternalChatTurnResult,
    ctx: TurnHookContext,
  ) => Promise<TurnReply | null>;
  /**
   * A stop from outside the turn — a person ending it from the room it runs in.
   * Aborting it ends the turn without an answer and without an apology in the
   * thread, which is not what a timeout or a crash does (ISS-1146).
   */
  externalStop?: AbortSignal | undefined;
  /** Released once the turn is over, however it ended. */
  dispose?: () => Promise<void>;
  log?: Record<string, unknown>;
}

/**
 * How the turn ended, in terms a reader can tell apart.
 */
export type TurnOutcome =
  | { kind: 'delivered'; messageId: string | null }
  | { kind: 'stopped'; reason: string }
  | { kind: 'superseded'; reason: string }
  | { kind: 'diverted'; reason: string }
  | { kind: 'declined'; reason: string }
  | { kind: 'undeliverable'; reason: string };

interface TurnContext {
  req: ConversationTurnRequest;
  conversationId: string;
  abort: AbortController;
  setPhase: (phase: string) => void;
}

async function composeReply(ctx: TurnContext): Promise<TurnReply> {
  const { req } = ctx;
  const speakerUserId = req.speakerUserId === undefined ? req.principalUserId : req.speakerUserId;
  const hook: TurnHookContext = {
    setPhase: ctx.setPhase,
    signal: ctx.abort.signal,
    principalUserId: req.principalUserId,
    speakerUserId,
    conversationId: ctx.conversationId,
    handleUserId: req.handleUserId ?? null,
  };

  const early = await req.divertBeforeTurn?.(hook);
  if (early) return early;

  ctx.setPhase('prepare');
  const inputs = (await req.prepare?.(hook)) ?? {};
  const capture = req.sendMode === 'tool' ? roomSendCapture() : null;
  const tools = capture
    ? mergeToolsets(capture.toolset, ...(inputs.tools ? [inputs.tools] : []))
    : inputs.tools;

  ctx.setPhase('turn');
  const turn = {
    projectId: req.venue.projectId,
    adapter: req.venue.adapter,
    conversationId: ctx.conversationId,
    record: capture
      ? ('nothing' as const)
      : req.questionAlreadyRecorded
        ? ('silence-only' as const)
        : ('question-only' as const),
    userId: req.principalUserId,
    userKey: req.speakerKey,
    speakerUserId,
    speakerLabel: req.speakerKey,
    persona: inputs.persona ?? null,
    conversationContext: inputs.conversationContext ?? null,
    tools,
    resolveImage: inputs.resolveImage,
    signal: ctx.abort.signal,
  };
  let result = await runExternalChatTurn({
    ...turn,
    message: req.message,
    questionInHistory: Boolean(req.questionAlreadyRecorded),
    images: inputs.images,
    ...(req.onTurnEvent && !capture ? { onTurnEvent: req.onTurnEvent } : {}),
  });

  const late = await req.divertAfterTurn?.(result, hook);
  if (late) return late;

  if (capture) {
    if (result.terminal !== 'done') {
      const reason = result.error ?? result.terminal;
      await recordSilence({
        conversationId: ctx.conversationId,
        projectId: req.venue.projectId,
        reason,
      });
      return { send: false, reason, declined: true };
    }
    const captured = capture.captured();
    if (captured === null) {
      await recordSilence({
        conversationId: ctx.conversationId,
        projectId: req.venue.projectId,
        reason: 'tool-not-called',
      });
      return { send: false, reason: 'tool-not-called', declined: true };
    }
    result = { ...result, reply: captured };
  }

  if (req.mayDecline) {
    if (result.terminal !== 'done' || result.reply.trim().length === 0) {
      return { send: false, reason: result.error ?? 'empty-reply', declined: true };
    }
    if (declinedTurn(result.reply)) {
      const tail = declinedTail(result.reply);
      if (tail)
        logger.info(
          { ...req.log, tail },
          'conversations: the turn declined with a trailing remark',
        );
      await recordSilence({
        conversationId: ctx.conversationId,
        projectId: req.venue.projectId,
        reason: 'nothing-to-say',
      });
      return { send: false, reason: 'nothing-to-say', declined: true };
    }
  }

  const silent = capture !== null || req.fallbacks === 'silence';
  let declinedInRetry = false;
  const screenedMessage = await screenedTurnReply({
    door: req.door,
    projectId: req.venue.projectId,
    handleName: req.handleName,
    first: result,
    setPhase: ctx.setPhase,
    ...(req.log ? { log: req.log } : {}),
    fallback: silent ? 'none' : 'code-authored',
    retry: async (instruction) => {
      const again = capture ? roomSendCapture() : null;
      const retried = await runExternalChatTurn({
        ...turn,
        ...(again
          ? { tools: mergeToolsets(again.toolset, ...(inputs.tools ? [inputs.tools] : [])) }
          : {}),
        record: 'nothing',
        message: instruction,
      });
      const text = again ? (again.captured() ?? '') : retried.reply;
      if (req.mayDecline && declinedTurn(text)) {
        declinedInRetry = true;
        return { ...retried, reply: '' };
      }
      return { ...retried, reply: text };
    },
  });
  if (declinedInRetry) {
    await recordSilence({
      conversationId: ctx.conversationId,
      projectId: req.venue.projectId,
      reason: 'nothing-to-say',
    });
    return { send: false, reason: 'nothing-to-say', declined: true };
  }
  if (!screenedMessage) {
    await recordSilence({
      conversationId: ctx.conversationId,
      projectId: req.venue.projectId,
      reason: 'screen-refused',
    });
    return { send: false, reason: 'screen-refused', declined: true };
  }
  const screenReplaced = screenedMessage.text.trim() !== result.reply.trim();
  return { send: true, message: screenedMessage, screenReplaced };
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

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TURN_TIMEOUT_MS);
  timer.unref?.();
  const onExternalStop = () => abort.abort();
  req.externalStop?.addEventListener('abort', onExternalStop, { once: true });
  let phase = 'start';
  let reply: TurnReply;
  try {
    reply = await withTimeout(
      composeReply({
        req,
        conversationId: conversation.id,
        abort,
        setPhase: (p) => {
          phase = p;
        },
      }),
      HANDLE_TIMEOUT_MS,
    );
  } catch (err) {
    abort.abort();
    if (req.externalStop?.aborted) {
      clearTimeout(timer);
      await req.dispose?.();
      logger.info({ ...req.log, phase }, 'conversations: a person stopped this turn');
      return { kind: 'stopped', reason: 'stopped-by-a-person' };
    }
    const timedOut = err instanceof TurnTimeoutError;
    logger.error({ err, ...req.log, phase, timedOut }, 'conversations: turn failed');
    Sentry.captureException(err, {
      tags: { area: 'conversations', phase, timed_out: String(timedOut) },
      extra: { adapter: req.venue.adapter, externalId: req.venue.externalId, ...req.log },
    });
    if (req.sendMode === 'tool' || req.fallbacks === 'silence') {
      await recordSilence({
        conversationId: conversation.id,
        projectId: req.venue.projectId,
        reason: 'turn-failed',
      });
      reply = { send: false, reason: 'turn-failed', declined: true };
    } else {
      reply = {
        send: true,
        message: codeAuthored(errorFallbackReply(req.handleName)),
        screenReplaced: true,
      };
    }
  } finally {
    clearTimeout(timer);
    req.externalStop?.removeEventListener('abort', onExternalStop);
    await req.dispose?.();
  }

  if (!reply.send) {
    return reply.declined
      ? { kind: 'declined', reason: reply.reason }
      : { kind: 'diverted', reason: reply.reason };
  }

  let receipt: Awaited<ReturnType<typeof transport.deliver>>;
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
      { err, ...req.log, adapter: req.venue.adapter, externalId: req.venue.externalId },
      'conversations: the reply could not be delivered; nothing was recorded',
    );
    return { kind: 'undeliverable', reason: err instanceof Error ? err.message : String(err) };
  }

  try {
    const entry = req.replyEntry?.(reply.message.text);
    await recordDeliveredReply({
      conversationId: conversation.id,
      projectId: req.venue.projectId,
      text: receipt.deliveredText ?? reply.message.text,
      receipt,
      deliveryKey: req.deliveryKey,
      ...(entry ? { messageId: entry.id, blocks: entry.blocks } : {}),
    });
  } catch (err) {
    logger.error(
      { err, ...req.log, adapter: req.venue.adapter, externalId: req.venue.externalId },
      'conversations: delivered, but recording the reply failed; the outcome stays delivered',
    );
    Sentry.captureException(err, { tags: { area: 'conversations', phase: 'record' } });
  }
  return { kind: 'delivered', messageId: receipt.messageId };
}
