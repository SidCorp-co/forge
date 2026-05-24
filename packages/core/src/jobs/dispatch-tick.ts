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
import {
  publishPipelineHealthChanged,
  recordTickAt,
} from '../issues/pipeline-health.js';
import { logger } from '../logger.js';
import { projectRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';
import { pickNextDispatchableJobForProject } from './dispatch-gates.js';
import { handleDispatch } from './dispatcher.js';

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
  let next: Promise<void>;
  next = tail
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

async function runTickInner(
  projectId: string,
  triggerBlockerIssueId?: string,
): Promise<void> {
  // ISS-164 — record per-project dispatcher heartbeat for pipelineHealth.lastTickAt.
  recordTickAt(projectId);

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
    logger.warn(
      { err, projectId },
      'dispatch-tick: queued-issue pre-snapshot failed',
    );
  }

  try {
    for (let i = 0; i < MAX_DISPATCH_PER_TICK; i++) {
      const job = await pickNextDispatchableJobForProject(projectId);
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
        // ISS-162 — exit the loop on any skip. The picker is stateless and
        // would keep returning the same L4-blocked or no-runner candidate on
        // every iteration; spinning here would burn CPU until MAX_DISPATCH_PER_TICK.
        // The next external trigger (job complete, runner online, 60s backstop)
        // re-enters the sweep with fresh state.
        return;
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
