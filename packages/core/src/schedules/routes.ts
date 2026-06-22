import { zValidator } from '@hono/zod-validator';
import { and, asc, desc, eq, lte, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { agentSessions, pipelineRuns, projects, schedules } from '../db/schema.js';
import { assertProjectRole, loadProjectAccess } from '../lib/authz.js';
import { logger } from '../logger.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { nextRunFor, validateCron } from './cron.js';
import { dispatchScheduleRun } from './dispatch.js';
import { getImprovementMessage } from './messages/registry.js';

const idParamSchema = z.object({ id: z.uuid() });

const listQuerySchema = z
  .object({
    projectId: z.uuid(),
    enabled: z.enum(['true', 'false']).optional(),
  })
  .strict();

const runsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).optional(),
  })
  .strict();

// ISS-244 — `runner: 'antigravity'` is rejected on this surface until the
// antigravity adapter gains an interactive WS entry point. Schedule dispatch
// now rides the same rails as `/api/agent-sessions/start`, which is desktop
// (claude-code) only. Keep the enum narrow at the API boundary; the DB-level
// enum (`scheduleRunners`) stays wide so existing rows don't fail at read.
const apiScheduleRunner = z.enum(['desktop']);

const scheduleMode = z.enum(['propose', 'auto']);

const createSchema = z
  .object({
    projectId: z.uuid(),
    name: z.string().trim().min(1).max(200),
    cron: z.string().trim().min(1).max(200),
    prompt: z.string().trim().min(1).max(20_000),
    runner: apiScheduleRunner.optional(),
    enabled: z.boolean().optional(),
    targetProjectSlug: z.string().trim().min(1).max(200).nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).nullable().optional(),
    templateKey: z.string().trim().min(1).max(200).nullable().optional(),
    params: z.record(z.string(), z.unknown()).nullable().optional(),
    mode: scheduleMode.optional(),
  })
  .strict();

const updateSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    cron: z.string().trim().min(1).max(200).optional(),
    prompt: z.string().trim().min(1).max(20_000).optional(),
    runner: apiScheduleRunner.optional(),
    enabled: z.boolean().optional(),
    targetProjectSlug: z.string().trim().min(1).max(200).nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).nullable().optional(),
    templateKey: z.string().trim().min(1).max(200).nullable().optional(),
    params: z.record(z.string(), z.unknown()).nullable().optional(),
    mode: scheduleMode.optional(),
  })
  .strict()
  .refine((o) => Object.keys(o).length > 0, { message: 'no fields to update' });

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

// Cross-project routing via `targetProjectSlug` would otherwise let a source
// project's admin plant jobs on any project they know the slug of. Require the
// actor to hold at least `member` on the target project before accepting the
// slug, both when persisting it (POST/PUT) and when manually triggering
// (`/:id/run`).
// Reset `lastStatus` to 'failed' after a dispatcher throw so the row never
// gets pinned to 'running' or a stale 'success'. Errors during the reset are
// logged but never propagated — the original dispatch failure is what matters.
async function markScheduleFailed(scheduleId: string, ctx: string): Promise<void> {
  try {
    await db
      .update(schedules)
      .set({ lastStatus: 'failed' })
      .where(eq(schedules.id, scheduleId));
  } catch (err) {
    logger.error({ err, scheduleId }, `${ctx}: lastStatus reset threw`);
  }
}

async function assertTargetProjectAccess(
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

export const scheduleRoutes = new Hono<{ Variables: AuthVars }>();
scheduleRoutes.use('*', requireAuth(), assertEmailVerified());

scheduleRoutes.get(
  '/',
  zValidator('query', listQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId, enabled } = c.req.valid('query');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    assertProjectRole(access, 'viewer', 'not a project member');

    const conditions = [eq(schedules.projectId, projectId)];
    if (enabled !== undefined) conditions.push(eq(schedules.enabled, enabled === 'true'));

    const rows = await db
      .select()
      .from(schedules)
      .where(and(...conditions))
      .orderBy(asc(schedules.createdAt));

    return c.json(rows);
  },
);

scheduleRoutes.get(
  '/:id',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const [row] = await db.select().from(schedules).where(eq(schedules.id, id)).limit(1);
    if (!row) throw notFound('schedule not found');

    const access = await loadProjectAccess(row.projectId, userId);
    assertProjectRole(access, 'viewer', 'not a project member');

    return c.json(row);
  },
);

// Run history for a schedule. Schedule runs are not their own table — each
// dispatch creates an `agent_sessions` row tagged `metadata.scheduleId` (+
// `metadata.tick:true` when cron-driven, absent for a manual `/run`) under a
// `system`-kind `pipeline_run`. We join the run for its clean started/finished
// span + terminal status, newest first.
scheduleRoutes.get(
  '/:id/runs',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('query', runsQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const { limit } = c.req.valid('query');
    const userId = c.get('userId');

    const [schedule] = await db
      .select({ projectId: schedules.projectId })
      .from(schedules)
      .where(eq(schedules.id, id))
      .limit(1);
    if (!schedule) throw notFound('schedule not found');

    const access = await loadProjectAccess(schedule.projectId, userId);
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
          ? Math.max(
              0,
              Math.round((new Date(end).getTime() - new Date(start).getTime()) / 1000),
            )
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

    return c.json({ runs });
  },
);

scheduleRoutes.post(
  '/',
  zValidator('json', createSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const input = c.req.valid('json');
    const userId = c.get('userId');

    const access = await loadProjectAccess(input.projectId, userId);
    assertProjectRole(access, 'admin', 'not a project admin');

    const validation = validateCron(input.cron);
    if (!validation.ok) {
      throw new HTTPException(400, {
        message: validation.error ?? 'invalid cron',
        cause: { code: 'INVALID_CRON' },
      });
    }

    if (input.targetProjectSlug) {
      await assertTargetProjectAccess(input.targetProjectSlug, userId);
    }

    if (input.templateKey) {
      const msg = getImprovementMessage(input.templateKey);
      if (!msg) {
        throw new HTTPException(400, {
          message: `templateKey '${input.templateKey}' not found in registry`,
          cause: { code: 'INVALID_TEMPLATE_KEY' },
        });
      }
    }

    const enabled = input.enabled ?? true;
    const nextRunAt = enabled ? nextRunFor(input.cron) : null;
    const mode = input.mode ?? (input.templateKey ? 'propose' : undefined);

    // ISS-244 — desktop is the only runner supported on the new interactive
    // dispatch path. The DB column default ('antigravity') predates this;
    // pin to 'desktop' here so newly-created schedules are dispatchable.
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

    return c.json(inserted, 201);
  },
);

scheduleRoutes.put(
  '/:id',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', updateSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const patch = c.req.valid('json');
    const userId = c.get('userId');

    const [row] = await db.select().from(schedules).where(eq(schedules.id, id)).limit(1);
    if (!row) throw notFound('schedule not found');

    const access = await loadProjectAccess(row.projectId, userId);
    assertProjectRole(access, 'admin', 'not a project admin');

    if (patch.targetProjectSlug !== undefined && patch.targetProjectSlug !== null) {
      await assertTargetProjectAccess(patch.targetProjectSlug, userId);
    }

    if (patch.templateKey !== undefined && patch.templateKey !== null) {
      const msg = getImprovementMessage(patch.templateKey);
      if (!msg) {
        throw new HTTPException(400, {
          message: `templateKey '${patch.templateKey}' not found in registry`,
          cause: { code: 'INVALID_TEMPLATE_KEY' },
        });
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

    return c.json(updated);
  },
);

scheduleRoutes.delete(
  '/:id',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const [row] = await db
      .select({ id: schedules.id, projectId: schedules.projectId })
      .from(schedules)
      .where(eq(schedules.id, id))
      .limit(1);
    if (!row) throw notFound('schedule not found');

    const access = await loadProjectAccess(row.projectId, userId);
    assertProjectRole(access, 'admin', 'not a project admin');

    await db.delete(schedules).where(eq(schedules.id, id));
    return c.body(null, 204);
  },
);

scheduleRoutes.post(
  '/:id/run',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const [schedule] = await db.select().from(schedules).where(eq(schedules.id, id)).limit(1);
    if (!schedule) throw notFound('schedule not found');

    const access = await loadProjectAccess(schedule.projectId, userId);
    assertProjectRole(access, 'member', 'not a project member');

    // Defensive re-check: rows persisted before the create/update gate landed
    // could carry a `targetProjectSlug` the actor has no business triggering.
    let resolvedTarget: { id: string; createdBy: string } | undefined;
    if (schedule.targetProjectSlug) {
      resolvedTarget = await assertTargetProjectAccess(schedule.targetProjectSlug, userId);
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
        actorUserId: userId,
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
      // synchronously so the user knows nothing was started. `unsupported-runner`
      // is only reachable for pre-existing antigravity rows.
      throw new HTTPException(409, {
        message: result.reason,
        cause: { code: 'SCHEDULE_DISPATCH_FAILED', reason: result.reason },
      });
    }

    return c.json({ sessionId: result.sessionId, message: 'Schedule triggered' }, 202);
  },
);

// Test-only: runs the tick scanner once and dispatches due schedules.
//
// Concurrency model: each due row is claimed atomically by an UPDATE that
// asserts the previously-observed nextRunAt. If a parallel ticker (pg-boss
// redelivery, app restart overlap, second instance) claims it first, the
// rowcount will be 0 and we skip without enqueueing — preventing duplicate
// dispatches.
export async function runScheduleTickOnce(now: Date = new Date()): Promise<string[]> {
  const due = await db
    .select()
    .from(schedules)
    .where(and(eq(schedules.enabled, true), lte(schedules.nextRunAt, now)));

  const dispatched: string[] = [];
  for (const schedule of due) {
    try {
      // Atomic claim: only one ticker wins for this (id, nextRunAt) pair.
      const claimed = await db
        .update(schedules)
        .set({
          lastRunAt: now,
          lastStatus: 'running',
          nextRunAt: nextRunFor(schedule.cron, now),
        })
        .where(
          and(
            eq(schedules.id, schedule.id),
            eq(schedules.enabled, true),
            schedule.nextRunAt
              ? eq(schedules.nextRunAt, schedule.nextRunAt)
              : sql`${schedules.nextRunAt} IS NULL`,
          ),
        )
        .returning({ id: schedules.id });
      if (claimed.length === 0) continue; // another ticker won the race

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
          // FIXME(iss-257): system-initiated sessions attribute to the
          // project creator (audit `projects.created_by`) because
          // activity-feed expectations want a real user. A sentinel system
          // user requires a separate migration — tracked for follow-up.
          // Consumers can detect tick-driven sessions by
          // `metadata.source === 'schedule.run'` && `metadata.tick === true`.
          tick: true,
        });
      } catch (dispatchErr) {
        // Don't leave `lastStatus='running'` if dispatch throws after the
        // atomic claim — flip to 'failed' so the row reflects reality.
        logger.error({ err: dispatchErr, scheduleId: schedule.id }, 'schedule.tick: dispatch threw');
        await markScheduleFailed(schedule.id, 'schedule.tick');
        continue;
      }

      await db
        .update(schedules)
        .set({ lastStatus: result.status })
        .where(eq(schedules.id, schedule.id));

      if (result.ok) dispatched.push(schedule.id);
    } catch (err) {
      logger.error({ err, scheduleId: schedule.id }, 'schedule.tick: dispatch failed');
    }
  }
  return dispatched;
}
