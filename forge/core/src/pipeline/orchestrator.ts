import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type IssueStatus, type JobType, jobs, projects } from '../db/schema.js';
import { enqueueJob } from '../jobs/enqueue.js';
import { logger } from '../logger.js';
import type { Actor } from './activity.js';
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
