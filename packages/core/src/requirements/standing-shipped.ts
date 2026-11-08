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
import {
  ancestryTurn,
  awaitsAncestry,
  codesAct,
  JUDGE_WHO,
  releaseAskOf,
  releaseTurn,
} from './standing-proof.js';

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
// criterion without a pass, so the cause reads beside whom it waits on. Where a verdict counts only on
// a release (ISS-900), the judge is named that release, and with none recorded nobody is asked to
// judge: the master owes the record (`standing-proof.ts:releaseTurn`). A criterion whose every
// judgement waits on the live build's ancestry read reads as that system's wait, last (ISS-1134).
export function shippedTurn(
  input: StandingInput,
  coverage: readonly RequirementCoverage[],
  breakdownDue: string | null,
) {
  const release = releaseAskOf(input.liveBuild);
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
  // unknown is not unproven (ISS-1134): one waiting only on the ancestry read is not judged again
  const pending = unproven.filter((c) => c.verdict !== 'failing' && awaitsAncestry(c));
  const unjudged = unproven.filter((c) => c.verdict !== 'failing' && !awaitsAncestry(c));
  const parts = [
    unjudged.length > 0 ? say('requirements.rule.unjudged', { codes: codesOf(unjudged) }) : null,
    pending.length > 0
      ? say('requirements.rule.ancestryUnread', { codes: codesOf(pending) })
      : null,
    unjudged.length > 0 && release === 'none' ? say('requirements.rule.noReleaseRecorded') : null,
    failing.length > 0 ? say('requirements.rule.failed', { codes: codesOf(failing) }) : null,
  ].filter((p): p is Said => p !== null);
  const rule = say('requirements.rule.shippedNotProven', {
    parts,
    undeclared: input.judge === null ? say('requirements.rule.noJudge') : null,
  });
  if (release && unjudged.length > 0) {
    return releaseTurn(input.judge, release, codesOf(unjudged), rule);
  }
  if (unjudged.length > 0) {
    return {
      group: 'waiting' as const,
      waitingOn: waitingOn('agent', {
        who: JUDGE_WHO[input.judge ?? 'self'],
        act: codesAct('standing.act.judgeShipped', unjudged),
        rule,
      }),
    };
  }
  if (failing.length === 0) return ancestryTurn(pending, rule);
  return {
    group: 'waiting' as const,
    waitingOn: waitingOn(
      'agent',
      { who: MASTER, act: say('standing.act.breakDownFailing', { codes: codesOf(failing) }), rule },
      { dueAt: breakdownDue },
    ),
  };
}
