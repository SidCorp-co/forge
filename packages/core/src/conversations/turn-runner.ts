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

import type { SettledEntry } from '../assistant/conversation-progress.js';
import { type ExternalChatTurnResult, runExternalChatTurn } from '../assistant/external-chat.js';
import type { ChatStreamEvent } from '../assistant/providers/types.js';
import type { ChatToolset } from '../assistant/tools/mcp-adapter.js';
import type { ImageResolver, TurnImage } from '../assistant/vision.js';
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
import { assertAnswerableDoor, declinedTurn, screenedTurnReply } from './screened-reply.js';
import { openConversation } from './store.js';
import { recordDeliveredReply, recordSilence } from './transcript.js';

// cm:why cancels the provider fetch/SSE read so a stalled upstream terminates as an error instead of hanging
const TURN_TIMEOUT_MS = 90_000;
// cm:guard must stay ABOVE TURN_TIMEOUT_MS so a normal provider-abort resolves first: the abort signal only reaches the provider, so an unbounded await BEFORE the turn — a hung preparation, a stuck conversation read — would wedge the caller in silence without this backstop.
const HANDLE_TIMEOUT_MS = 120_000;

class TurnTimeoutError extends Error {
  constructor(readonly ms: number) {
    super(`conversation turn timed out after ${ms}ms`);
    this.name = 'TurnTimeoutError';
  }
}

// cm:guard does NOT cancel `p` — the runner aborts the provider separately; this only frees the caller to send a fallback and report
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
// cm:guard the principal is handed to the hooks rather than read off the adapter's own route: a many-speaker venue runs under the binding's principal and a one-to-one venue under the speaker's, and an adapter that read its route here again would quietly restore the binding's principal for every direct message (ISS-987).
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

// cm:guard `send: false` is the explicit "this turn posts nothing" case, and it is not a failure: an adapter that handed the turn to a slower path answers through that path, and posting here as well double-replies (ISS-727).
export type TurnReply =
  | { send: false; reason: string; declined?: boolean }
  | {
      send: true;
      message: ScreenedMessage;
      /**
       * The text going out is NOT what the model's first attempt said.
       */
      // cm:guard reported as a FACT by the layer that replaced it, never inferred downstream from
      // comparing strings: a watcher that guessed would call a turn's own preamble a withdrawn
      // draft on any reply the screen trimmed or the model prefixed, and would stay silent on a
      // retry that happened to produce the same sentence. Absent means false, which is right for
      // every divert — those replace nothing because nothing ran (ISS-1078).
      screenReplaced?: boolean;
    };

export interface ConversationTurnRequest {
  venue: ConversationVenue;
  /** The Forge principal whose access this turn reads and runs its tools under. */
  principalUserId: string;
  /** The transport's own id for the speaker, for the audit row. */
  speakerKey: string;
  /**
   * The Forge user the newest person message is linked to. Absent: the
   * principal spoke. `null`: nobody Forge knows did (ISS-1034).
   */
  speakerUserId?: string | null | undefined;
  /** The handle answering for `venue.projectId` in this room, as the window read it; null where none is in it. */
  handleUserId?: string | null | undefined;
  message: string;
  /** The door the reply goes out of; its row carries the pair and the repair budget. */
  door: DoorId;
  /**
   * The question is already a row, so this turn writes only its silence.
   */
  // cm:guard set by the WINDOW path and by nothing else: the collector persisted the message the moment it arrived, and a turn that appended it again would show the model the same text twice and file a second copy under the speaker's name (ISS-1004).
  questionAlreadyRecorded?: boolean;
  /**
   * This turn is allowed to say nothing.
   */
  // cm:guard a turn nobody summoned MUST be able to decline, and that is the whole difference between an agent reading its rooms and an agent answering everything it hears: without it the fallbacks below post "sorry, I had trouble" into a room that asked it nothing (ISS-1004).
  mayDecline?: boolean;
  /**
   * The stable key this turn's delivery answers, so a retry of it delivers nothing.
   */
  // cm:guard derived from the WINDOW by the caller and never minted here: a key this function invented would be fresh on every attempt, which is the at-most-once property read backwards (ISS-1004 rule 2).
  deliveryKey?: string;
  /**
   * Called once, immediately before the text is handed to the transport.
   */
  // cm:guard the hook exists so a caller can make the ATTEMPT durable, and it is called before the send rather than after it because that is the only order a crash cannot beat: a reply accepted by the server and lost by a dying core is indistinguishable from one never sent, unless the intent to send was written first (ISS-1004 rule 2, review F2).
  // cm:guard a FALSE from it means the caller no longer holds the right to speak here and the text is NOT sent: this is how a holder whose lease expired mid-turn is stopped, and treating the refusal as an error would post the fallback into the room the second holder is already answering (ISS-1004, review pass 1 F1).
  onBeforeDeliver?: () => Promise<boolean>;
  /** The answering handle's own name — the code-authored fallbacks speak as it. */
  handleName: string;
  /**
   * The transport's own inputs, built INSIDE the timeout.
   */
  // cm:guard inside, not before: a hung preparation — a stalled history fetch, a blocked config read — is exactly the unbounded await HANDLE_TIMEOUT_MS exists to backstop, and building the inputs outside puts it back where nothing can see it.
  prepare?: (ctx: TurnHookContext) => Promise<TurnInputs>;
  /**
   * The transport's chance to hand the turn elsewhere before the model runs.
   */
  // cm:guard it runs BEFORE `prepare` and not after: an adapter that hands the whole turn to a slower path needs none of the model's inputs, and building a toolset plus downloading a message's images for a turn nobody is going to take is work paid for nothing (ISS-727's agent mode is the case).
  divertBeforeTurn?: (ctx: TurnHookContext) => Promise<TurnReply | null>;
  /** ...and after it, on what the model actually called. */
  divertAfterTurn?: (
    result: ExternalChatTurnResult,
    ctx: TurnHookContext,
  ) => Promise<TurnReply | null>;
  /**
   * Watch the turn's loop events as the model produces them.
   */
  // cm:guard handed to the FIRST turn only and never to the screen's corrective retry: the retry's
  // prose is a second attempt at the same answer, and streaming it would put two drafts of one
  // reply on the socket with nothing to say which the room ended up with. What the reader is shown
  // instead is the settled text, marked, by `onSettled` below (ISS-1078).
  onTurnEvent?: ((event: ChatStreamEvent) => void) | undefined;
  /**
   * The exact text this turn settled on, handed over after the screen and before the delivery.
   */
  // cm:guard called AFTER `onBeforeDeliver` and BEFORE `deliver`, which is the only window that is
  // both: a turn whose right to answer moved publishes nothing, and a correction frame that landed
  // after the delivery event would reach a screen that had already replaced the draft it corrects.
  // cm:guard it answers with what the durable ROW should carry — the turn's one identity and its
  // blocks — because the producer of the frames is the only thing that knows both, and because
  // where the screen replaced the text those blocks are NOT the ones it streamed (ISS-1078).
  // cm:guard whether the screen replaced anything is TOLD to it and not left to be worked out: the
  // watcher holds the prose but not the verdict, and every way of inferring one from the other is
  // wrong on some ordinary turn.
  onSettled?:
    | ((deliveredText: string, screenReplaced: boolean) => Promise<SettledEntry>)
    | undefined;
  /** Released once the turn is over, however it ended. */
  dispose?: () => Promise<void>;
  log?: Record<string, unknown>;
}

/**
 * How the turn ended, in terms a reader can tell apart.
 */
// cm:guard `diverted` is NOT a failure and no caller may treat it as one: it is the fourth state — not yet known — and the answer arrives by the path the adapter handed it to (ISS-1002 invariant 4).
export type TurnOutcome =
  | { kind: 'delivered'; messageId: string | null }
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
  // cm:guard the handle arrives ON THE REQUEST from the window that routed it and this runner reads the store for nothing new: every adapter test drives this runner against a FIFO of mocked selects, and one more query here shifted all of them (measured: 20 Rocket.Chat cases red at once). The chat tools stamp what the hook carries; a turn nobody gave a handle stamps null (ISS-1034 criterion 25).
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

  ctx.setPhase('turn');
  // cm:guard every turn this runner takes is SCREENED, so it writes the question and never the answer: `question-and-answer` persists the model's first reply before the screen has read it, and a transcript holding text the screen rejected is a record of a conversation nobody had (`external-chat.ts` carries the other half of this rule).
  const turn = {
    projectId: req.venue.projectId,
    adapter: req.venue.adapter,
    conversationId: ctx.conversationId,
    record: req.questionAlreadyRecorded ? ('silence-only' as const) : ('question-only' as const),
    userId: req.principalUserId,
    userKey: req.speakerKey,
    speakerUserId,
    speakerLabel: req.speakerKey,
    persona: inputs.persona ?? null,
    conversationContext: inputs.conversationContext ?? null,
    tools: inputs.tools,
    resolveImage: inputs.resolveImage,
    signal: ctx.abort.signal,
  };
  const result = await runExternalChatTurn({
    ...turn,
    message: req.message,
    images: inputs.images,
    ...(req.onTurnEvent ? { onTurnEvent: req.onTurnEvent } : {}),
  });

  const late = await req.divertAfterTurn?.(result, hook);
  if (late) return late;

  // cm:guard the two declines are kept apart because only ONE of them owes a row here: a turn that errored or came back empty is already filed by `external-chat.ts` under its own reason, and a turn that answered the sentinel produced text nothing else will record (ISS-1004 rule 4).
  if (req.mayDecline) {
    if (result.terminal !== 'done' || result.reply.trim().length === 0) {
      return { send: false, reason: result.error ?? 'empty-reply', declined: true };
    }
    if (declinedTurn(result.reply)) {
      await recordSilence({
        conversationId: ctx.conversationId,
        projectId: req.venue.projectId,
        reason: 'nothing-to-say',
      });
      return { send: false, reason: 'nothing-to-say', declined: true };
    }
  }

  const message = await screenedTurnReply({
    door: req.door,
    projectId: req.venue.projectId,
    handleName: req.handleName,
    first: result,
    setPhase: ctx.setPhase,
    ...(req.log ? { log: req.log } : {}),
    // cm:guard the retry WRITES nothing: its message is a code-authored instruction, and a persisted one is words the speaker never said, replayed to the model every turn after. It still READS the conversation, which is why it names one (ISS-1001).
    retry: (instruction) =>
      runExternalChatTurn({ ...turn, record: 'nothing', message: instruction }),
  });
  // cm:guard the comparison is made HERE, against the model's own final text, and it is a report
  // rather than a guess: this is the one place that holds both the attempt and what the screen
  // settled on. `screenedTurnReply` hands the door `result.reply.trim()`, so the trim is accounted
  // for and nothing about blocks, streaming or preambles enters into it (ISS-1078).
  return { send: true, message, screenReplaced: message.text !== result.reply.trim() };
}

/**
 * Take one turn in a venue, and deliver what it produced.
 */
// cm:guard the transport is looked up by the VENUE's adapter and never handed in: `deliver` is the one outbound door, and a caller allowed to supply its own would be the copy of the turn path this module exists to remove (ISS-1002 invariant 6).
export async function runConversationTurn(req: ConversationTurnRequest): Promise<TurnOutcome> {
  assertAnswerableDoor(req.door);
  const transport = conversationTransport(req.venue.adapter);
  if (!transport) {
    throw new Error(
      `conversations: no transport is registered for adapter "${req.venue.adapter}", so a turn in ${req.venue.externalId} has nowhere to be delivered — call registerConversationTransport when that adapter starts`,
    );
  }
  const conversation = await openConversation(req.venue);

  // cm:guard two nested guards so a stall NEVER leaves the speaker in silence: `abort` cancels the provider, `withTimeout` backstops a hang the abort cannot reach; either fire sends a fallback AND captures to Sentry tagged with `phase`.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TURN_TIMEOUT_MS);
  timer.unref?.();
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
    // cm:guard the message was seen, so the venue never goes silent — but the CONVERSATION is not dropped on the way out: a turn that failed keeps its transcript, and the silence is recorded with its reason by `external-chat.ts` (ISS-1001).
    abort.abort();
    const timedOut = err instanceof TurnTimeoutError;
    logger.error({ err, ...req.log, phase, timedOut }, 'conversations: turn failed');
    Sentry.captureException(err, {
      tags: { area: 'conversations', phase, timed_out: String(timedOut) },
      extra: { adapter: req.venue.adapter, externalId: req.venue.externalId, ...req.log },
    });
    // cm:guard a turn that failed or timed out HAS replaced whatever it was writing, and says so:
    // the room watched prose arrive and is now handed a fixed sentence instead, which is the same
    // withdrawal a screen refusal is and owes the same notice.
    reply = {
      send: true,
      message: codeAuthored(errorFallbackReply(req.handleName)),
      screenReplaced: true,
    };
  } finally {
    clearTimeout(timer);
    await req.dispose?.();
  }

  if (!reply.send) {
    return reply.declined
      ? { kind: 'declined', reason: reply.reason }
      : { kind: 'diverted', reason: reply.reason };
  }

  let receipt: Awaited<ReturnType<typeof transport.deliver>>;
  let entry: SettledEntry | null = null;
  try {
    if (req.onBeforeDeliver && !(await req.onBeforeDeliver())) {
      return { kind: 'superseded', reason: 'the right to answer here moved to another holder' };
    }
    entry = (await req.onSettled?.(reply.message.text, reply.screenReplaced === true)) ?? null;
    receipt = await transport.deliver(req.venue, reply.message);
  } catch (err) {
    // cm:guard nothing is recorded when the door refuses: the venue never saw this text, and a transcript row for it would say the opposite. The commonest refusal is a room rebound while the turn ran, which `deliver` names rather than swallows.
    logger.error(
      { err, ...req.log, adapter: req.venue.adapter, externalId: req.venue.externalId },
      'conversations: the reply could not be delivered; nothing was recorded',
    );
    return { kind: 'undeliverable', reason: err instanceof Error ? err.message : String(err) };
  }

  await recordDeliveredReply({
    conversationId: conversation.id,
    projectId: req.venue.projectId,
    text: reply.message.text,
    receipt,
    deliveryKey: req.deliveryKey,
    // cm:guard `text` stays the sentence that WENT OUT and this adds nothing to it: what the entry
    // carries is the turn's identity and the record of what it ran, and where the screen replaced
    // the reply its own producer has already dropped the text blocks the door refused (ISS-1078).
    ...(entry ? { entryId: entry.entryId, blocks: entry.blocks } : {}),
  });
  return { kind: 'delivered', messageId: receipt.messageId };
}
