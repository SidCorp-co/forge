// The screen a question round passes before it is written down.
//
// A round is screened HERE, at the ask, while the agent that wrote it is still
// on the line and can be refused to its face. The same cell is screened again
// at `question-delivery` minutes later, and by then there is nobody to ask: a
// round refused there stays owed and unpostable, which is a person waiting on a
// decision they were never shown (ISS-997).

import { isChoiceStep, type QuestionStep } from '../db/schema-questions.js';
import { renderRefusals } from '../messaging/contract.js';
import { screenAtDoor } from '../messaging/screen.js';

/** Every agent-authored string in a round, for the screen to read before anything is written. */
export function agentAuthoredSegments(step: QuestionStep): string[] {
  return isChoiceStep(step)
    ? [step.prompt, ...step.options.map((o) => o.label)]
    : [step.prompt, step.needed];
}

/**
 * Refuse a round whose text does not fit the `role:ask` cell, naming the rule.
 */
export function screenRound(
  step: QuestionStep,
  refuse: (message: string, code: 'QUESTION_MESSAGE_REFUSED') => never,
): void {
  const verdict = screenAtDoor('question-ask', agentAuthoredSegments(step));
  if (!verdict.ok) refuse(renderRefusals(verdict.refusals), 'QUESTION_MESSAGE_REFUSED');
}
