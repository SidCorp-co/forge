import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  type IssueStatus,
  type JobType,
  agentSessions,
  comments,
  issues,
  jobs,
  projects,
} from '../db/schema.js';
import { enqueueJob } from '../jobs/enqueue.js';
import { logger } from '../logger.js';
import { Sentry, isSentryEnabled } from '../observability/sentry.js';
import { projectRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';
import type { Actor } from './activity.js';
import {
  type PreventivePattern,
  queryPreventivePatterns,
} from './ci-fix-pattern-query.js';
import type { HooksBus } from './hooks.js';
import { openIssueRun, setCurrentStep } from './runs.js';
import { SkillNotLoadableError, resolveSkill } from './skill-loader.js';
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

// Mirror the indexer's MAX_EMBED_CHARS so the query path matches the
// storage path's bounded contract (description schema cap is 100k).
const MAX_QUERY_EMBED_CHARS = 8192;

async function loadIssueText(issueId: string): Promise<string> {
  const [row] = await db
    .select({
      title: issues.title,
      description: issues.description,
      sessionContext: issues.sessionContext,
    })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  if (!row) return '';

  // Pull errorTypes from the issue's existing ciFixContext (set when a
  // prior code job failed CI) and prepend them to the embed text. The
  // store side embeds `errorTypes.join(' ') | diffSummary`, so without
  // this prefix the query side embeds title+description with zero
  // shared vocabulary — a known recall hit (round-4 review #2).
  const ctx = row.sessionContext as { ciFixContext?: { errors?: Array<{ type?: unknown }> } } | null;
  const errorTypes = Array.from(
    new Set(
      (ctx?.ciFixContext?.errors ?? [])
        .map((e) => (typeof e?.type === 'string' ? e.type : null))
        .filter((v): v is string => v !== null && v.length > 0),
    ),
  );

  const parts: string[] = [];
  if (errorTypes.length > 0) parts.push(errorTypes.join(' '));
  if (row.title) parts.push(row.title);
  if (row.description) parts.push(row.description);
  const text = parts.join('\n\n');
  return text.length > MAX_QUERY_EMBED_CHARS ? text.slice(0, MAX_QUERY_EMBED_CHARS) : text;
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

  // Pre-flight: refuse to enqueue when `forge-<type>` is missing/empty. The
  // manual path throws so the HTTP route can map to 4xx; the auto path
  // (considerEnqueue) handles the same error by escalating to pipeline_failed.
  const skillName = `forge-${skill.type}`;
  const resolution = await resolveSkill(skillName, args.projectId);
  if (!resolution.loadable) {
    throw new SkillNotLoadableError(resolution.skillName, resolution.reason, resolution.expectedPath);
  }

  const createdBy = resolveCreatedBy(args.actor, ownerId);

  const preventiveContext = await buildPreventiveContext(
    skill.type,
    args.projectId,
    args.issueId,
  );

  const run = await openIssueRun({ projectId: args.projectId, issueId: args.issueId });

  let insertedId: string | null = null;
  try {
    const [inserted] = await db
      .insert(jobs)
      .values({
        projectId: args.projectId,
        issueId: args.issueId,
        pipelineRunId: run.id,
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

  await setCurrentStep(run.id, skill.type);

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

  // Pre-flight: skill must be loadable BEFORE we open a run / insert a job.
  // A miss here is treated as a permanent failure for this issue — surface
  // it as `pipeline_failed` with a comment naming the missing skill so an
  // operator can fix the registration without spelunking through agent
  // sessions (ISS-105).
  const skillName = `forge-${skill.type}`;
  const resolution = await resolveSkill(skillName, args.projectId);
  if (!resolution.loadable) {
    await handleSkillNotLoadable({
      projectId: args.projectId,
      issueId: args.issueId,
      status: args.status,
      jobType: skill.type,
      skillName: resolution.skillName,
      expectedPath: resolution.expectedPath,
      reason: resolution.reason,
      ownerId,
    });
    return;
  }

  const createdBy = resolveCreatedBy(args.actor, ownerId);

  const preventiveContext = await buildPreventiveContext(
    skill.type,
    args.projectId,
    args.issueId,
  );

  const run = await openIssueRun({ projectId: args.projectId, issueId: args.issueId });

  let insertedId: string | null = null;
  try {
    const [inserted] = await db
      .insert(jobs)
      .values({
        projectId: args.projectId,
        issueId: args.issueId,
        pipelineRunId: run.id,
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

  await setCurrentStep(run.id, skill.type);

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

async function handleSkillNotLoadable(args: {
  projectId: string;
  issueId: string;
  status: IssueStatus;
  jobType: JobType;
  skillName: string;
  expectedPath: string;
  reason: 'skill_not_found' | 'skill_empty_body';
  ownerId: string | null;
}): Promise<void> {
  const { projectId, issueId, status, jobType, skillName, expectedPath, reason, ownerId } = args;

  // Parent run for the failure surface so the issue's run timeline shows
  // an attempt rather than appearing to skip the stage entirely.
  let runId: string | null = null;
  try {
    const run = await openIssueRun({ projectId, issueId });
    runId = run.id;
  } catch (err) {
    logger.warn({ err, issueId }, 'orchestrator: openIssueRun failed during skill-not-found escalate');
  }

  // Placeholder agent_session row so the issue detail's sessions tab carries
  // an explicit failure with `failureReason='skill_not_found'`. Best-effort
  // — the issue-status transition + comment below are the operator-visible
  // surface and must not be blocked by a session insert error.
  if (runId) {
    try {
      await db.insert(agentSessions).values({
        projectId,
        pipelineRunId: runId,
        title: `${skillName}: skill not loadable`,
        status: 'failed',
        failureReason: reason,
        metadata: { type: 'pipeline', issueId, jobType, skillName, expectedPath },
      } as never);
    } catch (err) {
      logger.warn({ err, issueId, skillName }, 'orchestrator: skill-not-found session insert failed');
    }
  }

  // Direct UPDATE mirrors the sweeper's escalate path (sweeper.ts:423) —
  // pipeline_failed is reachable from any active pipeline status and the
  // state-machine validator would reject most of them.
  await db
    .update(issues)
    .set({ status: 'pipeline_failed', updatedAt: new Date() })
    .where(eq(issues.id, issueId));

  if (ownerId) {
    try {
      await db.insert(comments).values({
        issueId,
        authorId: ownerId,
        body: buildSkillNotFoundComment(skillName, expectedPath, reason, status),
        isAi: true,
      } as never);
    } catch (err) {
      logger.warn({ err, issueId, skillName }, 'orchestrator: skill-not-found comment insert failed');
    }
  }

  try {
    roomManager.publish(projectRoom(projectId), {
      event: 'pipeline.skill_not_found',
      data: { issueId, jobType, skillName, expectedPath, reason },
    });
  } catch (err) {
    logger.warn({ err, issueId, skillName }, 'orchestrator: skill-not-found WS broadcast failed');
  }

  if (isSentryEnabled()) {
    Sentry.addBreadcrumb({
      category: 'pipeline',
      level: 'error',
      message: 'skill_not_found',
      data: { issueId, projectId, skillName, jobType, expectedPath, reason, detection: 'pre_flight' },
    });
    Sentry.captureMessage('pipeline.skill_not_found', {
      level: 'error',
      tags: { skillName, jobType, detection: 'pre_flight' },
    });
  }

  logger.error(
    { skillName, issueId, projectId, jobType, reason, expectedPath },
    'orchestrator: skill not loadable, escalating issue to pipeline_failed',
  );
}

function buildSkillNotFoundComment(
  skillName: string,
  expectedPath: string,
  reason: 'skill_not_found' | 'skill_empty_body',
  attemptedStatus: IssueStatus,
): string {
  return [
    `🛑 **Pipeline gave up** — \`${skillName}\` is not loadable.`,
    ``,
    `**Reason:** ${reason}`,
    `**Expected at:** \`${expectedPath}\` (or via a project skill override).`,
    `**Attempted status:** \`${attemptedStatus}\``,
    ``,
    `Install or restore the skill, then re-trigger by moving this issue back to \`${attemptedStatus}\` (or \`confirmed\` to restart from triage).`,
  ].join('\n');
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
