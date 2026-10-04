import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { scheduleKinds } from '../db/schema.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { zValidator } from '../middleware/zod-validator.js';
import {
  createSchedule,
  deleteSchedule,
  getSchedule,
  listSchedules,
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

const scheduleMode = z.enum(['propose', 'auto']);

const apiScheduleKind = z.enum(scheduleKinds);

const createSchema = z
  .object({
    projectId: z.uuid(),
    name: z.string().trim().min(1).max(200),
    cron: z.string().trim().min(1).max(200),
    prompt: z.string().trim().min(1).max(20_000).optional(),
    kind: apiScheduleKind.optional(),
    script: z.string().trim().min(1).max(50_000).optional(),
    enabled: z.boolean().optional(),
    targetProjectSlug: z.string().trim().min(1).max(200).nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).nullable().optional(),
    templateKey: z.string().trim().min(1).max(200).nullable().optional(),
    params: z.record(z.string(), z.unknown()).nullable().optional(),
    mode: scheduleMode.optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    const kind = data.kind ?? 'prompt';
    if (kind === 'script') {
      if (!data.script) {
        ctx.addIssue({
          code: 'custom',
          path: ['script'],
          message: 'script is required when kind is "script"',
        });
      }
      if (data.prompt !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['prompt'],
          message: 'prompt must be omitted when kind is "script"',
        });
      }
      if (data.templateKey) {
        ctx.addIssue({
          code: 'custom',
          path: ['templateKey'],
          message: 'templateKey must be omitted when kind is "script"',
        });
      }
    } else if (kind === 'release_batch' || kind === 'sentry_pull') {
      const what =
        kind === 'release_batch'
          ? 'it cuts whatever is waiting at the gate'
          : "it pulls whatever the project's Sentry binding declares";
      for (const field of ['prompt', 'script', 'templateKey'] as const) {
        if (data[field] !== undefined && data[field] !== null) {
          ctx.addIssue({
            code: 'custom',
            path: [field],
            message: `${field} must be omitted when kind is "${kind}" — ${what}`,
          });
        }
      }
    } else if (!data.prompt) {
      ctx.addIssue({
        code: 'custom',
        path: ['prompt'],
        message: 'prompt is required when kind is "prompt"',
      });
    }
  });

const updateSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    cron: z.string().trim().min(1).max(200).optional(),
    prompt: z.string().trim().min(1).max(20_000).optional(),
    kind: apiScheduleKind.optional(),
    script: z.string().trim().min(1).max(50_000).optional(),
    enabled: z.boolean().optional(),
    targetProjectSlug: z.string().trim().min(1).max(200).nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).nullable().optional(),
    templateKey: z.string().trim().min(1).max(200).nullable().optional(),
    params: z.record(z.string(), z.unknown()).nullable().optional(),
    mode: scheduleMode.optional(),
  })
  .strict()
  .refine((o) => Object.keys(o).length > 0, { message: 'no fields to update' })
  .superRefine((data, ctx) => {
    // Only catch the obviously-wrong combination within THIS patch — full
    // consistency against the persisted row (e.g. kind already 'script' on
    // the row, patch only sets `enabled`) is enforced in updateSchedule().
    if (data.kind === 'script' && data.prompt !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['prompt'],
        message: 'prompt must be omitted when kind is "script"',
      });
    }
    if (data.kind === 'prompt' && data.script !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['script'],
        message: 'script must be omitted when kind is "prompt"',
      });
    }
  });

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
    const rows = await listSchedules(
      projectId,
      c.get('userId'),
      enabled === 'true' ? true : enabled === 'false' ? false : undefined,
    );
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
    const result = await runScheduleNow(id, {
      userId: c.get('userId'),
      viaTokenId: c.get('patTokenId') ?? null,
    });
    return c.json(result, 202);
  },
);
