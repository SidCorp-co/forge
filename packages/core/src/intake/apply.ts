/**
 * Where an intake draft lands (REQ-34 BC-4, BC-13): a requirement's open draft gets its empty
 * fields filled, each stated as an assumption naming its source; a feedback item gets its triage
 * checklist proposed as a `feedback_triage` suggestion by the BA assistant. A refusal is kept as
 * what was applied, never thrown, so the draft itself is still kept on the item.
 *
 * How the value check ended lands too (REQ-65 BC-2, REQ-66 BC-2): a refused requirement moves to
 * `refused` with its reason, one that repeats another is proposed as its duplicate, and a feedback
 * item's triage follows the check, its decline noting the reason; a held check proposes no triage
 * until its question is answered.
 */

import { FEEDBACK_TRIAGE_CHECKLIST } from '@forge/contracts/checklist-registry';
import { evaluateChecklist, parseAnswers, type RecordAnswers } from '@forge/contracts/checklists';
import type { FeedbackKind } from '@forge/contracts/feedback';
import {
  criterionAnswerOf,
  TRIAGE_ROUTE_QUESTION,
  triageAnswersOf,
  triageDerivedOf,
} from '@forge/contracts/feedback-triage';
import {
  INTAKE_FIELDS,
  type IntakeDraftApplied,
  intakeRefOf,
  type ValueEffect,
} from '@forge/contracts/intake-drafts';
import { SUGGESTION_PAYLOADS } from '@forge/contracts/suggestions';
import { db } from '../db/client.js';
import { feedbackTriageRecord } from '../feedback/index.js';
import { RefusalError } from '../lib/refusal.js';
import { type DraftGapFill, fillDraftGaps, refuseOnValueIn } from '../requirements/index.js';
import { createSuggestion } from '../suggestions/index.js';
import type { IntakeItem } from './reads.js';
import type { JudgedDraft } from './rules.js';

const faultsOf = (faults: readonly string[]): string | null =>
  faults.length ? faults.slice(0, 6).join('; ') : null;

const objectOf = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/**
 * A proposed triage judged as its accept judges it: the feedback_triage payload's own schema, then
 * the checklist answers it hands the triage over what the item's record answers already (REQ-34
 * BC-2; `feedback/recording-tool.ts:proposalGaps` judges an assistant's proposal the same way). A
 * proposal its approver could only be refused for is refused here, so the retry drafts the missing
 * answers. Whether a named criterion stands on the item's requirement is left to the accept.
 */
export function triageFaultOver(record: RecordAnswers) {
  return (triage: unknown): string | null => {
    const parsed = SUGGESTION_PAYLOADS.feedback_triage.schema.safeParse(triage);
    if (!parsed.success) {
      return faultsOf(
        parsed.error.issues.map((i) => `${i.path.join('.') || 'triage'}: ${i.message}`),
      );
    }
    const { route, kind, answers } = parsed.data;
    if (route === 'decline') {
      return answers === undefined ? null : 'answers: a decline asks no checklist questions';
    }
    const given = objectOf(answers);
    if (given && Object.hasOwn(given, TRIAGE_ROUTE_QUESTION)) {
      return "answers.route: the route is the triage's own field, not an answer";
    }
    const criterion = given?.criterion;
    if (typeof criterion === 'string' && criterion.trim() && !criterionAnswerOf(criterion)) {
      return `answers.criterion: "${criterion.slice(0, 80)}" is not REQ-n BC-m or none`;
    }
    const recorded = record.kind && 'value' in record.kind ? record.kind.value : undefined;
    const sent = parseAnswers(FEEDBACK_TRIAGE_CHECKLIST, triageAnswersOf({ route, answers }));
    if (!sent.ok) return faultsOf(sent.refusals.map((r) => `answers: ${r.detail}`));
    const derived = triageDerivedOf({ kind: (kind ?? recorded) as FeedbackKind, route, answers });
    const { gaps } = evaluateChecklist(FEEDBACK_TRIAGE_CHECKLIST, {
      given: sent.answers,
      record,
      derived,
    });
    return faultsOf(gaps.map((g) => `answers: ${g.detail}`));
  };
}

/** `item`'s triage judge: a feedback item's own record is read once, before the model is asked. */
export async function triageJudgeFor(
  item: IntakeItem,
): Promise<(triage: unknown) => string | null> {
  return triageFaultOver(item.kind === 'feedback' ? await feedbackTriageRecord(db, item.id) : {});
}

/** A refusal kept as what was applied: its first code and detail. */
function noneOf(err: unknown): { as: 'none'; code: string; detail: string } {
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

/** How a requirement's value check ended, written where its flow reads it. */
async function valueToRequirement(
  item: IntakeItem,
  draft: JudgedDraft,
  model: string | null,
): Promise<ValueEffect | null> {
  const outcome = draft.value.outcome;
  if (outcome?.kind === 'refuse') {
    const out = await db.transaction((tx) =>
      refuseOnValueIn(tx, {
        projectId: item.projectId,
        requirementId: item.id,
        reason: outcome.reason,
      }),
    );
    return out.moved
      ? { as: 'refused' }
      : {
          as: 'none',
          code: 'VALUE_CHECK_NOT_DRAFT',
          detail: `${item.key} is ${out.status}; the value check refuses only a draft`,
        };
  }
  if (outcome?.kind !== 'merge') return null;
  try {
    const out = await createSuggestion({
      projectId: item.projectId,
      actor: { userId: item.authorId, agency: item.authorAgency },
      producerKind: 'ba_assistant',
      producerId: null,
      kind: 'duplicate',
      target: { requirement: item.key },
      payload: { duplicateOf: outcome.into.key, note: outcome.why },
      model,
    });
    if (out.ok) return { as: 'suggestion', suggestionId: out.suggestion.id };
    const [first] = out.refusals;
    return { as: 'none', code: first?.code ?? 'SUGGESTION_REFUSED', detail: first?.detail ?? '' };
  } catch (err) {
    return noneOf(err);
  }
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

/** A refused item's decline carries the check's reason where the triage gives no note of its own. */
function triageOf(draft: JudgedDraft): unknown {
  const outcome = draft.value.outcome;
  const triage = objectOf(draft.triage);
  if (outcome?.kind !== 'refuse' || !triage) return draft.triage;
  const note = typeof triage.note === 'string' && triage.note.trim() ? triage.note : outcome.reason;
  return { ...triage, note };
}

async function applyToFeedback(
  item: IntakeItem,
  draft: JudgedDraft,
  model: string | null,
): Promise<IntakeDraftApplied> {
  if (draft.value.outcome === null) {
    return {
      as: 'none',
      code: 'VALUE_CHECK_HELD',
      detail: 'a question holds the value check, so its triage waits for the answer',
    };
  }
  try {
    const out = await createSuggestion({
      projectId: item.projectId,
      actor: { userId: item.authorId, agency: item.authorAgency },
      producerKind: 'ba_assistant',
      producerId: null,
      kind: 'feedback_triage',
      target: { feedback: item.key },
      payload: triageOf(draft),
      model,
    });
    if (out.ok) return { as: 'suggestion', suggestionId: out.suggestion.id };
    const [first] = out.refusals;
    return { as: 'none', code: first?.code ?? 'SUGGESTION_REFUSED', detail: first?.detail ?? '' };
  } catch (err) {
    // the reporter's own permissions bound what the assistant proposes for them: a refusal is kept
    return noneOf(err);
  }
}

/** Writes `draft` where `item`'s own flow reads it, and says what was written: its fills or triage, then its value check. */
export async function applyDraft(
  item: IntakeItem,
  draft: JudgedDraft,
  model: string | null,
): Promise<{ applied: IntakeDraftApplied; effect: ValueEffect | null }> {
  if (item.kind === 'feedback') {
    return { applied: await applyToFeedback(item, draft, model), effect: null };
  }
  // the draft is filled first, so a refused request a person keeps is already drafted
  const applied = await applyToRequirement(item, draft);
  return { applied, effect: await valueToRequirement(item, draft, model) };
}
