// A round unanswered for 14 days that holds up a requirement (REQ-68 BC-8). The agent proposes
// deferring the requirement or dropping it. Its decision leads with those two answers and recommends
// the defer. The round's own answers stay, so the person can still answer it.

import type { NeedsYouAreaKey } from '@forge/contracts/needs-you';
import { type NeedsYouDecision, questionDecisionId } from '@forge/contracts/needs-you-decisions';
import type { OpenPersonQuestion } from '../questions/index.js';
import { ESCALATE_AFTER_DAYS, escalationActs } from '../questions/index.js';
import type { AttentionRow } from './needs-you.js';
import { answer, type Built, filled, questionDecision } from './needs-you-decision-builders.js';

const ANSWERS_MAX = 8;

/** The decision with the agent's day-14 proposal added, or as built where there is none to make. */
export function withEscalation(
  built: Built,
  escalated: { key: string; status: string } | null,
  projectId: string,
): Built {
  if (!escalated) return built;
  const acts = escalationActs(escalated.status);
  if (acts.length === 0) return built;
  const { key } = escalated;
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
