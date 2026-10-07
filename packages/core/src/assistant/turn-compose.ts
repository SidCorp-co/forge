// Composing one turn's reply: the egress gate, the transport's hooks, the model, and the screen.

import { codeAuthored, recordSilence, turnFailureReason } from '../conversations/index.js';
import { type TurnCredential, turnAuthorityRefusalOf } from '../credentials/turn-credential.js';
import { egressDeep } from '../lib/data-egress.js';
import { logger } from '../lib/logger.js';
import { correctFalseClaims } from './confab.js';
import { STOPPED_BY_A_PERSON, TURN_TIMED_OUT } from './conversation-stops.js';
import {
  type ExternalChatTurnArgs,
  type ExternalChatTurnResult,
  runExternalChatTurn,
} from './external-chat.js';
import { declinedTail, declinedTurn, screenedTurnReply } from './screened-reply.js';
import { type AwaitReplyCapture, awaitReplyCapture } from './tools/await-reply-tool.js';
import { type ChatToolset, mergeToolsets } from './tools/mcp-adapter.js';
import { type RoomSendCapture, roomSendCapture } from './tools/room-send-tool.js';
import type {
  ConversationTurnRequest,
  TurnHookContext,
  TurnInputs,
  TurnReply,
} from './turn-request.js';

export interface TurnContext {
  req: ConversationTurnRequest;
  conversationId: string;
  abort: AbortController;
  setPhase: (phase: string) => void;
  credential: () => Promise<TurnCredential>;
}

/** Record a silence for this turn and close it as declined under `reason`. */
export async function silence(ctx: TurnContext, reason: string): Promise<TurnReply> {
  await recordSilence({
    conversationId: ctx.conversationId,
    projectId: ctx.req.venue.projectId,
    reason,
  });
  return { send: false, reason, ended: 'declined' };
}

/** A turn that ended in an error: a coded failure the window records, never a silence it chose. */
function failed(ctx: TurnContext, result: ExternalChatTurnResult): TurnReply {
  const code =
    ctx.abort.signal.reason === TURN_TIMED_OUT
      ? 'ASSISTANT_TURN_TIMED_OUT'
      : 'ASSISTANT_TURN_FAILED';
  logger.warn(
    { ...ctx.req.log, code, error: result.error },
    'conversations: the turn ended in an error before it answered',
  );
  return {
    send: false,
    ended: 'failed',
    code,
    reason: turnFailureReason(code, ctx.req.handleName),
  };
}

const said = (text: string): TurnReply => ({
  send: true,
  message: codeAuthored(text),
  screenReplaced: false,
});

/** The attempt's toolset: the transport's tools, with this attempt's captures merged in front. */
function withCaptures(
  captures: readonly (RoomSendCapture | AwaitReplyCapture | null)[],
  tools: ChatToolset | undefined,
): ChatToolset | undefined {
  const own = captures.flatMap((c) => (c ? [c.toolset] : []));
  if (own.length === 0) return tools;
  return mergeToolsets(...own, ...(tools ? [tools] : []));
}

/** One `await_reply` capture per attempt, where the venue records asks; none elsewhere. */
const asksCapture = (req: ConversationTurnRequest): AwaitReplyCapture | null =>
  req.recordsAsks ? awaitReplyCapture() : null;

function hookOf(ctx: TurnContext): TurnHookContext {
  const { req } = ctx;
  return {
    setPhase: ctx.setPhase,
    signal: ctx.abort.signal,
    authority: req.authority,
    principalUserId: req.authority.userId,
    credential: ctx.credential,
    speakerUserId: req.speakerUserId === undefined ? req.authority.userId : req.speakerUserId,
    conversationId: ctx.conversationId,
    handleUserId: req.handleUserId ?? null,
  };
}

/** The transport's inputs, or the code-authored line a refused authority earns. */
async function prepareInputs(
  ctx: TurnContext,
  hook: TurnHookContext,
): Promise<TurnInputs | TurnReply> {
  ctx.setPhase('prepare');
  try {
    return (await ctx.req.prepare?.(hook)) ?? {};
  } catch (err) {
    const refused = turnAuthorityRefusalOf(err);
    if (!refused) throw err;
    return said(refused.message);
  }
}

export async function composeReply(ctx: TurnContext): Promise<TurnReply> {
  const { req } = ctx;
  const hook = hookOf(ctx);

  // a conversation with a person is operational content (`lib/data-egress.ts`, surface
  // `conversation`): on a no_egress project no turn hands it to a model or a box, and the room is
  // told so by name instead of answered by one
  const gate = await egressDeep(
    req.venue.projectId,
    'conversation',
    null,
    `conversation ${ctx.conversationId}`,
  );
  if (!gate.ok) return said(`${gate.refusal.code}: ${gate.refusal.detail}`);

  const early = await req.divertBeforeTurn?.(hook);
  if (early) return early;

  const inputs = await prepareInputs(ctx, hook);
  if ('send' in inputs) return inputs;
  const capture = req.sendMode === 'tool' ? roomSendCapture() : null;
  const asks = asksCapture(req);

  ctx.setPhase('turn');
  const turn: ExternalChatTurnArgs = {
    projectId: req.venue.projectId,
    adapter: req.venue.adapter,
    conversationId: ctx.conversationId,
    record: capture ? 'nothing' : req.questionAlreadyRecorded ? 'silence-only' : 'question-only',
    userId: req.authority.userId,
    userKey: req.speakerKey,
    speakerUserId: hook.speakerUserId,
    speakerLabel: req.speakerKey,
    persona: inputs.persona ?? null,
    conversationContext: inputs.conversationContext ?? null,
    pageContext: inputs.pageContext ?? null,
    tools: withCaptures([capture, asks], inputs.tools),
    resolveImage: inputs.resolveImage,
    signal: ctx.abort.signal,
    message: req.message,
  };
  const first = await runExternalChatTurn({
    ...turn,
    questionInHistory: Boolean(req.questionAlreadyRecorded),
    images: inputs.images,
    ...(req.onTurnEvent && !capture ? { onTurnEvent: req.onTurnEvent } : {}),
  });

  // A stop that landed while the model was answering: a turn a person ended records, screens and
  // delivers nothing, and `runConversationTurn` closes the window as stopped.
  if (req.externalStop?.aborted) return { send: false, reason: STOPPED_BY_A_PERSON };

  const late = await req.divertAfterTurn?.(first, hook);
  if (late) return late;

  const settled = await settleFirst(ctx, first, capture);
  if ('send' in settled) return settled;
  return screenReply(ctx, settled, asks?.declared() ?? false, (instruction) => {
    const again = capture ? roomSendCapture() : null;
    const asksAgain = asksCapture(req);
    return {
      again,
      asks: asksAgain,
      run: runExternalChatTurn({
        ...turn,
        tools: withCaptures([again, asksAgain], inputs.tools),
        record: 'nothing',
        message: instruction,
      }),
    };
  });
}

/** The first attempt's reply as the screen should see it, or how the turn already ended. */
async function settleFirst(
  ctx: TurnContext,
  first: ExternalChatTurnResult,
  capture: RoomSendCapture | null,
): Promise<ExternalChatTurnResult | TurnReply> {
  let result = first;
  if (capture) {
    if (result.terminal !== 'done') return failed(ctx, result);
    const captured = capture.captured();
    if (captured === null) return silence(ctx, 'tool-not-called');
    result = { ...result, reply: captured };
  }
  result = { ...result, reply: correctFalseClaims(result.reply, first.toolCalls).text };

  if (!ctx.req.mayDecline) return result;
  if (result.terminal !== 'done') return failed(ctx, result);
  if (result.reply.trim().length === 0) {
    return { send: false, reason: 'empty-reply', ended: 'declined' };
  }
  if (!declinedTurn(result.reply)) return result;
  const tail = declinedTail(result.reply);
  if (tail) {
    logger.info(
      { ...ctx.req.log, tail },
      'conversations: the turn declined with a trailing remark',
    );
  }
  return silence(ctx, 'nothing-to-say');
}

type Retry = (instruction: string) => {
  again: RoomSendCapture | null;
  asks: AwaitReplyCapture | null;
  run: Promise<ExternalChatTurnResult>;
};

/**
 * Screen the reply, retrying where the door asks for it. `firstAsked` is whether the first attempt
 * called `await_reply`; a retry's own call replaces it, because the delivered text is the last
 * attempt's, and a code-authored line never awaits anything.
 */
async function screenReply(
  ctx: TurnContext,
  result: ExternalChatTurnResult,
  firstAsked: boolean,
  retry: Retry,
): Promise<TurnReply> {
  const { req } = ctx;
  let declinedInRetry = false;
  let asked = firstAsked;
  const screened = await screenedTurnReply({
    door: req.door,
    projectId: req.venue.projectId,
    handleName: req.handleName,
    language: req.replyLanguage ?? 'en',
    first: result,
    setPhase: ctx.setPhase,
    ...(req.log ? { log: req.log } : {}),
    fallback: req.sendMode === 'tool' || req.fallbacks === 'silence' ? 'none' : 'code-authored',
    retry: async (instruction) => {
      const { again, asks, run } = retry(instruction);
      const retried = await run;
      asked = asks?.declared() ?? false;
      const reply = again ? (again.captured() ?? '') : retried.reply;
      const text = correctFalseClaims(reply, [...result.toolCalls, ...retried.toolCalls]).text;
      if (req.mayDecline && declinedTurn(text)) {
        declinedInRetry = true;
        return { ...retried, reply: '' };
      }
      return { ...retried, reply: text };
    },
  });
  if (declinedInRetry) return silence(ctx, 'nothing-to-say');
  if (!screened) return silence(ctx, 'screen-refused');
  return {
    send: true,
    message: screened,
    screenReplaced: screened.text.trim() !== result.reply.trim(),
    awaitsReply: asked && screened.proof !== null,
  };
}
