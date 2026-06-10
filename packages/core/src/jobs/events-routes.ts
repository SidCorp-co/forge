import { zValidator } from '@hono/zod-validator';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { agentSessions, jobEventKinds, jobEvents, jobs } from '../db/schema.js';
import { assertProjectRole, loadProjectAccess } from '../lib/authz.js';
import { logger } from '../logger.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { type DeviceVars, requireDevice } from '../middleware/require-device.js';
import { projectRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';
import { broadcastSessionEvent } from './agent-session-link.js';
import { maybeDeriveIncremental } from './session-transcript.js';

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

const forbidden = (message: string) =>
  new HTTPException(403, { message, cause: { code: 'FORBIDDEN' } });

const conflict = (message: string, code: string) =>
  new HTTPException(409, { message, cause: { code } });

const jobIdParamSchema = z.object({ id: z.uuid() });

const eventInputSchema = z.object({
  kind: z.enum(jobEventKinds),
  data: z.record(z.string(), z.unknown()).default({}),
  ts: z.iso.datetime().optional(),
});

const eventBatchSchema = z
  .object({
    events: z.array(eventInputSchema).min(1).max(100),
  })
  .strict();

const TERMINAL_STATUSES = new Set(['done', 'failed', 'cancelled'] as const);

const eventsListQuerySchema = z
  .object({
    sinceSeq: z.coerce.number().int().min(0).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(200),
  })
  .strict();

export const jobEventsRoutes = new Hono<{ Variables: DeviceVars }>();

// GET /api/jobs/:id/events — replay endpoint for the WS client. Members of
// the job's project can read; device auth not required (reads are safe).
//
// Auth is applied per-handler (not via .use) so the middleware doesn't
// intercept POST /:id/events on the sibling device router.
export const jobEventsListRoutes = new Hono<{ Variables: AuthVars }>();
jobEventsListRoutes.get(
  '/:id/events',
  requireAuth(),
  assertEmailVerified(),
  zValidator('param', jobIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('query', eventsListQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id: jobId } = c.req.valid('param');
    const { sinceSeq, limit } = c.req.valid('query');
    const userId = c.get('userId');

    const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
    if (!job) throw notFound('job not found');

    const access = await loadProjectAccess(job.projectId, userId);
    assertProjectRole(access, 'viewer', 'not a project member');

    const whereClauses = [eq(jobEvents.jobId, jobId)];
    if (sinceSeq !== undefined) whereClauses.push(gt(jobEvents.seq, sinceSeq));
    const where = whereClauses.length === 1 ? whereClauses[0] : and(...whereClauses);

    const items = await db
      .select()
      .from(jobEvents)
      .where(where)
      .orderBy(asc(jobEvents.seq))
      .limit(limit);

    const lastSeq = items.length > 0 ? Number(items[items.length - 1]?.seq ?? 0) : (sinceSeq ?? 0);
    return c.json({ items, lastSeq });
  },
);

jobEventsRoutes.post(
  '/:id/events',
  requireDevice(),
  zValidator('param', jobIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', eventBatchSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id: jobId } = c.req.valid('param');
    const { events } = c.req.valid('json');
    const device = c.get('device');

    const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
    if (!job) throw notFound('job not found');
    if (job.deviceId !== device.id) {
      throw forbidden('job is not dispatched to this device');
    }
    if (
      TERMINAL_STATUSES.has(job.status as typeof TERMINAL_STATUSES extends Set<infer T> ? T : never)
    ) {
      throw conflict('job is in a terminal state', 'JOB_TERMINATED');
    }

    // Server-assigned monotonic seq. Postgres rejects FOR UPDATE on aggregates,
    // so serialize concurrent inserts for this jobId via a transaction-scoped
    // advisory lock keyed on the jobId hash. The lock auto-releases at COMMIT/ROLLBACK.
    const inserted = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${jobId}))`);
      const maxRows = await tx.execute<{ max_seq: number | null }>(sql`
        SELECT COALESCE(MAX(seq), 0) AS max_seq
        FROM job_events
        WHERE job_id = ${jobId}
      `);
      const first = maxRows[0] as { max_seq: number | string | null } | undefined;
      const baseSeq = Number(first?.max_seq ?? 0);

      const values = events.map((e, i) => ({
        jobId,
        kind: e.kind,
        data: e.data,
        seq: baseSeq + i + 1,
        ...(e.ts ? { ts: new Date(e.ts) } : {}),
      }));

      return tx.insert(jobEvents).values(values).returning();
    });

    // Post-commit broadcast. Iterate and publish; failures bubble (fail-fast).
    for (const row of inserted) {
      roomManager.publish(projectRoom(job.projectId), {
        event: 'job.event',
        data: {
          jobId,
          seq: row.seq,
          kind: row.kind,
          ts: row.ts,
          data: row.data,
        },
      });
    }

    // Heartbeat sync: bump the linked agent_sessions row so the zombie sweeper
    // doesn't kill an in-flight pipeline job. CAS queued→running on first event
    // stamps startedAt; later batches bump lastHeartbeatAt only. Best-effort —
    // failures here must not break event ingest.
    //
    // Why here and not in the desktop worker: the worker uses `jobId` as its
    // local session key and would need to know the linked `agentSessionId` to
    // PATCH the row directly. Doing it server-side keeps the worker oblivious
    // to the linkage; PR-B will surface `agentSessionId` to the worker so the
    // session row also gets messages/diff streamed live.
    if (job.agentSessionId) {
      try {
        const heartbeatNow = new Date();
        const flipped = await db
          .update(agentSessions)
          .set({
            status: 'running',
            startedAt: heartbeatNow,
            lastHeartbeatAt: heartbeatNow,
            updatedAt: heartbeatNow,
          })
          .where(
            and(
              eq(agentSessions.id, job.agentSessionId),
              eq(agentSessions.status, 'queued'),
            ),
          )
          .returning({
            id: agentSessions.id,
            projectId: agentSessions.projectId,
            deviceId: agentSessions.deviceId,
          });
        if (flipped.length > 0) {
          const row = flipped[0];
          if (row) {
            broadcastSessionEvent(
              row.id,
              row.projectId,
              row.deviceId,
              'agent-session.status',
              { status: 'running' },
            );
          }
        } else {
          // Already running (or terminal). Bump heartbeat only — guarded so we
          // don't revive cancelled/failed/completed rows.
          await db
            .update(agentSessions)
            .set({ lastHeartbeatAt: heartbeatNow, updatedAt: heartbeatNow })
            .where(
              and(
                eq(agentSessions.id, job.agentSessionId),
                eq(agentSessions.status, 'running'),
              ),
            );
        }
      } catch (err) {
        logger.warn(
          { err, jobId, agentSessionId: job.agentSessionId },
          'events-routes: agent_sessions heartbeat sync failed',
        );
      }
    }

    // ISS-283 — derive the canonical agent_sessions transcript from the stdout
    // lines the runner streams (CLI-run jobs never PATCH the session row
    // themselves). Throttled + fire-and-forget so it never blocks event ingest;
    // the final authoritative derive runs on job /complete | /fail.
    if (job.agentSessionId) {
      const stdoutCount = events.reduce((n, e) => (e.kind === 'stdout' ? n + 1 : n), 0);
      maybeDeriveIncremental(jobId, job.agentSessionId, stdoutCount);
    }

    const first = inserted[0];
    const last = inserted[inserted.length - 1];
    return c.json(
      {
        accepted: inserted.length,
        firstSeq: first?.seq ?? null,
        lastSeq: last?.seq ?? null,
      },
      200,
    );
  },
);
