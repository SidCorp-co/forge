import { zValidator } from '@hono/zod-validator';
import { and, asc, eq, gt, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { withKernelMarker } from '../db/kernel-marker.js';
import type { JobStatus } from '../db/schema.js';
import {
  agentSessions,
  jobEventKinds,
  jobEvents,
  jobs,
  type SessionRuntimeState,
  sessionRuntimeStates,
  terminalAgentSessionStatuses,
} from '../db/schema.js';
import { assertProjectRole, loadProjectAccess } from '../lib/authz.js';
import { logger } from '../logger.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { type DeviceVars, requireDevice } from '../middleware/require-device.js';
import { projectRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';
import { broadcastSessionEvent } from './agent-session-link.js';
import { readJobGate } from './job-queries.js';
import { maybeDeriveIncremental } from './session-transcript.js';
import { TERMINAL_JOB_STATUSES } from './status-sets.js';

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

const TERMINAL_STATUSES = new Set<JobStatus>(TERMINAL_JOB_STATUSES);

const eventsListQuerySchema = z
  .object({
    sinceSeq: z.coerce.number().int().min(0).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(200),
  })
  .strict();

export const jobEventsRoutes = new Hono<{ Variables: DeviceVars }>();

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

    const job = await readJobGate(jobId);
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

function runtimeStateOf(e: { kind: string; data?: unknown }): SessionRuntimeState | undefined {
  if (e.kind !== 'progress') return undefined;
  const d = e.data as { runtimeState?: unknown } | null | undefined;
  const raw = d?.runtimeState;
  return (sessionRuntimeStates as readonly unknown[]).includes(raw)
    ? (raw as SessionRuntimeState)
    : undefined;
}

function isParkEvent(e: { kind: string; data?: unknown }): boolean {
  return runtimeStateOf(e) === 'awaiting_input';
}

/** The runtime states that report a turn ran, as against one that reports the process only. */
const TURN_RUNTIME_STATES: ReadonlySet<SessionRuntimeState> = new Set(['working', 'checkpointing']);

/** The frame kinds that are the agent's own output, and so cannot exist unless a turn was asked. */
const TURN_EVENT_KINDS: ReadonlySet<string> = new Set([
  'stdout',
  'stderr',
  'tool_call',
  'tool_result',
  'result',
]);

/**
 * Whether this frame reports that a turn BEGAN, as against reporting that the
 * box is alive.
 */
function isTurnEvidence(e: { kind: string; data?: unknown }): boolean {
  if (e.kind === 'progress') {
    const state = runtimeStateOf(e);
    return state !== undefined && TURN_RUNTIME_STATES.has(state);
  }
  return TURN_EVENT_KINDS.has(e.kind);
}

function isPartialStreamEvent(e: { kind: string; data?: unknown }): boolean {
  if (e.kind !== 'stdout') return false;
  const line = (e.data as { line?: { type?: unknown } } | null | undefined)?.line;
  return line?.type === 'stream_event';
}

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

    const job = await readJobGate(jobId);
    if (!job) throw notFound('job not found');
    if (job.deviceId !== device.id) {
      throw forbidden('job is not dispatched to this device');
    }
    if (
      TERMINAL_STATUSES.has(job.status as typeof TERMINAL_STATUSES extends Set<infer T> ? T : never)
    ) {
      throw conflict('job is in a terminal state', 'JOB_TERMINATED');
    }

    const persisted = events.filter((e) => !isPartialStreamEvent(e));

    const inserted =
      persisted.length === 0
        ? []
        : await db.transaction(async (tx) => {
            await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${jobId}))`);
            const maxRows = await tx.execute<{ max_seq: number | null }>(sql`
        SELECT COALESCE(MAX(seq), 0) AS max_seq
        FROM job_events
        WHERE job_id = ${jobId}
      `);
            const first = maxRows[0] as { max_seq: number | string | null } | undefined;
            const baseSeq = Number(first?.max_seq ?? 0);

            const values = persisted.map((e, i) => ({
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

    if (job.ackedAt === null) {
      try {
        await db
          .update(jobs)
          .set({
            ackedAt: new Date(),
            killRequestedAt: null,
            killConfirmedAt: null,
            killOutcome: null,
          })
          .where(and(eq(jobs.id, jobId), isNull(jobs.ackedAt)));
      } catch (err) {
        logger.warn({ err, jobId }, 'job-events: ack fallback stamp failed (continuing)');
      }
    }

    const linkedSessionId = job.agentSessionId;
    if (linkedSessionId && events.some((e) => !isParkEvent(e))) {
      try {
        const heartbeatNow = new Date();
        const sawTurn = events.some(isTurnEvidence);
        const previous = db.$with('prev').as(
          db
            .select({ id: agentSessions.id, status: agentSessions.status })
            .from(agentSessions)
            .where(
              and(
                eq(agentSessions.id, linkedSessionId),
                inArray(agentSessions.status, ['queued', 'running']),
              ),
            )
            .for('update'),
        );
        const flip = sawTurn
          ? {
              status: 'running' as const,
              startedAt: sql`CASE WHEN ${previous.status} = 'queued' THEN ${heartbeatNow.toISOString()}::timestamptz ELSE ${agentSessions.startedAt} END`,
            }
          : {};
        const beat = await withKernelMarker(db, async (tx) =>
          tx
            .with(previous)
            .update(agentSessions)
            .set({
              ...flip,
              lastHeartbeatAt: heartbeatNow,
              updatedAt: heartbeatNow,
            })
            .from(previous)
            .where(eq(agentSessions.id, previous.id))
            .returning({
              id: agentSessions.id,
              projectId: agentSessions.projectId,
              deviceId: agentSessions.deviceId,
              startedRunning: sawTurn
                ? sql<boolean>`${previous.status} = 'queued'`
                : sql<boolean>`false`,
            }),
        );
        const beaten = beat[0];
        if (beaten?.startedRunning) {
          broadcastSessionEvent(
            beaten.id,
            beaten.projectId,
            beaten.deviceId,
            'agent-session.status',
            { status: 'running' },
          );
        }
      } catch (err) {
        logger.warn(
          { err, jobId, agentSessionId: job.agentSessionId },
          'events-routes: agent_sessions heartbeat sync failed',
        );
      }
    }

    if (job.agentSessionId) {
      const reported = events.reduce<SessionRuntimeState | undefined>(
        (acc, e) => runtimeStateOf(e) ?? acc,
        undefined,
      );
      if (reported) {
        try {
          await db
            .update(agentSessions)
            .set({ runtimeState: reported, updatedAt: new Date() })
            .where(
              and(
                eq(agentSessions.id, job.agentSessionId),
                notInArray(agentSessions.status, [...terminalAgentSessionStatuses]),
              ),
            );
        } catch (err) {
          logger.warn({ err, jobId, reported }, 'events-routes: runtime-state sync failed');
        }
      }
    }

    if (job.agentSessionId) {
      const stdoutCount = events.reduce((n, e) => (e.kind === 'stdout' ? n + 1 : n), 0);
      void maybeDeriveIncremental(jobId, job.agentSessionId, stdoutCount);
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
