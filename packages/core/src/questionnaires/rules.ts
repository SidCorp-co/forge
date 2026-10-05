/**
 * The guards of a questionnaire (workflow project-onboarding rev 1, steps `ask`, `answer-lands` and
 * `what-next`), as pure functions over what the service read: which items a batch may carry, how
 * many rounds a thread may send, which state a batch must be in to take answers, and whether each
 * answer fits its item. Who may post or submit is a permission.
 */

import {
  type OnboardingRefusal,
  QUESTIONNAIRE_MAX_ROUNDS,
  type QuestionnaireAnswer,
  type QuestionnaireItem,
  type QuestionnaireStatus,
} from '@forge/contracts/onboarding';
import { type PermissionFacts, permissionRefusal } from '../permissions/index.js';

type QuestionnaireRefusal = OnboardingRefusal;

const EVIDENCE = /^(\S+:\S+|(REQ|ISS|FB|BC)-\d+\b.*|design \S+.*|workflow \S+.*)$/;

const choiceControls = new Set(['choice', 'multi']);

// cm:guard each item is answerable as posted: ids unique, options only on choice and multi and two
// or more, a default naming one of them, a recommendation answered by accept or reject, and
// evidence that is a file:symbol or a Forge record (QUESTIONNAIRE_ITEM_INVALID)
export function itemRefusals(items: readonly QuestionnaireItem[]): QuestionnaireRefusal[] {
  const out: QuestionnaireRefusal[] = [];
  const seen = new Set<string>();
  items.forEach((item, i) => {
    const at = (field: string) => `/items/${i}${field}`;
    const bad = (field: string, detail: string) =>
      out.push({ code: 'QUESTIONNAIRE_ITEM_INVALID', path: at(field), detail });
    if (seen.has(item.id)) bad('/id', `item id "${item.id}" appears twice; each item has its own.`);
    seen.add(item.id);
    const options = item.options ?? [];
    if (choiceControls.has(item.control)) {
      if (options.length < 2)
        bad(
          '/options',
          `a ${item.control} item offers two or more options; "${item.id}" has ${options.length}.`,
        );
      const ids = new Set(options.map((o) => o.id));
      if (ids.size !== options.length) bad('/options', `the options of "${item.id}" repeat an id.`);
      if (item.inferredDefault !== undefined && !ids.has(item.inferredDefault))
        bad(
          '/inferredDefault',
          `the inferred default "${item.inferredDefault}" is not one of the options of "${item.id}" (${[...ids].join(', ')}).`,
        );
    } else {
      if (options.length > 0)
        bad(
          '/options',
          `a ${item.control} item takes no options; "${item.id}" lists ${options.length}.`,
        );
      if (item.inferredDefault !== undefined)
        bad(
          '/inferredDefault',
          `a ${item.control} item has no option to infer; drop inferredDefault on "${item.id}".`,
        );
    }
    if ((item.group === 'recommendation') !== (item.control === 'accept_reject'))
      bad(
        '/control',
        `a recommendation is answered by accept or reject, and only a recommendation is; "${item.id}" is a ${item.group} with control ${item.control}.`,
      );
    item.evidence.forEach((e, j) => {
      if (!EVIDENCE.test(e))
        bad(
          `/evidence/${j}`,
          `evidence "${e}" is neither a file:symbol (apps/api/src/x.ts:Thing) nor a Forge record (REQ-1 BC-6, ISS-4, FB-2, design <flow> step); a project with no code cites its records.`,
        );
    });
  });
  return out;
}

// cm:guard a follow-up carries only what stayed open: an item answered in an earlier round of the
// same series is not asked again (QUESTIONNAIRE_ITEM_ANSWERED_BEFORE), and a rejected
// recommendation is never suggested again (QUESTIONNAIRE_RECOMMENDATION_REJECTED)
export function repeatRefusals(
  items: readonly QuestionnaireItem[],
  answeredBefore: ReadonlySet<string>,
  rejectedBefore: ReadonlySet<string>,
): QuestionnaireRefusal[] {
  const out: QuestionnaireRefusal[] = [];
  items.forEach((item, i) => {
    if (rejectedBefore.has(item.id)) {
      out.push({
        code: 'QUESTIONNAIRE_RECOMMENDATION_REJECTED',
        path: `/items/${i}/id`,
        detail: `"${item.id}" was rejected in an earlier round of this thread; a rejected recommendation is recorded and not suggested again.`,
      });
    } else if (answeredBefore.has(item.id)) {
      out.push({
        code: 'QUESTIONNAIRE_ITEM_ANSWERED_BEFORE',
        path: `/items/${i}/id`,
        detail: `"${item.id}" was answered in an earlier round; a follow-up batch asks only what stayed open, plus new questions under new ids.`,
      });
    }
  });
  return out;
}

// cm:guard at most QUESTIONNAIRE_MAX_ROUNDS batches per series (QUESTIONNAIRE_ROUNDS_EXHAUSTED); after
// the third, open items stay listed on their designs as open questions
export function roundsRefusal(roundsSent: number): QuestionnaireRefusal | null {
  if (roundsSent < QUESTIONNAIRE_MAX_ROUNDS) return null;
  return {
    code: 'QUESTIONNAIRE_ROUNDS_EXHAUSTED',
    path: '',
    detail: `${roundsSent} of ${QUESTIONNAIRE_MAX_ROUNDS} rounds were sent; no fourth batch is asked. List what stays open on the designs as open questions instead.`,
  };
}

// cm:guard one open batch per thread (QUESTIONNAIRE_ALREADY_OPEN): a skipped batch still waits on its person
export function alreadyOpenRefusal(
  open: { id: string; round: number; status: QuestionnaireStatus } | null,
): QuestionnaireRefusal | null {
  if (!open) return null;
  return {
    code: 'QUESTIONNAIRE_ALREADY_OPEN',
    path: '',
    detail: `batch ${open.id} (round ${open.round}) is ${open.status} in this thread; a new batch waits until that one is answered or superseded by a re-analysis.`,
  };
}

interface BatchState {
  id: string;
  status: QuestionnaireStatus;
  round: number;
  submittedAt: Date | null;
  supersededAt: Date | null;
  supersededReason: string | null;
  supersededBy: string | null;
}

// cm:guard a batch is answered once: re-sending is QUESTIONNAIRE_ALREADY_ANSWERED, and an answer to a
// batch a re-analysis replaced is QUESTIONNAIRE_SUPERSEDED naming the batch that replaced it
export function submitStateRefusal(batch: BatchState, skip: boolean): QuestionnaireRefusal | null {
  if (batch.status === 'superseded') {
    const by = batch.supersededBy
      ? `batch ${batch.supersededBy} replaced it`
      : 'no batch has replaced it yet; the next one comes after the analysis';
    return {
      code: 'QUESTIONNAIRE_SUPERSEDED',
      path: '',
      detail: `batch ${batch.id} was superseded${batch.supersededAt ? ` at ${batch.supersededAt.toISOString()}` : ''} (${batch.supersededReason ?? 'superseded'}); ${by}. Answer that one.`,
    };
  }
  if (batch.status === 'submitted') {
    return {
      code: 'QUESTIONNAIRE_ALREADY_ANSWERED',
      path: '',
      detail: `batch ${batch.id} was answered${batch.submittedAt ? ` at ${batch.submittedAt.toISOString()}` : ''}; a batch is answered once. What stayed open comes back in the next round.`,
    };
  }
  if (skip && batch.status === 'skipped') {
    return {
      code: 'QUESTIONNAIRE_ALREADY_ANSWERED',
      path: '/skip',
      detail: `batch ${batch.id} is already skipped for now; answer it, or leave it.`,
    };
  }
  return null;
}

function fits(item: QuestionnaireItem, a: QuestionnaireAnswer): string | null {
  const given = (['choice', 'choices', 'text', 'decision'] as const).filter(
    (k) => a[k] !== undefined,
  );
  const field = {
    choice: 'choice',
    multi: 'choices',
    text: 'text',
    accept_reject: 'decision',
  }[item.control];
  if (given.length !== 1 || given[0] !== field)
    return `a ${item.control} item is answered with \`${field}\` alone; this answer gives ${given.length ? given.join(', ') : 'nothing'}.`;
  const ids = new Set((item.options ?? []).map((o) => o.id));
  if (item.control === 'choice' && !ids.has(a.choice as string))
    return `"${a.choice}" is not an option of "${item.id}" (${[...ids].join(', ')}).`;
  if (item.control === 'multi') {
    const picked = a.choices ?? [];
    const unknown = picked.filter((c) => !ids.has(c));
    if (unknown.length) return `${unknown.join(', ')} are not options of "${item.id}".`;
    if (new Set(picked).size !== picked.length) return `the choices for "${item.id}" repeat.`;
  }
  return null;
}

// cm:guard every answer names an item of the batch still open (QUESTIONNAIRE_ITEM_UNKNOWN), fits its
// control (QUESTIONNAIRE_ANSWER_INVALID), and a send answers at least one (QUESTIONNAIRE_NOTHING_ANSWERED);
// an unanswered item stays open and an inferred default is never applied for it
export function answerRefusals(
  items: ReadonlyMap<string, { item: QuestionnaireItem; open: boolean }>,
  answers: readonly QuestionnaireAnswer[],
  skip: boolean,
): QuestionnaireRefusal[] {
  const out: QuestionnaireRefusal[] = [];
  if (!skip && answers.length === 0) {
    out.push({
      code: 'QUESTIONNAIRE_NOTHING_ANSWERED',
      path: '/answers',
      detail:
        'a send answers at least one item; to leave them all for now, send { answers: [], skip: true }.',
    });
  }
  const seen = new Set<string>();
  answers.forEach((a, i) => {
    const at = `/answers/${i}`;
    const entry = items.get(a.itemId);
    if (!entry?.open) {
      out.push({
        code: 'QUESTIONNAIRE_ITEM_UNKNOWN',
        path: `${at}/itemId`,
        detail: entry
          ? `"${a.itemId}" is no longer open in this batch.`
          : `this batch holds no item "${a.itemId}"; its items are ${[...items.keys()].join(', ')}.`,
      });
      return;
    }
    if (seen.has(a.itemId)) {
      out.push({
        code: 'QUESTIONNAIRE_ANSWER_INVALID',
        path: `${at}/itemId`,
        detail: `"${a.itemId}" is answered twice in one send.`,
      });
      return;
    }
    seen.add(a.itemId);
    const miss = fits(entry.item, a);
    if (miss) out.push({ code: 'QUESTIONNAIRE_ANSWER_INVALID', path: at, detail: miss });
  });
  return out;
}

export const submitterRefusal = (facts: PermissionFacts): QuestionnaireRefusal | null =>
  permissionRefusal(facts, 'questionnaires.answer', 'answering a questionnaire');

export const posterRefusal = (facts: PermissionFacts): QuestionnaireRefusal | null =>
  permissionRefusal(facts, 'questionnaires.write', 'posting a questionnaire');

/** The thread a batch belongs to: an onboarding round, a requirement ask, or a first-requirements ask. */
export interface QuestionnaireArm {
  onboardingId: string | null;
  requirementId: string | null;
  firstRequirementsOf: string | null;
}

// cm:guard a batch names exactly one thread (QUESTIONNAIRE_THREAD_INVALID), the rule the
// questionnaire_batches_arc_chk constraint holds at the row
export function questionnaireArmRefusal(arm: QuestionnaireArm): QuestionnaireRefusal | null {
  const named = [arm.onboardingId, arm.requirementId, arm.firstRequirementsOf].filter(
    (v) => v !== null,
  ).length;
  if (named === 1) return null;
  return {
    code: 'QUESTIONNAIRE_THREAD_INVALID',
    path: '',
    detail: `a batch belongs to exactly one thread (an onboarding round, a requirement, or a first-requirements room); this one names ${named}.`,
  };
}

/** A BA room's answers come back to the BA as the person's next message; an onboarding round's go to its revise job. */
export const batchReopensRoom = (arm: QuestionnaireArm): boolean =>
  arm.requirementId !== null || arm.firstRequirementsOf !== null;
