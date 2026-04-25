import { zValidator } from '@hono/zod-validator';
import { and, asc, eq, gte, lte } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { activityLog, issues, jobs, usageRecords } from '../db/schema.js';
import { sql } from 'drizzle-orm';
import { enqueueJob } from '../jobs/enqueue.js';
import { isUniqueViolation } from '../lib/db-errors.js';
import { loadProjectAccess } from '../lib/project-access.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { logger } from '../logger.js';

const idParamSchema = z.object({ id: z.uuid() });

const pipelineTimingQuerySchema = z
  .object({
    projectId: z.uuid(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    limit: z.coerce.number().int().min(1).max(5000).default(1000),
  })
  .strict();

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

const forbidden = (message: string) =>
  new HTTPException(403, { message, cause: { code: 'FORBIDDEN' } });

export const issueExtrasRoutes = new Hono<{ Variables: AuthVars }>();
issueExtrasRoutes.use('*', requireAuth(), assertEmailVerified());

// POST /api/issues/:id/enrich
// Enqueues a custom job to re-run AI enrichment for the issue. The desktop
// device-runner picks the job off the queue. We do not run the LLM in-process.
issueExtrasRoutes.post(
  '/:id/enrich',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id: issueId } = c.req.valid('param');
    const userId = c.get('userId');

    const [issue] = await db
      .select({ id: issues.id, projectId: issues.projectId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .limit(1);
    if (!issue) throw notFound('issue not found');

    const access = await loadProjectAccess(issue.projectId, userId);
    if (!access.role && access.ownerId !== userId) throw forbidden('not a project member');

    let job: { id: string; status: string } | undefined;
    try {
      const [row] = await db
        .insert(jobs)
        .values({
          projectId: issue.projectId,
          issueId: issue.id,
          createdBy: userId,
          type: 'custom',
          payload: { kind: 'enrich', issueId: issue.id },
          status: 'queued',
        })
        .returning({ id: jobs.id, status: jobs.status });
      job = row;
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new HTTPException(409, {
          message: 'enrich already queued for this issue',
          cause: { code: 'ENRICH_ALREADY_QUEUED' },
        });
      }
      throw err;
    }
    if (!job) throw new Error('jobs: insert returned no row');

    try {
      await enqueueJob(job.id);
    } catch (err) {
      logger.error({ err, jobId: job.id }, 'enrich: enqueueJob failed; row persisted');
    }

    return c.json({ issueId: issue.id, jobId: job.id, status: job.status }, 202);
  },
);

// GET /api/issues/pipeline-timing?projectId=...&from=...&to=...
// Aggregates dwell time per status from activity_log status-change events.
// For each issue, sorts transitions by time and computes (next.at - current.at)
// as the dwell time of `current.from` status. Returns avg/median/p90 per status.
issueExtrasRoutes.get(
  '/pipeline-timing',
  zValidator('query', pipelineTimingQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId, from, to, limit } = c.req.valid('query');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    if (!access.role && access.ownerId !== userId) throw forbidden('not a project member');

    const conditions = [
      eq(issues.projectId, projectId),
      eq(activityLog.action, 'issue.statusChanged'),
    ];
    if (from) conditions.push(gte(activityLog.createdAt, from));
    if (to) conditions.push(lte(activityLog.createdAt, to));

    const rows = await db
      .select({
        issueId: activityLog.issueId,
        payload: activityLog.payload,
        createdAt: activityLog.createdAt,
      })
      .from(activityLog)
      .innerJoin(issues, eq(issues.id, activityLog.issueId))
      .where(and(...conditions))
      .orderBy(asc(activityLog.issueId), asc(activityLog.createdAt))
      .limit(limit);

    type Row = (typeof rows)[number];
    const perStatus = new Map<string, number[]>();

    let cursor = 0;
    while (cursor < rows.length) {
      const issueId = rows[cursor]!.issueId;
      const group: Row[] = [];
      while (cursor < rows.length && rows[cursor]!.issueId === issueId) {
        group.push(rows[cursor]!);
        cursor++;
      }
      for (let i = 0; i < group.length - 1; i++) {
        const cur = group[i]!;
        const next = group[i + 1]!;
        const status = (cur.payload as { from?: string } | null)?.from;
        if (!status) continue;
        const ms = next.createdAt.getTime() - cur.createdAt.getTime();
        if (ms < 0) continue;
        let bucket = perStatus.get(status);
        if (!bucket) {
          bucket = [];
          perStatus.set(status, bucket);
        }
        bucket.push(ms);
      }
    }

    const stats = [...perStatus.entries()].map(([status, samples]) => {
      samples.sort((a, b) => a - b);
      const sum = samples.reduce((s, v) => s + v, 0);
      const avg = samples.length === 0 ? 0 : sum / samples.length;
      const median = samples.length === 0 ? 0 : samples[Math.floor(samples.length / 2)] ?? 0;
      const p90Index = Math.min(samples.length - 1, Math.floor(samples.length * 0.9));
      const p90 = samples.length === 0 ? 0 : samples[p90Index] ?? 0;
      return {
        status,
        sampleCount: samples.length,
        avgMs: Math.round(avg),
        medianMs: median,
        p90Ms: p90,
      };
    });

    stats.sort((a, b) => a.status.localeCompare(b.status));

    return c.json({ projectId, stats });
  },
);

// GET /api/issues/:id/cost-summary
// Joins usage_records.session_id ↔ jobs.id to roll up estimated cost +
// token totals for any usage row tagged with one of this issue's job ids.
issueExtrasRoutes.get(
  '/:id/cost-summary',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id: issueId } = c.req.valid('param');
    const userId = c.get('userId');

    const [issue] = await db
      .select({ id: issues.id, projectId: issues.projectId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .limit(1);
    if (!issue) throw notFound('issue not found');

    const access = await loadProjectAccess(issue.projectId, userId);
    if (!access.role && access.ownerId !== userId) throw forbidden('not a project member');

    const [totals] = await db
      .select({
        estimatedCost: sql<number>`coalesce(sum(${usageRecords.estimatedCost}), 0)`.mapWith(Number),
        inputTokens: sql<number>`coalesce(sum(${usageRecords.inputTokens}), 0)`.mapWith(Number),
        outputTokens: sql<number>`coalesce(sum(${usageRecords.outputTokens}), 0)`.mapWith(Number),
        cacheReadTokens:
          sql<number>`coalesce(sum(${usageRecords.cacheReadTokens}), 0)`.mapWith(Number),
        cacheCreationTokens:
          sql<number>`coalesce(sum(${usageRecords.cacheCreationTokens}), 0)`.mapWith(Number),
        requests: sql<number>`coalesce(sum(${usageRecords.requestCount}), 0)`.mapWith(Number),
        sampleCount: sql<number>`count(${usageRecords.id})`.mapWith(Number),
      })
      .from(usageRecords)
      .innerJoin(jobs, eq(jobs.id, sql`${usageRecords.sessionId}::uuid`))
      .where(eq(jobs.issueId, issueId));

    return c.json({
      issueId,
      projectId: issue.projectId,
      ...(totals ?? {
        estimatedCost: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        requests: 0,
        sampleCount: 0,
      }),
    });
  },
);
