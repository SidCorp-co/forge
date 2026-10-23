// What an accept by decision waived (REQ-74): the acceptance checklist's answers of provenance
// `waived` (`checklists.ts:waivedEvaluation`), each by its question, the label a person reads and the
// gap's own words, so the accept that posts them and the read that shows them name one list.

import { REQUIREMENT_ACCEPTANCE_CHECKLIST } from '@forge/contracts/checklist-registry';
import type { ChecklistAnswer } from '@forge/contracts/checklists';
import { requirementKey } from '@forge/contracts/requirements';
import { recordRequirementDecisionIn } from '../comments/index.js';
import type { Tx } from '../db/client.js';
import type { RequirementActor } from './read.js';

export function waivedOf(
  evaluation: { readonly answers: readonly ChecklistAnswer[] } | null,
): { question: string; label: string; detail: string }[] {
  return (evaluation?.answers ?? [])
    .filter((a) => a.provenance === 'waived')
    .map((a) => {
      const q = REQUIREMENT_ACCEPTANCE_CHECKLIST.questions.find((x) => x.id === a.question);
      const label = q?.answeredBy.by === 'record' ? q.answeredBy.label : a.question;
      return { question: a.question, label, detail: a.value };
    });
}

/** The decision comment an accept by decision posts on the requirement, naming each item it waived. */
export async function postWaivedDecisionIn(
  tx: Tx,
  input: {
    projectId: string;
    requirementId: string;
    reqSeq: number;
    revision: number;
    actor: RequirementActor;
    reason: string;
    waived: readonly { label: string; detail: string }[];
  },
): Promise<void> {
  const items = input.waived.map((w) => `${w.label}: ${w.detail}`).join(' ');
  await recordRequirementDecisionIn(tx, {
    projectId: input.projectId,
    requirementId: input.requirementId,
    authorId: input.actor.userId,
    agency: input.actor.agency,
    decision: {
      decision: `Accepted ${requirementKey(input.reqSeq)} r${input.revision} by decision, waiving: ${items}`,
      reason: input.reason,
    },
  });
}
