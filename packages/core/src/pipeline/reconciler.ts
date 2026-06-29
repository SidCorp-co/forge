import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import type { IssueStatus, JobType } from '../db/schema.js';
import { applyStatusTransition } from '../issues/apply-transition.js';
import { logger } from '../logger.js';
import { Sentry, isSentryEnabled } from '../observability/sentry.js';
import { reEnqueueForIssue } from './orchestrator.js';
import {
  AUTO_DISPATCH_STATUSES,
  PIPELINE_STEPS,
  TRIGGER_STATUS_BY_JOB_TYPE,
  WORKING_STATUS_BY_JOB_TYPE,
} from './registry.js';

/**
 * ISS-196 — minute-cadence safety net for the trigger → outbox → orchestrator
 * path. Two responsibilities:
 *   1. Rescue issues stuck at an auto-dispatch status with no active job —
 *      happens when the worker crashed mid-dispatch on a row whose
 *      `pipeline_outbox.processed_at` was set just before `insertAndEnqueueJob`
 *      threw, or when the outbox row was processed but the orchestrator
 *      decided not to enqueue and the issue later became eligible again.
 *   2. Sentry-breadcrumb when the outbox itself has stale unprocessed rows
 *      (>5min) — signals worker death even when no issue is stuck yet.
 *
 * Should be rare: `reconciler_hits_per_hour > 0` means the happy path
 * (trigger + worker) missed an event. Grafana alarms on a non-zero rate
 * sustained over multiple buckets.
 */

const RECONCILER_QUEUE = 'pipeline-reconciler';
const STALE_OUTBOX_INTERVAL = '5 minutes';
const STUCK_ISSUE_INTERVAL = '60 seconds';
const STUCK_ISSUE_LIMIT = 100;

// ISS-598 — in-flight wedge reset. A step whose agent flips the issue to a
// distinct in-flight status and is itself responsible for advancing it back
// out (code/fix → `in_progress`) can have its Claude session cut by a usage
// limit AFTER its last substantive tool call (e.g. the handoff write) but
// BEFORE the state-advance transition. The CLI turn ends cleanly → the job is
// recorded `done` (exit 0), so the failure classifier — which would otherwise
// route a usage limit to a cross-device retry (ISS-596) — never sees it. And
// because the server never auto-advances on the agent's behalf (handoff is
// best-effort context, NOT a completion gate), the issue is stranded at its
// in-flight status under a still-open run with no next job — a permanent wedge
// that occupies the runner slot (cap=1 serial projects stall entirely).
//
// This watchdog detects that exact, narrow signature and ROLLS THE ISSUE BACK
// to the step's trigger status. The status-change trigger → outbox →
// orchestrator then re-dispatches the step cleanly (the ISS-* branch already
// exists, so forge-code/-fix reuse the worktree). We roll BACK, never forward:
// the server cannot verify the partial work is complete or correct, so a clean
// re-run from the trigger status is the only safe recovery. A human operator
// MAY advance forward after verifying the branch+handoff — automation must not.
const WEDGE_GRACE = '10 minutes';
const WEDGE_RESET_LIMIT = 50;

// Steps with a non-null in-flight status are the only ones that can wedge this
// way (the agent owns the advance out of `workingStatus`). Derived from the
// registry so a new such step is covered automatically.
const RESETTABLE_STEPS = PIPELINE_STEPS.filter(
  (s): s is typeof s & { workingStatus: IssueStatus } => s.workingStatus !== null,
);
const WEDGE_WORKING_STATUSES: readonly IssueStatus[] = [
  ...new Set(RESETTABLE_STEPS.map((s) => s.workingStatus)),
];
const WEDGE_JOB_TYPES: readonly JobType[] = [...new Set(RESETTABLE_STEPS.map((s) => s.jobType))];

let registered = false;

export async function runReconcilerOnce(): Promise<{
  rescued: number;
  stale: number;
  reset: number;
}> {
  let rescued = 0;
  let stale = 0;
  let reset = 0;

  // Embed AUTO_DISPATCH_STATUSES as a parenthesised list of parameters via
  // sql.join — passing the JS array directly into the template expands it as
  // a record tuple, which Postgres can't cast to text[] (drizzle quirk caught
  // by the ISS-196 forge-test smoke run).
  const statusList = sql.join(
    AUTO_DISPATCH_STATUSES.map((s) => sql`${s}`),
    sql`, `,
  );

  const stuck = await db.execute<{
    id: string;
    project_id: string;
    status: string;
    created_by: string | null;
  }>(sql`
    SELECT i.id, i.project_id, i.status, p.created_by
    FROM issues i
    INNER JOIN projects p ON p.id = i.project_id
    WHERE i.status IN (${statusList})
      AND i.updated_at < now() - interval '${sql.raw(STUCK_ISSUE_INTERVAL)}'
      AND NOT EXISTS (
        SELECT 1 FROM jobs j
        WHERE j.issue_id = i.id
          AND j.status IN ('queued','dispatched','running')
      )
    LIMIT ${STUCK_ISSUE_LIMIT}
  `);

  for (const row of stuck) {
    try {
      const actorId = row.created_by ?? '<reconciler>';
      await reEnqueueForIssue({
        projectId: row.project_id,
        issueId: row.id,
        status: row.status as IssueStatus,
        // Synthesise a device principal from the project owner; matches the
        // pattern in orchestrator.resolveSkipDevice (no schema change needed).
        actor: { type: 'device', id: actorId },
        reason: { reconciler: true, reason: 'enqueued_missing' },
      });
      rescued++;
      if (isSentryEnabled()) {
        Sentry.addBreadcrumb({
          category: 'pipeline.reconciler.enqueued_missing',
          level: 'warning',
          data: { issueId: row.id, status: row.status },
        });
      }
    } catch (err) {
      logger.error({ err, issueId: row.id, status: row.status }, 'reconciler: rescue failed');
    }
  }

  try {
    const staleRows = await db.execute<{ count: string | number }>(sql`
      SELECT COUNT(*)::text AS count
      FROM pipeline_outbox
      WHERE processed_at IS NULL
        AND created_at < now() - interval '${sql.raw(STALE_OUTBOX_INTERVAL)}'
    `);
    const first = staleRows[0];
    const n = first ? Number(first.count) : 0;
    if (n > 0) {
      stale = n;
      logger.warn({ stale: n }, 'reconciler: outbox has stale unprocessed rows');
      if (isSentryEnabled()) {
        Sentry.addBreadcrumb({
          category: 'pipeline.outbox.stale_unprocessed',
          level: 'warning',
          data: { staleCount: n },
        });
      }
    }
  } catch (err) {
    logger.error({ err }, 'reconciler: stale-outbox probe failed');
  }

  try {
    reset = await resetInFlightWedgesOnce();
  } catch (err) {
    logger.error({ err }, 'reconciler: in-flight wedge pass failed');
  }

  return { rescued, stale, reset };
}

/**
 * ISS-598 — detect and roll back issues stranded at a step's in-flight status
 * (the usage-limit-after-handoff wedge described above). Returns the number of
 * issues reset. Kept narrow on purpose; every clause below exists to avoid
 * resetting an issue whose step is still legitimately in flight:
 *
 *   • issue is at a step's in-flight `workingStatus` (e.g. `in_progress`);
 *   • the LATEST job for the issue is `done` and of a resettable type
 *     (code/fix) — `done` is the crux: a `failed`/`cancelled` job is already
 *     owned by the retry/cascade machinery, and `done` is the only state where
 *     no retry will ever fire, so the wedge is permanent;
 *   • a `kind='issue'` run is still `running` (paused/terminal runs are left
 *     alone — a paused run is a deliberate human hold);
 *   • NO job is queued/dispatched/running for the issue (no in-flight work and
 *     no pending retry — both would resolve the status without us);
 *   • the issue has sat untouched past `WEDGE_GRACE` (the normal advance out of
 *     the in-flight status happens within the job session, in seconds).
 */
export async function resetInFlightWedgesOnce(): Promise<number> {
  if (WEDGE_WORKING_STATUSES.length === 0) return 0;
  let reset = 0;

  const workingList = sql.join(
    WEDGE_WORKING_STATUSES.map((s) => sql`${s}`),
    sql`, `,
  );
  const jobTypeList = sql.join(
    WEDGE_JOB_TYPES.map((t) => sql`${t}`),
    sql`, `,
  );

  const wedged = await db.execute<{
    id: string;
    project_id: string;
    status: string;
    reopen_count: number;
    created_by: string | null;
    job_type: string;
  }>(sql`
    SELECT i.id, i.project_id, i.status, i.reopen_count, p.created_by, lj.type AS job_type
    FROM issues i
    INNER JOIN projects p ON p.id = i.project_id
    CROSS JOIN LATERAL (
      SELECT j.type, j.status
      FROM jobs j
      WHERE j.issue_id = i.id
      ORDER BY j.created_at DESC
      LIMIT 1
    ) lj
    WHERE i.status IN (${workingList})
      AND i.updated_at < now() - interval '${sql.raw(WEDGE_GRACE)}'
      AND lj.status = 'done'
      AND lj.type IN (${jobTypeList})
      AND EXISTS (
        SELECT 1 FROM pipeline_runs r
        WHERE r.issue_id = i.id AND r.kind = 'issue' AND r.status = 'running'
      )
      AND NOT EXISTS (
        SELECT 1 FROM jobs j2
        WHERE j2.issue_id = i.id
          AND j2.status IN ('queued', 'dispatched', 'running')
      )
    LIMIT ${WEDGE_RESET_LIMIT}
  `);

  for (const row of wedged) {
    const jobType = row.job_type as JobType;
    const entryStatus = TRIGGER_STATUS_BY_JOB_TYPE[jobType];
    // Final guard: the issue's current status MUST be the in-flight status the
    // latest job type owns. Protects against a future registry shape where two
    // job types share a working status but map back to different triggers.
    if (!entryStatus || WORKING_STATUS_BY_JOB_TYPE[jobType] !== row.status) continue;
    const actorId = row.created_by ?? '<reconciler>';
    try {
      await applyStatusTransition(
        {
          id: row.id,
          projectId: row.project_id,
          status: row.status as IssueStatus,
          reopenCount: row.reopen_count,
        },
        entryStatus,
        // Synthesise a device principal from the project owner (matches the
        // stuck-issue rescue pass above — no schema change needed).
        { id: actorId, ownerId: actorId },
        { reason: 'reconciler_inflight_wedge_reset' },
      );
      reset++;
      logger.warn(
        { issueId: row.id, from: row.status, to: entryStatus, jobType },
        'reconciler: reset in-flight wedge (usage-limit-after-handoff class) to trigger status',
      );
      if (isSentryEnabled()) {
        Sentry.addBreadcrumb({
          category: 'pipeline.reconciler.inflight_wedge_reset',
          level: 'warning',
          data: { issueId: row.id, from: row.status, to: entryStatus, jobType },
        });
      }
    } catch (err) {
      // NO_OP / STALE_TRANSITION means a real transition raced us (the wedge
      // resolved itself between SELECT and UPDATE) — benign. Other errors are
      // genuine; either way we never throw, so one bad row can't stall the tick.
      logger.error(
        { err, issueId: row.id, status: row.status },
        'reconciler: in-flight wedge reset failed',
      );
    }
  }

  return reset;
}

/**
 * Register the pg-boss `* * * * *` schedule. Idempotent. Lazy-imports
 * pg-boss so test loaders that don't touch the queue can still resolve
 * this module.
 */
export async function registerReconciler(): Promise<void> {
  if (registered) return;
  const { boss } = await import('../queue/boss.js');
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss v10 type drift
  await (boss as any).createQueue(RECONCILER_QUEUE);
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss v10 type drift
  await (boss as any).work(RECONCILER_QUEUE, async () => {
    try {
      await runReconcilerOnce();
    } catch (err) {
      logger.error({ err }, 'reconciler: tick failed');
      throw err;
    }
  });
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss v10 type drift
  await (boss as any).schedule(RECONCILER_QUEUE, '* * * * *');
  registered = true;
}

/** Test-only — reset registration. */
export function resetReconcilerForTest(): void {
  registered = false;
}
