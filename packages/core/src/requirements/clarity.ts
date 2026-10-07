/**
 * What a requirement still leaves unclear (JU-6): the open questions its revision's spec names, each
 * asked as a question on the requirement, and the questions its issues and runs named as about it.
 * A blocking open question refuses the agree (REQUIREMENT_OPEN_QUESTIONS).
 */

import { randomUUID } from 'node:crypto';
import type {
  RequirementAnswerView,
  RequirementOpenQuestion,
  RequirementQuestionPlace,
  RequirementQuestionView,
  RequirementSpec,
} from '@forge/contracts/requirements';
import type { Tx } from '../db/client.js';
import { peopleOf } from '../lib/people.js';
import {
  answeredOnIssuesOf,
  insertAskedQuestion,
  openAmong,
  questionsOnRequirement,
  type RequirementQuestionRow,
} from '../questions/index.js';
import { openQuestionsRefusalOf, type RequirementRefusal } from './rules.js';

/**
 * The spec as stored: each open question without an id is asked as a question on the requirement
 * and keeps the id it was asked as; one naming an id names a question on this requirement (asked of
 * it, or named as about it), or the write is refused by name.
 */
export async function withAskedQuestions(
  tx: Tx,
  input: { projectId: string; requirementId: string; spec: RequirementSpec },
): Promise<{ spec: RequirementSpec } | { refusals: RequirementRefusal[] }> {
  const entries = input.spec.openQuestions;
  if (!entries?.length) return { spec: input.spec };
  const known = new Set((await questionsOnRequirement(input.requirementId, tx)).map((q) => q.id));
  const refusals: RequirementRefusal[] = [];
  const asked: RequirementOpenQuestion[] = [];
  for (const [i, entry] of entries.entries()) {
    if (entry.questionId) {
      if (!known.has(entry.questionId)) {
        refusals.push({
          code: 'REQUIREMENT_OPEN_QUESTION_UNKNOWN',
          path: `/spec/openQuestions/${i}/questionId`,
          detail: `open question ${i + 1} names question ${entry.questionId}, which is neither asked of this requirement nor named as about it; leave questionId out to ask it here, or name a question this requirement lists.`,
        });
      }
      asked.push(entry);
      continue;
    }
    const q = await insertAskedQuestion(tx, {
      id: randomUUID(),
      projectId: input.projectId,
      requirementId: input.requirementId,
      prompt: entry.question,
      blockerKind: 'human',
      answer: { shape: 'free_text', needed: `The answer, from ${entry.whoAnswers}` },
    });
    asked.push({ ...entry, questionId: q.id });
  }
  if (refusals.length) return { refusals };
  return { spec: { ...input.spec, openQuestions: asked } };
}

/** The blocking open questions `spec` names that are still open; the agree is refused while any stands. */
export async function openQuestionsRefusal(
  tx: Tx,
  spec: RequirementSpec | null | undefined,
  revision: number,
): Promise<RequirementRefusal | null> {
  const ids = (spec?.openQuestions ?? []).flatMap((q) =>
    q.blocking && q.questionId ? [q.questionId] : [],
  );
  return openQuestionsRefusalOf(spec, await openAmong(ids, tx), revision);
}

function placeOf(row: RequirementQuestionRow): RequirementQuestionPlace {
  if (row.issue) return { kind: 'issue', key: row.issue.key, title: row.issue.title };
  return row.onRequirement ? { kind: 'requirement' } : { kind: 'run' };
}

/** The newest spec entry naming each question, read across revisions newest first. */
function entriesById(specs: readonly (RequirementSpec | null)[]) {
  const out = new Map<string, RequirementOpenQuestion>();
  for (const spec of specs)
    for (const q of spec?.openQuestions ?? [])
      if (q.questionId && !out.has(q.questionId)) out.set(q.questionId, q);
  return out;
}

/** The questions a requirement's page lists, open first, newest first within each. */
export async function questionViewsOf(
  tx: Tx,
  requirementId: string,
  specsNewestFirst: readonly (RequirementSpec | null)[],
  clarificationsWithheld: boolean,
): Promise<RequirementQuestionView[]> {
  const entries = entriesById(specsNewestFirst);
  // a BA clarification no spec names is the operational `requirement.clarification` surface, so a
  // reader its policy withholds that surface from does not get it through the requirement's read
  const rows = (await questionsOnRequirement(requirementId, tx)).filter(
    (r) => !(clarificationsWithheld && r.onRequirement && !entries.has(r.id)),
  );
  const people = await peopleOf(rows.map((r) => r.answer?.by ?? null));
  const views = rows.map((r) => {
    const entry = entries.get(r.id);
    return {
      id: r.id,
      prompt: r.prompt,
      status: r.status,
      place: placeOf(r),
      whoAnswers: entry?.whoAnswers ?? null,
      blocking: entry?.blocking ?? false,
      round: r.round,
      askedAt: r.askedAt,
      answer: r.answer
        ? {
            text: r.answer.text,
            at: r.answer.at,
            by: r.answer.by ? (people.get(r.answer.by)?.name ?? null) : null,
          }
        : null,
    };
  });
  return [...views.filter((v) => v.status === 'open'), ...views.filter((v) => v.status !== 'open')];
}

/** The answered questions its Decisions tab rolls up: on it, about it, and on its issues, newest first. */
export async function answerViewsOf(
  tx: Tx,
  requirementId: string,
  clarificationsWithheld: boolean,
): Promise<RequirementAnswerView[]> {
  const [own, onIssues] = await Promise.all([
    questionsOnRequirement(requirementId, tx),
    answeredOnIssuesOf(requirementId, tx),
  ]);
  const seen = new Set<string>();
  const answered = [...own, ...onIssues].filter((r) => {
    if (!r.answer || seen.has(r.id) || (clarificationsWithheld && r.onRequirement)) return false;
    seen.add(r.id);
    return true;
  });
  const people = await peopleOf(answered.map((r) => r.answer?.by ?? null));
  return answered
    .map((r) => {
      const a = r.answer as NonNullable<RequirementQuestionRow['answer']>;
      return {
        questionId: r.id,
        prompt: r.prompt,
        answer: a.text,
        answeredAt: a.at,
        answeredBy: a.by ? (people.get(a.by)?.name ?? null) : null,
        place: placeOf(r),
      };
    })
    .sort((a, b) => b.answeredAt.localeCompare(a.answeredAt));
}
