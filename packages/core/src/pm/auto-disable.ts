import { and, eq, gte, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobs, notifications, pmConfig, projects } from '../db/schema.js';
import { logger } from '../logger.js';
import { deliverExisting } from '../notifications/deliver.js';
import { emissionAllowed, noteSuppressed } from '../notifications/emission-switch.js';
import { INITIAL_STATE, kindOf, tierOf } from '../notifications/kinds.js';
import type { HookPayloads } from '../pipeline/hooks.js';

const WINDOW_MS = 60 * 60 * 1000;
const FAILURE_LIMIT = 3;

/**
 * Three-strikes guard: when 3 PM jobs fail in the same project within an
 * hour, disable cadence + event triggers and notify the project creator
 * (audit `projects.created_by`). The operator can re-enable from project
 * settings.
 *
 * Counts `jobs.status='failed'` rather than `pm_decisions` because a PM
 * session that crashed before writing a decision row still counts toward
 * the limit — the job-status path is the runner-of-record.
 */
export async function handlePmJobFailedAutoDisable(
  payload: HookPayloads['jobFailed'],
): Promise<void> {
  if (payload.type !== 'pm') return;

  const since = new Date(Date.now() - WINDOW_MS);
  const [{ count } = { count: 0 }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(jobs)
    .where(
      and(
        eq(jobs.projectId, payload.projectId),
        eq(jobs.type, 'pm'),
        eq(jobs.status, 'failed'),
        gte(jobs.createdAt, since),
      ),
    );

  if (count < FAILURE_LIMIT) return;

  let recordId: string | null = null;
  let recipient: string | null = null;
  await db.transaction(async (tx) => {
    await tx
      .update(pmConfig)
      .set({ enabled: false, cadenceCron: null, updatedAt: new Date() })
      .where(eq(pmConfig.projectId, payload.projectId));

    const [project] = await tx
      .select({ createdBy: projects.createdBy })
      .from(projects)
      .where(eq(projects.id, payload.projectId))
      .limit(1);
    if (!project) return;

    if (!emissionAllowed('pm_escalation')) {
      noteSuppressed('pm_escalation', 'PM cadence auto-disabled');
      return;
    }

    const [record] = await tx
      .insert(notifications)
      .values({
        projectId: payload.projectId,
        type: 'pm_escalation',
        kind: kindOf('pm_escalation'),
        tier: tierOf('pm_escalation'),
        state: INITIAL_STATE[kindOf('pm_escalation')],
        title: 'PM cadence auto-disabled',
        body: `PM agent failed ${count} times in the last hour. Cadence and event triggers are off until you re-enable in project settings.`,
        issueId: null,
        agentSessionId: null,
      })
      .returning({ id: notifications.id });
    recordId = record?.id ?? null;
    recipient = project.createdBy;
  });

  if (recordId && recipient) await deliverExisting(recordId, [recipient]);

  logger.warn({ projectId: payload.projectId, failures: count }, 'pm.auto-disable: cadence off');
}
