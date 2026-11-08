/**
 * What an agreed requirement's move into delivery waits on while its own gate would refuse it
 * (ISS-1084, FB-561: agenfold REQ-18 was asked to start delivery while its check was owed). The move
 * is never asked of anyone while its refusal stands: the standing names the act that clears it, at
 * its door. Pure, like `standing.ts`, whose move turn reads it.
 */

import type { RequirementWaitingOn } from '@forge/contracts/requirements';
import { say, sayEn } from '@forge/contracts/said';
import { waitingOn } from '@forge/contracts/standing';
import { signerWait } from './standing-gates.js';
import type { WorkTurn } from './standing-work.js';

/** What of a requirement's delivery check would refuse its move into delivery now. */
export interface DeliveryHold {
  /** Its open questions the gate refuses on (`REQUIREMENT_QUESTION_OPEN`). */
  questions: number;
  /** Whether a person, not the master, owes one of them. */
  person: boolean;
  /** The steward's check is owed and unfinished (`REQUIREMENT_UNCHECKED`). */
  unchecked: boolean;
}

/**
 * The turn a hold puts in place of the move: its open questions first, answered by whoever owes them
 * (the master, or a signer where a person owes one), then the steward's check. Null where nothing of
 * the check holds the move.
 */
export function heldTurn(
  hold: DeliveryHold | null | undefined,
  viewer: Parameters<typeof signerWait>[0],
): WorkTurn | null {
  if (!hold) return null;
  if (hold.questions > 0) {
    const act =
      hold.questions === 1
        ? say('standing.act.answerDeliveryQuestion')
        : say('standing.act.answerDeliveryQuestions', { n: hold.questions });
    const rule = say('requirements.rule.deliveryQuestionOpen');
    if (hold.person) return signerWait(viewer, act, rule);
    return {
      group: 'waiting',
      waitingOn: waitingOn(
        'agent',
        { who: say('standing.who.master'), act, rule },
        { dueAt: null },
      ),
    };
  }
  if (!hold.unchecked) return null;
  return {
    group: 'waiting',
    waitingOn: waitingOn(
      'agent',
      {
        who: say('standing.who.steward'),
        act: say('standing.act.finishDeliveryCheck'),
        rule: say('requirements.rule.deliveryUnchecked'),
      },
      { dueAt: null },
    ),
  };
}

/** The decision holding the wait that began at `since`, where one does now (ISS-1078); else null. */
export function heldByDecision(
  d: { at: Date; why: string; until: Date | null; condition: string | null } | null,
  since: Date,
  now: Date,
): { why: string; until: string } | null {
  if (!d || d.at.getTime() < since.getTime()) return null;
  if (d.until) {
    return d.until.getTime() > now.getTime()
      ? { why: d.why, until: `until ${d.until.toISOString().slice(0, 10)}` }
      : null;
  }
  return d.condition ? { why: d.why, until: `while ${d.condition}` } : null;
}

/** The wait's rule, naming the decision that holds it. */
export function heldRule(w: RequirementWaitingOn, held: { why: string; until: string }) {
  const rule = say('requirements.rule.heldByDecision', {
    rule: w.says.rule,
    until: held.until,
    why: held.why,
  });
  return { rule: sayEn(rule), says: { ...w.says, rule } };
}
