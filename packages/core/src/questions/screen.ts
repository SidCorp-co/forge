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
// cm:guard the option LABELS are segments and the facts line rendered beside them is not: `optionFacts` is written by us from the option's own columns, so screening it would have the contract read our render rather than what the agent claimed. The `needed` line of a free-text round IS the agent's (ISS-997).
export function agentAuthoredSegments(step: QuestionStep): string[] {
  return isChoiceStep(step)
    ? [step.prompt, ...step.options.map((o) => o.label)]
    : [step.prompt, step.needed];
}

/**
 * Refuse a round whose text does not fit the `role:ask` cell, naming the rule.
 */
// cm:guard the refusal carries `renderRefusals` and never a bare "wrong format": the author is an agent that will rewrite and retry, and a refusal that does not say which rule broke, what shape passes and what one looks like buys a second round of the same mistake (ISS-997).
// cm:guard thrown BEFORE the insert, not after, so a refused round leaves no `agent_questions` row: a written row is already owed to a person by `owedRounds`, and one that can never pass the delivery screen would be retried against an unbound room forever.
export function screenRound(
  step: QuestionStep,
  refuse: (message: string, code: 'QUESTION_MESSAGE_REFUSED') => never,
): void {
  const verdict = screenAtDoor('question-ask', agentAuthoredSegments(step));
  if (!verdict.ok) refuse(renderRefusals(verdict.refusals), 'QUESTION_MESSAGE_REFUSED');
}
