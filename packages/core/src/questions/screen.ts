import { isChoiceStep, type QuestionStep } from '../db/schema-questions.js';
import { renderRefusals } from '../messaging/contract.js';
import { screenAtDoor } from '../messaging/screen.js';

/** Every agent-authored string in a round, for the screen to read before anything is written. */
export function agentAuthoredSegments(step: QuestionStep): string[] {
  if (!isChoiceStep(step)) return [step.prompt, step.needed];
  const segments = [step.prompt];
  for (const o of step.options) {
    segments.push(o.label);
    if (o.fingerprint?.trim()) segments.push(o.fingerprint);
  }
  return segments;
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
