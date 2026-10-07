import { TERMINAL_JOB_STATUSES } from '@forge/contracts/job-machine';
import { Hono } from 'hono';
import { z } from 'zod';
import { maybeDeriveIncremental, setSessionRuntimeState } from '../agent-sessions/index.js';
import type { JobStatus } from '../db/schema.js';
import {
  DEVICE_POSTED_JOB_EVENT_KINDS,
  type SessionRuntimeState,
  sessionRuntimeStates,
} from '../db/schema.js';
import { loadProjectAccess } from '../lib/authz.js';
import { publishEphemeral } from '../lib/ephemeral.js';
import { logger } from '../lib/logger.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { type DeviceVars, requireDevice } from '../middleware/require-device.js';
import { forbidden, notFound } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { requireHeld } from '../permissions/index.js';
import { CLAIM_MIN_RUNNER } from '../runners/index.js';
import { broadcastSessionEvent } from './agent-session-link.js';
import { jobEphemeralTarget } from './job-push.js';
import { readJobGate } from './job-queries.js';
import { scrubJobOutput } from './job-secret-scrub.js';
import { listJobEvents } from './read.js';
import { refuseJob } from './refusals.js';
import { appendJobEvents, beatLinkedSession, stampJobAckFromEvents } from './service.js';

const jobIdParamSchema = z.object({ id: z.uuid() });

const eventInputSchema = z.object({
  kind: z.enum(DEVICE_POSTED_JOB_EVENT_KINDS),
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
  zValidator('param', jobIdParamSchema),
  zValidator('query', eventsListQuerySchema),
  async (c) => {
    const { id: jobId } = c.req.valid('param');
    const { sinceSeq, limit } = c.req.valid('query');
    const userId = c.get('userId');

    const job = await readJobGate(jobId);
    if (!job) throw notFound('job not found');

    const access = await loadProjectAccess(job.projectId, userId);
    requireHeld(access, 'project.read');

    const items = await listJobEvents(jobId, sinceSeq, limit);

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

/**
 * A job's session never parks in its process: a box at the claim floor reports `working` or
 * `starting` for a pool job, and only a chat turn waits in a process between turns. A frame saying
 * otherwise is refused by name rather than leaving the session exempt from every clock.
 */
function assertNoJobPark(events: ReadonlyArray<{ kind: string; data?: unknown }>): void {
  if (!events.some(isParkEvent)) return;
  throw refuseJob(
    'JOB_SESSION_PARK_RETIRED',
    `a job's session does not wait in its process between turns, and this batch reports \`awaiting_input\` for one; a box claiming jobs reports \`working\` or \`starting\` (claim floor ${CLAIM_MIN_RUNNER}). Update forge-runner on this box.`,
    '/events',
  );
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

/**
 * The linked session hears the batch: a heartbeat, and the last reported runtime state. It runs
 * BEFORE the events are stored, and any failure fails the request: a refusal (409, which the
 * runner reads as disowned, for a session under a closed run) or a 500 the runner retries. Run
 * after the store, the same failure would either hide behind a 200 or make the runner's retry
 * store the batch twice.
 */
async function syncLinkedSession(
  sessionId: string,
  events: ReadonlyArray<{ kind: string; data?: unknown }>,
  deviceId: string,
): Promise<void> {
  const started = await beatLinkedSession(
    sessionId,
    new Date(),
    events.some(isTurnEvidence),
    deviceId,
  );
  if (started) {
    await broadcastSessionEvent(
      started.id,
      started.projectId,
      started.deviceId,
      'agent-session.status',
      {
        status: 'running',
      },
    );
  }
  const reported = events.reduce<SessionRuntimeState | undefined>(
    (acc, e) => runtimeStateOf(e) ?? acc,
    undefined,
  );
  if (reported) await setSessionRuntimeState(sessionId, reported);
}

jobEventsRoutes.post(
  '/:id/events',
  requireDevice(),
  zValidator('param', jobIdParamSchema),
  zValidator('json', eventBatchSchema),
  async (c) => {
    const { id: jobId } = c.req.valid('param');
    const { events } = c.req.valid('json');
    const device = c.get('device');

    const job = await readJobGate(jobId);
    if (!job) throw notFound('job not found');
    if (job.deviceId !== device.id) {
      throw forbidden('job is not dispatched to this device');
    }
    if (TERMINAL_STATUSES.has(job.status)) {
      throw refuseJob('JOB_TERMINATED', 'job is in a terminal state');
    }
    // A pool pane's heartbeat is the one channel to its box that a lost `job.cancel` frame
    // cannot take with it: the box closes the pane and acks the kill (`cancel-job.ts:
    // settleConfirmedCancel`).
    if (job.cancellationRequested) {
      throw refuseJob(
        'JOB_CANCEL_REQUESTED',
        'a cancel was requested for this job: close its process and post kill-ack `killed`',
      );
    }

    assertNoJobPark(events);
    if (job.agentSessionId) await syncLinkedSession(job.agentSessionId, events, device.id);

    const persisted = await scrubJobOutput(
      [jobId],
      events.filter((e) => !isPartialStreamEvent(e)),
    );

    const inserted = await appendJobEvents(jobId, persisted);

    // Live log lines are ephemeral (lib/ephemeral.ts): stored above, announced without the outbox,
    // to the readers its job's frames go to — a person's own chat never reaches the project room.
    if (inserted.length > 0) {
      const target = await jobEphemeralTarget(job);
      for (const row of inserted) {
        publishEphemeral(target, {
          event: 'job.event',
          data: {
            jobId,
            projectId: job.projectId,
            seq: row.seq,
            kind: row.kind,
            ts: row.ts,
            data: row.data,
          },
        });
      }
    }

    if (job.ackedAt === null) {
      try {
        await stampJobAckFromEvents(jobId);
      } catch (err) {
        logger.warn({ err, jobId }, 'job-events: ack fallback stamp failed (continuing)');
      }
    }

    if (job.agentSessionId) {
      const stdoutCount = events.reduce((n, e) => (e.kind === 'stdout' ? n + 1 : n), 0);
      void maybeDeriveIncremental(jobId, job.agentSessionId, stdoutCount);
    }

    return c.json({
      accepted: inserted.length,
      firstSeq: inserted[0]?.seq ?? null,
      lastSeq: inserted[inserted.length - 1]?.seq ?? null,
    });
  },
);
