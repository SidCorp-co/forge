import type { ProposeDuplicate } from '../requirements/index.js';
import { createSuggestion } from './propose.js';

/** requirements' `proposeDuplicate` port: the near-duplicate an agree met, filed as a duplicate suggestion. */
export const proposeRequirementDuplicate: ProposeDuplicate = async (i) => {
  const out = await createSuggestion({
    projectId: i.projectId,
    actor: i.actor,
    producerKind: i.actor.agency === 'agent' ? 'agent' : 'person',
    producerId: i.actor.userId,
    kind: 'duplicate',
    target: { requirement: i.requirementId },
    baseRevision: i.baseRevision,
    payload: { duplicateOf: i.duplicateOf, similarity: i.similarity },
  });
  return out.ok
    ? { ok: true, id: out.suggestion.id }
    : { ok: false, refused: out.refusals.map((r) => `${r.code}: ${r.detail}`).join('; ') };
};
