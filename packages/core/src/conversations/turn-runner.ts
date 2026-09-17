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
  // cm:guard `screenReplaced` is a FACT about the screen and never a text comparison: a turn that
  // called a tool answers in two model round trips, so the prose a watcher accumulated holds the
  // preamble as well and always differs from the one reply that goes out — inferring a refusal from
  // that difference told every tool-using turn's reader their draft had been refused. Measured on a
  // local walk, 2026-09-17 (ISS-1078).
  | { send: true; message: ScreenedMessage; screenReplaced: boolean };

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
   * How the model's answer reaches the venue: as its reply, or only through `room_send`.
   */
  // cm:guard `tool` changes WHICH TEXT is the reply and nothing after that point: the captured text takes the model's reply's place before the screen, and the screen, the reservation, `deliver` and the transcript row are the same as in `reply` mode. A second path that delivered from inside the tool would be two live paths, and the one this runner keeps true is the only one there is (ISS-1087 criteria 18-20).
  sendMode?: 'reply' | 'tool' | undefined;
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
  /**
   * Called for each event of the FIRST attempt's turn loop, as it yields.
   */
  // cm:guard the first attempt only, and never the corrective retry: a retry is a second model turn
  // whose prose REPLACES the first, so streaming it too would append the replacement to the draft a
  // reader is already looking at and show one answer twice. The replacement reaches them through
  // `onSettled` below, marked as the correction it is (ISS-1078).
  onTurnEvent?: ((event: ChatStreamEvent) => void) | undefined;
  /**
   * Called once with the text the screen admitted, before it is delivered.
   */
  // cm:guard it carries BOTH the text and whether the screen replaced the attempt that streamed,
  // because the watcher cannot tell those apart on its own: its accumulated prose differs from the
  // delivered reply on every turn that called a tool, and a watcher left to infer a refusal from that
  // difference accuses the screen on every one of them. A screen refusal, an exhausted repair budget
  // and the error fallback are all `screenReplaced: true` — each really does replace what streamed.
  // Called before delivery, so a delivery that then fails leaves a frame the room's own read corrects;
  // progress is best-effort and the transcript is not (ISS-1078).
  onSettled?: ((settled: { text: string; screenReplaced: boolean }) => void) | undefined;
  /**
   * The identity and the blocks the delivered reply's row is written with.
   */
  // cm:guard asked for AFTER the screen has run, with the text that won, because that is the only
  // moment the answer is known — and the blocks that come back must be the blocks of that text. The
  // one implementation is `conversation-progress.ts:blocksForRecord`, which drops a refused draft's
  // text blocks rather than filing them (ISS-1078).
  replyEntry?:
    | ((deliveredText: string) => { id: string; blocks: readonly ContentBlock[] | null })
    | undefined;
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
  // cm:guard the send tool is merged FIRST so it owns its name whatever an external toolset offers, and it exists only in `tool` mode: a `window` room offered it would let the model post twice, once by the tool and once by its reply.
  const capture = req.sendMode === 'tool' ? roomSendCapture() : null;
  const tools = capture
    ? mergeToolsets(capture.toolset, ...(inputs.tools ? [inputs.tools] : []))
    : inputs.tools;

  ctx.setPhase('turn');
  // cm:guard every turn this runner takes is SCREENED, so it writes the question and never the answer: `question-and-answer` persists the model's first reply before the screen has read it, and a transcript holding text the screen rejected is a record of a conversation nobody had (`external-chat.ts` carries the other half of this rule).
  const turn = {
    projectId: req.venue.projectId,
    adapter: req.venue.adapter,
    conversationId: ctx.conversationId,
    // cm:guard in `tool` mode the model turn persists NOTHING and this runner files the one row the turn earns after it has read the capture: `external-chat.ts` files `empty-reply` on any turn whose prose is empty, which in tool mode is the ordinary shape of a turn that answered through `room_send`, and a transcript holding that row beside the delivered answer says the agent said nothing and also what it said (ISS-1087 criterion 19; whole-set review, round 4 F1).
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
    images: inputs.images,
    // cm:guard spread onto THIS call and not onto `turn`, because `turn` is also spread into the
    // retry below — putting it there is what would stream the replacement on top of the draft.
    // cm:guard and NOT in `tool` mode: the events carry the model's own prose, which in that mode is never the reply, and a watcher shown it would read a draft the room is never going to hear (ISS-1087 criterion 20; whole-set review F3).
    ...(req.onTurnEvent && !capture ? { onTurnEvent: req.onTurnEvent } : {}),
  });

  const late = await req.divertAfterTurn?.(result, hook);
  if (late) return late;

  // cm:guard in `tool` mode the model's OWN prose is never the reply: what it captured through `room_send` is, and a turn that captured nothing is a named silence rather than an unnamed one — `tool-not-called` is the row a person reads when a room in this mode goes quiet (ISS-1087 criteria 19, 20). A finished turn with no capture is judged before the decline check below, so the sentinel path never sees the model's prose.
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

  // cm:guard the two declines are kept apart because only ONE of them owes a row here: a turn that errored or came back empty is already filed by `external-chat.ts` under its own reason, and a turn that answered the sentinel produced text nothing else will record (ISS-1004 rule 4).
  if (req.mayDecline) {
    if (result.terminal !== 'done' || result.reply.trim().length === 0) {
      return { send: false, reason: result.error ?? 'empty-reply', declined: true };
    }
    if (declinedTurn(result.reply)) {
      // cm:guard what followed the sentinel is LOGGED and never posted: the judgement was a decline, and the hedge after it is the text the equality test used to hand to the room whole (ISS-1087 criteria 22, 38).
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

  let declinedInRetry = false;
  const screenedMessage = await screenedTurnReply({
    door: req.door,
    projectId: req.venue.projectId,
    handleName: req.handleName,
    first: result,
    setPhase: ctx.setPhase,
    ...(req.log ? { log: req.log } : {}),
    fallback: capture ? 'none' : 'code-authored',
    // cm:guard the retry WRITES nothing: its message is a code-authored instruction, and a persisted one is words the speaker never said, replayed to the model every turn after. It still READS the conversation, which is why it names one (ISS-1001).
    // cm:guard in `tool` mode a corrective retry is CAPTURED like the first attempt, through a capture of its own because the first is already spent: what the retry wrote as prose is not the reply, and a retry that never called `room_send` hands the screen an empty rewrite, which it refuses until the budget is spent and the turn falls silent (ISS-1087 criterion 20; whole-set review F1).
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
      // cm:guard a retry that DECLINES is a decline and never a rewrite to screen: the sentinel check above ran before this retry existed, so without this a "(nothing to add)" the model answered the corrective instruction with would go to the screen, be admitted, and reach the room as text (ISS-1087 criteria 37, 38; whole-set review F2). The empty reply spends the screen's budget; what the turn is then called is decided below.
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
  // cm:guard compared against THE FIRST ATTEMPT'S reply, which is the one whose events streamed, and
  // never against the accumulated prose: they are the same thing only on a turn with no tool call.
  // Trimmed, because that is what `screenedTurnReply` returns.
  const screenReplaced = screenedMessage.text.trim() !== result.reply.trim();
  return { send: true, message: screenedMessage, screenReplaced };
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
    // cm:guard `screenReplaced: true` because this fallback really does replace whatever streamed
    // before the throw — the screen never ran, and a reader watching prose arrive is owed the fact
    // that what they saw is not what went out (ISS-1078).
    // cm:guard in `tool` mode the fallback is NOT posted: the room hears only what `room_send` carried, and a turn that died before or during the model's work carried nothing, so it is recorded as a named silence instead (ISS-1087 criterion 19; whole-set review F1).
    if (req.sendMode === 'tool') {
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
    // cm:guard called HERE and not where the screen ran, because the screen is not the only thing
    // that replaces a draft: the catch above builds a code-authored fallback for a turn that threw or
    // timed out, and that path never reaches `composeReply`'s end. A watcher told only about screen
    // refusals would let a streamed draft be silently replaced by the error fallback — the exact
    // silent substitution this issue's decision rules out. After the delivery guard, so a superseded
    // turn announces no correction for text it never sent (ISS-1078, consult F2).
    req.onSettled?.({ text: reply.message.text, screenReplaced: reply.screenReplaced });
    receipt = await transport.deliver(req.venue, reply.message);
  } catch (err) {
    // cm:guard nothing is recorded when the door refuses: the venue never saw this text, and a transcript row for it would say the opposite. The commonest refusal is a room rebound while the turn ran, which `deliver` names rather than swallows.
    logger.error(
      { err, ...req.log, adapter: req.venue.adapter, externalId: req.venue.externalId },
      'conversations: the reply could not be delivered; nothing was recorded',
    );
    return { kind: 'undeliverable', reason: err instanceof Error ? err.message : String(err) };
  }

  // cm:guard resolved from the DELIVERED text and not from the turn, so a screened replacement is
  // stored under the identity the browser drew and with blocks that belong to what went out.
  const entry = req.replyEntry?.(reply.message.text);
  await recordDeliveredReply({
    conversationId: conversation.id,
    projectId: req.venue.projectId,
    text: reply.message.text,
    receipt,
    deliveryKey: req.deliveryKey,
    ...(entry ? { messageId: entry.id, blocks: entry.blocks } : {}),
  });
  return { kind: 'delivered', messageId: receipt.messageId };
}
