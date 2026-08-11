import { zValidator } from '@hono/zod-validator';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { jobEvents, jobs, skills } from '../db/schema.js';
import { publishPipelineHealthChanged } from '../issues/pipeline-health.js';
import { assertProjectRole, loadProjectAccess } from '../lib/authz.js';
import { applyKernelTransition } from '../lifecycle/transition.js';
import { logger } from '../logger.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { type DeviceVars, requireDevice } from '../middleware/require-device.js';
import { hooks } from '../pipeline/hooks.js';
import { clearRunnerLimit } from '../runners/apply-runner-limit.js';
import { recordSkillActivityEvent, resolvePacketIdForHash } from '../skills/activity.js';
import { failReconcileRunIfNoVerdictRecorded } from '../skills/reconcile-service.js';
import { materializeJobUsage } from '../usage-records/materialize.js';
import { projectRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';
import { syncAgentSessionLifecycle } from './agent-session-link.js';
import { JobCancelError, cancelJob } from './cancel-job.js';
import { dispatchTickForProject } from './dispatch-tick.js';
import { finalizeFailedJob } from './finalize-failure.js';
import { handleResumeFailed, isResumeFailedError } from './handle-resume-failed.js';
import type { RetryOutcome } from './retry.js';
import { deriveSessionFinal } from './session-transcript.js';

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

const forbidden = (message: string) =>
  new HTTPException(403, { message, cause: { code: 'FORBIDDEN' } });

const conflict = (message: string, code: string) =>
  new HTTPException(409, { message, cause: { code } });

const jobIdParamSchema = z.object({ id: z.uuid() });

// cm:why skillsRanWith is optional — absent for pre-0.7.0 runners and jobs with no skills seeded (ISS-798).
const ackBodySchema = z
  .object({
    skillsRanWith: z.record(z.string(), z.string().max(128)).optional(),
  })
  .passthrough();

const completeBodySchema = z
  .object({
    exitCode: z.number().int(),
    error: z.string().max(10_000).nullable().optional(),
    summary: z.string().max(10_000).optional(),
  })
  .strict();

const failBodySchema = z
  .object({
    error: z.string().max(10_000),
  })
  .strict();

const cancelBodySchema = z
  .object({
    reason: z.string().max(500).optional(),
  })
  .strict();

// cm:why outcome:'not_found' is the only way to confirm-without-waiting-out-the-heartbeat-window that a job no runner claimed is safe to fail-and-retry
// cm:edge protocol -> packages/core/src/jobs/kill-gate.ts — runner's answer to the job.cancel frame requestJobKill publishes
const killAckBodySchema = z
  .object({
    outcome: z.enum(['killed', 'not_found']),
  })
  .strict();

const RUNNABLE_STATUSES = new Set(['dispatched', 'running']);

// ISS-378 — `jobs.error` markers written by the SERVER-side reapers (never by
// a real runner /fail): the orphan reconcilers + stale-detector. A successful
// late /complete for a job carrying one of these means the runner actually
// finished but its report was lost (e.g. to a core outage) and a sweep reaped
// the row first — so the success is reconcilable, not a conflict.
const SYNTHETIC_REAP_ERRORS = new Set(['session_lost', 'dispatch_unclaimed', 'stale']);

async function loadJob(jobId: string) {
  const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  if (!row) throw notFound('job not found');
  return row;
}

export const jobLifecycleDeviceRoutes = new Hono<{ Variables: DeviceVars }>();

// ISS-449 (ISS-442 C3 / I3) — explicit runner ACK for the dispatch→ack hop.
// The runner calls this right after its pre-claim preflight passes (ISS-451)
// and before spawning the agent; the first job_event batch doubles as a
// fallback ack for older runners (events-routes.ts). Idempotent: a repeat
// call (or a call racing the event fallback) keeps the first timestamp and
// reports `acked:false`. A terminal job is NOT an error — the runner treats
// ack as best-effort and must not abort the job over a late/lost ack.
jobLifecycleDeviceRoutes.post(
  '/:id/ack',
  requireDevice(),
  zValidator('param', jobIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', ackBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const device = c.get('device');

    const job = await loadJob(id);
    if (job.deviceId !== device.id) throw forbidden('job is not dispatched to this device');

    if (job.ackedAt) {
      return c.json({
        jobId: job.id,
        status: job.status,
        ackedAt: job.ackedAt.toISOString(),
        acked: false,
      });
    }

    const now = new Date();
    const skillsRanWith = body.skillsRanWith ?? null;
    // cm:why read outside the tx (mirrors recordPrunedSkill) — the UPDATE's isNull(ackedAt) WHERE is what prevents a double-emit, not this read.
    const skillLookups =
      skillsRanWith && Object.keys(skillsRanWith).length > 0
        ? await Promise.all(
            Object.entries(skillsRanWith).map(async ([name, hash]) => {
              const [skill] = await db
                .select({ id: skills.id })
                .from(skills)
                .where(
                  and(
                    eq(skills.scope, 'project'),
                    eq(skills.projectId, job.projectId),
                    eq(skills.name, name),
                  ),
                )
                .limit(1);
              const packetId = skill
                ? await resolvePacketIdForHash(db, job.projectId, skill.id, hash)
                : undefined;
              return { name, hash, skillId: skill?.id, packetId };
            }),
          )
        : [];
    const updated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(jobs)
        .set({ ackedAt: now, ...(skillsRanWith !== null ? { skillsRanWith } : {}) })
        .where(
          and(
            eq(jobs.id, id),
            isNull(jobs.ackedAt),
            inArray(jobs.status, ['dispatched', 'running']),
          ),
        )
        .returning({ id: jobs.id, status: jobs.status, ackedAt: jobs.ackedAt });
      if (row) {
        for (const lookup of skillLookups) {
          await recordSkillActivityEvent(tx, {
            eventType: 'job.ran.with',
            actor: `runner:${device.id}`,
            trigger: 'push',
            projectId: job.projectId,
            deviceId: device.id,
            ...(lookup.skillId ? { skillId: lookup.skillId } : {}),
            ...(lookup.packetId ? { packetId: lookup.packetId } : {}),
            afterHash: lookup.hash,
            reason: `jobId=${id}`,
            deltaSummary: lookup.name,
            outcome: 'ok',
          });
        }
      }
      return row;
    });
    if (!updated) {
      // Terminal or concurrently acked — idempotent OK, report current state.
      const fresh = await loadJob(id);
      return c.json({
        jobId: fresh.id,
        status: fresh.status,
        ackedAt: fresh.ackedAt ? fresh.ackedAt.toISOString() : null,
        acked: false,
      });
    }
    return c.json({
      jobId: updated.id,
      status: updated.status,
      ackedAt: now.toISOString(),
      acked: true,
    });
  },
);

jobLifecycleDeviceRoutes.post(
  '/:id/complete',
  requireDevice(),
  zValidator('param', jobIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', completeBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const input = c.req.valid('json');
    const device = c.get('device');

    const job = await loadJob(id);
    if (job.deviceId !== device.id) throw forbidden('job is not dispatched to this device');

    // ISS-378 — idempotent late completion. A runner that finished real work
    // but whose /complete was lost to a core outage finds its job already
    // reaped to `failed` by a timeout/orphan sweep (server-side, not a runner
    // /fail). If it retries with success and no retry attempt has taken over,
    // accept it: flip failed→done and run the success side-effects, instead of
    // 409-discarding real work (ISS-360 lost a merged PR this way). Guarded so
    // it can't double-advance: if any retry descendant is queued/dispatched/
    // running/done, that attempt owns the outcome and we fall through to 409.
    if (
      !RUNNABLE_STATUSES.has(job.status) &&
      input.exitCode === 0 &&
      job.status === 'failed' &&
      typeof job.error === 'string' &&
      SYNTHETIC_REAP_ERRORS.has(job.error)
    ) {
      const activeRetry = await db
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            eq(jobs.retryOf, job.id),
            inArray(jobs.status, ['queued', 'dispatched', 'running', 'done']),
          ),
        )
        .limit(1);
      if (activeRetry.length === 0) {
        const [reclaimed] = await applyKernelTransition(db, {
          entity: 'job',
          to: 'done',
          set: { exitCode: 0, error: null, finishedAt: new Date() },
          where: and(eq(jobs.id, id), eq(jobs.status, 'failed'), eq(jobs.error, job.error)),
          fromStatus: 'failed',
          reason: 'reconciled_late_complete',
          actor: { type: 'runner', id: device.id },
          source: 'lifecycle',
        });
        if (reclaimed) {
          logger.warn(
            { jobId: reclaimed.id, reapedError: job.error },
            'lifecycle: reconciled a late successful completion — job had been reaped (work would otherwise be lost)',
          );
          if (reclaimed.agentSessionId) {
            void deriveSessionFinal(reclaimed.id, reclaimed.agentSessionId);
          }
          void materializeJobUsage(reclaimed);
          await syncAgentSessionLifecycle(reclaimed, 'done');
          roomManager.publish(projectRoom(reclaimed.projectId), {
            event: 'job.completed',
            data: { jobId: reclaimed.id, status: 'done', exitCode: 0 },
          });
          await hooks.emit('jobCompleted', {
            jobId: reclaimed.id,
            projectId: reclaimed.projectId,
            issueId: reclaimed.issueId,
            type: reclaimed.type,
          });
          // A successful completion clears any rate/usage/auth limit on the runner.
          void clearRunnerLimit(reclaimed.runnerId, reclaimed.projectId);
          void dispatchTickForProject(reclaimed.projectId);
          if (reclaimed.issueId) {
            await publishPipelineHealthChanged(reclaimed.projectId, [reclaimed.issueId]);
          }
          return c.json({
            jobId: reclaimed.id,
            status: 'done',
            exitCode: 0,
            retry: null,
            reconciled: true,
          });
        }
      }
    }

    if (!RUNNABLE_STATUSES.has(job.status)) {
      throw conflict('job is not in a runnable state', 'INVALID_STATE');
    }

    const status: 'done' | 'cancelled' | 'failed' =
      input.exitCode === 0 ? 'done' : input.exitCode === -1 ? 'cancelled' : 'failed';
    // Mutable companion to `input.error` for the failure paths below
    // (resume-fail / retry) that refine the reason without reassigning the
    // validated input object.
    const effectiveError: string | null = input.error ?? null;

    let [updated] = await applyKernelTransition(db, {
      entity: 'job',
      to: status,
      set: {
        exitCode: input.exitCode,
        error: effectiveError,
        finishedAt: new Date(),
      },
      where: and(eq(jobs.id, id), eq(jobs.status, job.status)),
      fromStatus: job.status,
      reason: status === 'failed' ? (effectiveError ?? 'exit nonzero') : `lifecycle_${status}`,
      actor: { type: 'runner', id: device.id },
      source: 'lifecycle',
    });

    if (!updated) throw conflict('job state changed mid-request', 'INVALID_STATE');

    // ISS-283 — final authoritative derive of the agent_sessions transcript
    // from the streamed job_events (CLI runner never PATCHes the session row).
    // Fire-and-forget + best-effort so it can never block or hang /complete;
    // it never writes status, so it can't fight syncAgentSessionLifecycle below.
    if (updated.agentSessionId) {
      void deriveSessionFinal(updated.id, updated.agentSessionId);
    }
    // ISS-439 — materialize the usage_records row from the stored job_events.
    void materializeJobUsage(updated);

    // Step-handoff is best-effort context for the next step — NOT a completion
    // gate. A `done` job stays `done` whether or not the agent wrote its
    // handoff row; the next step falls back to raw issue fields when a prior
    // handoff is missing (see handoff-prefetch / handoff-policy
    // fallbackToRawIssueFieldIfMissing).

    if (status === 'failed') {
      // PR-5c — resume failure takes precedence: invalidate prior session
      // and branch by `onResumeFail` policy (fresh → retry; abort → no retry).
      let resumePolicy: 'fresh' | 'abort' | null = null;
      if (isResumeFailedError(input.error)) {
        resumePolicy = await handleResumeFailed({
          id: updated.id,
          projectId: updated.projectId,
          issueId: updated.issueId,
          payload: updated.payload,
        });
      }
      let precomputedRetry: RetryOutcome | undefined;
      if (resumePolicy === 'abort') {
        const [reclassified] = await db
          .update(jobs)
          .set({ failureReason: 'resume_failed', failureKind: 'code', classifierVersion: 3 })
          .where(eq(jobs.id, updated.id))
          .returning();
        if (reclassified) updated = reclassified;
        precomputedRetry = { scheduled: false };
      }
      // ISS-280 / ISS-393 — shared finalize path: auto-retry → revert to
      // entry-status (or park at `waiting` when exhausted) → session sync →
      // broadcast → hooks → dispatch re-tick → health refresh.
      const retry = await finalizeFailedJob(updated, {
        error: effectiveError ?? 'exit nonzero',
        exitCode: input.exitCode,
        precomputedRetry,
      });
      return c.json({
        jobId: updated.id,
        status: updated.status,
        exitCode: updated.exitCode,
        retry,
      });
    }

    // done / cancelled — mirror lifecycle to the linked agent_session row so
    // /pipeline + issue detail tab reflect completion. Best-effort.
    await syncAgentSessionLifecycle(updated, status);

    // cm:edge sideeffect -> packages/core/src/skills/reconcile-service.ts — a reconcile/verify_skill job self-reporting done/cancelled without recording its verdict/vote needs a terminal path too (BLOCKER M half 2, ISS-801 review) — finalizeFailedJob only covers the runner-reported `failed` branch above.
    await failReconcileRunIfNoVerdictRecorded(updated).catch((err) =>
      logger.warn(
        { err, jobId: updated.id, type: updated.type },
        'lifecycle: failReconcileRunIfNoVerdictRecorded failed',
      ),
    );

    roomManager.publish(projectRoom(updated.projectId), {
      event: status === 'done' ? 'job.completed' : 'job.cancelled',
      data: { jobId: updated.id, status, exitCode: updated.exitCode },
    });

    // Cancelled jobs do not emit a completion hook.
    if (status === 'done') {
      await hooks.emit('jobCompleted', {
        jobId: updated.id,
        projectId: updated.projectId,
        issueId: updated.issueId,
        type: updated.type,
      });
      // A successful completion clears any rate/usage/auth limit on the runner.
      void clearRunnerLimit(updated.runnerId, updated.projectId);
    }

    // ISS-40 PR-E — re-tick the project so newly-freed slots get filled.
    // Fire-and-forget; never await.
    void dispatchTickForProject(updated.projectId);

    // ISS-164 — refresh pipelineHealth for the linked issue (activeSession
    // clears, queued siblings may now classify differently).
    if (updated.issueId) {
      await publishPipelineHealthChanged(updated.projectId, [updated.issueId]);
    }

    return c.json({
      jobId: updated.id,
      status: updated.status,
      exitCode: updated.exitCode,
      retry: null,
    });
  },
);

jobLifecycleDeviceRoutes.post(
  '/:id/fail',
  requireDevice(),
  zValidator('param', jobIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', failBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const input = c.req.valid('json');
    const device = c.get('device');

    const job = await loadJob(id);
    if (job.deviceId !== device.id) throw forbidden('job is not dispatched to this device');
    if (!RUNNABLE_STATUSES.has(job.status)) {
      throw conflict('job is not in a runnable state', 'INVALID_STATE');
    }

    let [updated] = await applyKernelTransition(db, {
      entity: 'job',
      to: 'failed',
      set: {
        error: input.error,
        finishedAt: new Date(),
      },
      where: and(eq(jobs.id, id), eq(jobs.status, job.status)),
      fromStatus: job.status,
      reason: input.error,
      actor: { type: 'runner', id: device.id },
      source: 'lifecycle',
    });

    if (!updated) throw conflict('job state changed mid-request', 'INVALID_STATE');

    // ISS-283 — final transcript derive (see /complete). Fire-and-forget.
    if (updated.agentSessionId) {
      void deriveSessionFinal(updated.id, updated.agentSessionId);
    }
    // ISS-439 — materialize the usage_records row from the stored job_events.
    void materializeJobUsage(updated);

    // PR-5c — same resume-failed branching as the user-lifecycle path.
    let resumePolicy: 'fresh' | 'abort' | null = null;
    if (isResumeFailedError(input.error)) {
      resumePolicy = await handleResumeFailed({
        id: updated.id,
        projectId: updated.projectId,
        issueId: updated.issueId,
        payload: updated.payload,
      });
    }
    let precomputedRetry: RetryOutcome | undefined;
    if (resumePolicy === 'abort') {
      const [reclassified] = await db
        .update(jobs)
        .set({ failureReason: 'resume_failed', failureKind: 'code', classifierVersion: 3 })
        .where(eq(jobs.id, updated.id))
        .returning();
      if (reclassified) updated = reclassified;
      precomputedRetry = { scheduled: false };
    }

    // ISS-280 — shared finalize path (see /complete).
    const retry = await finalizeFailedJob(updated, {
      error: input.error,
      precomputedRetry,
    });

    return c.json({
      jobId: updated.id,
      status: updated.status,
      error: updated.error,
      retry,
    });
  },
);

/**
 * ISS-785 — device-scoped kill-ack for the `job.cancel` frame the
 * kill-before-reap gate sends. Deliberately NOT a lifecycle transition: it
 * only stamps `killConfirmedAt`/`killOutcome` (first ack wins — idempotent)
 * and appends a `kill_ack` audit event, then returns 200 whether or not the
 * job is still active. `resolveKillConfirmation` (jobs/kill-gate.ts) is the
 * ONLY reader of these columns.
 */
jobLifecycleDeviceRoutes.post(
  '/:id/kill-ack',
  requireDevice(),
  zValidator('param', jobIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', killAckBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const { outcome } = c.req.valid('json');
    const device = c.get('device');

    const job = await loadJob(id);
    if (job.deviceId !== device.id) throw forbidden('job is not dispatched to this device');

    const now = new Date();
    await db.transaction(async (tx) => {
      await tx
        .update(jobs)
        .set({ killConfirmedAt: now, killOutcome: outcome })
        .where(and(eq(jobs.id, id), isNull(jobs.killConfirmedAt)));
      await insertKillAckEvent(tx, id, outcome, device.id);
    });

    return c.json({ jobId: id, killOutcome: outcome, acked: true });
  },
);

/**
 * Append the audited `kill_ack` event inside an open transaction. Mirrors
 * `cancel-job.ts`'s `insertInterventionEvent` — same advisory-lock +
 * `MAX(seq)+1` frontier as the job_events POST route so the server-assigned
 * seq stays monotonic under concurrent inserts.
 */
async function insertKillAckEvent(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  jobId: string,
  outcome: 'killed' | 'not_found',
  deviceId: string,
): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${jobId}))`);
  const maxRows = await tx.execute<{ max_seq: number | string | null }>(
    sql`SELECT COALESCE(MAX(seq), 0) AS max_seq FROM job_events WHERE job_id = ${jobId}`,
  );
  const first = maxRows[0] as { max_seq: number | string | null } | undefined;
  const nextSeq = Number(first?.max_seq ?? 0) + 1;

  await tx.insert(jobEvents).values({
    jobId,
    kind: 'kill_ack',
    data: { outcome, deviceId },
    seq: nextSeq,
  });
}

// Auth applied per-handler — see comment in jobs/routes.ts on why a bare
// `.use('*')` would 401 device-only sibling routes.
export const jobLifecycleUserRoutes = new Hono<{ Variables: AuthVars }>();

jobLifecycleUserRoutes.post(
  '/:id/cancel',
  requireAuth(),
  assertEmailVerified(),
  zValidator('param', jobIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const job = await loadJob(id);
    const access = await loadProjectAccess(job.projectId, userId);
    assertProjectRole(access, 'member', 'not a project member');

    // Optional `{ reason }` body; tolerate an empty/absent body (the cancel
    // button sends none) by defaulting to {} before schema-validating.
    const rawBody = await c.req.json().catch(() => ({}));
    const parsedBody = cancelBodySchema.safeParse(rawBody ?? {});
    if (!parsedBody.success) throw badRequest(z.flattenError(parsedBody.error));

    try {
      const result = await cancelJob(id, {
        actorUserId: userId,
        reason: parsedBody.data.reason ?? 'manual cancel (REST)',
        source: 'rest',
      });
      return c.json(result);
    } catch (e) {
      if (e instanceof JobCancelError) {
        if (e.code === 'NOT_FOUND') throw notFound(e.message);
        throw conflict(e.message, e.code);
      }
      throw e;
    }
  },
);
