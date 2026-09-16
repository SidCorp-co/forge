import { and, eq, gte, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobs, notifications, pmConfig, projects } from '../db/schema.js';
import { logger } from '../logger.js';
import { emissionAllowed, noteSuppressed } from '../notifications/emission-switch.js';
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

    // cm:guard ISS-1063 — this insert bypasses `createNotification`, so it must
    // consult the emission switch itself or it is a hole in the silence. It is not
    // routed through `createNotification` because that would take the write out of
    // this transaction, and the row must land with the `pmConfig` disable or with
    // neither.
    // cm:edge lockstep -> packages/core/src/notifications/emission-switch.ts — one of the two producers that write `notifications` directly; the other is admin/alert-sweeper.ts
    if (!emissionAllowed('pm_escalation')) {
      noteSuppressed('pm_escalation', 'PM cadence auto-disabled');
      return;
    }

    await tx.insert(notifications).values({
      userId: project.createdBy,
      projectId: payload.projectId,
      type: 'pm_escalation',
      title: 'PM cadence auto-disabled',
      body: `PM agent failed ${count} times in the last hour. Cadence and event triggers are off until you re-enable in project settings.`,
      issueId: null,
      agentSessionId: null,
    });
  });

  logger.warn({ projectId: payload.projectId, failures: count }, 'pm.auto-disable: cadence off');
}
