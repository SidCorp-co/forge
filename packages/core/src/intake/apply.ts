/**
 * Where an intake draft lands (REQ-34 BC-4, BC-13): a requirement's open draft gets its empty
 * fields filled, each stated as an assumption naming its source; a feedback item gets its triage
 * checklist proposed as a `feedback_triage` suggestion by the BA assistant. A refusal is kept as
 * what was applied, never thrown, so the draft itself is still kept on the item.
 */

import {
  INTAKE_FIELDS,
  type IntakeDraftApplied,
  intakeRefOf,
} from '@forge/contracts/intake-drafts';
import { SUGGESTION_PAYLOADS } from '@forge/contracts/suggestions';
import { RefusalError } from '../lib/refusal.js';
import { type DraftGapFill, fillDraftGaps } from '../requirements/index.js';
import { createSuggestion } from '../suggestions/index.js';
import type { IntakeItem } from './reads.js';
import type { JudgedDraft } from './rules.js';

/** The feedback_triage payload's own schema, so a draft is judged by what the suggestion takes. */
export function triageFault(triage: unknown): string | null {
  const parsed = SUGGESTION_PAYLOADS.feedback_triage.schema.safeParse(triage);
  return parsed.success
    ? null
    : parsed.error.issues
        .slice(0, 6)
        .map((i) => `${i.path.join('.') || 'triage'}: ${i.message}`)
        .join('; ');
}

async function applyToRequirement(
  item: IntakeItem,
  draft: JudgedDraft,
): Promise<IntakeDraftApplied> {
  const fields: readonly string[] = INTAKE_FIELDS.requirement;
  const fills = draft.assumptions
    .filter((a) => fields.includes(a.field))
    .map(
      (a) => ({ field: a.field, value: a.value, source: intakeRefOf(a.source) }) as DraftGapFill,
    );
  const out = await fillDraftGaps({ projectId: item.projectId, requirementId: item.id, fills });
  return out.ok
    ? { as: 'revision', revision: out.revision, fields: out.fields }
    : { as: 'none', code: out.code, detail: out.detail };
}

async function applyToFeedback(
  item: IntakeItem,
  draft: JudgedDraft,
  model: string | null,
): Promise<IntakeDraftApplied> {
  try {
    const out = await createSuggestion({
      projectId: item.projectId,
      actor: { userId: item.authorId, agency: item.authorAgency },
      producerKind: 'ba_assistant',
      producerId: null,
      kind: 'feedback_triage',
      target: { feedback: item.key },
      baseRevision: null,
      payload: draft.triage,
      model,
    });
    if (out.ok) return { as: 'suggestion', suggestionId: out.suggestion.id };
    const [first] = out.refusals;
    return { as: 'none', code: first?.code ?? 'SUGGESTION_REFUSED', detail: first?.detail ?? '' };
  } catch (err) {
    // the reporter's own permissions bound what the assistant proposes for them: a refusal is kept
    if (err instanceof RefusalError) {
      const [first] = err.refusals;
      return {
        as: 'none',
        code: first?.code ?? err.fallbackCode,
        detail: first?.detail ?? err.message,
      };
    }
    throw err;
  }
}

/** Writes `draft` where `item`'s own flow reads it, and says what was written. */
export function applyDraft(
  item: IntakeItem,
  draft: JudgedDraft,
  model: string | null,
): Promise<IntakeDraftApplied> {
  return item.kind === 'requirement'
    ? applyToRequirement(item, draft)
    : applyToFeedback(item, draft, model);
}
