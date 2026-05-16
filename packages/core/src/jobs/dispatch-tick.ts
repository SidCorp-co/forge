/**
 * ISS-40 PR-E — per-project dispatch re-tick orchestrator.
 *
 * Triggers (each fires `dispatchTickForProject(projectId)` fire-and-forget):
 *   - job complete / fail / cancel
 *   - issue terminal transition (released/closed/pipeline_failed) — also ticks
 *     child projects when a cross-project blocking edge unblocks
 *   - runner online flip
 *   - 60s pg-boss backstop sweep
 *
 * Each project has its own promise-chain lock so two simultaneous triggers
 * for the same project collapse into a single sweep. A 1-second debounce
 * absorbs bursts (e.g. five jobs completing within 200ms in a fan-out).
 *
 * The lock is in-process — losing it on crash means we drop pending sweeps,
 * so the 60s pg-boss schedule is the recovery mechanism.
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
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
 * runner online, backstop sweep) pass nothing and the event falls back to
 * `blockerId: null` (front-end renders a generic `Unblocked` tooltip).
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
  const next = tail
    .catch(() => undefined) // isolate from prior tick errors
    .then(async () => {
      pendingTrigger.delete(projectId);
      if (debounceMs > 0) {
        await new Promise((r) => setTimeout(r, debounceMs));
      }
      try {
        await runTickInner(projectId, triggerBlockerIssueId);
      } catch (err) {
        logger.error({ err, projectId }, 'dispatch-tick: inner sweep threw');
      }
    });

  projectLocks.set(projectId, next);
  next.finally(() => {
    if (projectLocks.get(projectId) === next) projectLocks.delete(projectId);
  });
  return next;
}

async function runTickInner(
  projectId: string,
  triggerBlockerIssueId?: string,
): Promise<void> {
  const seen = new Set<string>();
  for (let i = 0; i < MAX_DISPATCH_PER_TICK; i++) {
    const job = await pickNextDispatchableJobForProject(projectId);
    if (!job) return;
    // If we keep picking the same job (e.g. it's deps-satisfied but Layer 4
    // keeps rejecting because the only runner is full), break out to avoid
    // a hot loop — the next external trigger will pick it up.
    if (seen.has(job.id)) return;
    seen.add(job.id);

    // Snapshot the prior gate reason BEFORE dispatch so we can detect a
    // `waiting_on_dep` clear and emit `dependency.unblocked`. The successful
    // dispatch path clears jobs.gate_reason atomically with the status flip,
    // so reading after dispatch would miss the transition.
    const priorGateReason = job.gateReason;

    const outcome = await handleDispatch({ jobId: job.id });

    if (
      outcome === 'dispatched' &&
      priorGateReason === 'waiting_on_dep' &&
      job.issueId
    ) {
      roomManager.publish(projectRoom(projectId), {
        event: 'dependency.unblocked',
        data: {
          issueId: job.issueId,
          blockerId: triggerBlockerIssueId ?? null,
          at: new Date().toISOString(),
        },
      });
    }

    if (outcome === 'skipped') {
      // Could be Layer 1/2/3/4 fail OR a no-runner branch. The next iter
      // will pick a different job (priority/queued_at order); seen-guard
      // prevents reselecting the same one.
      continue;
    }
  }
}

/**
 * Fan-out tick across every project that currently has queued work. Used by
 * the 60s pg-boss backstop schedule. Awaits all per-project ticks so the
 * backstop's own promise resolves only once the sweep is complete (no orphan
 * fire-and-forget; per-project locks already coalesce concurrent triggers).
 */
export async function dispatchTickAllProjectsWithQueued(): Promise<void> {
  const rows = await db.execute<{ project_id: string }>(sql`
    SELECT DISTINCT project_id
    FROM (
      SELECT project_id FROM jobs WHERE status = 'queued' AND type <> 'pm'
      UNION
      SELECT project_id FROM agent_sessions WHERE status = 'queued'
    ) t
    WHERE project_id IS NOT NULL
  `);
  await Promise.allSettled(
    rows
      .filter((r): r is { project_id: string } => Boolean(r.project_id))
      .map((r) => dispatchTickForProject(r.project_id)),
  );
}

export const DISPATCH_TICK_BACKSTOP_QUEUE = 'job-dispatch-tick-backstop';

let backstopRegistered = false;

/**
 * Register the pg-boss `* * * * *` schedule that runs the fan-out tick once
 * per minute. Idempotent.
 */
export async function registerDispatchTickBackstop(): Promise<void> {
  if (backstopRegistered) return;
  // Lazy import so callsites that only need dispatchTickForProject don't
  // pull pg-boss into the test loader (transition.test.ts, lifecycle-routes
  // .test.ts both touch this graph indirectly).
  const { boss } = await import('../queue/boss.js');
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss v10 type drift
  await (boss as any).createQueue(DISPATCH_TICK_BACKSTOP_QUEUE);
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss v10 type drift
  await (boss as any).work(DISPATCH_TICK_BACKSTOP_QUEUE, async () => {
    try {
      await dispatchTickAllProjectsWithQueued();
    } catch (err) {
      logger.error({ err }, 'dispatch-tick: backstop sweep failed');
      throw err;
    }
  });
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss v10 type drift
  await (boss as any).schedule(DISPATCH_TICK_BACKSTOP_QUEUE, '* * * * *');
  backstopRegistered = true;
}

/** Test helper — reset the backstop registration flag. */
export function resetDispatchTickBackstopForTest(): void {
  backstopRegistered = false;
}

/** Test helper — override the debounce window. */
export function setDispatchTickDebounceMs(ms: number): void {
  debounceMs = ms;
}
