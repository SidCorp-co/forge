import { zValidator } from '@hono/zod-validator';
import { and, asc, eq, lte } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { jobs, projects, schedules, scheduleRunners } from '../db/schema.js';
import { enqueueJob } from '../jobs/enqueue.js';
import { loadProjectAccess } from '../lib/project-access.js';
import { logger } from '../logger.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { hooks } from '../pipeline/hooks.js';
import { nextRunFor, validateCron } from './cron.js';

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

    const [job] = await db
      .insert(jobs)
      .values({
        projectId: schedule.projectId,
        createdBy: userId,
        type: 'custom',
        payload: {
          kind: 'schedule.run',
          scheduleId: schedule.id,
          prompt: schedule.prompt,
          runner: schedule.runner,
          targetProjectSlug: schedule.targetProjectSlug ?? null,
        },
        status: 'queued',
      })
      .returning({ id: jobs.id });
    if (!job) throw new Error('jobs: insert returned no row');

    try {
      await enqueueJob(job.id);
    } catch (err) {
      logger.error({ err, jobId: job.id }, 'schedule.run: enqueueJob failed');
    }

    await hooks.emit('scheduleRun', {
      scheduleId: schedule.id,
      projectId: schedule.projectId,
      jobId: job.id,
      actorUserId: userId,
    });

    return c.json({ sessionId: job.id, jobId: job.id, message: 'Schedule triggered' }, 202);
  },
);

// Test-only: runs the tick scanner once and dispatches due schedules.
export async function runScheduleTickOnce(now: Date = new Date()): Promise<string[]> {
  const due = await db
    .select()
    .from(schedules)
    .where(and(eq(schedules.enabled, true), lte(schedules.nextRunAt, now)));

  const dispatched: string[] = [];
  for (const schedule of due) {
    try {
      const [project] = await db
        .select({ ownerId: projects.ownerId })
        .from(projects)
        .where(eq(projects.id, schedule.projectId))
        .limit(1);
      if (!project) continue;
      const [job] = await db
        .insert(jobs)
        .values({
          projectId: schedule.projectId,
          createdBy: project.ownerId,
          type: 'custom',
          payload: {
            kind: 'schedule.run',
            scheduleId: schedule.id,
            prompt: schedule.prompt,
            runner: schedule.runner,
            targetProjectSlug: schedule.targetProjectSlug ?? null,
            tick: true,
          },
          status: 'queued',
        })
        .returning({ id: jobs.id });
      if (!job) continue;
      await db
        .update(schedules)
        .set({
          lastRunAt: now,
          lastSessionId: job.id,
          lastStatus: 'running',
          nextRunAt: nextRunFor(schedule.cron, now),
        })
        .where(eq(schedules.id, schedule.id));
      try {
        await enqueueJob(job.id);
      } catch (err) {
        logger.error({ err, jobId: job.id }, 'schedule.tick: enqueueJob failed');
      }
      dispatched.push(schedule.id);
    } catch (err) {
      logger.error({ err, scheduleId: schedule.id }, 'schedule.tick: dispatch failed');
    }
  }
  return dispatched;
}
