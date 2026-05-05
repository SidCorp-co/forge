import { zValidator } from '@hono/zod-validator';
import { and, asc, eq, lte, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { schedules, scheduleRunners } from '../db/schema.js';
import { loadProjectAccess } from '../lib/project-access.js';
import { logger } from '../logger.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { nextRunFor, validateCron } from './cron.js';
import { dispatchScheduleRun } from './dispatch.js';

const idParamSchema = z.object({ id: z.uuid() });

const listQuerySchema = z
  .object({
    projectId: z.uuid(),
    enabled: z.enum(['true', 'false']).optional(),
  })
  .strict();

const createSchema = z
  .object({
    projectId: z.uuid(),
    name: z.string().trim().min(1).max(200),
    cron: z.string().trim().min(1).max(200),
    prompt: z.string().trim().min(1).max(20_000),
    runner: z.enum(scheduleRunners).optional(),
    enabled: z.boolean().optional(),
    targetProjectSlug: z.string().trim().min(1).max(200).nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .strict();

const updateSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    cron: z.string().trim().min(1).max(200).optional(),
    prompt: z.string().trim().min(1).max(20_000).optional(),
    runner: z.enum(scheduleRunners).optional(),
    enabled: z.boolean().optional(),
    targetProjectSlug: z.string().trim().min(1).max(200).nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .strict()
  .refine((o) => Object.keys(o).length > 0, { message: 'no fields to update' });

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

const forbidden = (message: string) =>
  new HTTPException(403, { message, cause: { code: 'FORBIDDEN' } });

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
    if (!access.role && access.ownerId !== userId) throw forbidden('not a project member');

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
    if (!access.role && access.ownerId !== userId) throw forbidden('not a project member');

    return c.json(row);
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
    if (access.ownerId !== userId && access.role !== 'owner') throw forbidden('not a project owner');

    const validation = validateCron(input.cron);
    if (!validation.ok) {
      throw new HTTPException(400, {
        message: validation.error ?? 'invalid cron',
        cause: { code: 'INVALID_CRON' },
      });
    }

    const enabled = input.enabled ?? true;
    const nextRunAt = enabled ? nextRunFor(input.cron) : null;

    const [inserted] = await db
      .insert(schedules)
      .values({
        projectId: input.projectId,
        name: input.name,
        cron: input.cron,
        prompt: input.prompt,
        runner: input.runner ?? 'antigravity',
        enabled,
        targetProjectSlug: input.targetProjectSlug ?? null,
        metadata: (input.metadata as never) ?? null,
        nextRunAt,
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
    if (access.ownerId !== userId && access.role !== 'owner') throw forbidden('not a project owner');

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.name !== undefined) updates.name = patch.name;
    if (patch.prompt !== undefined) updates.prompt = patch.prompt;
    if (patch.runner !== undefined) updates.runner = patch.runner;
    if (patch.targetProjectSlug !== undefined) updates.targetProjectSlug = patch.targetProjectSlug;
    if (patch.metadata !== undefined) updates.metadata = patch.metadata;

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
    if (access.ownerId !== userId && access.role !== 'owner') throw forbidden('not a project owner');

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
    if (!access.role && access.ownerId !== userId) throw forbidden('not a project member');

    let result: Awaited<ReturnType<typeof dispatchScheduleRun>>;
    try {
      result = await dispatchScheduleRun({
        schedule: {
          id: schedule.id,
          projectId: schedule.projectId,
          prompt: schedule.prompt,
          runner: schedule.runner,
          targetProjectSlug: schedule.targetProjectSlug ?? null,
        },
        actorUserId: userId,
      });
    } catch (err) {
      // Ensure `lastStatus` doesn't get pinned to a stale value on dispatcher
      // throws — record the failure so /list reflects reality.
      logger.error({ err, scheduleId: schedule.id }, 'schedule.run: dispatch threw');
      try {
        await db
          .update(schedules)
          .set({ lastStatus: 'failed' })
          .where(eq(schedules.id, schedule.id));
      } catch (statusErr) {
        logger.error({ err: statusErr, scheduleId: schedule.id }, 'schedule.run: lastStatus update threw');
      }
      throw err;
    }

    await db
      .update(schedules)
      .set({ lastStatus: result.status })
      .where(eq(schedules.id, schedule.id));

    if (!result.ok) {
      throw new HTTPException(409, {
        message: result.reason,
        cause: { code: 'SCHEDULE_DISPATCH_FAILED', reason: result.reason },
      });
    }

    return c.json({ sessionId: result.jobId, jobId: result.jobId, message: 'Schedule triggered' }, 202);
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
            projectId: schedule.projectId,
            prompt: schedule.prompt,
            runner: schedule.runner,
            targetProjectSlug: schedule.targetProjectSlug ?? null,
          },
          // FIXME(iss-257): system-initiated jobs attribute to the project owner
          // because jobs.created_by is NOT NULL. A sentinel system user
          // requires a separate migration — tracked for follow-up. Consumers
          // can detect tick-driven jobs by payload.kind === 'schedule.run'
          // && payload.tick === true.
          tick: true,
        });
      } catch (dispatchErr) {
        // Don't leave `lastStatus='running'` if dispatch throws after the
        // atomic claim — flip to 'failed' so the row reflects reality.
        logger.error({ err: dispatchErr, scheduleId: schedule.id }, 'schedule.tick: dispatch threw');
        try {
          await db
            .update(schedules)
            .set({ lastStatus: 'failed' })
            .where(eq(schedules.id, schedule.id));
        } catch (statusErr) {
          logger.error({ err: statusErr, scheduleId: schedule.id }, 'schedule.tick: lastStatus reset threw');
        }
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
