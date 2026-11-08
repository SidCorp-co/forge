/**
 * The delivery moves a requirement waits on (REQ-74 BC-8): once its live issues all closed and every
 * live criterion passes, into delivery, then delivered. Where a person gate asks them they are asked
 * of whoever may make them; where none does, Forge makes them by rule (`standing-tasks.ts:byRule`,
 * `steward/requirement-rule-moves.ts`, owner 2026-11-08 D1) and the wait is Forge's, never a person's.
 * Split from `standing.ts` to keep that file one read.
 */

import type { RequirementCoverage, RequirementWaitingOn } from '@forge/contracts/requirements';
import { type Said, type SaidKey, say } from '@forge/contracts/said';
import { waitingOn } from '@forge/contracts/standing';
import type { RequirementStatus } from '../db/schema-requirements.js';
import type { StandingInput, StandingIssue } from './standing.js';
import { actWait } from './standing-gates.js';
import { heldTurn } from './standing-held.js';
import { byRule } from './standing-tasks.js';
import type { WorkTurn } from './standing-work.js';

const MOVE_ASKED: Partial<Record<RequirementStatus, readonly [SaidKey, SaidKey]>> = {
  agreed: ['standing.act.startDelivery', 'requirements.rule.startDelivery'],
  in_delivery: ['standing.act.markDelivered', 'requirements.rule.markDelivered'],
};

/** The wait while a rule move is due and its sweep has not made it yet: Forge's, never a person's. */
export const ruleTurn = (move: Said): WorkTurn => ({
  group: 'waiting',
  waitingOn: waitingOn('agent', {
    who: say('standing.who.forge'),
    act: say('standing.act.moveByRule', { move }),
    rule: say('requirements.rule.byRule'),
  }) as RequirementWaitingOn,
});

export function moveTurn(
  input: StandingInput,
  live: readonly StandingIssue[],
  coverage: readonly RequirementCoverage[],
): WorkTurn | null {
  const done =
    live.length > 0 &&
    live.every((i) => i.status === 'closed') &&
    coverage.length > 0 &&
    coverage.every((c) => c.verdict === 'passing');
  const move = done ? MOVE_ASKED[input.status] : undefined;
  if (!move) return null;
  const held = input.status === 'agreed' ? heldTurn(input.deliveryHold, input.viewer) : null;
  if (held) return held;
  return byRule(input)
    ? ruleTurn(say(move[0]))
    : actWait(input, 'accept', say(move[0]), say(move[1]));
}
