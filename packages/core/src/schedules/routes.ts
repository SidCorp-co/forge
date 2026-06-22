import { zValidator } from '@hono/zod-validator';
import { and, eq, lte, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { schedules } from '../db/schema.js';
import { logger } from '../logger.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { nextRunFor } from './cron.js';
import { dispatchScheduleRun } from './dispatch.js';
import {
  createSchedule,
  deleteSchedule,
  getSchedule,
  listScheduleRuns,
  listSchedules,
  markScheduleFailed,
  runScheduleNow,
  updateSchedule,
} from './service.js';

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

export const scheduleRoutes = new Hono<{ Variables: AuthVars }>();
scheduleRoutes.use('*', requireAuth(), assertEmailVerified());

scheduleRoutes.get(
  '/',
  zValidator('query', listQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId, enabled } = c.req.valid('query');
    const rows = await listSchedules(projectId, c.get('userId'), enabled === 'true' ? true : enabled === 'false' ? false : undefined);
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
    const row = await getSchedule(id, c.get('userId'));
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
    const result = await listScheduleRuns(id, c.get('userId'), limit);
    return c.json(result);
  },
);

scheduleRoutes.post(
  '/',
  zValidator('json', createSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const input = c.req.valid('json');
    const inserted = await createSchedule(input, c.get('userId'));
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
    const updated = await updateSchedule(id, patch, c.get('userId'));
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
    await deleteSchedule(id, c.get('userId'));
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
    const result = await runScheduleNow(id, c.get('userId'));
    return c.json(result, 202);
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
