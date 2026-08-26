/**
 * ISS-40 PR-E — per-project dispatch re-tick orchestrator.
 *
 * Triggers (each fires `dispatchTickForProject(projectId)` fire-and-forget):
 *   - job complete / fail / cancel
 *   - issue terminal transition (released/closed) — also ticks
 *     child projects when a cross-project blocking edge unblocks
 *   - runner online flip
 *
 * Each project has its own promise-chain lock so two simultaneous triggers
 * for the same project collapse into a single sweep. A 1-second debounce
 * absorbs bursts (e.g. five jobs completing within 200ms in a fan-out).
 *
 * The lock is self-healing: any throw inside the inner sweep clears the
 * project's lock entry in the `finally` block, so a buggy tick cannot
 * poison the project's tick path forever (ISS-162 / ISS-141 amendment §1a).
 * Cross-process recovery for missed transitions is owned by the ISS-196
 * outbox worker + reconciler (`pipeline/outbox-worker.ts`, `pipeline/reconciler.ts`).
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { publishPipelineHealthChanged, recordTickAt } from '../issues/pipeline-health.js';
import { logger } from '../logger.js';
import { projectRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';
import { pickNextDispatchableJobForProject } from './dispatch-gates.js';
import { handleDispatch } from './dispatcher.js';
import { releaseHeldJobs } from './hold.js';
import { discardStaleTriggerJobs } from './stale-trigger.js';

/** Per-project promise tail. */
const projectLocks = new Map<string, Promise<unknown>>();

/** Set of projects whose tick is already pending (debounced). */
const pendingTrigger = new Set<string>();

/** Default debounce; overridable for tests via `setDispatchTickDebounceMs`. */
let debounceMs = 1000;

/** Safety cap to prevent a runaway tick from looping forever. */
const MAX_DISPATCH_PER_TICK = 50;

/**
 * Schedule a dispatch sweep for `projectId`. Coalescing rules:
 *   - If a tick is already pending (queued behind the lock), drop the new request.
 *   - Otherwise chain a new sweep onto the project's tail promise.
 *
 * `options.triggerBlockerIssueId` propagates from the terminal-transition
 * cascade so any `dependency.unblocked` event emitted during this sweep
 * names the blocker that triggered it. All other callers (job complete,
 * runner online, backstop sweep) pass nothing and the event is suppressed.
 *
 * Always resolves; never rejects (errors are logged, not propagated).
 */
// cm:flow dispatch/tick after:emit — coalesces every trigger for one project into a single sweep; ~8 call sites fire it with `void`, which is why the harness has to drain it
export function dispatchTickForProject(
  projectId: string,
  options?: { triggerBlockerIssueId?: string },
): Promise<void> {
  if (!projectId) return Promise.resolve();
  if (pendingTrigger.has(projectId)) return Promise.resolve();
  pendingTrigger.add(projectId);

  const triggerBlockerIssueId = options?.triggerBlockerIssueId;
  const tail = projectLocks.get(projectId) ?? Promise.resolve();
  // Forward-declare `next` so the `.then` callback can clear the lock entry
  // on its own promise — keeps a freshly-chained sweep from clobbering us.
  const next: Promise<void> = tail
    .catch(() => undefined) // isolate from prior tick errors
    .then(async () => {
      pendingTrigger.delete(projectId);
      try {
        if (debounceMs > 0) {
          await new Promise((r) => setTimeout(r, debounceMs));
        }
        await runTickInner(projectId, triggerBlockerIssueId);
      } catch (err) {
        logger.error({ err, projectId }, 'dispatch-tick: inner sweep threw');
      } finally {
        // Self-healing lock: even if runTickInner throws (or a hypothetical
        // synchronous throw from the setTimeout path), the lock entry is
        // released so the next external trigger starts a fresh chain.
        if (projectLocks.get(projectId) === next) projectLocks.delete(projectId);
      }
    });

  projectLocks.set(projectId, next);
  return next;
}

async function runTickInner(projectId: string, triggerBlockerIssueId?: string): Promise<void> {
  // ISS-164 — record per-project dispatcher heartbeat for pipelineHealth.lastTickAt.
  recordTickAt(projectId);

  // cm:guard release BEFORE the picker runs, never after (RFC 0002) — a runner coming back online fires this tick, and a release that landed after the pick would leave the freshly-queued job waiting for the NEXT trigger, which on a quiet project can be the 5-minute backstop
  try {
    await releaseHeldJobs(projectId);
  } catch (err) {
    logger.warn({ err, projectId }, 'dispatch-tick: hold release failed');
  }

  // cm:guard discard AFTER the hold release and BEFORE the picker (ISS-789) — a job released from hold is `queued` again and its trigger may have moved on while it waited, so releasing after would leave the stale job to be judged a whole tick later; and running after the pick would let the picker's own skip hide it for another cycle while `jobs_active_unique` blocks its replacement.
  try {
    await discardStaleTriggerJobs(projectId);
  } catch (err) {
    logger.warn({ err, projectId }, 'dispatch-tick: stale-trigger discard failed');
  }

  // ISS-164 — issues with queued work at sweep start; the post-sweep
  // pipelineHealth broadcast unions these with any issues whose jobs we end
  // up dispatching so still-gated rows get a refreshed `lastTickAt`.
  // The `retry_after_at` predicate mirrors the picker's L1 cooldown gate
  // (dispatch-gates.ts) so issues whose only queued work is parked under
  // a provider Retry-After hint don't trigger a per-tick WS broadcast —
  // without this, every backstop tick fans pipelineHealth events out to
  // every connected client for every cooldown-gated issue.
  const affectedIssueIds = new Set<string>();
  try {
    const rows = await db.execute<{ issue_id: string }>(sql`
      SELECT DISTINCT issue_id
      FROM jobs
      WHERE project_id = ${projectId}
        AND status = 'queued'
        AND issue_id IS NOT NULL
        AND (retry_after_at IS NULL OR retry_after_at <= now())
    `);
    for (const r of rows) if (r.issue_id) affectedIssueIds.add(r.issue_id);
  } catch (err) {
    logger.warn({ err, projectId }, 'dispatch-tick: queued-issue pre-snapshot failed');
  }

  try {
    // Jobs this tick picked but could not PLACE (barrier skip, or selected
    // runner full, or no capable free runner). Excluding them from the next
    // pick lets the tick keep draining placeable jobs onto free runners —
    // essential once maxConcurrentIssues>1, where a single unplaceable
    // head-of-line job (e.g. a resume pinned to a busy host) must NOT block
    // independent issues that can fan out to other runners.
    const skippedJobIds: string[] = [];
    for (let i = 0; i < MAX_DISPATCH_PER_TICK; i++) {
      const job = await pickNextDispatchableJobForProject(projectId, {
        excludeJobIds: skippedJobIds,
      });
      // null = nothing left the picker will hand out (incl. pool-wide full via
      // the L4 gate) — the tick is done.
      if (!job) return;
      if (job.issueId) affectedIssueIds.add(job.issueId);

      const outcome = await handleDispatch({ jobId: job.id });

      // Emit `dependency.unblocked` only when this sweep was triggered by a
      // terminal transition (the only caller that supplies triggerBlockerIssueId)
      // AND a job actually dispatched. Other triggers (job-complete, runner-
      // online, backstop) do not name a blocker and the front-end UI for those
      // is the regular `job.assigned` stream.
      if (outcome === 'dispatched' && triggerBlockerIssueId && job.issueId) {
        roomManager.publish(projectRoom(projectId), {
          event: 'dependency.unblocked',
          data: {
            issueId: job.issueId,
            blockerId: triggerBlockerIssueId,
            at: new Date().toISOString(),
          },
        });
      }

      if (outcome === 'skipped') {
        // This specific job couldn't be placed this tick. Exclude it and try
        // the next candidate rather than exiting (the original ISS-162 return
        // here head-of-line-blocked the whole project on one stuck job). The
        // picker is stateless, so excluding it prevents the re-pick spin; when
        // nothing placeable remains (incl. the whole pool full via the L4
        // gate) the picker returns null and the loop ends. Fresh state on the
        // next external trigger (job complete, runner online, 60s backstop)
        // re-evaluates every excluded job from scratch.
        skippedJobIds.push(job.id);
      }
    }
  } finally {
    // ISS-164 — broadcast refreshed pipelineHealth for every issue we
    // touched (dispatched) and every issue that started the tick with queued
    // work (still-gated rows pick up the new `lastTickAt`). Best-effort.
    if (affectedIssueIds.size > 0) {
      await publishPipelineHealthChanged(projectId, [...affectedIssueIds]);
    }
  }
}

/** Test helper — override the debounce window. */
export function setDispatchTickDebounceMs(ms: number): void {
  debounceMs = ms;
}

// cm:guard the integration harness MUST await this before dropping a worker database. Every trigger above is fire-and-forget, so a sweep outlives the test that caused it; dropping the database under one produced `database "test_w<N>_<hash>" does not exist` from runTickInner, and vitest attributes that rejection to whichever FILE happens to be running — which is why a docs-only commit could turn core-integration red.
// cm:edge protocol -> packages/core/tests/helpers/db.ts — cleanup() calls this first; reordering it after client.end() restores the race
/**
 * Await every in-flight sweep and settle the lock map.
 *
 * A sweep can chain another (dispatch → job complete → re-tick), so this
 * drains in rounds rather than awaiting a single snapshot. `rounds` bounds it
 * so a pathological re-tick loop surfaces as a leak rather than hanging the
 * suite; the residual project ids are returned for the caller to report.
 */
export async function quiesceDispatchTicks(rounds = 20): Promise<string[]> {
  for (let i = 0; i < rounds; i++) {
    const inflight = [...projectLocks.values()];
    if (inflight.length === 0) return [];
    await Promise.allSettled(inflight);
  }
  return [...projectLocks.keys()];
}
