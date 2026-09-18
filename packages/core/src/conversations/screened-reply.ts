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
  CORRECTIVE_PREFIX,
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

/**
 * Did the model decline this turn? Case, punctuation and whatever it added after
 * the sentinel are the model's; the judgement is not.
 */
// cm:guard BEGINS WITH and not equality: `(nothing to add) — though you may want to check the build` is a decline with a hedge on it, and under equality the whole string, sentinel included, went to the room. What follows the sentinel is logged by the caller and never posted (ISS-1087 criteria 22, 23, 38).
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
// cm:guard `fallback: 'none'` hands back null where a code-authored line would have gone, and the caller owns what that silence is called: a `tool`-mode room hears only what `room_send` carried, and a fallback the code wrote is text the tool never carried (ISS-1087 criteria 19, 20; whole-set review F1).
export async function screenedTurnReply(args: ScreenedTurnArgs): Promise<ScreenedMessage | null> {
  assertAnswerableDoor(args.door);
  let result = args.first;
  let attempt = 0;
  args.setPhase('verify');

  const outcome = await withRepairs(args.door, [result.reply], {
    // cm:why an empty FIRST reply is not a screen failure — it is handled below as its own outcome, with a fallback that names why it was empty. An empty REPAIR is: the model was told what to fix and answered with nothing.
    screen: async (segments): Promise<MessageVerdict> => {
      const text = (segments[0] ?? '').trim();
      // cm:hack ISS-978 until:`withRepairs` can be told "not a failure, and do not repair" without a
      // verdict — this is the one cast to an `ok` verdict outside a screen, and it is a CONTROL-FLOW
      // signal rather than a claim about text. What bounds it: the empty string it stands for never
      // reaches `screened()` below, because the `!trimmed` branch returns a `codeAuthored` fallback
      // first, so it can mint no proof and nothing can be posted under it. Priced at one cast that
      // `verdict-mint.test.ts` names; it ends when `RepairRound.screen` can return a third outcome.
      if (!text) {
        return attempt === 0
          ? ({ ok: true } as MessageVerdict)
          : { ok: false, refusals: [EMPTY_RETRY] };
      }
      // cm:guard the TRIMMED text is what is screened, because it is what is sent: `screened()` below
      // is called with `result.reply.trim()`, and since ISS-978 a proof is minted only where the
      // verdict was passed over that exact string. Screening the untrimmed segment and posting the
      // trimmed one is the same "the screen read something else" gap F5 names, two whitespace
      // characters wide (whole-set review F2).
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
  // cm:guard the verdict travels WITH the text as its proof — `screened` returns null on anything but an `ok` verdict over that exact string, so no later branch can send unscreened text under a stale one (ISS-978).
  // cm:guard the verdict handed over is the one `withRepairs` PASSED ON, not a fresh `{ ok: true }`: the
  // repair loop may have screened a rewritten attempt, and the pass that matters is the pass over the
  // text about to be sent. Since ISS-978 there is no other verdict available to write here anyway.
  const passed = screened(trimmed, args.door, outcome.verdict);
  if (!passed) throw new Error('conversations: a passing verdict yielded no screened message');
  return passed;
}
