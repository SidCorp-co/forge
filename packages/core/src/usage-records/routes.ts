import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { usageSources } from '../db/schema.js';
import { loadProjectAccess } from '../lib/authz.js';
import { listResponse } from '../lib/pagination.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { zValidator } from '../middleware/zod-validator.js';
import { findUsageRecord, listUsageRecords, readUsageSummary } from './read.js';
import { recordUsage, recordUsageBatch } from './service.js';
import { requireHeld } from '../permissions/index.js';

const idParamSchema = z.object({ id: z.uuid() });

const listQuerySchema = z
  .object({
    projectId: z.uuid(),
    source: z.enum(usageSources).optional(),
    model: z.string().min(1).optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

const summaryQuerySchema = z
  .object({
    projectId: z.uuid(),
    days: z.coerce.number().int().min(1).max(90).default(7),
  })
  .strict();

const sessionIdField = z
  .uuid({
    error: (iss) =>
      `${iss.path?.join('.') || 'sessionId'} must be an agent_sessions.id — a canonical uuid, like ` +
      `0f9e6d2a-4b1c-4f77-9a3e-2c5b81d7e004 — or null; got ` +
      JSON.stringify(String(iss.input).slice(0, 64)),
  })
  // A uuid is the same id in either case, so an uppercase spelling is canonicalised rather than
  // refused; anything that is not a uuid at all is the caller's contract break and is refused.
  .transform((v) => v.toLowerCase());

const recordCreateSchema = z
  .object({
    projectId: z.uuid().nullable().optional(),
    source: z.enum(usageSources),
    model: z.string().min(1).max(200),
    inputTokens: z.number().int().min(0).default(0),
    outputTokens: z.number().int().min(0).default(0),
    cacheReadTokens: z.number().int().min(0).default(0),
    cacheCreationTokens: z.number().int().min(0).default(0),
    requestCount: z.number().int().min(1).default(1),
    sessionId: sessionIdField.nullable().optional(),
    projectName: z.string().max(500).nullable().optional(),
    recordedAt: z.coerce.date(),
    estimatedCost: z.number().min(0).optional(),
  })
  .strict();

const bulkSchema = z
  .object({
    records: z
      .array(recordCreateSchema.extend({ projectId: z.uuid() }))
      .min(1)
      .max(500),
  })
  .strict();

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

export const usageRecordRoutes = new Hono<{ Variables: AuthVars }>();
usageRecordRoutes.use('*', requireAuth(), assertEmailVerified());

usageRecordRoutes.get(
  '/',
  zValidator('query', listQuerySchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const { projectId, source, model, from, to, page, pageSize } = c.req.valid('query');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    requireHeld(access, 'project.read');

    const offset = (page - 1) * pageSize;
    const { rows, total } = await listUsageRecords({
      projectId,
      source,
      model,
      from,
      to,
      limit: pageSize,
      offset,
    });
    return c.json(listResponse(c, rows, total, { limit: pageSize, offset }));
  },
);

usageRecordRoutes.get(
  '/summary',
  zValidator('query', summaryQuerySchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const { projectId, days } = c.req.valid('query');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    requireHeld(access, 'project.read');

    return c.json(await readUsageSummary(projectId, days));
  },
);

usageRecordRoutes.get(
  '/:id',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const row = await findUsageRecord(id);
    if (!row) throw notFound('usage record not found');

    if (!row.projectId) throw notFound('usage record not found');

    const access = await loadProjectAccess(row.projectId, userId);
    requireHeld(access, 'project.read');

    return c.json(row);
  },
);

usageRecordRoutes.post(
  '/',
  zValidator('json', recordCreateSchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const input = c.req.valid('json');
    const userId = c.get('userId');

    if (!input.projectId) {
      throw badRequest({ projectId: 'required' });
    }
    const access = await loadProjectAccess(input.projectId, userId);
    requireHeld(access, 'project.write');

    return c.json(await recordUsage(input), 201);
  },
);

usageRecordRoutes.post(
  '/bulk',
  zValidator('json', bulkSchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const { records } = c.req.valid('json');
    const userId = c.get('userId');

    const projectIds = Array.from(
      new Set(records.map((r) => r.projectId).filter((p): p is string => !!p)),
    );
    for (const projectId of projectIds) {
      const access = await loadProjectAccess(projectId, userId);
      requireHeld(access, 'project.write');
    }

    return c.json({ count: await recordUsageBatch(records) });
  },
);

usageRecordRoutes.post(
  '/ingest-cli',
  zValidator('json', bulkSchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const { records } = c.req.valid('json');
    const userId = c.get('userId');

    const projectIds = Array.from(
      new Set(records.map((r) => r.projectId).filter((p): p is string => !!p)),
    );
    for (const projectId of projectIds) {
      const access = await loadProjectAccess(projectId, userId);
      requireHeld(access, 'project.write');
    }

    const ingested = await recordUsageBatch(records, 'cli');
    return c.json({ ingested, scanned: records.length });
  },
);
