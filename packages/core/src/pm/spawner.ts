import { and, eq, gte, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobs, pmConfig, pmDecisions, projects } from '../db/schema.js';
import { enqueuePmJob } from '../jobs/enqueue.js';
import { isUniqueViolation } from '../lib/db-errors.js';
import { logger } from '../logger.js';
import { closeRun, openOneShotRun } from '../pipeline/runs.js';

export type SpawnCause =
  | 'job-failed'
  | 'pipeline-stalled'
  | 'needs-info'
  | 'queue-pressure'
  | 'graph-changed'
  | 'tick'
  | 'agent-cron'
  | 'operator'
  | 'operator-reply';

export interface SpawnPmSessionInput {
  projectId: string;
  cause: SpawnCause;
  eventRef?: Record<string, unknown>;
  // Set for 'operator' / 'operator-reply'. Becomes the `jobs.created_by`
  // FK; for non-operator causes we fall back to the project creator
  // (audit `projects.created_by`).
  actorUserId?: string;
}

export type SpawnPmSessionResult =
  | { ok: true; jobId: string }
  | { ok: false; reason: 'disabled' | 'trigger-masked' | 'rate-limited' | 'already-active' };

const MASKABLE_CAUSE_TO_TRIGGER_KEY: Partial<Record<SpawnCause, string>> = {
  'job-failed': 'jobFailed',
  'pipeline-stalled': 'pipelineStalled',
  'needs-info': 'needsInfo',
  'queue-pressure': 'queuePressure',
  'graph-changed': 'graphChanged',
};

const RATE_LIMIT_BYPASS: ReadonlySet<SpawnCause> = new Set(['operator', 'operator-reply']);

const DEFAULT_DEADLINE_MS = 120_000;

/**
 * Central PM session spawn helper. Enforces the four guards in this order:
 * 1. `pm_config.enabled` (and existence)
 * 2. `event_triggers` mask (per-cause; cron + operator override)
 * 3. `max_runs_per_hour` against `pm_decisions` count (operator bypasses)
 * 4. Per-project active-PM dedup (Postgres unique index from Epic 1)
 *
 * Never throws on guard failures — returns a structured `{ ok:false, reason }`
 * so call sites (subscribers, sweepers, the operator endpoint) can branch
 * without try/catch.
 */
export async function spawnPmSession(
  input: SpawnPmSessionInput,
): Promise<SpawnPmSessionResult> {
  const [config] = await db
    .select()
    .from(pmConfig)
    .where(eq(pmConfig.projectId, input.projectId))
    .limit(1);

  if (!config || !config.enabled) {
    return { ok: false, reason: 'disabled' };
  }

  const triggerKey = MASKABLE_CAUSE_TO_TRIGGER_KEY[input.cause];
  if (triggerKey) {
    const triggers = (config.eventTriggers ?? {}) as Record<string, unknown>;
    if (triggers[triggerKey] === false) {
      return { ok: false, reason: 'trigger-masked' };
    }
  }

  // Operator causes bypass the rate limit so a human can always force a run
  // (e.g. when triaging an outage). All other causes share the per-project
  // budget.
  if (!RATE_LIMIT_BYPASS.has(input.cause)) {
    const [{ count } = { count: 0 }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(pmDecisions)
      .where(
        and(
          eq(pmDecisions.projectId, input.projectId),
          gte(pmDecisions.createdAt, new Date(Date.now() - 60 * 60 * 1000)),
        ),
      );
    if (count >= config.maxRunsPerHour) {
      logger.info(
        { projectId: input.projectId, cause: input.cause, count, limit: config.maxRunsPerHour },
        'pm.spawn.rate_limited',
      );
      return { ok: false, reason: 'rate-limited' };
    }
  }

  let createdBy = input.actorUserId;
  if (!createdBy) {
    const [project] = await db
      .select({ createdBy: projects.createdBy })
      .from(projects)
      .where(eq(projects.id, input.projectId))
      .limit(1);
    if (!project) {
      // Project gone (race with delete). Treat as disabled — nothing to spawn.
      return { ok: false, reason: 'disabled' };
    }
    createdBy = project.createdBy;
  }

  const payload: Record<string, unknown> = {
    cause: input.cause,
    eventRef: input.eventRef ?? {},
    deadlineMs: DEFAULT_DEADLINE_MS,
    modelOverride: config.modelOverride ?? null,
    customInstructions: config.customInstructions ?? null,
  };

  // ISS-101 — one-shot pipeline_run per PM coordinator job. On dedup or insert
  // failure we close the run so we never leak open `kind='pm'` rows.
  const pmRun = await openOneShotRun({ projectId: input.projectId, kind: 'pm' });
  let jobId: string;
  try {
    const [row] = await db
      .insert(jobs)
      .values({
        projectId: input.projectId,
        issueId: null,
        pipelineRunId: pmRun.id,
        createdBy,
        type: 'pm',
        payload,
        status: 'queued',
      })
      .returning({ id: jobs.id });
    if (!row) throw new Error('spawnPmSession: insert returned no row');
    jobId = row.id;
  } catch (err) {
    if (isUniqueViolation(err)) {
      await closeRun(pmRun.id, 'cancelled');
      return { ok: false, reason: 'already-active' };
    }
    await closeRun(pmRun.id, 'cancelled');
    throw err;
  }

  await enqueuePmJob(jobId);
  logger.info({ projectId: input.projectId, cause: input.cause, jobId }, 'pm.spawn');
  return { ok: true, jobId };
}
