import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/client.js';
import { agentSessions, pipelineRuns, projects, schedules } from '../db/schema.js';
import { assertProjectRole, loadProjectAccess } from '../lib/authz.js';
import { logger } from '../logger.js';
import { nextRunFor, validateCron } from './cron.js';
import { dispatchScheduleRun } from './dispatch.js';
import { getImprovementMessage } from './messages/registry.js';

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

// Cross-project routing via `targetProjectSlug` would otherwise let a source
// project's admin plant jobs on any project they know the slug of. Require the
// actor to hold at least `member` on the target project before accepting the
// slug, both when persisting it (POST/PUT) and when manually triggering.
export async function assertTargetProjectAccess(
  slug: string,
  userId: string,
): Promise<{ id: string; createdBy: string }> {
  const [target] = await db
    .select({ id: projects.id, createdBy: projects.createdBy })
    .from(projects)
    .where(eq(projects.slug, slug))
    .limit(1);
  if (!target) {
    throw new HTTPException(400, {
      message: 'targetProjectSlug not found',
      cause: { code: 'INVALID_TARGET_PROJECT' },
    });
  }
  const access = await loadProjectAccess(target.id, userId);
  assertProjectRole(access, 'member', 'not a member of target project');
  return target;
}

// Reset `lastStatus` to 'failed' after a dispatcher throw so the row never
// gets pinned to 'running' or a stale 'success'. Errors during the reset are
// logged but never propagated — the original dispatch failure is what matters.
export async function markScheduleFailed(scheduleId: string, ctx: string): Promise<void> {
  try {
    await db.update(schedules).set({ lastStatus: 'failed' }).where(eq(schedules.id, scheduleId));
  } catch (err) {
    logger.error({ err, scheduleId }, `${ctx}: lastStatus reset threw`);
  }
}

export async function listSchedules(
  projectId: string,
  actorUserId: string,
  enabled?: boolean,
) {
  const access = await loadProjectAccess(projectId, actorUserId);
  assertProjectRole(access, 'viewer', 'not a project member');

  const conditions = [eq(schedules.projectId, projectId)];
  if (enabled !== undefined) conditions.push(eq(schedules.enabled, enabled));

  return db.select().from(schedules).where(and(...conditions)).orderBy(asc(schedules.createdAt));
}

export async function getSchedule(id: string, actorUserId: string) {
  const [row] = await db.select().from(schedules).where(eq(schedules.id, id)).limit(1);
  if (!row) throw notFound('schedule not found');

  const access = await loadProjectAccess(row.projectId, actorUserId);
  assertProjectRole(access, 'viewer', 'not a project member');

  return row;
}

export async function listScheduleRuns(id: string, actorUserId: string, limit?: number) {
  const [schedule] = await db
    .select({ projectId: schedules.projectId })
    .from(schedules)
    .where(eq(schedules.id, id))
    .limit(1);
  if (!schedule) throw notFound('schedule not found');

  const access = await loadProjectAccess(schedule.projectId, actorUserId);
  assertProjectRole(access, 'viewer', 'not a project member');

  const rows = await db
    .select({
      sessionId: agentSessions.id,
      pipelineRunId: agentSessions.pipelineRunId,
      status: agentSessions.status,
      title: agentSessions.title,
      failureReason: agentSessions.failureReason,
      sessionStartedAt: agentSessions.startedAt,
      createdAt: agentSessions.createdAt,
      tick: sql<boolean>`(${agentSessions.metadata} ->> 'tick') = 'true'`,
      runStatus: pipelineRuns.status,
      runStartedAt: pipelineRuns.startedAt,
      runFinishedAt: pipelineRuns.finishedAt,
    })
    .from(agentSessions)
    .leftJoin(pipelineRuns, eq(agentSessions.pipelineRunId, pipelineRuns.id))
    .where(sql`${agentSessions.metadata} ->> 'scheduleId' = ${id}`)
    .orderBy(desc(agentSessions.createdAt))
    .limit(limit ?? 20);

  const toIso = (d: Date | string | null): string | null =>
    d == null ? null : d instanceof Date ? d.toISOString() : d;

  const runs = rows.map((r) => {
    const start = r.sessionStartedAt ?? r.runStartedAt ?? r.createdAt;
    const end = r.runFinishedAt ?? null;
    const durationSeconds =
      start && end
        ? Math.max(0, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 1000))
        : null;
    return {
      sessionId: r.sessionId,
      pipelineRunId: r.pipelineRunId,
      status: r.status,
      runStatus: r.runStatus,
      trigger: r.tick ? ('scheduled' as const) : ('manual' as const),
      title: r.title,
      failureReason: r.failureReason,
      startedAt: toIso(start),
      finishedAt: toIso(end),
      durationSeconds,
    };
  });

  return { runs };
}

export interface CreateScheduleInput {
  projectId: string;
  name: string;
  cron: string;
  prompt: string;
  runner?: 'desktop' | undefined;
  enabled?: boolean | undefined;
  targetProjectSlug?: string | null | undefined;
  metadata?: Record<string, unknown> | null | undefined;
  templateKey?: string | null | undefined;
  params?: Record<string, unknown> | null | undefined;
  mode?: 'propose' | 'auto' | undefined;
}

export async function createSchedule(input: CreateScheduleInput, actorUserId: string) {
  const access = await loadProjectAccess(input.projectId, actorUserId);
  assertProjectRole(access, 'admin', 'not a project admin');

  const validation = validateCron(input.cron);
  if (!validation.ok) {
    throw new HTTPException(400, {
      message: validation.error ?? 'invalid cron',
      cause: { code: 'INVALID_CRON' },
    });
  }

  if (input.targetProjectSlug) {
    await assertTargetProjectAccess(input.targetProjectSlug, actorUserId);
  }

  if (input.templateKey) {
    const msg = getImprovementMessage(input.templateKey);
    if (!msg) {
      throw badRequest(`templateKey '${input.templateKey}' not found in registry`);
    }
  }

  const enabled = input.enabled ?? true;
  const nextRunAt = enabled ? nextRunFor(input.cron) : null;
  const mode = input.mode ?? (input.templateKey ? 'propose' : undefined);

  // ISS-244 — desktop is the only runner supported on the new interactive
  // dispatch path. Pin to 'desktop' so newly-created schedules are dispatchable.
  const [inserted] = await db
    .insert(schedules)
    .values({
      projectId: input.projectId,
      name: input.name,
      cron: input.cron,
      prompt: input.prompt,
      runner: input.runner ?? 'desktop',
      enabled,
      targetProjectSlug: input.targetProjectSlug ?? null,
      metadata: (input.metadata as never) ?? null,
      nextRunAt,
      templateKey: input.templateKey ?? null,
      params: (input.params as never) ?? null,
      mode: mode ?? null,
    })
    .returning();
  if (!inserted) throw new Error('schedules: insert returned no row');

  return inserted;
}

export interface UpdateSchedulePatch {
  name?: string | undefined;
  cron?: string | undefined;
  prompt?: string | undefined;
  runner?: 'desktop' | undefined;
  enabled?: boolean | undefined;
  targetProjectSlug?: string | null | undefined;
  metadata?: Record<string, unknown> | null | undefined;
  templateKey?: string | null | undefined;
  params?: Record<string, unknown> | null | undefined;
  mode?: 'propose' | 'auto' | undefined;
}

export async function updateSchedule(id: string, patch: UpdateSchedulePatch, actorUserId: string) {
  const [row] = await db.select().from(schedules).where(eq(schedules.id, id)).limit(1);
  if (!row) throw notFound('schedule not found');

  const access = await loadProjectAccess(row.projectId, actorUserId);
  assertProjectRole(access, 'admin', 'not a project admin');

  if (patch.targetProjectSlug !== undefined && patch.targetProjectSlug !== null) {
    await assertTargetProjectAccess(patch.targetProjectSlug, actorUserId);
  }

  if (patch.templateKey !== undefined && patch.templateKey !== null) {
    const msg = getImprovementMessage(patch.templateKey);
    if (!msg) {
      throw badRequest(`templateKey '${patch.templateKey}' not found in registry`);
    }
  }

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.name !== undefined) updates.name = patch.name;
  if (patch.prompt !== undefined) updates.prompt = patch.prompt;
  if (patch.runner !== undefined) updates.runner = patch.runner;
  if (patch.targetProjectSlug !== undefined) updates.targetProjectSlug = patch.targetProjectSlug;
  if (patch.metadata !== undefined) updates.metadata = patch.metadata;
  if (patch.templateKey !== undefined) updates.templateKey = patch.templateKey;
  if (patch.params !== undefined) updates.params = patch.params;
  if (patch.mode !== undefined) updates.mode = patch.mode;

  const cron = patch.cron ?? row.cron;
  const enabled = patch.enabled ?? row.enabled;

  if (patch.cron !== undefined) {
    const validation = validateCron(patch.cron);
    if (!validation.ok) {
      throw new HTTPException(400, {
        message: validation.error ?? 'invalid cron',
        cause: { code: 'INVALID_CRON' },
      });
    }
    updates.cron = patch.cron;
  }
  if (patch.enabled !== undefined) updates.enabled = patch.enabled;

  if (patch.cron !== undefined || patch.enabled !== undefined) {
    updates.nextRunAt = enabled ? nextRunFor(cron) : null;
  }

  const [updated] = await db
    .update(schedules)
    .set(updates)
    .where(eq(schedules.id, id))
    .returning();
  if (!updated) throw notFound('schedule not found');

  return updated;
}

export async function deleteSchedule(id: string, actorUserId: string): Promise<void> {
  const [row] = await db
    .select({ id: schedules.id, projectId: schedules.projectId })
    .from(schedules)
    .where(eq(schedules.id, id))
    .limit(1);
  if (!row) throw notFound('schedule not found');

  const access = await loadProjectAccess(row.projectId, actorUserId);
  assertProjectRole(access, 'admin', 'not a project admin');

  await db.delete(schedules).where(eq(schedules.id, id));
}

export async function runScheduleNow(
  id: string,
  actorUserId: string,
): Promise<{ sessionId: string; message: string }> {
  const [schedule] = await db.select().from(schedules).where(eq(schedules.id, id)).limit(1);
  if (!schedule) throw notFound('schedule not found');

  const access = await loadProjectAccess(schedule.projectId, actorUserId);
  assertProjectRole(access, 'member', 'not a project member');

  // Defensive re-check: rows persisted before the create/update gate landed
  // could carry a `targetProjectSlug` the actor has no business triggering.
  let resolvedTarget: { id: string; createdBy: string } | undefined;
  if (schedule.targetProjectSlug) {
    resolvedTarget = await assertTargetProjectAccess(schedule.targetProjectSlug, actorUserId);
  }

  let result: Awaited<ReturnType<typeof dispatchScheduleRun>>;
  try {
    result = await dispatchScheduleRun({
      schedule: {
        id: schedule.id,
        name: schedule.name,
        projectId: schedule.projectId,
        prompt: schedule.prompt,
        runner: schedule.runner,
        targetProjectSlug: schedule.targetProjectSlug ?? null,
        templateKey: schedule.templateKey ?? null,
        params: (schedule.params as Record<string, unknown> | null) ?? null,
        mode: schedule.mode ?? null,
        appliedMessageVersions:
          (schedule.appliedMessageVersions as Record<string, number> | null) ?? null,
      },
      actorUserId,
      ...(resolvedTarget ? { resolvedTarget } : {}),
    });
  } catch (err) {
    logger.error({ err, scheduleId: schedule.id }, 'schedule.run: dispatch threw');
    await markScheduleFailed(schedule.id, 'schedule.run');
    throw err;
  }

  await db
    .update(schedules)
    .set({ lastStatus: result.status })
    .where(eq(schedules.id, schedule.id));

  if (!result.ok) {
    // ISS-244 — manual /run no longer queues; surface "no device online"
    // synchronously so the user knows nothing was started.
    throw new HTTPException(409, {
      message: result.reason,
      cause: { code: 'SCHEDULE_DISPATCH_FAILED', reason: result.reason },
    });
  }

  return { sessionId: result.sessionId, message: 'Schedule triggered' };
}
