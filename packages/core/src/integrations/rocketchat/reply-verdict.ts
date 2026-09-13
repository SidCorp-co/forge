/**
 * What a room is told when the model's own reply cannot be sent as it stands:
 * the screen, the one corrective retry, and the fallback vocabulary.
 *
 * Split out of `connection-manager.ts`, which owns connection ownership and
 * routing and had grown this decision inside itself.
 */

import { type ExternalChatTurnResult, runExternalChatTurn } from '../../assistant/external-chat.js';
import { logger } from '../../logger.js';
import type { FastTurnInputs } from './images.js';
import { FIXED_REPLY_CONSTANT, type ReplySendProof } from './outbound.js';
import { screenStakeholderReply } from './reply-screen.js';

// cm:guard fallbacks speak AS the bot by name — never as an anonymous "the system" or "the model" voice
export const errorFallbackReply = (name: string): string =>
  // cm:ignore CM001 — the i18n pragma `check-source-language` reads to allow this user-facing Vietnamese reply; deleting it to satisfy codemap reds the language gate instead
  `Xin lỗi, ${name} đang quá tải hoặc gặp sự cố — bạn thử lại sau ít phút nhé.`; // i18n-allow: user-facing channel reply

// cm:guard ISS-818 — name the REASON: a bare "couldn't verify" reads to a stakeholder as "didn't understand you" so they rephrase, which cannot help because the question WAS understood and the answer failed the check
export const unverifiedFallbackReply = (name: string): string =>
  // cm:ignore CM001 — the i18n pragma `check-source-language` reads to allow this user-facing Vietnamese reply; deleting it to satisfy codemap reds the language gate instead
  `Xin lỗi, ${name} chưa đối chiếu được số liệu dự án nên không dám gửi câu trả lời chưa chắc chắn — không phải do câu hỏi của bạn, bạn hỏi lại sau ít phút nhé.`; // i18n-allow: user-facing channel reply

export const emptyFallbackReply = (name: string): string =>
  // cm:ignore CM001 — the i18n pragma `check-source-language` reads to allow this user-facing Vietnamese reply; deleting it to satisfy codemap reds the language gate instead
  `Xin lỗi, ${name} chưa đưa ra được câu trả lời cho yêu cầu này — bạn diễn đạt lại giúp ${name} nhé.`; // i18n-allow: user-facing channel reply

const correctiveMessage = (problems: string[]): string =>
  `[SYSTEM CHECK — not from the user] Your previous reply cannot be sent as-is: ${problems.join('; ')}. Rewrite it now, keep only verified facts, actually CALL the tools if work is needed, cite issue ids/links only exactly as tools returned them, and reply in the user's language.`;

// cm:guard `send: false` is the explicit "this turn posts nothing" case — the completion bridge delivers that reply asynchronously, so posting here too double-replies
export type TurnOutcome =
  | { send: false }
  | { send: true; text: string; proof: ReplySendProof; messageId?: string | null };

export const fixed = (text: string): TurnOutcome => ({
  send: true,
  text,
  proof: FIXED_REPLY_CONSTANT,
});

export interface ScreenWithRetryArgs {
  projectId: string;
  rid: string;
  botName: string;
  /** The first turn's own authority: a retry is that turn again, not a new one. */
  principalUserId: string;
  /** The transport's own id for the speaker, carried into the retry unchanged. */
  speakerKey: string;
  first: ExternalChatTurnResult;
  fast: FastTurnInputs;
  persona: string;
  conversationContext: string | null;
  signal: AbortSignal;
  setPhase: (phase: string) => void;
}

// cm:guard exactly ONE corrective retry, then an honest fallback — never a second: each retry is a full model turn inside HANDLE_TIMEOUT_MS, and a model that failed the guard twice does not converge on a third
export async function screenWithRetry(args: ScreenWithRetryArgs): Promise<TurnOutcome> {
  const { projectId, rid, botName, fast, persona, conversationContext, signal, setPhase } = args;
  const screen = (r: ExternalChatTurnResult) =>
    screenStakeholderReply(projectId, r.reply, r.toolCalls, r.progress);
  let result = args.first;

  setPhase('verify');
  let verdict = result.reply.trim() ? await screen(result) : { ok: true, problems: [] as string[] };
  if (!verdict.ok) {
    logger.warn(
      { rid, projectId, problems: verdict.problems },
      'rocketchat: reply failed output guards; corrective retry',
    );
    setPhase('retry');
    result = await runExternalChatTurn({
      projectId,
      adapter: 'rocketchat',
      conversationId: result.conversationId ?? undefined,
      // cm:guard the retry WRITES nothing to the room: its own message is this file's corrective instruction, and a persisted one is words the speaker never said, replayed to the model every turn after. It still READS the room, which is why it names the conversation (ISS-1001).
      record: 'nothing',
      message: correctiveMessage(verdict.problems),
      tools: fast.tools,
      userId: args.principalUserId,
      userKey: args.speakerKey,
      persona,
      conversationContext,
      resolveImage: fast.resolveImage,
      signal,
    });
    verdict = result.reply.trim()
      ? await screen(result)
      : { ok: false, problems: ['empty retry reply'] };
    if (!verdict.ok) {
      logger.error(
        { rid, projectId, problems: verdict.problems },
        'rocketchat: retry still failing output guards; sending honest fallback',
      );
    }
  }
  if (!verdict.ok) return fixed(unverifiedFallbackReply(botName));
  const trimmedReply = result.reply.trim();
  if (!trimmedReply) {
    return fixed(
      result.terminal === 'error' ? errorFallbackReply(botName) : emptyFallbackReply(botName),
    );
  }
  // cm:guard the verdict travels WITH the text as its proof — the only shape sendFixedReply accepts for model-generated output, so no later branch can send unscreened text under a stale proof
  return {
    send: true,
    text: trimmedReply,
    proof: { ok: true, problems: verdict.problems },
    messageId: result.assistantMessageId,
  };
}
