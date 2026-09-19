import type { ExternalChatTurnResult } from '../assistant/external-chat.js';
import { logger } from '../logger.js';
import { type DoorId, type MessageVerdict, problemsOf } from '../messaging/contract.js';
import { doorPolicy } from '../messaging/doors.js';
import { withRepairs } from '../messaging/repairs.js';
import { screenReplyAtDoor } from '../messaging/reply-screen.js';
import {
  CORRECTIVE_PREFIX,
  emptyFallbackReply,
  errorFallbackReply,
  unverifiedFallbackReply,
} from './fallback-replies.js';
import { codeAuthored, type ScreenedMessage, screened } from './ports.js';

/**
 * What a turn says when it has nothing to add.
 */
export const NOTHING_TO_ADD = '(nothing to add)';

/**
 * Did the model decline this turn? Case, punctuation and whatever it added after
 * the sentinel are the model's; the judgement is not.
 */
export function declinedTurn(text: string): boolean {
  return text.trim().toLowerCase().startsWith(NOTHING_TO_ADD);
}

/** What the model wrote after the sentinel, for the log; empty when it wrote nothing more. */
export function declinedTail(text: string): string {
  const trimmed = text.trim();
  return trimmed
    .slice(NOTHING_TO_ADD.length)
    .replace(/^[\s.!—–-]+/, '')
    .trim();
}

const correctiveMessage = (problems: string[]): string =>
  `${CORRECTIVE_PREFIX} Your previous reply cannot be sent as-is: ${problems.join('; ')}. Rewrite it now, keep only verified facts, actually CALL the tools if work is needed, cite issue ids/links only exactly as tools returned them, and reply in the user's language.`;

const EMPTY_RETRY = {
  rule: 'non-empty',
  why: 'empty retry reply',
  quote: null,
  shape: 'the rewrite carries text',
  example: 'The deploy is done; one check is still red.',
} as const;

export interface ScreenedTurnArgs {
  /** The door this reply goes out of; its row carries the pair and the repair budget. */
  door: DoorId;
  projectId: string;
  /** The answering handle's own name — the fallbacks speak as it. */
  handleName: string;
  /** The first attempt, already run. */
  first: ExternalChatTurnResult;
  /** Ask the model again with a corrective instruction, and hand back what it wrote. */
  retry: (instruction: string) => Promise<ExternalChatTurnResult>;
  setPhase: (phase: string) => void;
  /** What stands when the screen is exhausted or the model wrote nothing: a code-authored line, or nothing at all. */
  fallback?: 'code-authored' | 'none';
  log?: Record<string, unknown>;
}

/**
 * Refuse a door that owes nobody a reply, before a turn is spent on one.
 */
export function assertAnswerableDoor(door: DoorId): void {
  if (doorPolicy(door).ending === 'fallback') return;
  throw new Error(
    `conversations: the turn runner answers somebody who is waiting, so it needs a door whose ending is "fallback"; "${door}" ends in a refusal and owes no reply at all`,
  );
}

/**
 * Screen a model turn's reply, and return the text that may be sent.
 */
export async function screenedTurnReply(args: ScreenedTurnArgs): Promise<ScreenedMessage | null> {
  assertAnswerableDoor(args.door);
  let result = args.first;
  let attempt = 0;
  args.setPhase('verify');

  const outcome = await withRepairs(args.door, [result.reply], {
    screen: async (segments): Promise<MessageVerdict> => {
      const text = (segments[0] ?? '').trim();
      if (!text) {
        return attempt === 0
          ? ({ ok: true } as MessageVerdict)
          : { ok: false, refusals: [EMPTY_RETRY] };
      }
      return screenReplyAtDoor(args.door, {
        projectId: args.projectId,
        segments: [text],
        toolCalls: result.toolCalls,
        progress: result.progress,
      });
    },
    rewrite: async (verdict) => {
      attempt += 1;
      logger.warn(
        { ...args.log, problems: problemsOf(verdict) },
        'conversations: reply failed its door screen; corrective retry',
      );
      args.setPhase('retry');
      result = await args.retry(correctiveMessage(problemsOf(verdict)));
      return [result.reply];
    },
  });

  if (outcome.kind === 'exhausted') {
    logger.error(
      { ...args.log, problems: problemsOf(outcome.verdict) },
      'conversations: reply still failing its door screen; sending honest fallback',
    );
    if (args.fallback === 'none') return null;
    return codeAuthored(unverifiedFallbackReply(args.handleName));
  }

  const trimmed = result.reply.trim();
  if (!trimmed) {
    if (args.fallback === 'none') return null;
    return codeAuthored(
      result.terminal === 'error'
        ? errorFallbackReply(args.handleName)
        : emptyFallbackReply(args.handleName),
    );
  }
  const passed = screened(trimmed, args.door, outcome.verdict);
  if (!passed) throw new Error('conversations: a passing verdict yielded no screened message');
  return passed;
}
