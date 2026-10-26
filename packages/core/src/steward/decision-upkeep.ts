// What the agent does for a decision nobody takes (REQ-68 BC-7, BC-8):
// - A decision whose item moved on is voided.
// - A round unanswered for 3 days reminds the people who owe it.
// - On day 14, the agent proposes deferring or dropping the requirement the round holds up (asked
//   of it, about it, or on an issue planned against it), recommending the defer; where it holds up
//   none, the drop its own options offer. A round offering neither has nothing to propose.
// Each step stamps the round, so it is taken once per round. Every other decision (a sign-off, a
// release, a design, a proposal) is aged by `decision-ages.ts`.

import { logger } from '../lib/logger.js';
import { emitNotification } from '../notifications/index.js';
import { namedHolders } from '../permissions/index.js';
import {
  type AgedRound,
  agedRounds,
  type DecisionAgeStamp,
  ESCALATE_AFTER_DAYS,
  escalationActs,
  proposable,
  REMIND_AFTER_DAYS,
  stampAgedRounds,
  sweepMovedDecisions,
} from '../questions/index.js';

const DAY_MS = 86_400_000;

/** The people who owe an answer: the project's writers, never an agent, never the asker. */
async function owingPeople(round: AgedRound): Promise<string[]> {
  const holders = await namedHolders('project.write', round.projectId);
  return holders.filter((h) => h.kind === 'human' && h.id !== round.askedBy).map((h) => h.id);
}

const clipped = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;

/** Tell the people who owe each round, then stamp it; a round no one owes is still stamped. */
async function tell(
  stamp: DecisionAgeStamp,
  rounds: readonly AgedRound[],
  now: Date,
  notice: (r: AgedRound) => { title: string; body: string },
): Promise<string[]> {
  const told: string[] = [];
  for (const r of rounds) {
    try {
      const recipients = await owingPeople(r);
      if (recipients.length > 0) {
        const { title, body } = notice(r);
        await emitNotification({
          recipients,
          projectId: r.projectId,
          type: 'decision_reminder',
          title,
          body,
          issueId: r.issueId,
          dedupeKey: `decision-${stamp}:${r.id}:${r.round}`,
        });
      }
      told.push(r.id);
    } catch (err) {
      logger.error({ err, questionId: r.id, stamp }, 'decision-upkeep: telling failed');
    }
  }
  return stampAgedRounds(stamp, told, now);
}

const about = (r: AgedRound) => r.itemKey ?? 'A question';

/** One pass: void what moved, remind on day 3, propose defer or drop on day 14. */
export async function sweepDecisionUpkeep(now: Date = new Date()) {
  const voided = await sweepMovedDecisions();
  const reminded = await tell(
    'remindedAt',
    await agedRounds('remindedAt', new Date(now.getTime() - REMIND_AFTER_DAYS * DAY_MS)),
    now,
    (r) => ({
      title: `${about(r)}: a decision has waited ${REMIND_AFTER_DAYS} days`,
      body: clipped(r.prompt, 500),
    }),
  );
  // a round with a defer or a drop to propose: its requirement's, else its own options' drop
  const due = (
    await agedRounds('escalatedAt', new Date(now.getTime() - ESCALATE_AFTER_DAYS * DAY_MS))
  ).filter(proposable);
  const escalated = await tell('escalatedAt', due, now, (r) => ({
    title:
      r.requirement && escalationActs(r.requirement.status).length > 0
        ? `${r.requirement.key}: defer or drop proposed after ${ESCALATE_AFTER_DAYS} days`
        : `${about(r)}: dropping it is proposed after ${ESCALATE_AFTER_DAYS} days`,
    body: clipped(`No answer to: ${r.prompt}`, 500),
  }));
  return { voided: voided.length, reminded: reminded.length, escalated: escalated.length };
}
