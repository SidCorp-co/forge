// The `release_batch` schedule branch: cut whatever is waiting at the gate.
//
// Lives beside `dispatch.ts` rather than inside it because that file is at its
// size budget and this branch shares nothing with the agent-session path — no
// device, no session, no Claude runner.

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';
import { logger } from '../logger.js';
import type { DispatchScheduleInput, RoutedFire } from './dispatch-types.js';
import { runScheduledReleaseCut } from './release-batch-run.js';

/**
 * Which project a schedule acts on, and whose authority it acts with. Shared by
 * the two runner-less kinds so they cannot disagree about a `targetProjectSlug`.
 */
export async function resolveScheduleTargetProject(
  input: DispatchScheduleInput,
): Promise<{ projectId: string; userId: string } | null> {
  const { schedule } = input;
  let projectId = schedule.projectId;
  if (schedule.targetProjectSlug) {
    const target =
      input.resolvedTarget ??
      (
        await db
          .select({ id: projects.id, createdBy: projects.createdBy })
          .from(projects)
          .where(eq(projects.slug, schedule.targetProjectSlug))
          .limit(1)
      )[0];
    if (!target) return null;
    projectId = target.id;
  }
  const userId =
    input.actor?.userId ?? (await loadCreatedBy(projectId, input.resolvedTarget?.createdBy));
  if (!userId) return null;
  return { projectId, userId };
}

export async function routeScheduleReleaseBatchFire(
  input: DispatchScheduleInput,
  fireId: string,
): Promise<RoutedFire> {
  const resolved = await resolveScheduleTargetProject(input);
  if (!resolved) {
    return {
      result: { ok: false, reason: 'project-not-found', status: 'skipped' },
      settle: { status: 'skipped', reason: 'project-not-found' },
    };
  }
  const { projectId, userId } = resolved;

  const outcome = await runScheduledReleaseCut({ projectId, userId });

  if (outcome.status === 'failed') {
    logger.warn({ scheduleId: input.schedule.id, fireId }, 'schedule.release-batch: cut failed');
    return {
      result: { ok: false, reason: 'session-failed', status: 'failed' },
      settle: {
        status: 'failed',
        error: outcome.error ?? outcome.output,
        output: outcome.output,
      },
    };
  }
  if (outcome.status === 'skipped') {
    return {
      result: { ok: true, sessionId: null, status: 'skipped', resolvedProjectId: projectId },
      settle: outcome.code
        ? {
            status: 'skipped',
            reason: 'gate-refused',
            refusal: outcome.code,
            output: outcome.output,
          }
        : { status: 'skipped', reason: 'nothing-to-do', output: outcome.output },
    };
  }
  return {
    result: { ok: true, sessionId: null, status: 'success', resolvedProjectId: projectId },
    settle: { status: 'success', output: outcome.output },
  };
}

/** The user a runner-less schedule acts as: the caller, else the project owner. */
export async function loadCreatedBy(projectId: string, hint?: string): Promise<string | undefined> {
  if (hint) return hint;
  const [row] = await db
    .select({ createdBy: projects.createdBy })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return row?.createdBy;
}
