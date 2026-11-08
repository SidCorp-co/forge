// Forge's own recommendation on a question round nobody recommended an answer for (ISS-686 c1,
// REQ-68 BC-1, ISS-1148): judge K101 found ISS-673's decision showing "No recommendation" and one
// "Write the answer", so the person formed the answer alone.

import type { DecisionAnswer, NeedsYouDecision } from '@forge/contracts/needs-you-decisions';
import type { QuestionStep } from '../db/schema-questions.js';

/** What "Let the run decide" sends the run that asked: its go, under `decision-authority`. */
export const RUN_DECIDES_TEXT =
  'Decide it yourself, and record your choice and why on the item. Ask again only for something irreversible, real money, credentials or a new product direction.';

/**
 * The run decides, as `decision-authority` lets it, in one click, beside the typed answer. A
 * sensitive round asks for what the person alone holds, a secret no run can decide, so it says why
 * it recommends none instead.
 */
export function ruleRecommended(
  step: QuestionStep,
  typed: DecisionAnswer,
  path: string,
): {
  recommended: NeedsYouDecision['recommended'];
  noRecommendation: string | null;
  answers: DecisionAnswer[];
} {
  if (step.sensitive) {
    return {
      recommended: null,
      noRecommendation: 'It asks for something only you hold, so nobody can recommend it.',
      answers: [typed],
    };
  }
  return {
    recommended: {
      answerId: 'decide',
      why: 'Nobody recommended an answer, and the run may decide anything not irreversible, money, credentials or a new direction.',
      by: 'rule',
    },
    noRecommendation: null,
    answers: [
      {
        id: 'decide',
        label: 'Let the run decide',
        act: 'question.answer',
        path,
        body: { round: step.round, text: RUN_DECIDES_TEXT },
        effect: 'Tells the run that asked to choose itself and record why.',
        recommended: true,
        needsReason: false,
        declines: false,
      },
      typed,
    ],
  };
}
