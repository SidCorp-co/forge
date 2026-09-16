/**
 * What a venue is shown when the model's own reply cannot be sent as it stands:
 * the screen, the corrective retries the door's budget allows, and the fallback
 * vocabulary.
 *
 * Moved out of the first adapter's own reply verdict, which held this for one
 * transport and would have held a copy of it for every later one (ISS-1002).
 */

import type { ExternalChatTurnResult } from '../assistant/external-chat.js';
import { logger } from '../logger.js';
import { type DoorId, type MessageVerdict, problemsOf } from '../messaging/contract.js';
import { doorPolicy } from '../messaging/doors.js';
import { withRepairs } from '../messaging/repairs.js';
import { screenReplyAtDoor } from '../messaging/reply-screen.js';
import {
  emptyFallbackReply,
  errorFallbackReply,
  unverifiedFallbackReply,
} from './fallback-replies.js';
import { codeAuthored, type ScreenedMessage, screened } from './ports.js';

/**
 * What a turn says when it has nothing to add.
 */
// cm:guard a SENTINEL and not an empty string, because the two mean different things: an empty reply is a turn that failed to produce one, and this is a turn that produced the judgement "nothing here needs me". A room the bot was never summoned to is owed the second and must never be posted the first's apology (ISS-1004).
export const NOTHING_TO_ADD = '(nothing to add)';

/** Did the model decline this turn? Punctuation and case are the model's, the judgement is not. */
export function declinedTurn(text: string): boolean {
  return (
    text
      .trim()
      .toLowerCase()
      .replace(/[.!]+$/, '') === NOTHING_TO_ADD
  );
}

const correctiveMessage = (problems: string[]): string =>
  `[SYSTEM CHECK — not from the user] Your previous reply cannot be sent as-is: ${problems.join('; ')}. Rewrite it now, keep only verified facts, actually CALL the tools if work is needed, cite issue ids/links only exactly as tools returned them, and reply in the user's language.`;

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
  log?: Record<string, unknown>;
}

/**
 * Refuse a door that owes nobody a reply, before a turn is spent on one.
 */
// cm:guard it is checked BEFORE the turn and not inside it: everything the turn throws becomes the honest fallback so a waiting speaker is never left in silence, and a caller's own contract break swallowed by that arm would post a fallback where a refusal was the deliverable (ISS-1002).
export function assertAnswerableDoor(door: DoorId): void {
  if (doorPolicy(door).ending === 'fallback') return;
  throw new Error(
    `conversations: the turn runner answers somebody who is waiting, so it needs a door whose ending is "fallback"; "${door}" ends in a refusal and owes no reply at all`,
  );
}

/**
 * Screen a model turn's reply, and return the text that may be sent.
 */
// cm:guard this always returns something SENDABLE, and that is the DOOR's decision rather than this function's: only a door whose ending is `fallback` reaches here, and substituting a fallback at one that refuses would post words its writer never wrote (ISS-997).
// cm:guard the budget is DECLARED on the door and spent by `withRepairs`, never counted here — changing it means changing the door's row, where the number sits next to its reason.
export async function screenedTurnReply(args: ScreenedTurnArgs): Promise<ScreenedMessage> {
  assertAnswerableDoor(args.door);
  let result = args.first;
  let attempt = 0;
  args.setPhase('verify');

  const outcome = await withRepairs(args.door, [result.reply], {
    // cm:why an empty FIRST reply is not a screen failure — it is handled below as its own outcome, with a fallback that names why it was empty. An empty REPAIR is: the model was told what to fix and answered with nothing.
    screen: async (segments): Promise<MessageVerdict> => {
      const text = (segments[0] ?? '').trim();
      if (!text) return attempt === 0 ? { ok: true } : { ok: false, refusals: [EMPTY_RETRY] };
      return screenReplyAtDoor(args.door, {
        projectId: args.projectId,
        segments: [segments[0] ?? ''],
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
    return codeAuthored(unverifiedFallbackReply(args.handleName));
  }

  const trimmed = result.reply.trim();
  if (!trimmed) {
    return codeAuthored(
      result.terminal === 'error'
        ? errorFallbackReply(args.handleName)
        : emptyFallbackReply(args.handleName),
    );
  }
  // cm:guard the verdict travels WITH the text as its proof — `screened` returns null on anything but an `ok` verdict over that exact string, so no later branch can send unscreened text under a stale one (ISS-978).
  const passed = screened(trimmed, { ok: true, problems: [] });
  if (!passed) throw new Error('conversations: a passing verdict yielded no screened message');
  return passed;
}
