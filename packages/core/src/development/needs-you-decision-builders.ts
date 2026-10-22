// The decisions the needs-me read builds, one per kind of record (REQ-41 BC-2): each with the
// question, the recommended answer and why, and the buttons that answer it, every button's path
// filled from `@forge/contracts/needs-you-decisions:DECISION_ACTS` so none posts to a path with a hole.
// The approve-group ones are `needs-you-approve-builders.ts`.

import type { NeedsYouAreaKey } from '@forge/contracts/needs-you';
import {
  type DecisionAct,
  type DecisionAnswer,
  decisionPath,
  type NeedsYouDecision,
} from '@forge/contracts/needs-you-decisions';
import { type QuestionSuggestion, suggestionFor } from '@forge/contracts/question-suggestion';
import {
  isStewardDecisionQuestion,
  STEWARD_DECISIONS_WITH_REASON,
  type StewardDecisionSubject,
  stewardDecisionEffect,
  stewardDecisionOf,
} from '@forge/contracts/steward';
import { type ChoiceStep, isChoiceStep, type QuestionStep } from '../db/schema-questions.js';
import type { OpenPersonQuestion } from '../questions/index.js';
import type { AttentionRow } from './needs-you.js';

const QUESTION_MAX = 2000;

/**
 * A decision as its record builds it; `decisionsOf` adds whether its item is stuck and when it falls
 * due, and its page group where the builder leaves it to the entity it decides.
 */
export type DecisionBody = Omit<NeedsYouDecision, 'id' | 'stuck' | 'dueAt' | 'topic' | 'proposal'> &
  Partial<Pick<NeedsYouDecision, 'id' | 'topic' | 'proposal'>>;
/** A decision, and the question it answers where it is one, so one question is one decision. */
export type Built = { decision: DecisionBody; questionId: string | null };

export const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

export function filled(
  act: DecisionAct,
  params: Record<string, string | number | undefined>,
): string {
  const path = decisionPath(act, params);
  if (!path.ok) {
    throw new Error(
      `needs-you: a ${act} button is missing ${path.missing.join(', ')}; a decision never posts to a path with a hole in it`,
    );
  }
  return path.path;
}

export function answer(
  over: Omit<DecisionAnswer, 'needsReason' | 'declines' | 'effect' | 'recommended' | 'body'> &
    Partial<Pick<DecisionAnswer, 'needsReason' | 'declines' | 'effect' | 'recommended' | 'body'>>,
): DecisionAnswer {
  return {
    needsReason: false,
    declines: false,
    effect: null,
    recommended: false,
    body: null,
    ...over,
  };
}

/**
 * A stuck item's decision the steward asked (REQ-48 BC-5): Forge's own options, each button saying
 * what answering it does to the item it names, keep, drop, withdraw and reopen taking the answerer's
 * reason, recommended by the steward with the one line it wrote into the prompt.
 */
function stewardDecision(
  base: Omit<DecisionBody, 'recommended' | 'noRecommendation' | 'answers'>,
  q: OpenPersonQuestion,
  step: ChoiceStep,
  path: string,
): Built {
  const kind: StewardDecisionSubject = q.issueId
    ? 'issue'
    : q.requirementId
      ? 'requirement'
      : 'feedback';
  const itemKey = base.opens?.key ?? base.key;
  const recommended = step.options.find((o) => o.id === step.recommendedOptionId);
  if (!recommended) {
    throw new Error(
      `needs-you: steward decision ${q.id} recommends ${step.recommendedOptionId}, which it does not offer`,
    );
  }
  const shown = [recommended, ...step.options.filter((o) => o.id !== recommended.id)];
  // an issue draft is offered open, link or requirement, a draft requirement merge or drop; a live
  // issue no master serves is kept or dropped, an agreed requirement's draft revision withdrawn
  const draft = shown.some((o) => {
    const d = stewardDecisionOf(o.id);
    return kind === 'issue'
      ? d === 'open' || d === 'link' || d === 'requirement'
      : kind === 'requirement' && (d === 'merge' || d === 'drop');
  });
  const tail = step.prompt.slice(step.prompt.lastIndexOf('Recommended: '));
  const at = tail.indexOf(', because ');
  const because = at < 0 ? '' : tail.slice(at + ', because '.length).trim();
  const lead = `The steward recommends "${clip(recommended.label, 200)}"`;
  return {
    questionId: q.id,
    decision: {
      ...base,
      recommended: {
        answerId: recommended.id,
        why: clip(because ? `${lead} because ${because}` : `${lead}.`, 600),
        by: 'steward',
      },
      noRecommendation: null,
      answers: shown.map((o) => {
        const decision = stewardDecisionOf(o.id);
        const effect = decision
          ? stewardDecisionEffect(decision, { kind, key: itemKey, draft, option: o.id })
          : null;
        return answer({
          id: o.id,
          label: clip(o.label, 120),
          act: 'question.answer',
          path,
          body: { round: step.round, optionId: o.id },
          effect,
          needsReason: decision !== null && STEWARD_DECISIONS_WITH_REASON.includes(decision),
          recommended: o.id === recommended.id,
        });
      }),
    },
  };
}

/** The one line a suggestion shows: the text, why, and the records it read. */
function suggestionWhy(text: string, why: string, from: readonly string[]): string {
  return clip(`"${clip(text, 320)}" ${why}${from.length ? ` (read ${from.join(', ')})` : ''}`, 600);
}

/** Why a round with no recommendation from its asker shows none, naming what the assistant's draft came to. */
function noRecommendationOf(
  suggestion: QuestionSuggestion | null,
  round: number,
  asked = 'The run that asked gave no recommended answer',
): string {
  if (!suggestion || suggestion.round !== round) {
    return `${asked}, and the assistant has not drafted one yet.`;
  }
  if (suggestion.outcome === 'failed') {
    return clip(
      `${asked}, and the assistant drafted none (${suggestion.code}): ${suggestion.detail}`,
      600,
    );
  }
  return `${asked}.`;
}

/**
 * A free-text round whose asker recommended nothing: the assistant's suggestion for this round where
 * it drafted one (REQ-41 BC-2), sent as it stands by one click; else the reason there is none.
 */
function unrecommendedDecision(
  base: Omit<DecisionBody, 'group' | 'recommended' | 'noRecommendation' | 'answers'> & {
    group: 'answer';
  },
  q: OpenPersonQuestion,
  step: QuestionStep,
  typed: DecisionAnswer,
  path: string,
): Built {
  const suggested = suggestionFor(q.suggestion, step.round);
  if (!suggested) {
    return {
      questionId: q.id,
      decision: {
        ...base,
        recommended: null,
        noRecommendation: noRecommendationOf(q.suggestion, step.round),
        answers: [typed],
      },
    };
  }
  return {
    questionId: q.id,
    decision: {
      ...base,
      recommended: {
        answerId: 'suggested',
        why: suggestionWhy(suggested.text, suggested.why, suggested.from),
        by: 'assistant',
      },
      noRecommendation: null,
      answers: [
        answer({
          id: 'suggested',
          label: 'Send the suggested answer',
          act: 'question.answer',
          path,
          body: { round: step.round, text: suggested.text },
          effect: "Sends the assistant's suggested answer, as written, to the run that asked.",
          recommended: true,
        }),
        typed,
      ],
    },
  };
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
  if (isChoiceStep(step) && isStewardDecisionQuestion(step.options)) {
    return stewardDecision(base, q, step, path);
  }
  if (isChoiceStep(step)) {
    const asked = step.options.find((o) => o.id === step.recommendedOptionId);
    const suggested = asked ? null : suggestionFor(q.suggestion, step.round);
    const suggestedOption = suggested?.optionId
      ? step.options.find((o) => o.id === suggested.optionId)
      : undefined;
    const recommended = asked ?? suggestedOption;
    const rest = step.options.filter((o) => o.id !== recommended?.id);
    const shown = [...(recommended ? [recommended] : []), ...rest].slice(0, 8);
    return {
      questionId: q.id,
      decision: {
        ...base,
        recommended: recommended
          ? asked
            ? {
                answerId: recommended.id,
                why: `Whoever asked recommends "${clip(recommended.label, 200)}".`,
                by: 'asker',
              }
            : {
                answerId: recommended.id,
                why: suggestionWhy(recommended.label, suggested?.why ?? '', suggested?.from ?? []),
                by: 'assistant',
              }
          : null,
        noRecommendation: recommended
          ? null
          : noRecommendationOf(
              q.suggestion,
              step.round,
              'The run that asked named a recommended option it did not offer',
            ),
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
  if (!step.recommended) return unrecommendedDecision(base, q, step, typed, path);
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

export function feedbackDecision(
  row: AttentionRow,
  area: NeedsYouAreaKey,
  projectId: string,
  answered: string | null,
  /** `fix`: a shipped fix the reporter verifies; `answer`: an answer they confirm. */
  settles: 'answer' | 'fix' = 'answer',
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
        settles === 'fix'
          ? `Is ${row.key} fixed in what shipped?`
          : answered
            ? `Does this answer settle ${row.key}? "${answered}"`
            : `Does the answer given on ${row.key} settle it?`,
        QUESTION_MAX,
      ),
      recommended: {
        answerId: 'verify',
        why:
          settles === 'fix'
            ? 'The work that carries it shipped; reopen it with a reason if the problem is still there.'
            : 'It was answered and nobody has reopened it; reopen it with a reason if the answer misses the point.',
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
          declines: true,
          effect: `${row.key} is reopened with your reason.`,
        }),
      ],
      touchedAt: row.touchedAt,
    },
  };
}
