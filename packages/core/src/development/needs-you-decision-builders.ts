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
import { say, sayEn } from '@forge/contracts/said';
import {
  isStewardDecisionQuestion,
  STEWARD_DECISIONS_WITH_REASON,
  type StewardDecisionSubject,
  stewardDecisionEffect,
  stewardDecisionOf,
  stewardDecisionQuestion,
  stewardMergeOf,
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

/** `text` cut to `max` at the last whitespace before it, its line breaks kept: never mid-word. */
export function clipAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max - 1);
  const space = head.search(/\s\S*$/);
  return `${(space > 0 ? head.slice(0, space) : head).trimEnd()}…`;
}

/** The room a free-text round's need keeps in its question, however long its prompt. */
const NEED_MAX = 1200;

/**
 * A free-text round's question: what was asked, then what answers it, as the asker wrote both (REQ-68
 * BC-1). The need is where an asker lists the choices it weighs, so it is part of what every surface
 * draws at every width, said once, never a button's hover title cut at 200 characters (K98, ISS-673).
 */
function askedWithNeed(asked: string, needed: string): string {
  const need = needed.trim();
  if (!need) return clipAtWord(asked, QUESTION_MAX);
  const line = `What answers it: ${clipAtWord(need, NEED_MAX)}`;
  return `${clipAtWord(asked, QUESTION_MAX - line.length - 2)}\n\n${line}`;
}

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

/**
 * A reason is asked only where a rule needs one, prefilled from the recommendation (REQ-68 BC-2):
 * the recommended answer that takes a reason carries the recommendation's why in its body, which the
 * person sends as it stands or edits. Every other answer that takes one asks for the person's own.
 * A typed free-text answer is the answer itself, never prefilled.
 */
export function prefilledReason<T extends Pick<DecisionBody, 'answers' | 'recommended'>>(d: T): T {
  const why = d.recommended?.why;
  if (!why) return d;
  return {
    ...d,
    answers: d.answers.map((a) => {
      if (!a.recommended || !a.needsReason) return a;
      const body: Record<string, unknown> = { ...(a.body ?? {}) };
      if (a.act !== 'question.answer') body.reason = why;
      else if ('optionId' in body) body.note = why;
      else return a;
      return { ...a, body };
    }),
  };
}

/**
 * What waits on a decision, the first half of its impact (REQ-68 BC-1): its item stuck until it is
 * decided, due on a day, or waiting on it.
 */
export function waitsOn(row: Pick<AttentionRow, 'key' | 'due'>, item: string = row.key): string {
  if (row.due?.stuck) return `${item} is stuck until this is decided`;
  if (row.due?.dueAt) return `${item} is due ${row.due.dueAt.slice(0, 10)}`;
  return `${item} waits on this`;
}

/** A decision's impact: what waits on it, then what follows once it is decided, in one line. */
export const impactOf = (
  row: Pick<AttentionRow, 'key' | 'due'>,
  follows: string,
  item: string = row.key,
): string => clip(`${waitsOn(row, item)}; ${follows}.`, 300);

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
 * A stuck item's decision the steward asked (REQ-48 BC-5), drawn from the round's structured fields
 * alone (REQ-48 r3 BC-14): the question is the one sentence its options make
 * (`stewardDecisionQuestion`), never the stored prompt, so a round asked before the prompt was one
 * sentence reads the same as one asked after; the reason is the round's own `why` (migration 0516
 * carried it out of the older prompts once), said once. Each button says what answering it does to
 * the item it names; keep, drop, withdraw and reopen take the answerer's reason. A merge is offered
 * only where the round names what the two items share (BC-16): one asked before that rule, naming
 * nothing, is left off the buttons, and where it was the recommended one the decision says why it
 * recommends none.
 */
function stewardDecision(
  base: Omit<DecisionBody, 'recommended' | 'noRecommendation' | 'answers'>,
  q: OpenPersonQuestion,
  step: ChoiceStep,
  path: string,
  waits: string,
): Built {
  const kind: StewardDecisionSubject = q.issueId
    ? 'issue'
    : q.requirementId
      ? 'requirement'
      : 'feedback';
  const itemKey = base.opens?.key ?? base.key;
  const offered = step.options.filter((o) => !stewardMergeOf(o.id) || o.shares?.trim());
  const recommended = offered.find((o) => o.id === step.recommendedOptionId);
  if (!recommended && !step.options.some((o) => o.id === step.recommendedOptionId)) {
    throw new Error(
      `needs-you: steward decision ${q.id} recommends ${step.recommendedOptionId}, which it does not offer`,
    );
  }
  const shown = recommended
    ? [recommended, ...offered.filter((o) => o.id !== recommended.id)]
    : offered;
  // an issue draft is offered open, link or requirement, a draft requirement merge or drop; a live
  // issue no master serves is kept or dropped, an agreed requirement's draft revision withdrawn
  const draft = step.options.some((o) => {
    const d = stewardDecisionOf(o.id);
    return kind === 'issue'
      ? d === 'open' || d === 'link' || d === 'requirement'
      : kind === 'requirement' && (d === 'merge' || d === 'drop');
  });
  const item = { kind, draft };
  return {
    questionId: q.id,
    decision: {
      ...base,
      ...stewardBrief(kind, draft, itemKey, waits),
      question: stewardDecisionQuestion(
        shown.map((o) => o.id),
        item,
      ),
      recommended: recommended
        ? {
            answerId: recommended.id,
            why: clip(step.why?.trim() || 'The steward recorded no reason with it.', 600),
            by: 'steward',
          }
        : null,
      noRecommendation: recommended
        ? null
        : `The steward recommended merging into ${stewardMergeOf(step.recommendedOptionId)?.into ?? 'another item'} without naming what the two share, so that merge is not offered.`,
      answers: shown.map((o) => {
        const decision = stewardDecisionOf(o.id);
        const effect = decision
          ? stewardDecisionEffect(decision, {
              ...item,
              key: itemKey,
              option: o.id,
              shares: o.shares ?? null,
            })
          : null;
        return answer({
          id: o.id,
          label: clip(o.label, 120),
          act: 'question.answer',
          path,
          body: { round: step.round, optionId: o.id },
          effect,
          needsReason: decision !== null && STEWARD_DECISIONS_WITH_REASON.includes(decision),
          recommended: o.id === recommended?.id,
        });
      }),
    },
  };
}

/** What a steward decision changes and its impact, by the item it decides (REQ-68 BC-1). */
function stewardBrief(
  kind: StewardDecisionSubject,
  draft: boolean,
  key: string,
  waits: string,
): { changes: string; impact: string } {
  if (kind === 'issue') {
    return draft
      ? {
          changes: `Whether draft ${key} becomes open work`,
          impact: clip(`${waits}; only open work is planned and built.`, 300),
        }
      : {
          changes: `Whether ${key} stays open work`,
          impact: clip(`${waits}; no master serves it now.`, 300),
        };
  }
  if (kind === 'requirement') {
    return draft
      ? {
          changes: `Whether draft ${key} stays a requirement of its own`,
          impact: clip(`${waits}; its issues and criteria follow the answer.`, 300),
        }
      : {
          changes: `Whether ${key} keeps its draft revision`,
          impact: clip(`${waits}; delivery goes on reading its current revision.`, 300),
        };
  }
  return {
    changes: `How ${key} is handled`,
    impact: clip(`${waits}; its reporter hears back once it is decided.`, 300),
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
    // a question asked on nothing is titled by its prompt, which the question already says (REQ-48 r3 BC-14)
    title: row.entity === 'question' ? sayEn(say('needsYou.title.question')) : clip(row.title, 500),
    opens,
    question: isChoiceStep(step)
      ? clip(step.prompt.trim() || row.title || 'A run asked a question', QUESTION_MAX)
      : askedWithNeed(step.prompt.trim() || row.title || 'A run asked a question', step.needed),
    changes: `What the run that asked ${opens ? `on ${opens.key} ` : ''}goes on with`,
    impact: impactOf(row, 'it goes on once it has your answer', opens?.key ?? 'The run that asked'),
    touchedAt: q.at,
    // what the question is about, so the person answering never asks which requirement (ISS-583)
    ...(q.subject ? { subject: q.subject } : {}),
  };
  if (isChoiceStep(step) && isStewardDecisionQuestion(step.options)) {
    return stewardDecision(base, q, step, path, waitsOn(row, base.opens?.key ?? row.key));
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
    effect: 'Sends what you write to the run that asked.',
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

const WHY_MAX = 600;

/** Why settling is recommended, carrying the answer given where there is one, clipped to the why's room. */
function feedbackWhy(settles: 'answer' | 'fix', answered: string | null): string {
  if (settles === 'fix') {
    return 'The work that carries it shipped; reopen it with a reason if the problem is still there.';
  }
  const rule = 'Nobody has reopened it; reopen it with a reason if the answer misses the point.';
  const given = answered?.trim();
  if (!given) return `It was answered. ${rule}`;
  const room = WHY_MAX - rule.length - 'The answer given: "". '.length;
  return `The answer given: "${clip(given.replace(/\s+/g, ' '), room)}". ${rule}`;
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
      // one sentence, the question alone: the answer it asks about is the why's, said there once (REQ-48 r3 BC-14)
      question:
        settles === 'fix'
          ? `Is ${row.key} fixed in what shipped?`
          : `Does the answer given on ${row.key} settle it?`,
      changes: `Whether ${row.key} is closed or reopened`,
      impact: impactOf(row, 'its reporter is told what you decide'),
      recommended: {
        answerId: 'verify',
        why: feedbackWhy(settles, answered),
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
