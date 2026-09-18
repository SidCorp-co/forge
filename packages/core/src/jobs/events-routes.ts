import { zValidator } from '@hono/zod-validator';
import { and, asc, eq, gt, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { withKernelMarker } from '../db/kernel-marker.js';
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

// cm:guard auth is applied PER-HANDLER, never with `.use` — a router-wide middleware here also intercepts `POST /:id/events` on the sibling device router, which authenticates a device rather than a user.
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

// cm:guard reads `data.runtimeState` by name out of an untyped jsonb payload — the runner writes that key in `daemon/dispatch.rs#map_event` and nothing type-checks the pair. A rename on either side does not fail: it silently makes every park count as activity again AND stops the column below ever being written.
// cm:guard a value the enum does not know is DROPPED, never written. The column is `text` with no database check, so an unrecognised string would persist and then read as "not parked" to the quiet-clock exemption and "not a park" to the residency deadline — a session invisible to both hops.
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
// cm:guard `starting` is NOT here and that is the whole membership rule: it is what `turn_evidence.rs` beats for a pane whose prompt was DELIVERED and never submitted, which is the reading this set exists to refuse. `closed` is not here either — a session that ended reports nothing about a turn having begun.
const TURN_RUNTIME_STATES: ReadonlySet<SessionRuntimeState> = new Set(['working', 'checkpointing']);

/** The frame kinds that are the agent's own output, and so cannot exist unless a turn was asked. */
// cm:guard an ALLOWLIST here, opposite to `isPartialStreamEvent`'s denylist, and the asymmetry is the point: that one decides what to STORE, where a missed kind is data lost forever, while this one decides what to ASSERT, where a missed kind costs a session the `running` reading until its next beat carries a state. A new kind is admitted here only once somebody can say a turn must have run for it to exist.
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
// cm:why ISS-1101 — `!isParkEvent` answered true for the pane lane's own beat, `("progress", {"source":"pool_jobs","state":"running"})`, which carries no `runtimeState` at all and is the ONLY thing that lane posts before a turn runs. Core therefore read `running` off a pane holding an unsubmitted prompt: measured sid-desk 2026-09-18, a release batch at $0.00 spend for thirty-one minutes with four issues sitting at `releasing` and no reader able to tell it from a deploy.
// cm:guard a `progress` frame carrying NO `runtimeState` is NOT evidence, and that is the discriminating case rather than an edge one — `db/schema.ts` states that a NULL `runtime_state` means "this runner never reported, infer nothing", and inferring `running` from it is the same assertion one column over. `intervention` and `kill_ack` are absent for the same reason: neither is the agent's output.
// cm:edge lockstep -> packages/runner/crates/forge-runner-core/src/daemon/turn_evidence.rs — `Evidence::runtime_state` is what decides which word the beat carries, and `pool_jobs.rs#CoreReport::progress` is what puts it on the wire. A rename on either side fails nothing: the key is read by name out of untyped jsonb and an unknown word is DROPPED, which silently restores the unconditional flip this rule exists to remove.
// cm:guard the DECLARED cost, and it is a reading rather than a gap: a box whose pane it could not hook beats `Evidence::Unproven`, which carries no `runtimeState` at all, so its session reads `queued` with a NULL `runtime_state` and a fresh `last_heartbeat_at` for the whole job. That triple says "a worker is reporting and nothing has reported a turn", which is the whole of what core knows about such a pane; it is bounded by `reapZombieSessions`' quiet arm, never by its queue arm, so nothing fails while the box keeps beating.
function isTurnEvidence(e: { kind: string; data?: unknown }): boolean {
  if (e.kind === 'progress') {
    const state = runtimeStateOf(e);
    return state !== undefined && TURN_RUNTIME_STATES.has(state);
  }
  return TURN_EVENT_KINDS.has(e.kind);
}

// cm:guard a DENYLIST of one proven-unread frame, never an allowlist — a frame kind the CLI adds tomorrow must keep being stored, and an allowlist would drop it in silence, which is the one failure this filter must not become
// cm:edge contract -> packages/core/src/lib/agent-stream-parser.ts — `stream_event` is dropped because that parser answers `{messages:[]}` for it and nothing else in core or web reads one; teaching any reader to consume one means deleting this filter FIRST, because the frames it would need were never stored
// cm:guard filter ONLY what is persisted, never the batch the signals above read — the ack stamp, the session heartbeat, `runtime_state` and the derive cadence are all computed from the UNFILTERED batch above, so dropping these rows cannot make a busy session look quiet, which is the whole reason `--include-partial-messages` is on (ISS-479)
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

    // cm:why an ADVISORY lock and not `FOR UPDATE`: the frontier is `MAX(seq)`, and Postgres refuses `FOR UPDATE` on an aggregate, so there is no row to lock. The transaction-scoped advisory lock keyed on the jobId hash serialises concurrent inserts for one job instead, and releases itself at COMMIT/ROLLBACK.
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

    // cm:why ISS-449 (I3) — fallback ack: the first event batch proves the runner claimed the job even when the explicit POST /:id/ack was lost or the runner predates it. Best-effort; the explicit ack (or a prior batch) wins via the isNull guard.
    // cm:guard the `isNull` predicate below is the RACE guard and stays; this branch is the CHEAP guard, on the row this handler already read. Without it the statement ran on every batch of every running job and matched nothing after the first (ISS-1014). Dropping the predicate and keeping only this branch would be the other way round and is wrong: the read is outside the write, so two concurrent first batches would both stamp.
    if (job.ackedAt === null) {
      try {
        await db
          .update(jobs)
          // cm:edge lockstep -> packages/core/src/jobs/lifecycle-routes.ts — the explicit ack clears the same kill columns; a first ack that leaves them behind hands a later reap a confirmation about a process that had not started yet (ISS-785)
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

    // cm:guard server-side and NOT in the worker on purpose: the worker keys its local session by `jobId` and would have to learn the linked `agentSessionId` to PATCH the row itself. Moving it there couples every worker to the linkage for a bump core can do from the id it already has.
    // cm:guard best-effort, and it must stay that way — a throw here would fail event INGEST, losing the runner's output to protect a freshness stamp the sweeper can recover from on the next batch.
    // cm:edge lockstep -> packages/core/src/agent-sessions/routes.ts — the SAME rule as `isWorkerActivity` there, and it has to be in both: a park announced over PATCH and a park announced as a job event are the same fact arriving by two doors, and a rule on only one door leaves the other stamping the session healthy while it waits on a human.
    const linkedSessionId = job.agentSessionId;
    if (linkedSessionId && events.some((e) => !isParkEvent(e))) {
      try {
        const heartbeatNow = new Date();
        // cm:guard ISS-1101 — the two halves of this statement answer DIFFERENT questions and only one of them needs evidence. `lastHeartbeatAt`/`updatedAt` say the box is alive, which any non-park frame proves; `status`/`startedAt` say the AGENT began a turn, which only `isTurnEvidence` proves. Collapsing them back into one predicate is the defect: the session then reads running-and-recently-alive, the reading an operator trusts most, off a beat from a pane nobody had asked anything.
        const sawTurn = events.some(isTurnEvidence);
        // cm:why ONE statement (ISS-1014), replacing a CAS on `status='queued'` that missed on every batch after the first plus a second UPDATE that then did the bump — two statements inside a transaction, about twice a second for every running job on the box. The CTE carries the row as it stood BEFORE the write, which is the only way one statement can still report whether the queued→running flip was THIS batch's, and that is what keeps the broadcast firing exactly once.
        // cm:guard the `FOR UPDATE` in the CTE is what makes that exactly-once, and a plain `UPDATE ... FROM agent_sessions prev` self-join is NOT equivalent: under READ COMMITTED a second concurrent first batch would block on the row lock, re-check the now-`running` row against a predicate that still admits it, and read its own pre-write snapshot as `queued` — two batches, two `startedRunning`, two broadcasts of a flip that happened once. `FOR UPDATE` makes the loser re-read the WINNER's row, so it sees `running` and stays quiet.
        // cm:guard the CTE carries the status predicate, and the UPDATE therefore matches nothing when the session is already terminal — the join has no row to join to. Widening the CTE's `IN` list would turn this into a door that revives a cancelled or failed session, and `lifecycle/transition-guard.test.ts` would not catch it, because `'running'` is not a terminal literal.
        // cm:guard an ISO STRING, never the `Date` — inside a raw `sql` template drizzle has no column type to serialise a Date against, so postgres-js is handed a bare Date at bind time and throws `The "string" argument must be of type string`. The same trap is already named on `ackFastCutoffIso` in `jobs/loop-monitor.ts`; the `.toISOString()` plus the cast is the fix.
        // cm:guard `startedAt` is stamped ONLY on the flip, and deliberately not as `COALESCE(started_at, now)`: a row already `running` with a NULL `started_at` keeps it NULL, exactly as the two statements left it. Filling it in is a second behaviour change, and `loop-monitor.ts`'s heartbeat hop reads that column as a fallback cutoff.
        // cm:guard still inside `withKernelMarker` because this writes `status` — an unstamped status write on a kernel table charges its whole traffic to the north-star interventions metric as manual SQL (`db/kernel-marker.ts`).
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
        // cm:guard the flip columns are OMITTED rather than written back to themselves when the batch
        // carries no turn evidence, and it is still ONE statement either way — the ISS-1014 rule that
        // put this CTE here in the first place. A `status = status` self-assignment would read the same
        // to the row and hand every reader of `kernel_transitions` a status write that changed nothing.
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
              // cm:guard the broadcast flag reads the SAME condition the write did. Left as the bare
              // `prev.status = 'queued'` it announces a flip to every listener on a batch that did not
              // make one, and the room then shows `running` for a row that still says `queued`.
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

    // cm:guard the JOB-EVENTS door is the ONLY writer of `runtime_state` on the pipeline path. The session-keyed PATCH cannot serve it: the runner keys a pipeline session by `job_id`, so a PATCH to `/api/agent-sessions/:id` with that id 404s. Without this write the column stays NULL for every duplex job, and all three readers of it — the quiet-clock exemption (loop-monitor.ts), the residency deadline (park-deadline.ts) and the result guard (resident-session.ts) — are inert on the path they were built for.
    // cm:guard OUTSIDE the heartbeat branch above, and that separation is the point: a park-only batch must record the park while NOT counting as activity. Folding this in there would make the two rules one, and the park would be invisible in exactly the case it matters.
    // cm:guard and it stays a SECOND statement for a second reason found while collapsing the heartbeat into one (ISS-1014): the two match different row sets. The heartbeat takes `status IN ('queued','running')`; this one takes every non-terminal status, `idle` included. Folding them would silently stop recording the park on an idle session — so a batch that reports a runtime state writes `agent_sessions` twice, on purpose.
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

    // cm:why derived here rather than written by the runner (ISS-283): a CLI-run job holds only a device token and the session PATCH is user-JWT-gated, so the stdout lines it streams are the only record core can build the transcript from. The result is voided on purpose — the derive is throttled and best-effort so it can never block event ingest, and the authoritative rebuild runs on job /complete | /fail.
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
