/**
 * Pipeline sweeper tick — loop-monitor driver + demoted alarm passes.
 *
 * ISS-449 (ISS-442 C3 / invariant I3) — the closed job loop
 * (`jobs/loop-monitor.ts`) is now the PRIMARY mechanism: it owns the
 * dispatch→ack→heartbeat→result hop timeouts and performs every terminal
 * write (via `applyKernelTransition`) as the FIRST pass of this tick. The
 * three sweep passes this file used to own — `sweepZombieSessions`,
 * `reconcileOrphanedJobs`, `reconcileNeverClaimedDispatches` — are DEMOTED to
 * assertion/alarm (renamed `alarm*`): they keep their detection SELECTs but
 * perform NO terminal writes. Because they run in the same tick right AFTER
 * the loop, any row they still match is a row the loop should have handled
 * and didn't — a loop MISS, logged as `loop-miss` and surfaced as a
 * `pipeline_wedge` (coverage proof during the cutover; the alarm passes are
 * deleted at the ISS-442 parent integration once the loop is proven).
 *
 * Still active here (not part of the demoted four):
 *
 *  - One-shot run reaper (ISS-445) — closes job-less system/interactive runs
 *    whose backing session is dead. Run-axis, not modeled by the job loop.
 *  - Dispatcher backstop — re-tick `dispatchTickForProject` for every project
 *    that has queued jobs. Event-driven triggers are best-effort and can miss
 *    under race conditions; the backstop guarantees queued jobs are
 *    re-evaluated at least once per minute. `pgboss-health` monitors the
 *    schedule and alerts when this tick stops firing.
 *  - Queue snapshots (ISS-381) — per-project queue-depth observability.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type IssueStatus, agentSessions, comments, jobs } from '../db/schema.js';
import {
  type DeviceLite,
  type TransitionIssueRow,
  applyStatusTransition,
} from '../issues/apply-transition.js';
import { broadcastSessionEvent } from '../jobs/agent-session-link.js';
import { resolveGateSettings } from '../jobs/dispatch-gates.js';
import { dispatchTickForProject } from '../jobs/dispatch-tick.js';
import {
  type LoopMonitorResult,
  type LoopScope,
  getLoopThresholds,
  runLoopMonitor,
} from '../jobs/loop-monitor.js';
import { recordPipelineSweeperTick } from '../jobs/pgboss-health.js';
import { applyKernelTransition } from '../lifecycle/transition.js';
import { logger } from '../logger.js';
import { Sentry, isSentryEnabled } from '../observability/sentry.js';
import { boss } from '../queue/boss.js';
import { closeOpenRunForIssue, closeRunIfOneShot } from './runs.js';
import { emitPipelineWedge } from './wedge.js';

export const PIPELINE_SWEEPER_QUEUE = 'pipeline-sweeper';

const PIPELINE_METADATA_TYPES = sql`('pipeline','pm')`;

/** Back-compat shim — thresholds are owned by the loop monitor now (single
 *  source: same env names, same clamps). */
export function getZombieThresholds(): { queueMs: number; heartbeatMs: number } {
  const t = getLoopThresholds();
  return { queueMs: t.queueMs, heartbeatMs: t.heartbeatMs };
}

export interface ZombieSweepResult {
  // Counts are ALARMED rows (loop misses), not reaps — see module header.
  queueTimedOut: number;
  heartbeatTimedOut: number;
  noClientAcked: number;
}

export interface OrphanReconcileResult {
  reconciled: number;
}

export interface OneShotRunReapResult {
  // job-less system/interactive runs closed because no live session remained.
  reaped: number;
}

export interface IssueRunReapResult {
  // issue runs closed because their backing issue already reached a terminal status.
  reaped: number;
}

export interface StallDetectResult {
  // pipeline_wedge notifications emitted for never-clearing dependency deadlocks.
  detected: number;
}

export interface ParkClosedUnmergedResult {
  // dependent issues parked at `waiting` because their blocker was closed without merging.
  parked: number;
}

export interface SweepResult {
  durationMs: number;
  /** ISS-449 — the primary closed-loop pass (reaps). */
  loop: LoopMonitorResult;
  /** Demoted alarm passes (loop-miss counts, no writes). */
  zombieSessions: ZombieSweepResult;
  orphanedJobs: OrphanReconcileResult;
  neverClaimedDispatches: OrphanReconcileResult;
  orphanedOneShotRuns: OneShotRunReapResult;
  /** ISS-461 — issue runs closed because their backing issue is terminal (reaps). */
  orphanedIssueRuns: IssueRunReapResult;
  /** ISS-442 — dependency deadlocks surfaced (a gate that will never clear). */
  stalledDependencies: StallDetectResult;
  /** ISS-639 — dependents parked because their blocker closed without merging. */
  parkedClosedUnmerged: ParkClosedUnmergedResult;
  backstopProjects: number;
  queueSnapshots: number;
}

export async function runPipelineSweep(now: Date = new Date()): Promise<SweepResult> {
  const t0 = Date.now();

  // Per-pass fault isolation. Historically these passes ran as a bare
  // sequential `await` chain, so the FIRST pass to throw aborted the whole
  // tick — starving every pass after it. That silently broke the run-axis
  // reapers for days: a throw in an upstream pass (loop monitor / an alarm)
  // meant `reapOrphanedOneShotRuns` never ran, so job-less `schedule.run`
  // system runs + chat `interactive` runs leaked `running` forever across
  // EVERY project (they have no `jobs` row, so nothing else closes them —
  // VISION §5.10 "state never lies"). Now each pass runs isolated: one
  // failure is logged + captured (so the culprit pass is identifiable in
  // Sentry) but the remaining passes — crucially the reapers — still run.
  const errors: Array<{ pass: string; err: unknown }> = [];
  const runPass = async <T>(name: string, fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (err) {
      errors.push({ pass: name, err });
      logger.error(
        { err, pass: name },
        `pipeline-sweeper: pass '${name}' threw (isolated — remaining passes still run)`,
      );
      if (isSentryEnabled()) {
        Sentry.captureException(err, { tags: { area: 'pipeline-sweeper', sweep_pass: name } });
      }
      return undefined;
    }
  };

  // ISS-449 — the loop monitor runs FIRST and owns every reap. The alarm
  // passes below run against the post-loop state, so anything they match is a
  // genuine loop miss (handler threw, CAS starved, coverage gap) — not a row
  // the loop simply hadn't reached yet.
  const loop = await runPass('loopMonitor', () => runLoopMonitor(now));
  const zombieSessions = await runPass('alarmZombieSessions', () => alarmZombieSessions(now));
  const orphanedJobs = await runPass('alarmOrphanedJobs', () => alarmOrphanedJobs(now));
  const neverClaimedDispatches = await runPass('alarmNeverClaimedDispatches', () =>
    alarmNeverClaimedDispatches(now),
  );
  // ISS-445 — close job-less system/interactive runs (schedule.run + chat)
  // whose backing agent_session is no longer live. These runs carry no `jobs`
  // row, so the job loop never fires for them and they would leak `running`
  // forever (VISION §5.10 "state never lies"). Still an ACTIVE reaper.
  const orphanedOneShotRuns = await runPass('reapOrphanedOneShotRuns', () =>
    reapOrphanedOneShotRuns(now),
  );
  // ISS-461 — close `issue`-kind runs whose backing issue already reached a
  // terminal status (closed/released) but whose run never closed. closeOpenRunForIssue
  // fires only via applyTransition; a terminal write that bypasses it (or closes
  // predating that wiring) leaks the run `running`/`paused` forever and inflates
  // the dashboard live-run count. Run-axis backstop; still an ACTIVE reaper.
  const orphanedIssueRuns = await runPass('reapOrphanedIssueRuns', () =>
    reapOrphanedIssueRuns(now),
  );
  // ISS-442 — surface dependency deadlocks the dispatcher can't resolve: a job
  // queued past the grace window whose `blocks`/`decomposes` blocker is parked
  // (merged_at NULL, not closed, no active job to ever stamp it). Static config
  // validation can't catch a no-op skill on an enabled+auto merge stage, so this
  // runtime pass is the backstop (anhome-class wedge). Detect + escalate only —
  // never mutates state (operator fixes mergeStates or marks the blocker merged).
  const stalledDependencies = await runPass('detectStalledDependencies', () =>
    detectStalledDependencies(now),
  );
  // ISS-639 — active counterpart to the blocks-gate `closed` bypass fix: a
  // dependent whose blocker closed WITHOUT merging (under a stampable base)
  // now simply sits queued past the gate rather than dispatching onto a base
  // branch missing the blocker's code. Park it at `waiting` so a human picks
  // the base, instead of leaving it silently stuck forever.
  const parkedClosedUnmerged = await runPass('parkClosedUnmergedBlockedDependents', () =>
    parkClosedUnmergedBlockedDependents(now),
  );
  const backstopProjects = await runPass('dispatcherBackstop', () => runDispatcherBackstop());
  // ISS-381 (2.2) — snapshot per-project queue depth.
  const queueSnapshots = await runPass('recordQueueSnapshots', () => recordQueueSnapshots());

  // Preserve the ISS-449 missed-tick contract: if ANY pass failed, do NOT
  // record a clean heartbeat — re-throw so `pgboss-health` still sees the
  // missed tick and pg-boss retries the (idempotent) tick. The difference from
  // the old code is purely ordering: every pass has already RUN this tick
  // before we surface the failure, so a single buggy pass can no longer starve
  // the reapers. Each error was logged + captured individually above; re-throw
  // the first so its original cause/message surfaces unchanged.
  if (errors.length > 0) {
    throw errors[0]?.err;
  }

  recordPipelineSweeperTick(t0);
  return {
    durationMs: Date.now() - t0,
    // Safe: reached only when `errors` is empty, i.e. every pass returned a value.
    loop: loop as LoopMonitorResult,
    zombieSessions: zombieSessions as ZombieSweepResult,
    orphanedJobs: orphanedJobs as OrphanReconcileResult,
    neverClaimedDispatches: neverClaimedDispatches as OrphanReconcileResult,
    orphanedOneShotRuns: orphanedOneShotRuns as OneShotRunReapResult,
    orphanedIssueRuns: orphanedIssueRuns as IssueRunReapResult,
    stalledDependencies: stalledDependencies as StallDetectResult,
    parkedClosedUnmerged: parkedClosedUnmerged as ParkClosedUnmergedResult,
    backstopProjects: backstopProjects as number,
    queueSnapshots: queueSnapshots as number,
  };
}

/**
 * Grace window before a still-queued, dependency-blocked job is treated as a
 * deadlock rather than a normal wait. Long by design: a legit blocker can take
 * a while to merge. Override with `FORGE_STALL_GRACE_MS`.
 */
const STALL_GRACE_MS = (() => {
  const env = Number(process.env.FORGE_STALL_GRACE_MS);
  return Number.isFinite(env) && env > 0 ? env : 45 * 60_000;
})();

type StalledRow = {
  job_id: string;
  project_id: string;
  job_type: string;
  issue_id: string;
  wedged_seq: number;
  wedged_title: string;
  blocker_id: string;
  blocker_status: string;
  blocker_seq: number;
  blocker_title: string;
  kind: string;
  queued_secs: number;
};

// ISS-619 — EN label for the blocker's internal status, used in the
// business-language wedge summary. Falls back to a title-cased status for
// any value not explicitly mapped (new statuses shouldn't need a code change
// here to render legibly).
const BLOCKER_STATUS_LABELS: Record<string, string> = {
  needs_info: 'Needs info',
  waiting: 'Waiting for review',
  on_hold: 'On hold',
  draft: 'Draft',
  reopen: 'Reopened',
};

function blockerStatusLabel(status: string): string {
  return (
    BLOCKER_STATUS_LABELS[status] ??
    status.charAt(0).toUpperCase() + status.slice(1).replace(/_/g, ' ')
  );
}

function humanizeDuration(mins: number): string {
  return mins < 60 ? `~${mins}m` : `~${Math.round(mins / 60)}h`;
}

/**
 * ISS-442 — detect dependency deadlocks the dispatcher will never resolve and
 * surface them via `emitPipelineWedge` (deduped per job, fans out to the owner,
 * feeds the interventions metric). A job is deadlocked when it has sat `queued`
 * past {@link STALL_GRACE_MS} and its gate's blocker is PARKED: `merged_at` is
 * NULL, the blocker isn't `closed`, and the blocker has NO active job that could
 * ever advance it to stamp `merged_at`. Mirrors the `blockedBy` /
 * `decomposeChildrenPending` predicates in `jobs/dispatch-gates.ts` (same
 * job-type scoping) plus the parked-blocker condition. Detection only — never
 * mutates state. Best-effort: never throws (returns 0 on error).
 */
export async function detectStalledDependencies(
  now: Date = new Date(),
  scope: SweepScope = {},
): Promise<StallDetectResult> {
  try {
    const cutoffIso = new Date(now.getTime() - STALL_GRACE_MS).toISOString();
    const projectClause = scope.projectId ? sql`AND j.project_id = ${scope.projectId}` : sql``;

    const rows = await db.execute<StalledRow>(sql`
      SELECT j.id AS job_id, j.project_id, j.type AS job_type, j.issue_id::text AS issue_id,
             wi.iss_seq AS wedged_seq, wi.title AS wedged_title,
             p.id::text AS blocker_id, p.status AS blocker_status,
             p.iss_seq AS blocker_seq, p.title AS blocker_title, d.kind,
             extract(epoch FROM (now() - j.queued_at))::int AS queued_secs
      FROM jobs j
      JOIN pipeline_runs r ON r.id = j.pipeline_run_id
      JOIN issues wi ON wi.id = j.issue_id
      JOIN issue_dependencies d ON (
            (d.kind = 'blocks' AND d.to_issue_id = j.issue_id AND j.type <> 'pm')
         OR (d.kind = 'decomposes' AND d.from_issue_id = j.issue_id
             AND j.type IN ('code','review','test','fix'))
      )
      JOIN issues p ON p.id = (CASE WHEN d.kind = 'blocks' THEN d.from_issue_id ELSE d.to_issue_id END)
      WHERE j.status = 'queued'
        AND j.issue_id IS NOT NULL
        AND j.queued_at < ${cutoffIso}
        AND r.status = 'running'
        AND (d.valid_until IS NULL OR d.valid_until > now())
        AND p.merged_at IS NULL
        AND p.status <> 'closed'
        AND NOT EXISTS (
          SELECT 1 FROM jobs bj
          WHERE bj.issue_id = p.id
            AND bj.status IN ('queued','dispatched','running')
        )
        ${projectClause}
      ORDER BY j.queued_at ASC
      LIMIT 100
    `);

    const seen = new Set<string>();
    let detected = 0;
    for (const row of rows) {
      if (seen.has(row.job_id)) continue;
      seen.add(row.job_id);
      const mins = Math.round(row.queued_secs / 60);
      const rel = row.kind === 'blocks' ? 'blocked by' : 'decomposes — waiting on child';
      const relBusiness = row.kind === 'blocks' ? 'a blocking issue' : 'a sub-task';
      const statusLabel = blockerStatusLabel(row.blocker_status);
      const nextStep =
        row.blocker_status === 'needs_info'
          ? `Add the missing info to ISS-${row.blocker_seq}, or mark it done if it's already complete.`
          : `Resolve ISS-${row.blocker_seq} (or mark it done) so this work can continue.`;
      await emitPipelineWedge({
        projectId: row.project_id,
        issueId: row.issue_id,
        hop: 'dispatch',
        entity: 'job',
        entityId: row.job_id,
        reason: `'${row.job_type}' job queued ${mins}m, ${rel} ${row.blocker_id} which is parked at status='${row.blocker_status}' (merged_at NULL, no active job). The dependency gate keys on merged_at, which only stamps when the blocker leaves its mergeStates.baseBranch — so this gate will never clear on its own.`,
        action: `Fix the blocker's merge point: Settings → Pipeline → "Merge points" (set baseBranch to the stage where it actually merges), or mark the blocker merged (forge_issues mark_merged) if it is genuinely done.`,
        title: `Blocked: ISS-${row.wedged_seq} "${row.wedged_title}" is waiting on ${relBusiness} that can't continue`,
        summary: `Waiting ${humanizeDuration(mins)}. ISS-${row.blocker_seq} "${row.blocker_title}" is parked at "${statusLabel}" and won't proceed on its own.`,
        nextStep,
        secondaryIssueId: row.blocker_id,
      });
      detected++;
    }
    if (detected > 0) {
      logger.warn({ detected }, 'pipeline-sweeper: dependency deadlocks surfaced');
    }
    return { detected };
  } catch (err) {
    logger.error({ err }, 'pipeline-sweeper: stall detection pass failed (skipped)');
    return { detected: 0 };
  }
}

type ClosedUnmergedRow = {
  job_id: string;
  project_id: string;
  issue_id: string;
  issue_status: IssueStatus;
  issue_reopen_count: number;
  blocker_seq: number;
  blocker_title: string;
  created_by: string | null;
};

/**
 * ISS-639 — active counterpart to the blocks-gate fix in
 * `jobs/dispatch-gates.ts`: when a project's `mergeStates.baseBranch` IS
 * stampable, the gate no longer treats a `closed`+`merged_at IS NULL`
 * blocker as satisfying `blockedBy`/`decomposeChildrenPending`, so a
 * dependent whose blocker closed without merging now just sits `queued`
 * forever instead of silently dispatching onto a base branch missing the
 * blocker's code (devbox ISS-2/ISS-4). This pass actively unwedges it: past
 * {@link STALL_GRACE_MS} (same grace window as `detectStalledDependencies` —
 * long enough for the ordinary close→`mark_merged` race to resolve on its
 * own), park the dependent issue at `waiting`, comment naming the unmerged
 * blocker, and reap its stuck run so the project's serial slot frees.
 * Skips projects whose base is structurally unstampable (manual/toggle-off)
 * — that is the legitimate `OR status='closed'` bypass the gate still
 * honors, so those dependents are left alone. Best-effort: never throws
 * (returns `{ parked: 0 }` on error); each row is isolated so one failure
 * doesn't block the rest.
 *
 * Since the close-time auto-stamp (issues/merged-at.ts markMergedOnClose,
 * getcontent 2026-07-13), every close through the state-machine writer (and
 * the GitHub mirror-close) stamps merged_at, so new closed-unmerged blockers
 * can no longer arise from normal operation. This pass stays as the backstop
 * for pre-existing rows and direct DB writes that bypass both paths.
 */
export async function parkClosedUnmergedBlockedDependents(
  now: Date = new Date(),
  scope: SweepScope = {},
): Promise<ParkClosedUnmergedResult> {
  try {
    const cutoffIso = new Date(now.getTime() - STALL_GRACE_MS).toISOString();
    const projectClause = scope.projectId ? sql`AND j.project_id = ${scope.projectId}` : sql``;

    const rows = await db.execute<ClosedUnmergedRow>(sql`
      SELECT DISTINCT ON (j.issue_id)
             j.id AS job_id, j.project_id, j.issue_id::text AS issue_id,
             wi.status AS issue_status, wi.reopen_count AS issue_reopen_count,
             p.iss_seq AS blocker_seq, p.title AS blocker_title,
             pr.created_by AS created_by
      FROM jobs j
      JOIN pipeline_runs r ON r.id = j.pipeline_run_id
      JOIN issues wi ON wi.id = j.issue_id
      JOIN projects pr ON pr.id = j.project_id
      JOIN issue_dependencies d ON (
            (d.kind = 'blocks' AND d.to_issue_id = j.issue_id AND j.type <> 'pm')
         OR (d.kind = 'decomposes' AND d.from_issue_id = j.issue_id
             AND j.type IN ('code','review','test','fix'))
      )
      JOIN issues p ON p.id = (CASE WHEN d.kind = 'blocks' THEN d.from_issue_id ELSE d.to_issue_id END)
      WHERE j.status = 'queued'
        AND j.issue_id IS NOT NULL
        AND j.queued_at < ${cutoffIso}
        AND r.status = 'running'
        AND wi.status <> 'waiting'
        AND (d.valid_until IS NULL OR d.valid_until > now())
        AND p.status = 'closed'
        AND p.merged_at IS NULL
        ${projectClause}
      ORDER BY j.issue_id, j.queued_at ASC
      LIMIT 100
    `);

    let parked = 0;
    const stampableCache = new Map<string, boolean>();
    for (const row of rows) {
      try {
        let stampable = stampableCache.get(row.project_id);
        if (stampable === undefined) {
          stampable = (await resolveGateSettings(row.project_id)).baseStampable;
          stampableCache.set(row.project_id, stampable);
        }
        // Legit closed-bypass case (manual/toggle-off base) — the gate itself
        // still honors `closed` for these; leave the dependent alone.
        if (!stampable) continue;
        // comments.author_id is non-nullable; nothing to attribute the park to.
        if (!row.created_by) continue;

        const device: DeviceLite = { id: row.created_by, ownerId: row.created_by };
        const issueRow: TransitionIssueRow = {
          id: row.issue_id,
          projectId: row.project_id,
          status: row.issue_status,
          reopenCount: row.issue_reopen_count,
        };
        await applyStatusTransition(issueRow, 'waiting', device, { skip: true });

        await db.insert(comments).values({
          issueId: row.issue_id,
          authorId: row.created_by,
          isAi: true,
          body: `⛔ Blocked: ISS-${row.blocker_seq} "${row.blocker_title}" was closed without merging its code to the base branch (merged_at is empty). Pipeline can't build on it. Decide the base: reopen/merge the blocker, or \`mark_merged\` it if the code is genuinely in, then move this issue back to its stage.`,
        } as never);

        await closeOpenRunForIssue(row.issue_id, 'failed');
        parked++;
      } catch (err) {
        logger.warn(
          { err, issueId: row.issue_id },
          'pipeline-sweeper: park-closed-unmerged row failed (skipped)',
        );
      }
    }
    if (parked > 0) {
      logger.warn(
        { parked },
        'pipeline-sweeper: parked dependents blocked on closed-unmerged blocker',
      );
    }
    return { parked };
  } catch (err) {
    logger.error({ err }, 'pipeline-sweeper: park-closed-unmerged pass failed (skipped)');
    return { parked: 0 };
  }
}

/**
 * ISS-381 (2.2) — write one `queue_snapshots` row per project that currently has
 * at least one active job (queued/dispatched/running). One grouped
 * INSERT...SELECT per tick; projects with no active jobs get no row (the read
 * gap-fills missing buckets as 0). Best-effort: never throws — a snapshot is
 * observability, not part of the dispatch path. Returns the rows written.
 *
 * `avg_wait_ms` is the mean current wait (now - queued_at) over jobs still
 * `queued` (NULL when none are queued). `queue_depth` counts `queued`;
 * `running_count` counts `dispatched`+`running`.
 */
async function recordQueueSnapshots(): Promise<number> {
  try {
    const rows = await db.execute<{ project_id: string }>(sql`
      INSERT INTO queue_snapshots (project_id, queue_depth, running_count, avg_wait_ms)
      SELECT project_id,
             count(*) FILTER (WHERE status = 'queued')::int AS queue_depth,
             count(*) FILTER (WHERE status IN ('dispatched', 'running'))::int AS running_count,
             avg(extract(epoch from (now() - queued_at)) * 1000.0)
               FILTER (WHERE status = 'queued')::bigint AS avg_wait_ms
      FROM jobs
      WHERE status IN ('queued', 'dispatched', 'running')
      GROUP BY project_id
      RETURNING project_id
    `);
    const written = Array.isArray(rows) ? rows.length : 0;
    if (written > 0) {
      logger.info({ written }, 'pipeline-sweeper: queue snapshots written');
    }
    return written;
  } catch (err) {
    logger.error({ err }, 'pipeline-sweeper: queue snapshot pass failed (skipped)');
    return 0;
  }
}

/**
 * Re-tick `dispatchTickForProject` for every project with at least one
 * queued job. Returns the count of projects observed (not ticks completed —
 * `dispatchTickForProject` debounces per project so a recently-fired event
 * trigger may coalesce this call into a no-op). Errors propagate to the
 * caller so the failure is visible to `pgboss-health` instead of swallowed.
 */
async function runDispatcherBackstop(): Promise<number> {
  const rows = await db
    .selectDistinct({ projectId: jobs.projectId })
    .from(jobs)
    .where(eq(jobs.status, 'queued'));
  for (const r of rows) {
    void dispatchTickForProject(r.projectId);
  }
  return rows.length;
}

type SweepScope = LoopScope;

type SessionAlarmRow = {
  id: string;
  project_id: string;
  pipeline_run_id: string | null;
};

/**
 * DEMOTED (ISS-449) — alarm-only mirror of the loop monitor's session hops
 * (claim queue-timeout / heartbeat-stale / no-client). Detection predicates
 * are kept in lockstep with `reapZombieSessions` (jobs/loop-monitor.ts); a
 * match here means the loop missed the row this tick. No terminal writes.
 *
 * For an actual scoped reap (the manual `/agent-sessions/sweep-zombies`
 * endpoint), call `reapZombieSessions` directly.
 */
export async function alarmZombieSessions(
  now: Date,
  scope: SweepScope = {},
): Promise<ZombieSweepResult> {
  const { queueMs, heartbeatMs } = getZombieThresholds();
  const queueCutoffIso = new Date(now.getTime() - queueMs).toISOString();
  const heartbeatCutoffIso = new Date(now.getTime() - heartbeatMs).toISOString();
  const projectClause = scope.projectId ? sql`AND s.project_id = ${scope.projectId}` : sql``;

  const queued = await db.execute<SessionAlarmRow>(sql`
    SELECT s.id, s.project_id, s.pipeline_run_id
    FROM agent_sessions s
    WHERE s.status = 'queued'
      AND ((s.dispatched_at IS NOT NULL AND s.dispatched_at < ${queueCutoffIso})
        OR (s.dispatched_at IS NULL AND s.created_at < ${queueCutoffIso}))
      AND s.metadata->>'type' IN ${PIPELINE_METADATA_TYPES}
      ${projectClause}
  `);

  const heartbeat = await db.execute<SessionAlarmRow>(sql`
    SELECT s.id, s.project_id, s.pipeline_run_id
    FROM agent_sessions s
    WHERE s.status = 'running'
      AND ((s.last_heartbeat_at IS NOT NULL AND s.last_heartbeat_at < ${heartbeatCutoffIso})
        OR (s.last_heartbeat_at IS NULL AND s.started_at IS NOT NULL
            AND s.started_at < ${heartbeatCutoffIso} AND s.updated_at < ${heartbeatCutoffIso})
        OR (s.last_heartbeat_at IS NULL AND s.started_at IS NULL
            AND s.updated_at < ${heartbeatCutoffIso} AND s.created_at < ${heartbeatCutoffIso}))
      AND s.metadata->>'type' IN ${PIPELINE_METADATA_TYPES}
      ${projectClause}
  `);

  const noClient = await db.execute<SessionAlarmRow>(sql`
    SELECT s.id, s.project_id, s.pipeline_run_id
    FROM agent_sessions s
    WHERE s.status = 'running'
      AND s.claude_session_id IS NULL
      AND COALESCE(s.metadata->>'type','') NOT IN ${PIPELINE_METADATA_TYPES}
      AND ((s.last_heartbeat_at IS NOT NULL AND s.last_heartbeat_at < ${heartbeatCutoffIso})
        OR (s.last_heartbeat_at IS NULL AND s.created_at < ${heartbeatCutoffIso}))
      ${projectClause}
  `);

  await alarmLoopMiss('claim', 'session', [...queued, ...noClient]);
  await alarmLoopMiss('heartbeat', 'session', [...heartbeat]);

  return {
    queueTimedOut: queued.length,
    heartbeatTimedOut: heartbeat.length,
    noClientAcked: noClient.length,
  };
}

type JobAlarmRow = {
  id: string;
  project_id: string;
  issue_id: string | null;
};

/**
 * DEMOTED (ISS-449) — alarm-only mirror of the loop monitor's session-lost
 * propagation (`reapSessionLostJobs`, was ISS-280 `reconcileOrphanedJobs`).
 */
export async function alarmOrphanedJobs(
  _now: Date = new Date(),
  scope: SweepScope = {},
): Promise<OrphanReconcileResult> {
  const projectClause = scope.projectId ? sql`AND j.project_id = ${scope.projectId}` : sql``;
  const candidates = await db.execute<JobAlarmRow>(sql`
    SELECT j.id, j.project_id, j.issue_id
    FROM jobs j
    JOIN agent_sessions s ON s.id = j.agent_session_id
    WHERE j.status IN ('dispatched', 'running')
      AND s.status IN ('failed', 'cancelled_stale')
      AND NOT EXISTS (
        SELECT 1 FROM job_events e
        WHERE e.job_id = j.id AND e.kind = 'result'
      )
      ${projectClause}
  `);

  await alarmLoopMiss('heartbeat', 'job', [...candidates]);
  return { reconciled: candidates.length };
}

/**
 * DEMOTED (ISS-449) — alarm-only mirror of the loop monitor's dispatch→ack
 * hop (`reapAckMisses`, was ISS-378 `reconcileNeverClaimedDispatches`). The
 * `acked_at IS NULL` term keeps the predicate in lockstep with the loop: an
 * ACKED job with no events is claimed-but-quiet, which is the result hop's
 * territory, not an ack miss.
 */
export async function alarmNeverClaimedDispatches(
  now: Date = new Date(),
  scope: SweepScope = {},
): Promise<OrphanReconcileResult> {
  const projectClause = scope.projectId ? sql`AND j.project_id = ${scope.projectId}` : sql``;
  const cutoffIso = new Date(now.getTime() - getLoopThresholds().ackMs).toISOString();
  const candidates = await db.execute<JobAlarmRow>(sql`
    SELECT j.id, j.project_id, j.issue_id
    FROM jobs j
    WHERE j.status = 'dispatched'
      AND j.acked_at IS NULL
      AND j.dispatched_at IS NOT NULL
      AND j.dispatched_at < ${cutoffIso}
      AND NOT EXISTS (
        SELECT 1 FROM job_events e WHERE e.job_id = j.id
      )
      ${projectClause}
  `);

  await alarmLoopMiss('ack', 'job', [...candidates]);
  return { reconciled: candidates.length };
}

/** Shared alarm tail: log the loop miss + surface it as a wedge (the wedge
 *  emitter dedupes per entity, so a row stuck across ticks doesn't spam). */
async function alarmLoopMiss(
  hop: 'ack' | 'claim' | 'heartbeat' | 'result',
  entity: 'job' | 'session',
  rows: Array<SessionAlarmRow | JobAlarmRow>,
): Promise<void> {
  if (rows.length === 0) return;
  logger.warn({ hop, entity, ids: rows.map((r) => r.id) }, 'loop-miss');
  for (const row of rows) {
    await emitPipelineWedge({
      projectId: row.project_id,
      issueId: 'issue_id' in row ? row.issue_id : null,
      hop,
      entity,
      entityId: row.id,
      reason: `loop-miss: the ${hop} hop should have handled this ${entity} and did not (alarm pass match)`,
      action:
        'Inspect core logs around this tick for a thrown miss-handler; if the row is genuinely wedged, use the single-job cancel escape hatch (forge_jobs cancel).',
    });
  }
}

/**
 * ISS-445 — close job-less `system`/`interactive` runs whose session is dead.
 *
 * schedule.run and interactive chat open a one-shot run via `openOneShotRun`
 * and execute it over an `agent:start` WS broadcast to the device room — they
 * create NO `jobs` row, so the `agent_session` IS the unit of work. The only
 * existing close paths are session/job-terminal events: the device POSTing
 * `/agent-sessions/desktop/status` (→ `closeRunIfOneShot`) and the job
 * lifecycle (`jobs/agent-session-link.ts`). When an unattended device finishes
 * the turn but never reports terminal status (the dominant schedule.run case),
 * both the session AND the run stay `running` forever — the loop monitor's
 * session hops don't catch it (claim/heartbeat are gated to
 * `metadata.type IN (pipeline,pm)`; the no-client hop only reaps
 * `claude_session_id IS NULL`), and `cascadeCancelChildJobs` keys
 * session-terminal off linked *jobs*, of which there are none.
 *
 * This pass is the backstop: a run is reapable when it is a job-less
 * `system`/`interactive` run older than the heartbeat threshold (age guard so
 * a freshly-opened run is never touched) with NO live session. A session counts
 * as live when its heartbeat is fresh within the bare heartbeat floor, OR
 * (ISS-442 device-aware grace) within a longer grace window while its device is
 * still beating on the runner WS — so a long-but-alive agent that goes quiet
 * between worker-side writes (parallel subagents) is not force-failed. Any
 * lingering non-terminal session is force-failed (`heartbeat_timeout`) and
 * broadcast first, then the run is closed through the shared
 * `closeRunIfOneShot` SSOT (CAS-guarded; cascade is a no-op with zero jobs).
 *
 * Outcome honesty: `completed` only when a session genuinely reached a
 * completed terminal and none failed (the missed-`/desktop/status` case);
 * otherwise `failed` — never the false-`completed` mirror of ISS-352. The pass
 * also drains the existing leaked backlog on the first ticks after deploy
 * (their heartbeats are days stale), so no one-shot migration is needed.
 *
 * Best-effort per row: one failure is logged and skipped, never aborting the
 * pass — same convention as the loop monitor's per-row handlers.
 */
export async function reapOrphanedOneShotRuns(
  now: Date = new Date(),
  scope: SweepScope = {},
): Promise<OneShotRunReapResult> {
  const { heartbeatMs } = getZombieThresholds();
  // postgres-js rejects raw Date params; serialise to ISO before binding.
  const cutoffIso = new Date(now.getTime() - heartbeatMs).toISOString();
  // ISS-442 — a job-less agent (esp. a schedule audit fanning out parallel
  // subagents) can go many minutes between worker-side writes while genuinely
  // alive, so the bare 3-min heartbeat floor force-failed LIVE runs (the run
  // closed mid-work; the still-running session was then orphaned by the
  // terminal-run trigger). Add a device-aware grace: a session whose heartbeat
  // is within DEVICE_GRACE *and* whose device is still beating on the runner WS
  // (`runners.last_seen_at` fresh) counts as live. A dead/disconnected device
  // still reaps on the bare heartbeat floor; a truly abandoned session reaps
  // once even the grace lapses.
  const deviceGraceMs = Math.max(heartbeatMs, 20 * 60_000);
  const graceCutoffIso = new Date(now.getTime() - deviceGraceMs).toISOString();
  const projectClause = scope.projectId ? sql`AND r.project_id = ${scope.projectId}` : sql``;

  const candidates = await db.execute<{ id: string }>(sql`
    SELECT r.id
    FROM pipeline_runs r
    WHERE r.kind IN ('system', 'interactive')
      AND r.status IN ('running', 'paused')
      AND r.started_at < ${cutoffIso}
      AND NOT EXISTS (
        SELECT 1 FROM jobs j WHERE j.pipeline_run_id = r.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM agent_sessions s
        WHERE s.pipeline_run_id = r.id
          AND s.status IN ('queued', 'running', 'idle')
          AND (
            COALESCE(s.last_heartbeat_at, s.started_at, s.updated_at, s.created_at) >= ${cutoffIso}
            OR (
              COALESCE(s.last_heartbeat_at, s.started_at, s.updated_at, s.created_at) >= ${graceCutoffIso}
              AND EXISTS (
                SELECT 1 FROM runners rn
                WHERE rn.device_id = s.device_id
                  AND rn.last_seen_at >= ${cutoffIso}
              )
            )
          )
      )
      ${projectClause}
    ORDER BY r.started_at ASC
    LIMIT 200
  `);

  let reaped = 0;
  for (const row of candidates) {
    try {
      // Force-fail any lingering non-terminal session for this run. A session
      // already completed/failed is left as-is — the run still needs closing
      // (the missed-`/desktop/status` case).
      const flipped = await applyKernelTransition(db, {
        entity: 'session',
        to: 'failed',
        set: { failureReason: 'heartbeat_timeout', updatedAt: now },
        where: and(
          eq(agentSessions.pipelineRunId, row.id),
          inArray(agentSessions.status, ['queued', 'running', 'idle']),
        ),
        fromStatus: 'active',
        reason: 'heartbeat_timeout',
        actor: { type: 'sweeper' },
        source: 'sweeper',
      });
      for (const s of flipped) {
        broadcastSessionEvent(s.id, s.projectId, s.deviceId, 'agent-session.status', {
          status: 'failed',
          failureReason: 'heartbeat_timeout',
        });
      }

      // Derive the run outcome from the post-flip session statuses: a genuine
      // success-close (`completed`) only when some session reached a completed
      // terminal and none is failed/cancelled_stale; otherwise `failed`.
      const sessions = await db
        .select({ status: agentSessions.status })
        .from(agentSessions)
        .where(eq(agentSessions.pipelineRunId, row.id));
      const anyCompleted = sessions.some(
        (s) => s.status === 'completed' || s.status === 'completed_via_recovery',
      );
      const anyFailed = sessions.some(
        (s) => s.status === 'failed' || s.status === 'cancelled_stale',
      );
      const outcome: 'completed' | 'failed' = anyCompleted && !anyFailed ? 'completed' : 'failed';

      await closeRunIfOneShot(row.id, outcome);
      reaped++;
    } catch (err) {
      logger.error(
        { err, runId: row.id },
        'pipeline-sweeper: orphaned one-shot run reap failed (row skipped)',
      );
    }
  }

  if (reaped > 0) {
    logger.info({ reaped }, 'pipeline-sweeper: orphaned one-shot runs closed');
  }

  return { reaped };
}

/**
 * ISS-461 — close `issue`-kind runs left `running`/`paused` after their backing
 * issue already reached a TERMINAL status (closed/released).
 *
 * `closeOpenRunForIssue` is wired in exactly one place — `apply-transition.ts`'s
 * terminal block — so a terminal-status write that bypasses `applyTransition`
 * (or a close predating that wiring) orphans the issue run: it stays
 * `running`/`paused` forever, and none of the other reapers cover `kind='issue'`
 * (`reapOrphanedOneShotRuns` is scoped to `system`/`interactive`). The dashboard
 * live-run count (`derive.ts liveRuns()`) renders every `running`/`paused` run,
 * so each leak inflates it.
 *
 * Run-axis backstop (sibling of `reapOrphanedOneShotRuns`): it closes each
 * candidate through the shared SSOT `closeOpenRunForIssue` (CAS-guarded on
 * `status IN (running,paused)`, sets `finishedAt`, cascades child-job cancel,
 * emits the close hook). Outcome `'completed'` mirrors `apply-transition.ts`,
 * which passes `'completed'` for both `released` and `closed` — never a false
 * `failed`. The age guard (`started_at` older than the heartbeat threshold)
 * avoids racing a just-fired `applyTransition` close, and also drains the
 * existing leaked backlog on the first ticks after deploy (their `started_at`
 * is days old) — no one-shot migration needed.
 *
 * Best-effort per row: one failure is logged and skipped, never aborting the
 * pass — same convention as `reapOrphanedOneShotRuns`.
 */
export async function reapOrphanedIssueRuns(
  now: Date = new Date(),
  scope: SweepScope = {},
): Promise<IssueRunReapResult> {
  const { heartbeatMs } = getZombieThresholds();
  // postgres-js rejects raw Date params; serialise to ISO before binding.
  const cutoffIso = new Date(now.getTime() - heartbeatMs).toISOString();
  const projectClause = scope.projectId ? sql`AND r.project_id = ${scope.projectId}` : sql``;

  const candidates = await db.execute<{ id: string; issue_id: string }>(sql`
    SELECT r.id, r.issue_id
    FROM pipeline_runs r
    JOIN issues i ON i.id = r.issue_id
    WHERE r.kind = 'issue'
      AND r.status IN ('running', 'paused')
      AND i.status IN ('closed', 'released')
      AND r.started_at < ${cutoffIso}
      ${projectClause}
    ORDER BY r.started_at ASC
    LIMIT 200
  `);

  let reaped = 0;
  for (const row of candidates) {
    try {
      await closeOpenRunForIssue(row.issue_id, 'completed');
      reaped++;
    } catch (err) {
      logger.error(
        { err, runId: row.id, issueId: row.issue_id },
        'pipeline-sweeper: orphaned issue-run reap failed (row skipped)',
      );
    }
  }

  if (reaped > 0) {
    logger.info({ reaped }, 'pipeline-sweeper: orphaned issue runs closed');
  }

  return { reaped };
}

let registered = false;

export async function registerPipelineSweeper(): Promise<void> {
  if (registered) return;
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss v10 type drift
  await (boss as any).createQueue(PIPELINE_SWEEPER_QUEUE);
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss v10 type drift
  await (boss as any).work(PIPELINE_SWEEPER_QUEUE, async () => {
    try {
      await runPipelineSweep();
    } catch (err) {
      logger.error({ err }, 'pipeline-sweeper: tick failed');
      throw err;
    }
  });
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss v10 type drift
  await (boss as any).schedule(PIPELINE_SWEEPER_QUEUE, '* * * * *'); // every minute
  registered = true;
}

export function resetPipelineSweeperForTest(): void {
  registered = false;
}
