// The steward's decisions act when answered (REQ-48 BC-5), so they are asked through the steward's
// own door alone (`steward/decision-ask.ts`), which checks the item they are about and the run that
// asks. A question asked on the general door carrying one of their option ids is refused by name.

import { stewardDecisionOf } from '@forge/contracts/steward';
import { type AskAnswer, refuseQuestion } from './write.js';

export function refuseStewardOptions(answer: AskAnswer): void {
  const reserved =
    answer.shape === 'choice' ? answer.options.filter((o) => stewardDecisionOf(o.id)) : [];
  if (reserved.length === 0) return;
  throw refuseQuestion(
    'QUESTION_OPTIONS_STEWARDS',
    `${reserved.map((o) => o.id).join(', ')} ${reserved.length === 1 ? 'is' : 'are'} the steward's decisions, which act when answered: only the steward asks them, through POST /api/projects/:id/steward-runs/:runId/decisions. Give your options ids of their own`,
    '/options',
  );
}
