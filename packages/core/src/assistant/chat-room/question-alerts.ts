import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { organizations, projects } from '../../db/schema.js';
import { agentQuestions } from '../../db/schema-questions.js';
import { rocketchatQuestionDeliveries } from '../../db/schema-rocketchat.js';
import { emitNotification, resolveNotifications } from '../../notifications/index.js';
import { decidedOnTheWeb, type OwedRound } from './question-ledger.js';

const undeliverableKey = (questionId: string) => `rocketchat-question-undeliverable:${questionId}`;

export async function reportUndeliverable(
  owed: OwedRound,
  already: boolean,
  reason: string,
): Promise<void> {
  if (already) return;
  const [row] = await db
    .select({ slug: projects.slug, name: projects.name, createdBy: organizations.createdBy })
    .from(projects)
    .innerJoin(organizations, eq(organizations.id, projects.orgId))
    .where(eq(projects.id, owed.projectId))
    .limit(1);
  if (!row?.createdBy) return;
  await emitNotification({
    userId: row.createdBy,
    projectId: owed.projectId,
    issueId: owed.issueId,
    type: 'ops_alert',
    severity: 'warning',
    title: `${row.name} has a question waiting that cannot be delivered`,
    body: `A question is waiting on a person and ${row.slug} has nowhere to put it: ${reason}. Nothing was posted anywhere. Put that right and the question is delivered on the next sweep — whoever asked does not have to ask again.`,
    resolutionKey: undeliverableKey(owed.questionId),
  });
}

/** An alert an earlier drain raised for a web-decided question was never true; resolve it. */
export async function clearWebDecidedAlerts(): Promise<void> {
  const raised = await db
    .selectDistinct({ questionId: rocketchatQuestionDeliveries.questionId })
    .from(rocketchatQuestionDeliveries)
    .innerJoin(agentQuestions, eq(agentQuestions.id, rocketchatQuestionDeliveries.questionId))
    .where(and(eq(rocketchatQuestionDeliveries.status, 'undeliverable'), decidedOnTheWeb));
  for (const { questionId } of raised) await resolveNotifications(undeliverableKey(questionId));
}

/** The round reached its room: the undeliverable alert it may have raised is no longer true. */
export async function resolveUndeliverableAlert(questionId: string): Promise<void> {
  await resolveNotifications(undeliverableKey(questionId));
}
