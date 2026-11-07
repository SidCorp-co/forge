/**
 * What an agreed requirement's move into delivery waits on while its own gate would refuse it
 * (ISS-1084, FB-561: agenfold REQ-18 was asked to start delivery while its check was owed). The move
 * is never asked of anyone while its refusal stands: the standing names the act that clears it, at
 * its door. Pure, like `standing.ts`, whose move turn reads it.
 */

import { say } from '@forge/contracts/said';
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
