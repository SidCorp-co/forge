import { zValidator } from '@hono/zod-validator';
import { and, count, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { usageRecords, usageSources } from '../db/schema.js';
import { setTotalCount } from '../lib/pagination.js';
import { loadProjectAccess } from '../lib/project-access.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { estimateCost } from './pricing.js';

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
    sessionId: z.string().min(1).max(500).nullable().optional(),
    projectName: z.string().max(500).nullable().optional(),
    recordedAt: z.coerce.date(),
    estimatedCost: z.number().min(0).optional(),
  })
  .strict();

const bulkSchema = z
  .object({
    records: z.array(recordCreateSchema).min(1).max(500),
  })
  .strict();

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const forbidden = (message: string) =>
  new HTTPException(403, { message, cause: { code: 'FORBIDDEN' } });

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

export const usageRecordRoutes = new Hono<{ Variables: AuthVars }>();
usageRecordRoutes.use('*', requireAuth(), assertEmailVerified());

usageRecordRoutes.get(
  '/',
  zValidator('query', listQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId, source, model, from, to, page, pageSize } = c.req.valid('query');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    if (!access.role && access.ownerId !== userId) throw forbidden('not a project member');

    const conditions: SQL[] = [eq(usageRecords.projectId, projectId)];
    if (source) conditions.push(eq(usageRecords.source, source));
    if (model) conditions.push(eq(usageRecords.model, model));
    if (from) conditions.push(gte(usageRecords.recordedAt, from));
    if (to) conditions.push(lte(usageRecords.recordedAt, to));

    const offset = (page - 1) * pageSize;

    const [rows, [totalRow]] = await Promise.all([
      db
        .select()
        .from(usageRecords)
        .where(and(...conditions))
        .orderBy(desc(usageRecords.recordedAt))
        .limit(pageSize)
        .offset(offset),
      db
        .select({ n: count() })
        .from(usageRecords)
        .where(and(...conditions)),
    ]);

    setTotalCount(c, totalRow?.n ?? 0);
    return c.json(rows);
  },
);

usageRecordRoutes.get(
  '/summary',
  zValidator('query', summaryQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId, days } = c.req.valid('query');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    if (!access.role && access.ownerId !== userId) throw forbidden('not a project member');

    const fromDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const conditions = [
      eq(usageRecords.projectId, projectId),
      gte(usageRecords.recordedAt, fromDate),
    ];

    const [totals] = await db
      .select({
        inputTokens: sql<number>`coalesce(sum(${usageRecords.inputTokens}), 0)`.mapWith(Number),
        outputTokens: sql<number>`coalesce(sum(${usageRecords.outputTokens}), 0)`.mapWith(Number),
        estimatedCost: sql<number>`coalesce(sum(${usageRecords.estimatedCost}), 0)`.mapWith(Number),
        requests: sql<number>`coalesce(sum(${usageRecords.requestCount}), 0)`.mapWith(Number),
      })
      .from(usageRecords)
      .where(and(...conditions));

    const daily = await db
      .select({
        date: sql<string>`to_char(date_trunc('day', ${usageRecords.recordedAt}), 'YYYY-MM-DD')`,
        input: sql<number>`coalesce(sum(${usageRecords.inputTokens}), 0)`.mapWith(Number),
        output: sql<number>`coalesce(sum(${usageRecords.outputTokens}), 0)`.mapWith(Number),
        cost: sql<number>`coalesce(sum(${usageRecords.estimatedCost}), 0)`.mapWith(Number),
        requests: sql<number>`coalesce(sum(${usageRecords.requestCount}), 0)`.mapWith(Number),
      })
      .from(usageRecords)
      .where(and(...conditions))
      .groupBy(sql`date_trunc('day', ${usageRecords.recordedAt})`)
      .orderBy(sql`date_trunc('day', ${usageRecords.recordedAt})`);

    const byModel = await db
      .select({
        model: usageRecords.model,
        input: sql<number>`coalesce(sum(${usageRecords.inputTokens}), 0)`.mapWith(Number),
        output: sql<number>`coalesce(sum(${usageRecords.outputTokens}), 0)`.mapWith(Number),
        cost: sql<number>`coalesce(sum(${usageRecords.estimatedCost}), 0)`.mapWith(Number),
        requests: sql<number>`coalesce(sum(${usageRecords.requestCount}), 0)`.mapWith(Number),
      })
      .from(usageRecords)
      .where(and(...conditions))
      .groupBy(usageRecords.model);

    const bySource = await db
      .select({
        source: usageRecords.source,
        input: sql<number>`coalesce(sum(${usageRecords.inputTokens}), 0)`.mapWith(Number),
        output: sql<number>`coalesce(sum(${usageRecords.outputTokens}), 0)`.mapWith(Number),
        cost: sql<number>`coalesce(sum(${usageRecords.estimatedCost}), 0)`.mapWith(Number),
        requests: sql<number>`coalesce(sum(${usageRecords.requestCount}), 0)`.mapWith(Number),
      })
      .from(usageRecords)
      .where(and(...conditions))
      .groupBy(usageRecords.source);

    return c.json({
      totals: totals ?? { inputTokens: 0, outputTokens: 0, estimatedCost: 0, requests: 0 },
      daily,
      byModel,
      bySource,
    });
  },
);

usageRecordRoutes.get(
  '/:id',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const [row] = await db.select().from(usageRecords).where(eq(usageRecords.id, id)).limit(1);
    if (!row) throw notFound('usage record not found');

    if (row.projectId) {
      const access = await loadProjectAccess(row.projectId, userId);
      if (!access.role && access.ownerId !== userId) throw forbidden('not a project member');
    }

    return c.json(row);
  },
);

usageRecordRoutes.post(
  '/',
  zValidator('json', recordCreateSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const input = c.req.valid('json');
    const userId = c.get('userId');

    if (input.projectId) {
      const access = await loadProjectAccess(input.projectId, userId);
      if (!access.role && access.ownerId !== userId) throw forbidden('not a project member');
    }

    const cost =
      input.estimatedCost ??
      estimateCost(input.model, {
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        cacheReadTokens: input.cacheReadTokens,
        cacheCreationTokens: input.cacheCreationTokens,
      });

    const [inserted] = await db
      .insert(usageRecords)
      .values({
        projectId: input.projectId ?? null,
        source: input.source,
        model: input.model,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        cacheReadTokens: input.cacheReadTokens,
        cacheCreationTokens: input.cacheCreationTokens,
        estimatedCost: cost,
        requestCount: input.requestCount,
        sessionId: input.sessionId ?? null,
        projectName: input.projectName ?? null,
        recordedAt: input.recordedAt,
      })
      .returning();
    if (!inserted) throw new Error('usage_records: insert returned no row');

    return c.json(inserted, 201);
  },
);

usageRecordRoutes.post(
  '/bulk',
  zValidator('json', bulkSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { records } = c.req.valid('json');
    const userId = c.get('userId');

    // Authorise once per distinct project the caller submits.
    const projectIds = Array.from(
      new Set(records.map((r) => r.projectId).filter((p): p is string => !!p)),
    );
    for (const projectId of projectIds) {
      const access = await loadProjectAccess(projectId, userId);
      if (!access.role && access.ownerId !== userId) throw forbidden('not a project member');
    }

    const values = records.map((r) => ({
      projectId: r.projectId ?? null,
      source: r.source,
      model: r.model,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      cacheReadTokens: r.cacheReadTokens,
      cacheCreationTokens: r.cacheCreationTokens,
      estimatedCost:
        r.estimatedCost ??
        estimateCost(r.model, {
          inputTokens: r.inputTokens,
          outputTokens: r.outputTokens,
          cacheReadTokens: r.cacheReadTokens,
          cacheCreationTokens: r.cacheCreationTokens,
        }),
      requestCount: r.requestCount,
      sessionId: r.sessionId ?? null,
      projectName: r.projectName ?? null,
      recordedAt: r.recordedAt,
    }));

    const inserted = await db.insert(usageRecords).values(values).returning({ id: usageRecords.id });
    return c.json({ count: inserted.length });
  },
);

usageRecordRoutes.post(
  '/ingest-cli',
  zValidator('json', bulkSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    // Same shape as /bulk but tagged source semantics — desktop runners post
    // local JSONL parses here. Auth = same project-member gate per record.
    const { records } = c.req.valid('json');
    const userId = c.get('userId');

    const projectIds = Array.from(
      new Set(records.map((r) => r.projectId).filter((p): p is string => !!p)),
    );
    for (const projectId of projectIds) {
      const access = await loadProjectAccess(projectId, userId);
      if (!access.role && access.ownerId !== userId) throw forbidden('not a project member');
    }

    const values = records.map((r) => ({
      projectId: r.projectId ?? null,
      source: 'cli' as const,
      model: r.model,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      cacheReadTokens: r.cacheReadTokens,
      cacheCreationTokens: r.cacheCreationTokens,
      estimatedCost:
        r.estimatedCost ??
        estimateCost(r.model, {
          inputTokens: r.inputTokens,
          outputTokens: r.outputTokens,
          cacheReadTokens: r.cacheReadTokens,
          cacheCreationTokens: r.cacheCreationTokens,
        }),
      requestCount: r.requestCount,
      sessionId: r.sessionId ?? null,
      projectName: r.projectName ?? null,
      recordedAt: r.recordedAt,
    }));

    const inserted = await db.insert(usageRecords).values(values).returning({ id: usageRecords.id });
    return c.json({ ingested: inserted.length, scanned: records.length });
  },
);
