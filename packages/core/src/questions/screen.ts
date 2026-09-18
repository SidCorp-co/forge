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
// cm:guard `fingerprint` IS a segment and is not the facts line: the line around it is ours, the value inside it is the agent's, and `optionSuffix` interpolates it verbatim into the posted message four lines from this list. It is also the field that makes an option a permission — `bindsTo: 'this_call'` names the call a typed number allows — so a fingerprint carrying a newline or an option-line prefix reshapes the very text that states the scope being granted (ISS-978).
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
// cm:guard the refusal carries `renderRefusals` and never a bare "wrong format": the author is an agent that will rewrite and retry, and a refusal that does not say which rule broke, what shape passes and what one looks like buys a second round of the same mistake (ISS-997).
// cm:guard thrown BEFORE the insert, not after, so a refused round leaves no `agent_questions` row: a written row is already owed to a person by `owedRounds`, and one that can never pass the delivery screen would be retried against an unbound room forever.
export function screenRound(
  step: QuestionStep,
  refuse: (message: string, code: 'QUESTION_MESSAGE_REFUSED') => never,
): void {
  const verdict = screenAtDoor('question-ask', agentAuthoredSegments(step));
  if (!verdict.ok) refuse(renderRefusals(verdict.refusals), 'QUESTION_MESSAGE_REFUSED');
}
