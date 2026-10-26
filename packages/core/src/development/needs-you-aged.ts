// The decisions that are no question, aged as a question's round is (REQ-68 BC-8, judge K98 on
// dev.325: a sign-off, a release, a design or a proposal was never reminded, since the upkeep read
// agent_questions only). Each person who may decide one reads it in their own Needs you; on day 3 they
// are reminded, and on day 14 told that the agent proposes its decline, which the decision then
// recommends (`needs-you-decisions.ts:agedProposal`). A question's round is the upkeep sweep's
// (`steward/decision-upkeep.ts`). Each notice carries a key of its decision, the moment it was asked
// and its person, so it is sent once per decision and person however often this runs.

import { questionDecisionId } from '@forge/contracts/needs-you-decisions';
import { isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects } from '../db/schema-projects.js';
import { loadProjectAccess } from '../lib/authz.js';
import { logger } from '../lib/logger.js';
import { namedHolders } from '../permissions/index.js';
import { ESCALATE_AFTER_DAYS, REMIND_AFTER_DAYS } from '../questions/index.js';
import { readNeedsYouDecisionsBare } from './needs-you-decisions-read.js';
import { declineOf } from './needs-you-escalation.js';
import { needsYouViewerOf } from './needs-you-viewer.js';
import { emitNotification } from './ports.js';

const DAY_MS = 86_400_000;

const daysSince = (at: string, now: Date) => (now.getTime() - Date.parse(at)) / DAY_MS;

/** One person's aged decisions on one project, each told once at day 3 and once at day 14. */
async function agePersonsDecisions(projectId: string, userId: string, now: Date) {
  const access = await loadProjectAccess(projectId, userId);
  const { read } = await readNeedsYouDecisionsBare(
    projectId,
    needsYouViewerOf(access, userId, 'human'),
    access,
    now,
  );
  let reminded = 0;
  let escalated = 0;
  for (const d of read.decisions) {
    if (d.id.startsWith(questionDecisionId('')) || !d.touchedAt) continue;
    const days = daysSince(d.touchedAt, now);
    const item = d.opens?.key ?? d.key;
    if (days >= REMIND_AFTER_DAYS) {
      const told = await emitNotification({
        recipients: [userId],
        projectId,
        type: 'decision_reminder',
        title: `${item}: a decision has waited ${REMIND_AFTER_DAYS} days`,
        body: d.question.slice(0, 500),
        dedupeKey: `decision-remind:${d.id}:${d.touchedAt}:${userId}`,
      });
      reminded += told.delivered > 0 ? 1 : 0;
    }
    const proposed = days >= ESCALATE_AFTER_DAYS ? declineOf(d) : undefined;
    if (proposed) {
      const told = await emitNotification({
        recipients: [userId],
        projectId,
        type: 'decision_reminder',
        title: `${item}: "${proposed.label}" proposed after ${ESCALATE_AFTER_DAYS} days`,
        body: d.question.slice(0, 500),
        dedupeKey: `decision-propose:${d.id}:${d.touchedAt}:${userId}`,
      });
      escalated += told.delivered > 0 ? 1 : 0;
    }
  }
  return { reminded, escalated };
}

/** One pass over every live project's people who may decide: what each was told. */
export async function sweepAgedDecisions(
  now: Date = new Date(),
  only?: readonly string[],
): Promise<{ reminded: number; escalated: number }> {
  const ids =
    only ??
    (await db.select({ id: projects.id }).from(projects).where(isNull(projects.archivedAt))).map(
      (p) => p.id,
    );
  let reminded = 0;
  let escalated = 0;
  for (const projectId of ids) {
    const people = (await namedHolders('project.write', projectId)).filter(
      (h) => h.kind === 'human',
    );
    for (const person of people) {
      try {
        const told = await agePersonsDecisions(projectId, person.id, now);
        reminded += told.reminded;
        escalated += told.escalated;
      } catch (err) {
        logger.error({ err, projectId, userId: person.id }, 'needs-you-aged: a read failed');
      }
    }
  }
  return { reminded, escalated };
}
