/**
 * The standing of an agreed requirement whose capability already shipped (ISS-588, REQ-74 BC-4,
 * BC-5): no live issue carries it, and its criteria were judged on the running build at the
 * requirement itself (`standing-coverage.ts:requirementVerdictsOn`). REQ-45 r3 BC-8 forbids an issue
 * whose only work is verifying a capability, so a breakdown is owed only for a criterion that fails
 * there, which is new work. Pure, like `standing.ts`, whose turn and tasks read it.
 */

import type { RequirementCoverage } from '@forge/contracts/requirements';
import { type Said, say } from '@forge/contracts/said';
import { waitingOn } from '@forge/contracts/standing';
import type { StandingInput } from './standing.js';
import { actWait } from './standing-gates.js';
import { JUDGE_WHO } from './standing-proof.js';

const MASTER = say('standing.who.master');

/**
 * Whether the requirement rests on its shipped capability: it has no live issue and a verdict was
 * recorded on one of its criteria at the requirement itself. Read from that record alone, never
 * assumed: with none, nothing says the capability shipped and its breakdown stays owed.
 */
export function restsOnShipped(
  live: readonly unknown[],
  coverage: readonly RequirementCoverage[],
): boolean {
  return live.length === 0 && coverage.some((c) => c.verdicts.length > 0);
}

/** The criteria of a shipped requirement that fail on the running build: the only work it can owe. */
export const failingOf = (coverage: readonly RequirementCoverage[]) =>
  coverage.filter((c) => c.verdict === 'failing');

const codesOf = (rows: readonly RequirementCoverage[]) => rows.map((c) => c.code).join(', ');

// Whose turn a shipped requirement is, first rule wins: every criterion passing on the running
// build → its accept, by whoever the accept falls to (`standing-gates.ts:actWait`); a criterion with
// no counted pass (not judged, judged on another build, judged on an earlier wording) → the
// project's judge judges it there, an act that needs no new work and so goes first; a criterion
// failing → the master breaks it down, new work, with the breakdown's due date. The rule names every
// criterion without a pass, so the cause reads beside whom it waits on.
export function shippedTurn(
  input: StandingInput,
  coverage: readonly RequirementCoverage[],
  breakdownDue: string | null,
) {
  const unproven = coverage.filter((c) => c.verdict !== 'passing');
  if (unproven.length === 0) {
    return actWait(
      input,
      'accept',
      say('standing.act.acceptShipped'),
      say('requirements.rule.shippedProven'),
    );
  }
  const failing = failingOf(unproven);
  const unjudged = unproven.filter((c) => c.verdict !== 'failing');
  const parts = [
    unjudged.length > 0 ? say('requirements.rule.unjudged', { codes: codesOf(unjudged) }) : null,
    failing.length > 0 ? say('requirements.rule.failed', { codes: codesOf(failing) }) : null,
  ].filter((p): p is Said => p !== null);
  const rule = say('requirements.rule.shippedNotProven', {
    parts,
    undeclared: input.judge === null ? say('requirements.rule.noJudge') : null,
  });
  if (unjudged.length > 0) {
    return {
      group: 'waiting' as const,
      waitingOn: waitingOn('agent', {
        who: JUDGE_WHO[input.judge ?? 'self'],
        act: say('standing.act.judgeShipped', { codes: codesOf(unjudged) }),
        rule,
      }),
    };
  }
  return {
    group: 'waiting' as const,
    waitingOn: waitingOn(
      'agent',
      { who: MASTER, act: say('standing.act.breakDownFailing', { codes: codesOf(failing) }), rule },
      { dueAt: breakdownDue },
    ),
  };
}
