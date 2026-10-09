// The decisions the needs-me read builds, one per kind of record (REQ-41 BC-2): each with the
// question, the recommended answer and why, and the buttons that answer it, every button's path
// filled from `@forge/contracts/needs-you-decisions:DECISION_ACTS` so none posts to a path with a hole.

import type { NeedsYouAreaKey } from '@forge/contracts/needs-you';
import {
  type DecisionAct,
  type DecisionAnswer,
  decisionPath,
  type NeedsYouDecision,
} from '@forge/contracts/needs-you-decisions';
import { isChoiceStep, type QuestionStep } from '../db/schema-questions.js';
import type { OpenPersonQuestion } from '../questions/index.js';
import type { AttentionRow } from './needs-you.js';

const QUESTION_MAX = 2000;

/** A decision, and the question it answers where it is one, so one question is one decision. */
export type Built = { decision: NeedsYouDecision; questionId: string | null };

export const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

function filled(act: DecisionAct, params: Record<string, string | number | undefined>): string {
  const path = decisionPath(act, params);
  if (!path.ok) {
    throw new Error(
      `needs-you: a ${act} button is missing ${path.missing.join(', ')}; a decision never posts to a path with a hole in it`,
    );
  }
  return path.path;
}

function answer(
  over: Omit<DecisionAnswer, 'needsReason' | 'effect' | 'recommended' | 'body'> &
    Partial<Pick<DecisionAnswer, 'needsReason' | 'effect' | 'recommended' | 'body'>>,
): DecisionAnswer {
  return { needsReason: false, effect: null, recommended: false, body: null, ...over };
}

/** A question's round as a decision: each option a button, or the recommended text and a typed answer. */
export function questionDecision(
  row: AttentionRow,
  area: NeedsYouAreaKey,
  q: OpenPersonQuestion,
  opens: NeedsYouDecision['opens'],
): Built {
  const step: QuestionStep = q.current;
  const path = filled('question.answer', { questionId: q.id });
  const base = {
    group: 'answer' as const,
    area,
    entity: row.entity,
    key: row.key,
    title: clip(row.title, 500),
    opens,
    question: clip(step.prompt.trim() || row.title || 'A run asked a question', QUESTION_MAX),
    touchedAt: q.at,
  };
  if (isChoiceStep(step)) {
    const recommended = step.options.find((o) => o.id === step.recommendedOptionId);
    const rest = step.options.filter((o) => o.id !== step.recommendedOptionId);
    const shown = [...(recommended ? [recommended] : []), ...rest].slice(0, 8);
    return {
      questionId: q.id,
      decision: {
        ...base,
        recommended: recommended
          ? {
              answerId: recommended.id,
              why: `Whoever asked recommends "${clip(recommended.label, 200)}".`,
              by: 'asker',
            }
          : null,
        noRecommendation: recommended
          ? null
          : 'The run that asked named a recommended option it did not offer.',
        answers: shown.map((o) =>
          answer({
            id: o.id,
            label: clip(o.label, 120),
            act: 'question.answer',
            path,
            body: { round: step.round, optionId: o.id },
            effect: 'Sends this answer to the run that asked.',
            recommended: o.id === recommended?.id,
          }),
        ),
      },
    };
  }
  const typed = answer({
    id: 'write',
    label: step.recommended ? 'Write another answer' : 'Write the answer',
    act: 'question.answer',
    path,
    body: { round: step.round },
    needsReason: true,
    effect: `Sends what you write to the run that asked. It needs: ${clip(step.needed, 200)}`,
  });
  if (!step.recommended) {
    return {
      questionId: q.id,
      decision: {
        ...base,
        recommended: null,
        noRecommendation: 'The run that asked gave no recommended answer.',
        answers: [typed],
      },
    };
  }
  return {
    questionId: q.id,
    decision: {
      ...base,
      recommended: {
        answerId: 'recommended',
        why: `Whoever asked recommends: ${clip(step.recommended, 500)}`,
        by: 'asker',
      },
      noRecommendation: null,
      answers: [
        answer({
          id: 'recommended',
          label: 'Send the recommended answer',
          act: 'question.answer',
          path,
          body: { round: step.round, text: step.recommended },
          effect: 'Sends the recommended answer to the run that asked.',
          recommended: true,
        }),
        typed,
      ],
    },
  };
}

export function revisionDecision(
  row: AttentionRow,
  area: NeedsYouAreaKey,
  projectId: string,
  n: number,
): Built {
  const params = { projectId: projectId, key: row.key, n };
  return {
    questionId: null,
    decision: {
      group: 'approve',
      area,
      entity: row.entity,
      key: row.key,
      title: clip(row.title, 500),
      opens: { kind: 'requirement', key: row.key },
      question: `Accept revision ${n} of ${row.key}, or return it to its author?`,
      recommended: {
        answerId: 'accept',
        why: `Its author proposed revision ${n} for sign-off; accept it unless its change summary is not what you asked for.`,
        by: 'rule',
      },
      noRecommendation: null,
      answers: [
        answer({
          id: 'accept',
          label: `Accept revision ${n}`,
          act: 'revision.accept',
          path: filled('revision.accept', params),
          body: {},
          effect: `Revision ${n} becomes the current revision of ${row.key}.`,
          recommended: true,
        }),
        answer({
          id: 'return',
          label: 'Return with a reason',
          act: 'revision.return',
          path: filled('revision.return', params),
          body: {},
          needsReason: true,
          effect: 'Sends it back to its author with your reason.',
        }),
      ],
      touchedAt: row.touchedAt,
    },
  };
}

export function agreeDecision(
  row: AttentionRow,
  area: NeedsYouAreaKey,
  projectId: string,
  head: number,
): Built {
  const params = { projectId: projectId, key: row.key };
  return {
    questionId: null,
    decision: {
      group: 'approve',
      area,
      entity: row.entity,
      key: row.key,
      title: clip(row.title, 500),
      opens: { kind: 'requirement', key: row.key },
      question: `Agree ${row.key} at revision ${head}, or drop it?`,
      recommended: {
        answerId: 'agree',
        why: 'Its linked designs are approved and it waits only on an agree; drop it with a reason if it should not be built.',
        by: 'rule',
      },
      noRecommendation: null,
      answers: [
        answer({
          id: 'agree',
          label: `Agree revision ${head}`,
          act: 'requirement.agree',
          path: filled('requirement.agree', params),
          body: { revision: head },
          effect: `${row.key} is agreed at revision ${head} and goes to delivery.`,
          recommended: true,
        }),
        answer({
          id: 'drop',
          label: 'Drop with a reason',
          act: 'requirement.drop',
          path: filled('requirement.drop', params),
          body: {},
          needsReason: true,
          effect: `${row.key} is dropped and will not be built.`,
        }),
      ],
      touchedAt: row.touchedAt,
    },
  };
}

export function releaseDecision(
  row: AttentionRow,
  area: NeedsYouAreaKey,
  projectId: string,
  release: { runId: string; failing: number; total: number },
  approvalId: string,
): Built {
  const params = { projectId: projectId, runId: release.runId, approvalId };
  const path = filled('release.decide', params);
  const clean = release.failing === 0;
  return {
    questionId: null,
    decision: {
      group: 'approve',
      area,
      entity: row.entity,
      key: row.key,
      title: clip(row.title, 500),
      opens: { kind: 'release', key: row.key },
      question: `Approve release ${row.key} for production, or return it to the master?`,
      recommended: {
        answerId: clean ? 'approve' : 'return',
        why: clean
          ? `None of the ${release.total} criteria it carries is failing.`
          : `${release.failing} of the ${release.total} criteria it carries are failing.`,
        by: 'rule',
      },
      noRecommendation: null,
      answers: [
        answer({
          id: 'approve',
          label: `Approve ${row.key}`,
          act: 'release.decide',
          path,
          body: { decision: 'approve' },
          effect: 'The release may go to production.',
          recommended: clean,
        }),
        answer({
          id: 'return',
          label: 'Return with a reason',
          act: 'release.decide',
          path,
          body: { decision: 'return' },
          needsReason: true,
          effect: 'The master is told why and does not take it to production.',
          recommended: !clean,
        }),
      ],
      touchedAt: row.touchedAt,
    },
  };
}

export function feedbackDecision(
  row: AttentionRow,
  area: NeedsYouAreaKey,
  projectId: string,
  answered: string | null,
): Built {
  const params = { projectId: projectId, key: row.key };
  return {
    questionId: null,
    decision: {
      group: 'verify',
      area,
      entity: row.entity,
      key: row.key,
      title: clip(row.title, 500),
      opens: { kind: 'feedback', key: row.key },
      question: clip(
        answered
          ? `Does this answer settle ${row.key}? "${answered}"`
          : `Does the answer given on ${row.key} settle it?`,
        QUESTION_MAX,
      ),
      recommended: {
        answerId: 'verify',
        why: 'It was answered and nobody has reopened it; reopen it with a reason if the answer misses the point.',
        by: 'rule',
      },
      noRecommendation: null,
      answers: [
        answer({
          id: 'verify',
          label: 'Yes, settled',
          act: 'feedback.verify',
          path: filled('feedback.verify', params),
          body: {},
          effect: `${row.key} is closed as settled.`,
          recommended: true,
        }),
        answer({
          id: 'reopen',
          label: 'No, reopen with a reason',
          act: 'feedback.reopen',
          path: filled('feedback.reopen', params),
          body: {},
          needsReason: true,
          effect: `${row.key} is reopened with your reason.`,
        }),
      ],
      touchedAt: row.touchedAt,
    },
  };
}
