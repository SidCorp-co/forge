import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobs, projects } from '../db/schema.js';
import { enqueueJob } from '../jobs/enqueue.js';
import { logger } from '../logger.js';
import type { HookPayloads, HooksBus } from './hooks.js';
import { resolveSkillForStatus } from './skill-mapping.js';

const ACTIVE_JOB_STATUSES = ['queued', 'dispatched', 'running'] as const;

interface ProjectAgentConfig {
  enabled?: boolean;
  [toggle: string]: unknown;
}

async function loadPipelineConfig(projectId: string): Promise<ProjectAgentConfig | null> {
  const [row] = await db
    .select({ agentConfig: projects.agentConfig, ownerId: projects.ownerId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!row) return null;
  const ac = row.agentConfig as { pipelineConfig?: ProjectAgentConfig } | null;
  const cfg = ac?.pipelineConfig ?? null;
  // Attach owner for createdBy fallback (device-triggered transitions).
  if (cfg) (cfg as Record<string, unknown>).__ownerId = row.ownerId;
  return cfg;
}

function isToggleEnabled(cfg: ProjectAgentConfig, key: string): boolean {
  const v = cfg[key];
  if (v === undefined) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'object' && v !== null) {
    return (v as { enabled?: boolean }).enabled !== false;
  }
  return false;
}

async function findActiveJob(issueId: string, type: string): Promise<string | null> {
  const [row] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.issueId, issueId),
        eq(jobs.type, type as never),
        inArray(jobs.status, [...ACTIVE_JOB_STATUSES]),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

async function resolveCreatedBy(
  payload: HookPayloads['transition'],
  ownerId: string | null,
): Promise<string> {
  // Device-triggered transitions: fall back to project owner (jobs.createdBy FK is users.id).
  if (payload.actor.type === 'user') return payload.actor.id;
  if (ownerId) return ownerId;
  throw new Error('orchestrator: no valid createdBy available');
}

/**
 * Subscribe the pipeline orchestrator to the `transition` hook. On each
 * transition: resolve status → skill, check per-project toggle, dedupe
 * against active jobs, and enqueue via F1's `enqueueJob`.
 *
 * This should only be registered in the main process boot block, not at
 * module load — it touches the DB and pg-boss.
 */
export function registerPipelineOrchestrator(bus: HooksBus): void {
  bus.on('transition', async (payload) => {
    try {
      // Guard: `needs_info → open` never re-triages (user answered a question).
      if (payload.to === 'open' && payload.from === 'needs_info') return;

      const skill = resolveSkillForStatus(payload.to);
      if (!skill) return; // human-gated status

      const cfg = await loadPipelineConfig(payload.projectId);
      if (!cfg?.enabled) return;
      if (!isToggleEnabled(cfg, skill.toggle)) return;

      const existing = await findActiveJob(payload.issueId, skill.type);
      if (existing) {
        logger.debug(
          { issueId: payload.issueId, type: skill.type, existing },
          'orchestrator: active job already exists, skipping',
        );
        return;
      }

      const createdBy = await resolveCreatedBy(
        payload,
        (cfg as { __ownerId?: string }).__ownerId ?? null,
      );

      const [inserted] = await db
        .insert(jobs)
        .values({
          projectId: payload.projectId,
          issueId: payload.issueId,
          createdBy,
          type: skill.type,
          payload: {
            skillName: `forge-${skill.type}`,
            transition: { from: payload.from, to: payload.to },
          },
          status: 'queued',
        })
        .returning({ id: jobs.id });
      if (!inserted) return;

      try {
        await enqueueJob(inserted.id);
      } catch (err) {
        logger.error(
          { err, jobId: inserted.id },
          'orchestrator: pg-boss enqueue failed; job row persisted',
        );
      }

      logger.info(
        { jobId: inserted.id, type: skill.type, issueId: payload.issueId },
        'orchestrator: enqueued',
      );
    } catch (err) {
      logger.error(
        { err, issueId: payload.issueId, to: payload.to },
        'orchestrator: enqueue failed',
      );
    }
  });
}
