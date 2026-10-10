/**
 * The triage checklist's rules as pure functions over what the triage read (Feedback lifecycle r14
 * triage-check; Feedback triage r16 check and decide): the answers' own shape, the criterion they
 * name, and the route the short form allows (BC-6). The questions themselves are judged by the
 * kernel on the edge into triaged, or by `judgeRetriage` for an item triaged already, through the
 * same contract functions.
 */

import { FEEDBACK_TRIAGE_CHECKLIST, NO_CRITERION } from '@forge/contracts/checklist-registry';
import {
  type ChecklistEvaluation,
  checklistRefusals,
  type DerivedAnswer,
  evaluateChecklist,
  parseAnswers,
  type RecordAnswers,
} from '@forge/contracts/checklists';
import type { FeedbackKind, FeedbackRefusal, FeedbackTriageRoute } from '@forge/contracts/feedback';
import {
  criterionAnswerOf,
  isShortForm,
  namedCriterionOf,
  SHORT_FORM_ROUTES,
  TRIAGE_ROUTE_QUESTION,
} from '@forge/contracts/feedback-triage';
import type { Refusal } from '../lib/refusal.js';
import { refusal } from './rules.js';

const asObject = (answers: unknown): Record<string, unknown> | null =>
  typeof answers === 'object' && answers !== null && !Array.isArray(answers)
    ? (answers as Record<string, unknown>)
    : null;

/**
 * What the answers carry that the act does not take from them: the route, which is the act's own
 * `route`, and any answer at all on a decline, which carries only its reason.
 */
export function answersShapeRefusal(
  route: FeedbackTriageRoute | undefined,
  answers: unknown,
): FeedbackRefusal | null {
  if (answers === undefined) return null;
  if (route === 'decline') {
    return refusal(
      'CHECKLIST_ANSWER_INVALID',
      '/answers',
      'A decline is an act, not a route: it asks no checklist questions. Send its reason in note, without answers.',
    );
  }
  const given = asObject(answers);
  if (given && Object.hasOwn(given, TRIAGE_ROUTE_QUESTION)) {
    return refusal(
      'CHECKLIST_ANSWER_INVALID',
      `/answers/${TRIAGE_ROUTE_QUESTION}`,
      "The route is the triage's own field: send it as route, not inside answers.",
    );
  }
  return null;
}

/** A criterion answer that is neither "none" nor a REQ-n BC-m reference, refused by name. */
export function criterionTextRefusal(answers: unknown): FeedbackRefusal | null {
  const given = asObject(answers)?.criterion;
  if (typeof given !== 'string' || given.trim() === '') return null;
  if (criterionAnswerOf(given)) return null;
  return refusal(
    'FEEDBACK_CRITERION_INVALID',
    '/answers/criterion',
    `"${given.trim().slice(0, 80)}" names no criterion. Name it as REQ-n BC-m, such as REQ-12 BC-3, or answer "${NO_CRITERION}".`,
  );
}

/** The criterion a triage named, as core found it: standing now on its requirement, or not found. */
export type FoundCriterion =
  | { found: true; id: string; requirementId: string; requirementKey: string }
  | { found: false };

/**
 * A named criterion must stand at its requirement's current revision, and be one of the item's own
 * requirement where the item is about one: a criterion of another requirement says the item is
 * about that one, which a retarget says, not the triage.
 */
export function criterionFitRefusal(
  named: { requirement: string; code: string },
  found: FoundCriterion,
  item: { key: string; requirement: { id: string; key: string } | null },
): FeedbackRefusal | null {
  const ref = `${named.requirement} ${named.code}`;
  if (!found.found) {
    return refusal(
      'FEEDBACK_CRITERION_INVALID',
      '/answers/criterion',
      `${ref} is not a criterion of this project's current requirements. Name one that stands now, or answer "${NO_CRITERION}".`,
    );
  }
  if (item.requirement && item.requirement.id !== found.requirementId) {
    return refusal(
      'FEEDBACK_CRITERION_INVALID',
      '/answers/criterion',
      `${ref} is a criterion of ${found.requirementKey}, and ${item.key} is about ${item.requirement.key}. Name a criterion of ${item.requirement.key}, or retarget ${item.key} first.`,
    );
  }
  return null;
}

/** A bug against a named criterion takes the issue route on it, or is the duplicate of another (BC-6). */
export function shortFormRouteRefusal(
  kind: FeedbackKind,
  answers: unknown,
  route: FeedbackTriageRoute | undefined,
): FeedbackRefusal | null {
  if (route === undefined || route === 'decline' || !isShortForm(kind, answers)) return null;
  if ((SHORT_FORM_ROUTES as readonly string[]).includes(route)) return null;
  const named = namedCriterionOf(answers);
  return refusal(
    'FEEDBACK_ROUTE_TARGET_MISMATCH',
    '/route',
    `A bug against ${named?.requirement} ${named?.code} takes the issue route on it, not ${route}. Send route issue, or leave the route out.`,
  );
}

/**
 * The checklist judged for an item that is triaged already, whose re-triage moves along no edge:
 * the same parse and evaluation the kernel runs on the edge into triaged.
 */
export function judgeRetriage(
  answers: unknown,
  record: RecordAnswers,
  derived: Readonly<Record<string, DerivedAnswer>> = {},
): { evaluation: ChecklistEvaluation } | { refusals: Refusal[] } {
  const parsed = parseAnswers(FEEDBACK_TRIAGE_CHECKLIST, answers);
  if (!parsed.ok) return { refusals: parsed.refusals };
  const evaluation = evaluateChecklist(FEEDBACK_TRIAGE_CHECKLIST, {
    given: parsed.answers,
    record,
    derived,
  });
  return evaluation.complete ? { evaluation } : { refusals: checklistRefusals(evaluation) };
}
