// A decision unanswered for 14 days (REQ-68 BC-8). Where it holds up a requirement, the agent proposes
// deferring the requirement or dropping it: its decision leads with those two answers and recommends
// the defer. Where it holds up none, the agent proposes its own answer that declines the item (a
// return, a reject, a steward drop), recommended with why. The decision's own answers stay, so the
// person can still answer it; one offering no decline has nothing to propose and is left as built.

import type { NeedsYouAreaKey } from '@forge/contracts/needs-you';
import {
  type DecisionAnswer,
  type NeedsYouDecision,
  questionDecisionId,
} from '@forge/contracts/needs-you-decisions';
import type { OpenPersonQuestion } from '../questions/index.js';
import { DECLINE_OPTION_IDS, ESCALATE_AFTER_DAYS, escalationActs } from '../questions/index.js';
import type { AttentionRow } from './needs-you.js';
import {
  answer,
  type Built,
  clip,
  type DecisionBody,
  filled,
  prefilledReason,
  questionDecision,
} from './needs-you-decision-builders.js';

const ANSWERS_MAX = 8;

/** The answer that declines a decision's item: one marked declining, else a steward drop or withdraw. */
export function declineOf(d: Pick<DecisionBody, 'answers'>): DecisionAnswer | undefined {
  const own: ReadonlySet<string> = new Set(DECLINE_OPTION_IDS);
  return d.answers.find((a) => a.declines) ?? d.answers.find((a) => own.has(a.id));
}

/**
 * The decision with the agent's day-14 proposal of its own decline, recommended with why and first
 * among its answers; as built where it offers no decline. The why is prefilled where the answer
 * takes a reason, so the proposal is one press (BC-2).
 */
export function declineProposed<T extends DecisionBody>(d: T): T {
  const decline = declineOf(d);
  if (!decline) return d;
  return prefilledReason({
    ...d,
    recommended: {
      answerId: decline.id,
      why: `No answer in ${ESCALATE_AFTER_DAYS} days, so the agent proposes "${clip(decline.label, 120)}" until someone decides otherwise.`,
      by: 'rule',
    },
    noRecommendation: null,
    answers: [
      { ...decline, recommended: true },
      ...d.answers.filter((a) => a.id !== decline.id).map((a) => ({ ...a, recommended: false })),
    ],
  });
}

/** Whether a decision touched at `touchedAt` has waited the days the agent proposes after. */
export const waitedToPropose = (touchedAt: string | null, now: Date): boolean =>
  touchedAt !== null && now.getTime() - Date.parse(touchedAt) >= ESCALATE_AFTER_DAYS * DAY_MS;

const DAY_MS = 86_400_000;

/** The decision with the agent's day-14 proposal added, or as built where there is none to make. */
export function withEscalation(
  built: Built,
  escalated: OpenPersonQuestion['escalated'],
  projectId: string,
): Built {
  if (!escalated) return built;
  const acts = escalated.requirement ? escalationActs(escalated.requirement.status) : [];
  if (!escalated.requirement || acts.length === 0) {
    return { ...built, decision: declineProposed(built.decision) };
  }
  const { key } = escalated.requirement;
  const params = { projectId, key };
  const why = `No answer in ${ESCALATE_AFTER_DAYS} days, so the agent proposes deferring ${key} until someone can answer.`;
  const proposed = [
    ...(acts.includes('requirement.defer')
      ? [
          answer({
            id: 'escalation.defer',
            label: `Defer ${key}`,
            act: 'requirement.defer',
            path: filled('requirement.defer', params),
            body: {},
            needsReason: true,
            effect: `${key} leaves the current release and waits as deferred.`,
            recommended: true,
          }),
        ]
      : []),
    ...(acts.includes('requirement.drop')
      ? [
          answer({
            id: 'escalation.drop',
            label: `Drop ${key}`,
            act: 'requirement.drop',
            path: filled('requirement.drop', params),
            body: {},
            needsReason: true,
            declines: true,
            effect: `${key} is dropped and will not be built.`,
            recommended: !acts.includes('requirement.defer'),
          }),
        ]
      : []),
  ];
  const lead = proposed.find((a) => a.recommended);
  const d = built.decision;
  return {
    ...built,
    decision: {
      ...d,
      changes: `Whether ${key} waits on this answer, leaves the current release, or is dropped`,
      impact: `${key} has waited ${ESCALATE_AFTER_DAYS} days on this; an answer lets it go on.`,
      recommended: lead
        ? {
            answerId: lead.id,
            why:
              lead.act === 'requirement.defer'
                ? why
                : `No answer in ${ESCALATE_AFTER_DAYS} days, and ${key} cannot be deferred from where it stands.`,
            by: 'rule',
          }
        : d.recommended,
      noRecommendation: lead ? null : d.noRecommendation,
      answers: [...proposed, ...d.answers.map((a) => ({ ...a, recommended: false }))].slice(
        0,
        ANSWERS_MAX,
      ),
    },
  };
}

/**
 * A question's decision, with the agent's day-14 proposal where the round has waited that long. Its
 * id is the question's, whichever answers it offers, so a link to the question opens its decision.
 */
export const asked = (
  row: AttentionRow,
  area: NeedsYouAreaKey,
  q: OpenPersonQuestion,
  opens: NeedsYouDecision['opens'],
  projectId: string,
): Built => {
  const built = withEscalation(questionDecision(row, area, q, opens), q.escalated, projectId);
  return { ...built, decision: { ...built.decision, id: questionDecisionId(q.id) } };
};
