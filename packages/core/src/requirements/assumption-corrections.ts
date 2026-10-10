// Whether each assumption the intake assistant filled still stands (REQ-34 BC-26), read on every
// revision view: no write marks it, the revision's own fields decide.
import type { RequirementSpec } from '@forge/contracts/requirements';
import type { DraftGapField } from './draft-gaps.js';

/**
 * Each assumption the assistant filled, marked `corrected` where the revision no longer holds its
 * value in the field it filled (REQ-34 BC-26): the author's later edit corrected it. An assumption
 * a person wrote, naming no field, is read as written.
 */
export function withCorrections(
  draft: { tldr: string | null; spec: RequirementSpec },
  liveBodies: readonly string[],
): RequirementSpec {
  const list = draft.spec.assumptions;
  if (!list?.length) return draft.spec;
  const holds = (field: string, value: string): boolean => {
    switch (field as DraftGapField) {
      case 'summary':
        return draft.tldr === value;
      case 'goal':
        return draft.spec.goal === value;
      case 'persona':
        return draft.spec.personas?.includes(value) ?? false;
      case 'in_scope':
        return draft.spec.scopeIn?.includes(value) ?? false;
      case 'out_of_scope':
        return draft.spec.scopeOut?.includes(value) ?? false;
      case 'criterion':
        return liveBodies.includes(value);
      default:
        return true;
    }
  };
  return {
    ...draft.spec,
    assumptions: list.map((a) =>
      a.field && a.value !== undefined ? { ...a, corrected: !holds(a.field, a.value) } : a,
    ),
  };
}
