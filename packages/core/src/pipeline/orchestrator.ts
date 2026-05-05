import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type IssueStatus, type JobType, issues, jobs, projects } from '../db/schema.js';
import { enqueueJob } from '../jobs/enqueue.js';
import { logger } from '../logger.js';
import type { Actor } from './activity.js';
import {
  type PreventivePattern,
  queryPreventivePatterns,
} from './ci-fix-pattern-query.js';
import type { HooksBus } from './hooks.js';
import { resolveSkillForStatus } from './skill-mapping.js';

const ACTIVE_JOB_STATUSES = ['queued', 'dispatched', 'running'] as const;

interface PipelineConfig {
  enabled?: boolean;
  [toggle: string]: unknown;
}

async function loadPipelineConfig(
  projectId: string,
): Promise<{ cfg: PipelineConfig | null; ownerId: string | null }> {
  const [row] = await db
    .select({ agentConfig: projects.agentConfig, ownerId: projects.ownerId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!row) return { cfg: null, ownerId: null };
  const ac = row.agentConfig as { pipelineConfig?: PipelineConfig } | null;
  return { cfg: ac?.pipelineConfig ?? null, ownerId: row.ownerId ?? null };
}

function isToggleEnabled(cfg: PipelineConfig, key: string): boolean {
  const v = cfg[key];
  if (v === undefined) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'object' && v !== null) {
    return (v as { enabled?: boolean }).enabled !== false;
  }
  return false;
}

async function findActiveJob(issueId: string, type: JobType): Promise<string | null> {
  const [row] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.issueId, issueId),
        eq(jobs.type, type),
        inArray(jobs.status, [...ACTIVE_JOB_STATUSES]),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

function resolveCreatedBy(actor: Actor, ownerId: string | null): string {
  // Device-triggered triggers: fall back to project owner (jobs.createdBy FK is users.id).
  if (actor.type === 'user') return actor.id;
  if (ownerId) return ownerId;
  throw new Error('orchestrator: no valid createdBy available');
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

/**
 * ISS-32 — Build the `preventiveContext` block injected into forge-code job
 * payloads. Only runs for `code` jobs (the fix-loop avoidance is specific to
 * implementation work). Always returns a defined object so downstream
 * consumers don't need to defensively check for `undefined`.
 */
async function buildPreventiveContext(
  jobType: JobType,
  projectId: string,
  issueId: string,
): Promise<{ patterns: PreventivePattern[] }> {
  if (jobType !== 'code') return { patterns: [] };
  const issueText = await loadIssueText(issueId);
  if (!issueText) return { patterns: [] };
  const patterns = await queryPreventivePatterns({ projectId, issueText });
  return { patterns };
}

async function loadIssueText(issueId: string): Promise<string> {
  const [row] = await db
    .select({ title: issues.title, description: issues.description })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  if (!row) return '';
  return [row.title, row.description ?? ''].filter(Boolean).join('\n\n');
}

/**
 * Re-export for the self-healing sweeper (Phase H, ISS-306). Same shape
 * as the private considerEnqueue used by hook subscribers — exposing it
 * lets the sweeper salvage stuck issues without firing a synthetic
 * `transition` hook (which would mutate activity_log / WS broadcasts in
 * confusing ways).
 */
export async function reEnqueueForIssue(args: {
  projectId: string;
  issueId: string;
  status: IssueStatus;
  actor: Actor;
  reason: Record<string, unknown>;
}): Promise<void> {
  return considerEnqueue(args);
}

/**
 * Thrown by `triggerPipelineStepManual` when the same (issueId, type) already
 * has a queued/dispatched/running job. The route handler maps this to HTTP
 * 409 so the UI can surface "Job already running, cancel first".
 */
export class ActiveJobConflictError extends Error {
  constructor(
    public readonly existingJobId: string,
    public readonly type: JobType,
  ) {
    super(`active ${type} job already exists for this issue`);
    this.name = 'ActiveJobConflictError';
  }
}

/**
 * Manual fire of a pipeline stage from the issue UI (ISS-5). Bypasses
 * `pipelineConfig.enabled` and the per-stage `auto*` toggles — the user
 * explicitly clicked "Run" so we honor it regardless of project automation
 * settings. Throws `ActiveJobConflictError` when a job of the same
 * (issueId, type) is already active so the route can return 409.
 */
export async function triggerPipelineStepManual(args: {
  projectId: string;
  issueId: string;
  status: IssueStatus;
  stage?: JobType;
  actor: Actor;
  reason: Record<string, unknown>;
}): Promise<{ jobId: string; type: JobType }> {
  const skill = args.stage
    ? { type: args.stage, toggle: '' }
    : resolveSkillForStatus(args.status);
  if (!skill) throw new Error('no skill mapped for this status');

  const { ownerId } = await loadPipelineConfig(args.projectId);

  const existing = await findActiveJob(args.issueId, skill.type);
  if (existing) throw new ActiveJobConflictError(existing, skill.type);

  const createdBy = resolveCreatedBy(args.actor, ownerId);

  const preventiveContext = await buildPreventiveContext(
    skill.type,
    args.projectId,
    args.issueId,
  );

  let insertedId: string | null = null;
  try {
    const [inserted] = await db
      .insert(jobs)
      .values({
        projectId: args.projectId,
        issueId: args.issueId,
        createdBy,
        type: skill.type,
        payload: { skillName: `forge-${skill.type}`, ...args.reason, preventiveContext },
        status: 'queued',
      })
      .returning({ id: jobs.id });
    insertedId = inserted?.id ?? null;
  } catch (err) {
    // Concurrent click → unique-index dedupe. Surface as conflict so the UI
    // sees the same 409 it would for the in-app race check.
    if (isUniqueViolation(err)) {
      const racing = await findActiveJob(args.issueId, skill.type);
      if (racing) throw new ActiveJobConflictError(racing, skill.type);
    }
    throw err;
  }
  if (!insertedId) throw new Error('jobs: insert returned no row');

  try {
    await enqueueJob(insertedId);
  } catch (err) {
    logger.error(
      { err, jobId: insertedId },
      'manual trigger: pg-boss enqueue failed; row persisted',
    );
  }

  logger.info(
    { jobId: insertedId, type: skill.type, issueId: args.issueId },
    'manual trigger: enqueued',
  );
  return { jobId: insertedId, type: skill.type };
}

async function considerEnqueue(args: {
  projectId: string;
  issueId: string;
  status: IssueStatus;
  actor: Actor;
  reason: Record<string, unknown>;
}): Promise<void> {
  const skill = resolveSkillForStatus(args.status);
  if (!skill) return; // human-gated status

  const { cfg, ownerId } = await loadPipelineConfig(args.projectId);
  if (!cfg?.enabled) return;
  if (!isToggleEnabled(cfg, skill.toggle)) return;

  const existing = await findActiveJob(args.issueId, skill.type);
  if (existing) {
    logger.debug(
      { issueId: args.issueId, type: skill.type, existing },
      'orchestrator: active job already exists, skipping',
    );
    return;
  }

  const createdBy = resolveCreatedBy(args.actor, ownerId);

  const preventiveContext = await buildPreventiveContext(
    skill.type,
    args.projectId,
    args.issueId,
  );

  let insertedId: string | null = null;
  try {
    const [inserted] = await db
      .insert(jobs)
      .values({
        projectId: args.projectId,
        issueId: args.issueId,
        createdBy,
        type: skill.type,
        payload: {
          skillName: `forge-${skill.type}`,
          ...args.reason,
          preventiveContext,
        },
        status: 'queued',
      })
      .returning({ id: jobs.id });
    insertedId = inserted?.id ?? null;
  } catch (err) {
    if (isUniqueViolation(err)) {
      logger.debug(
        { issueId: args.issueId, type: skill.type },
        'orchestrator: unique-index dedupe — active job already exists',
      );
      return;
    }
    throw err;
  }
  if (!insertedId) return;

  try {
    await enqueueJob(insertedId);
  } catch (err) {
    logger.error(
      { err, jobId: insertedId },
      'orchestrator: pg-boss enqueue failed; job row persisted',
    );
  }

  logger.info(
    { jobId: insertedId, type: skill.type, issueId: args.issueId },
    'orchestrator: enqueued',
  );
}

/**
 * Subscribe the pipeline orchestrator to `transition` and `issueCreated`
 * hooks. Issue creation lands the issue in `open` without emitting a
 * `transition`, so the `open → triage` mapping needs both subscriptions
 * to cover the manual-creation path.
 *
 * Register only in the main process boot block — it touches the DB and pg-boss.
 */
export function registerPipelineOrchestrator(bus: HooksBus): void {
  bus.on('transition', async (payload) => {
    try {
      // Guard: `needs_info → open` never re-triages (user answered a question).
      if (payload.to === 'open' && payload.from === 'needs_info') return;
      await considerEnqueue({
        projectId: payload.projectId,
        issueId: payload.issueId,
        status: payload.to,
        actor: payload.actor,
        reason: { transition: { from: payload.from, to: payload.to } },
      });
    } catch (err) {
      logger.error(
        { err, issueId: payload.issueId, to: payload.to },
        'orchestrator: transition handler failed',
      );
    }
  });

  bus.on('issueCreated', async (payload) => {
    try {
      await considerEnqueue({
        projectId: payload.projectId,
        issueId: payload.issueId,
        status: 'open',
        actor: payload.actor,
        reason: { created: true },
      });
    } catch (err) {
      logger.error({ err, issueId: payload.issueId }, 'orchestrator: issueCreated handler failed');
    }
  });
}
