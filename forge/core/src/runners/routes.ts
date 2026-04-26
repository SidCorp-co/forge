import { createHmac, timingSafeEqual } from 'node:crypto';
import { zValidator } from '@hono/zod-validator';
import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import {
  type RunnerStatus,
  type RunnerType,
  jobEvents,
  jobs,
  runnerHosts,
  runnerStatuses,
  runnerTypes,
  runners,
} from '../db/schema.js';
import { isEnabled } from '../lib/feature-flags.js';
import { loadProjectAccess } from '../lib/project-access.js';
import { logger } from '../logger.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { roomManager } from '../ws/server.js';
import { projectRoom } from '../ws/rooms.js';
import { normalizeAntigravityEvent } from './event-normalizer.js';
import { getRunnerAdapter, listRunnerTypes } from './registry.js';
import type { Runner } from './types.js';

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const notFound = () =>
  new HTTPException(404, { message: 'runner not found', cause: { code: 'NOT_FOUND' } });

const forbidden = (msg: string) =>
  new HTTPException(403, { message: msg, cause: { code: 'FORBIDDEN' } });

const flagOff = () =>
  new HTTPException(404, { message: 'runner framework disabled', cause: { code: 'FEATURE_OFF' } });

function rowToRunner(r: typeof runners.$inferSelect): Runner {
  return {
    id: r.id,
    projectId: r.projectId,
    type: r.type,
    host: r.host,
    deviceId: r.deviceId,
    name: r.name,
    labels: Array.isArray(r.labels) ? (r.labels as string[]) : [],
    capabilities: (r.capabilities ?? {}) as Record<string, unknown>,
    config: (r.config ?? {}) as Record<string, unknown>,
    status: r.status,
    lastSeenAt: r.lastSeenAt,
    lastError: r.lastError,
  };
}

function publicRunner(r: Runner): Omit<Runner, 'config'> & { config: Record<string, unknown> } {
  // Strip secrets before returning over the wire.
  const config = { ...r.config };
  if ('apiKey' in config) config.apiKey = '***';
  if ('callbackSecret' in config) config.callbackSecret = '***';
  return { ...r, config };
}

const createBody = z
  .object({
    projectId: z.uuid(),
    type: z.enum(runnerTypes),
    host: z.enum(runnerHosts),
    name: z.string().min(1).max(120),
    deviceId: z.uuid().optional(),
    labels: z.array(z.string()).optional(),
    capabilities: z.record(z.string(), z.unknown()).optional(),
    config: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

const patchBody = z
  .object({
    name: z.string().min(1).max(120).optional(),
    labels: z.array(z.string()).optional(),
    capabilities: z.record(z.string(), z.unknown()).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    status: z.enum(['draining', 'disabled', 'offline', 'online']).optional(),
  })
  .strict();

const idParam = z.object({ id: z.uuid() });

const listQuery = z.object({
  projectId: z.uuid().optional(),
  type: z.enum(runnerTypes).optional(),
  status: z.enum(runnerStatuses).optional(),
});

export const runnerRoutes = new Hono<{ Variables: AuthVars }>();

runnerRoutes.use('*', async (c, next) => {
  if (!isEnabled('runnerFramework')) throw flagOff();
  await next();
});

runnerRoutes.use('*', requireAuth(), assertEmailVerified());

runnerRoutes.get(
  '/types',
  async (c) => {
    const types = listRunnerTypes().map((a) => ({
      type: a.type,
      configSchema: 'configSchema' in a && a.configSchema ? '<zod>' : null,
    }));
    return c.json({ types });
  },
);

runnerRoutes.get(
  '/',
  zValidator('query', listQuery, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const userId = c.get('userId');
    const q = c.req.valid('query');
    const filters = [];
    if (q.projectId) {
      // Verify access first.
      const access = await loadProjectAccess(q.projectId, userId);
      if (!access.role) throw forbidden('not a project member');
      filters.push(eq(runners.projectId, q.projectId));
    } else {
      // No projectId filter — return runners across the user's projects only.
      // For simplicity in v1, require explicit projectId. Without it, return [].
      return c.json({ runners: [] });
    }
    if (q.type) filters.push(eq(runners.type, q.type as RunnerType));
    if (q.status) filters.push(eq(runners.status, q.status as RunnerStatus));
    const rows = await db
      .select()
      .from(runners)
      .where(and(...filters));
    return c.json({ runners: rows.map((r) => publicRunner(rowToRunner(r))) });
  },
);

runnerRoutes.get(
  '/:id',
  zValidator('param', idParam, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const userId = c.get('userId');
    const { id } = c.req.valid('param');
    const [row] = await db.select().from(runners).where(eq(runners.id, id)).limit(1);
    if (!row) throw notFound();
    const access = await loadProjectAccess(row.projectId, userId);
    if (!access.role) throw forbidden('not a project member');
    return c.json({ runner: publicRunner(rowToRunner(row)) });
  },
);

runnerRoutes.post(
  '/',
  zValidator('json', createBody, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const userId = c.get('userId');
    const input = c.req.valid('json');
    const access = await loadProjectAccess(input.projectId, userId);
    if (access.role !== 'owner' && access.role !== 'admin' && access.ownerId !== userId) {
      throw forbidden('owner or admin only');
    }

    const adapter = getRunnerAdapter(input.type);
    if (!adapter) throw badRequest({ type: 'no adapter registered for type' });

    const result = adapter.validateConfig(input.config);
    if (!result.ok) throw badRequest({ config: result.error });

    const [row] = await db
      .insert(runners)
      .values({
        projectId: input.projectId,
        type: input.type,
        host: input.host,
        deviceId: input.deviceId ?? null,
        name: input.name,
        labels: input.labels ?? [],
        capabilities: input.capabilities ?? {},
        config: result.config,
      })
      .returning();
    if (!row) throw new HTTPException(500, { message: 'insert failed' });

    roomManager.publish(projectRoom(input.projectId), {
      event: 'runner.created',
      data: { runnerId: row.id, type: row.type },
    });

    return c.json({ runner: publicRunner(rowToRunner(row)) }, 201);
  },
);

runnerRoutes.patch(
  '/:id',
  zValidator('param', idParam, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', patchBody, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const userId = c.get('userId');
    const { id } = c.req.valid('param');
    const input = c.req.valid('json');
    const [existing] = await db.select().from(runners).where(eq(runners.id, id)).limit(1);
    if (!existing) throw notFound();
    const access = await loadProjectAccess(existing.projectId, userId);
    if (access.role !== 'owner' && access.role !== 'admin' && access.ownerId !== userId) {
      throw forbidden('owner or admin only');
    }

    let nextConfig = existing.config as Record<string, unknown>;
    if (input.config) {
      const adapter = getRunnerAdapter(existing.type);
      if (!adapter) throw badRequest({ type: 'no adapter registered' });
      const merged = { ...nextConfig, ...input.config };
      const result = adapter.validateConfig(merged);
      if (!result.ok) throw badRequest({ config: result.error });
      nextConfig = result.config;
    }

    const update: Partial<typeof runners.$inferInsert> = { updatedAt: new Date() };
    if (input.name !== undefined) update.name = input.name;
    if (input.labels !== undefined) update.labels = input.labels;
    if (input.capabilities !== undefined) update.capabilities = input.capabilities;
    if (input.config) update.config = nextConfig;
    if (input.status !== undefined) update.status = input.status;

    const [row] = await db.update(runners).set(update).where(eq(runners.id, id)).returning();
    if (!row) throw notFound();

    roomManager.publish(projectRoom(row.projectId), {
      event: 'runner.updated',
      data: { runnerId: row.id, status: row.status },
    });

    return c.json({ runner: publicRunner(rowToRunner(row)) });
  },
);

runnerRoutes.delete(
  '/:id',
  zValidator('param', idParam, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const userId = c.get('userId');
    const { id } = c.req.valid('param');
    const [existing] = await db.select().from(runners).where(eq(runners.id, id)).limit(1);
    if (!existing) throw notFound();
    const access = await loadProjectAccess(existing.projectId, userId);
    if (access.ownerId !== userId && access.role !== 'owner') {
      throw forbidden('owner only');
    }
    await db.delete(runners).where(eq(runners.id, id));
    roomManager.publish(projectRoom(existing.projectId), {
      event: 'runner.deleted',
      data: { runnerId: id },
    });
    return c.json({ ok: true });
  },
);

runnerRoutes.post(
  '/:id/health-check',
  zValidator('param', idParam, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const userId = c.get('userId');
    const { id } = c.req.valid('param');
    const [existing] = await db.select().from(runners).where(eq(runners.id, id)).limit(1);
    if (!existing) throw notFound();
    const access = await loadProjectAccess(existing.projectId, userId);
    if (!access.role) throw forbidden('not a project member');
    const adapter = getRunnerAdapter(existing.type);
    if (!adapter) throw badRequest({ type: 'no adapter registered' });
    const result = await adapter.health({ runner: rowToRunner(existing) });
    return c.json(result);
  },
);

runnerRoutes.post(
  '/:id/refresh-quota',
  zValidator('param', idParam, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const userId = c.get('userId');
    const { id } = c.req.valid('param');
    const [existing] = await db.select().from(runners).where(eq(runners.id, id)).limit(1);
    if (!existing) throw notFound();
    const access = await loadProjectAccess(existing.projectId, userId);
    if (!access.role) throw forbidden('not a project member');
    const adapter = getRunnerAdapter(existing.type);
    if (!adapter || !adapter.refreshQuota) {
      return c.json({ remaining: null, limit: null });
    }
    const result = await adapter.refreshQuota({ runner: rowToRunner(existing) });
    if (Object.keys(result).length > 0) {
      const config = (existing.config ?? {}) as Record<string, unknown>;
      const next = {
        ...config,
        quota: { ...(config['quota'] as object | undefined), ...result, refreshedAt: new Date().toISOString() },
      };
      await db
        .update(runners)
        .set({ config: next, updatedAt: new Date() })
        .where(eq(runners.id, id));
    }
    return c.json(result);
  },
);

runnerRoutes.post(
  '/:id/exclude',
  zValidator('param', idParam, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const userId = c.get('userId');
    const { id } = c.req.valid('param');
    const [existing] = await db.select().from(runners).where(eq(runners.id, id)).limit(1);
    if (!existing) throw notFound();
    const access = await loadProjectAccess(existing.projectId, userId);
    if (!access.role) throw forbidden('not a project member');
    await db.update(runners).set({ status: 'disabled', updatedAt: new Date() }).where(eq(runners.id, id));
    return c.json({ ok: true });
  },
);

runnerRoutes.post(
  '/:id/include',
  zValidator('param', idParam, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const userId = c.get('userId');
    const { id } = c.req.valid('param');
    const [existing] = await db.select().from(runners).where(eq(runners.id, id)).limit(1);
    if (!existing) throw notFound();
    const access = await loadProjectAccess(existing.projectId, userId);
    if (!access.role) throw forbidden('not a project member');
    await db
      .update(runners)
      .set({ status: 'offline', updatedAt: new Date() })
      .where(eq(runners.id, id));
    return c.json({ ok: true });
  },
);

// HMAC-authenticated callback for the `antigravity` adapter (and any future
// remote runner). Body is the raw event stream; signature header proves the
// caller knows the per-runner `callbackSecret`.
const eventsBody = z
  .object({
    events: z
      .array(
        z.object({
          type: z.string(),
          data: z.record(z.string(), z.unknown()).optional(),
          timestamp: z.string().optional(),
          jobId: z.uuid().optional(),
        }),
      )
      .min(1),
  })
  .strict();

export const runnerCallbackRoutes = new Hono();

// In-memory replay shield: per-runner LRU of recently-seen signatures within
// the 5-min skew window. Multi-instance deployments would need redis here, but
// for v1 a per-process map is acceptable (worst case: replay across instances
// during the 5-min window; acceptable risk given the secret rotation path).
const REPLAY_WINDOW_MS = 5 * 60_000;
const replayCache = new Map<string, number>();

function isReplay(key: string): boolean {
  const now = Date.now();
  // Opportunistic eviction.
  if (replayCache.size > 5000) {
    for (const [k, ts] of replayCache) {
      if (now - ts > REPLAY_WINDOW_MS) replayCache.delete(k);
    }
  }
  const seen = replayCache.get(key);
  if (seen !== undefined && now - seen <= REPLAY_WINDOW_MS) return true;
  replayCache.set(key, now);
  return false;
}

export function clearReplayCacheForTest(): void {
  replayCache.clear();
}

runnerCallbackRoutes.post(
  '/:id/events',
  zValidator('param', idParam, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    if (!isEnabled('runnerFramework')) throw flagOff();
    const { id } = c.req.valid('param');
    const sigHeader = c.req.header('x-forge-signature') ?? '';
    const tsHeader = c.req.header('x-forge-timestamp') ?? '';
    const ts = Number.parseInt(tsHeader, 10);
    if (!sigHeader || !tsHeader || Number.isNaN(ts)) {
      throw new HTTPException(401, { message: 'missing signature' });
    }
    const skewMs = Math.abs(Date.now() - ts);
    if (skewMs > REPLAY_WINDOW_MS) {
      throw new HTTPException(401, { message: 'timestamp skew' });
    }
    const [existing] = await db.select().from(runners).where(eq(runners.id, id)).limit(1);
    if (!existing) throw notFound();
    const cfg = (existing.config ?? {}) as { callbackSecret?: string };
    if (!cfg.callbackSecret) throw new HTTPException(401, { message: 'no callback secret' });

    const raw = await c.req.text();
    const expected = createHmac('sha256', cfg.callbackSecret).update(raw).update(tsHeader).digest('hex');
    const expectedHeader = `sha256=${expected}`;
    const a = Buffer.from(sigHeader);
    const b = Buffer.from(expectedHeader);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new HTTPException(401, { message: 'bad signature' });
    }
    // Replay protection — reject the same (runner, signature) inside the
    // skew window.
    if (isReplay(`${id}:${sigHeader}`)) {
      throw new HTTPException(409, { message: 'replay detected' });
    }

    let bodyJson: unknown;
    try {
      bodyJson = JSON.parse(raw);
    } catch {
      throw badRequest({ body: 'malformed JSON' });
    }
    const parsed = eventsBody.safeParse(bodyJson);
    if (!parsed.success) throw badRequest(z.flattenError(parsed.error));
    const { events } = parsed.data;

    let persisted = 0;
    // Track per-job next-seq across this batch to avoid one query per event.
    const nextSeqByJob = new Map<string, number>();
    for (const ev of events) {
      const norm = normalizeAntigravityEvent({
        type: ev.type,
        data: ev.data ?? {},
        ...(ev.timestamp !== undefined ? { timestamp: ev.timestamp } : {}),
      });
      if (norm.length === 0) continue;
      const targetJobId = ev.jobId;
      if (!targetJobId) continue;
      const [job] = await db.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, targetJobId)).limit(1);
      if (!job) continue;
      let nextSeq = nextSeqByJob.get(targetJobId);
      if (nextSeq === undefined) {
        const seqRows = await db.execute<{ max_seq: number | null }>(
          sql`SELECT COALESCE(MAX(seq), 0) AS max_seq FROM job_events WHERE job_id = ${targetJobId}`,
        );
        const max = seqRows[0]?.max_seq ?? 0;
        nextSeq = (typeof max === 'number' ? max : Number(max)) + 1;
      }
      for (const n of norm) {
        await db.insert(jobEvents).values({
          jobId: targetJobId,
          kind: n.kind,
          data: n.data,
          seq: nextSeq,
        });
        nextSeq++;
        persisted++;
      }
      nextSeqByJob.set(targetJobId, nextSeq);
    }

    logger.info({ runnerId: id, events: events.length, persisted }, 'runner callback ingested');
    return c.json({ ok: true, persisted }, 202);
  },
);
