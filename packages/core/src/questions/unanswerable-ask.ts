// What a question must carry to be asked at all: a subject, and the choices its prompt points at.
// Run by both doors that write a question (`write.ts:insertAskedQuestion`, `askParkQuestion`).

import type { QuestionRefusalCode } from '@forge/contracts/questions';
import { refuser } from '../lib/refusal.js';
import type { AskAnswer } from './write.js';

const refuseQuestion = refuser<QuestionRefusalCode>('QUESTION_REFUSED');

/**
 * Words a prompt uses to point at choices it lists elsewhere: "these readings", "which of these",
 * "the following options". Narrow on purpose, and deterministic: a prompt matching one while the
 * round carries no choice is a question naming something nobody can see (ISS-812).
 */
export const CHOICE_REFERENCE_PATTERN =
  /\b(?:(?:these|those|the following|the above) (?:readings?|options?|choices?|alternatives?|interpretations?)|which of (?:these|those|the following|the above))\b/i;

/** A free-text round lists its choices in `needed` as numbered `(1) …; (2) …`, which counts as carrying them. */
const NUMBERED_CHOICES_PATTERN = /\(1\)[\s\S]*\(2\)/;

/**
 * Refuses a question that stands on nothing (no issue, requirement, feedback item, asker, `about`,
 * session or origin) and one whose prompt points at choices while carrying none, naming what is
 * missing and the shape that is valid. Both doors that write a question run this.
 */
export function refuseUnanswerableAsk(input: {
  prompt: string;
  answer: AskAnswer;
  issueId?: string | undefined;
  requirementId?: string | undefined;
  feedbackId?: string | undefined;
  askedBy?: string | undefined;
  about?: unknown;
  agentSessionId?: string | undefined;
  origin?: unknown;
}): void {
  const { issueId, requirementId, feedbackId, askedBy, about, agentSessionId, origin } = input;
  if (!(issueId || requirementId || feedbackId || askedBy || about || agentSessionId || origin)) {
    throw refuseQuestion(
      'QUESTION_SUBJECT_REQUIRED',
      'this question names no subject: no issue, requirement, feedback item or asker. Ask it on an issue with `issueId`, or on a requirement or contract with `about`, so a person can tell what it is about',
      '/issueId',
    );
  }
  const carriesChoices =
    input.answer.shape === 'choice'
      ? input.answer.options.length > 0
      : NUMBERED_CHOICES_PATTERN.test(input.answer.needed);
  if (!carriesChoices && CHOICE_REFERENCE_PATTERN.test(input.prompt)) {
    throw refuseQuestion(
      'QUESTION_OPTIONS_REQUIRED',
      'the prompt refers to choices ("these readings", "which of these") and the question carries none, so nobody can answer it. Send the choices as `options` with a `recommendedOptionId`, or write the prompt so it names what it asks without pointing at a list',
      '/options',
    );
  }
}
