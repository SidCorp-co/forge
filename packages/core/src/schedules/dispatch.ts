import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobs, projects, runners, schedules } from '../db/schema.js';
import { enqueueJob } from '../jobs/enqueue.js';
import { logger } from '../logger.js';
import { hooks } from '../pipeline/hooks.js';

export interface ScheduleRowForDispatch {
  id: string;
  projectId: string;
  prompt: string;
  runner: 'desktop' | 'antigravity';
  targetProjectSlug: string | null;
}

export interface DispatchScheduleInput {
  schedule: ScheduleRowForDispatch;
  // Manual triggers attribute the job to the calling user; tick triggers fall
  // back to the resolved project's owner (jobs.created_by is NOT NULL — see
  // FIXME(iss-257) in routes.ts).
  actorUserId?: string;
  // Marks the resulting job payload so consumers can distinguish tick-driven
  // runs from manual /:id/run triggers.
  tick?: boolean;
  // When the caller has already resolved `targetProjectSlug` (e.g. the route's
  // auth gate), pass the resolved project here to skip a redundant lookup.
  resolvedTarget?: { id: string; ownerId: string };
}

export type DispatchScheduleResult =
  | { ok: true; jobId: string; status: 'success'; resolvedProjectId: string }
  | { ok: false; reason: 'project-not-found' | 'no-runner'; status: 'skipped' }
  | { ok: false; reason: 'enqueue-failed'; status: 'failed'; jobId: string };

/**
 * Resolve target project (cross-project via `targetProjectSlug` or fall back to
 * the schedule's home project), guard against missing runners (desktop-only),
 * insert a `jobs` row, enqueue, and emit the `scheduleRun` hook. Pure of any
 * direct mutation on `schedules` — caller updates `lastStatus` from the
 * returned `status`.
 */
export async function dispatchScheduleRun(
  input: DispatchScheduleInput,
): Promise<DispatchScheduleResult> {
  const { schedule } = input;

  let resolvedProjectId = schedule.projectId;
  let resolvedOwnerId: string | undefined;

  if (schedule.targetProjectSlug) {
    const target =
      input.resolvedTarget ??
      (
        await db
          .select({ id: projects.id, ownerId: projects.ownerId })
          .from(projects)
          .where(eq(projects.slug, schedule.targetProjectSlug))
          .limit(1)
      )[0];
    if (!target) return { ok: false, reason: 'project-not-found', status: 'skipped' };
    resolvedProjectId = target.id;
    resolvedOwnerId = target.ownerId;
  }

  const createdBy = input.actorUserId ?? (await loadOwnerId(resolvedProjectId, resolvedOwnerId));
  if (!createdBy) return { ok: false, reason: 'project-not-found', status: 'skipped' };

  // Tick (system-driven) skips the run when no desktop runner is online so the
  // job doesn't pile up unattended. Manual triggers (`tick !== true`) always
  // queue — the user is explicitly asking, so let it wait for a runner.
  //
  // NOTE: `schedules.runner` and `runners.type` are independent enums that
  // happen to map 1:1 today: `'desktop'` schedule → `'claude-code'` runner;
  // `'antigravity'` is identical on both sides. If either enum is renamed in
  // the future, update this mapping in lockstep — there is no shared source.
  if (input.tick && schedule.runner === 'desktop') {
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(runners)
      .where(
        and(
          eq(runners.projectId, resolvedProjectId),
          eq(runners.status, 'online'),
          eq(runners.type, 'claude-code'),
        ),
      );
    if (!row || row.count === 0) {
      return { ok: false, reason: 'no-runner', status: 'skipped' };
    }
  }

  const [job] = await db
    .insert(jobs)
    .values({
      projectId: resolvedProjectId,
      createdBy,
      type: 'custom',
      payload: {
        kind: 'schedule.run',
        scheduleId: schedule.id,
        prompt: schedule.prompt,
        runner: schedule.runner,
        targetProjectSlug: schedule.targetProjectSlug ?? null,
        ...(input.tick ? { tick: true } : {}),
      },
      status: 'queued',
    })
    .returning({ id: jobs.id });
  if (!job) throw new Error('schedule.dispatch: insert returned no row');

  // Point lastSessionId at this attempt as soon as the row exists — the UI's
  // "last run" link should track the latest dispatch attempt, even when it
  // ends up `failed` because of enqueue trouble. Orphan-cleanup below flips
  // the row to `status='failed'` rather than leaving it `queued`.
  await db
    .update(schedules)
    .set({ lastSessionId: job.id })
    .where(eq(schedules.id, schedule.id));

  try {
    await enqueueJob(job.id);
  } catch (err) {
    logger.error({ err, jobId: job.id }, 'schedule.dispatch: enqueueJob failed');
    try {
      await db
        .update(jobs)
        .set({ status: 'failed', error: 'enqueue-failed' })
        .where(eq(jobs.id, job.id));
    } catch (cleanupErr) {
      logger.error(
        { err: cleanupErr, jobId: job.id },
        'schedule.dispatch: failed to mark orphaned job',
      );
    }
    return { ok: false, reason: 'enqueue-failed', status: 'failed', jobId: job.id };
  }

  // Hook subscribers are best-effort — a throw here must not fail the dispatch
  // (the job is already enqueued; the caller would otherwise see a 5xx while
  // the runner picks it up).
  try {
    await hooks.emit('scheduleRun', {
      scheduleId: schedule.id,
      projectId: resolvedProjectId,
      jobId: job.id,
      actorUserId: createdBy,
    });
  } catch (err) {
    logger.error(
      { err, scheduleId: schedule.id, jobId: job.id },
      'schedule.dispatch: scheduleRun hook threw',
    );
  }

  return { ok: true, jobId: job.id, status: 'success', resolvedProjectId };
}

async function loadOwnerId(projectId: string, hint?: string): Promise<string | undefined> {
  if (hint) return hint;
  const [row] = await db
    .select({ ownerId: projects.ownerId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return row?.ownerId;
}
