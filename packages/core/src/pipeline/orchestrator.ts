import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  type IssueStatus,
  type JobType,
  issues,
  jobs,
  projects,
} from '../db/schema.js';
import { applyStatusTransition, type DeviceLite } from '../issues/apply-transition.js';
import { enqueueJob } from '../jobs/enqueue.js';
import { buildJobPromptString } from '../jobs/prompt-string.js';
import { logger } from '../logger.js';
import { Sentry, isSentryEnabled } from '../observability/sentry.js';
import type { Actor } from './activity.js';
import {
  type PreventivePattern,
  queryPreventivePatterns,
} from './ci-fix-pattern-query.js';
import type { HookPayloads, HooksBus } from './hooks.js';
import { openIssueRun, setCurrentStep } from './runs.js';
import {
  type ResolvedSkill,
  createProjectSkillResolver,
  inverseJobTypeToStatus,
  resolveJobTypeForStatus,
} from './skill-mapping.js';
import {
  MAX_SKIP_CHAIN,
  SKIPPABLE_STAGES,
  STAGE_FORWARD,
  type StagesConfig,
} from './state-machine.js';

const ACTIVE_JOB_STATUSES = ['queued', 'dispatched', 'running'] as const;

interface PipelineConfig {
  enabled?: boolean;
  states?: StagesConfig;
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
  const resolver = createProjectSkillResolver(args.projectId);

  let skill: ResolvedSkill | null;
  if (args.stage) {
    // Caller picked the jobType explicitly. Resolve the registered skill for
    // the matching status; if there's no row, fall back to the conventional
    // `forge-<type>` name so the manual escape hatch still works.
    const stageType = args.stage;
    const status = inverseJobTypeToStatus(stageType);
    skill = status ? await resolver.resolve(status) : null;
    if (!skill) {
      skill = { type: stageType, toggle: 'autoTriage', skillName: `forge-${stageType}` };
    }
  } else {
    skill = await resolver.resolve(args.status);
  }
  if (!skill) throw new Error('NO_SKILL_REGISTERED: no skill registration for this status');

  const { ownerId } = await loadPipelineConfig(args.projectId);

  const existing = await findActiveJob(args.issueId, skill.type);
  if (existing) throw new ActiveJobConflictError(existing, skill.type);

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
          skillName: skill.skillName,
          promptString: buildJobPromptString({
            skillName: skill.skillName,
            jobType: skill.type,
            issueId: args.issueId,
          }),
          ...args.reason,
          preventiveContext,
        },
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
  preloaded?: { cfg: PipelineConfig | null; ownerId: string | null };
}): Promise<void> {
  const jobMap = resolveJobTypeForStatus(args.status);
  if (!jobMap) return; // human-gated status

  const { cfg, ownerId } = args.preloaded ?? (await loadPipelineConfig(args.projectId));
  if (!cfg?.enabled) return;
  // Belt-and-suspenders: if the landing stage is disabled in `states`, never
  // enqueue a job. autoSkipDisabledStages should have moved the issue past
  // this stage already; this fallback ensures a failed skip path never
  // produces a job for a stage the operator explicitly turned off.
  const stageCfg = cfg.states?.[args.status];
  if (stageCfg && stageCfg.enabled === false) return;
  if (stageCfg && stageCfg.mode === 'manual') return;
  if (!isToggleEnabled(cfg, jobMap.toggle)) return;

  const resolver = createProjectSkillResolver(args.projectId);
  const skill = await resolver.resolve(args.status);
  if (!skill) {
    logger.warn(
      { projectId: args.projectId, status: args.status },
      'orchestrator: no skill_registration for auto stage — skipping enqueue',
    );
    return;
  }

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
          skillName: skill.skillName,
          promptString: buildJobPromptString({
            skillName: skill.skillName,
            jobType: skill.type,
            issueId: args.issueId,
          }),
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

/**
 * ISS-110 — When a project's `pipelineConfig.states[stage].enabled === false`,
 * the orchestrator must auto-transition issues past `stage` instead of
 * dispatching a job. Chains of disabled stages collapse transitively (capped
 * at `MAX_SKIP_CHAIN`). Each hop emits a Sentry breadcrumb tagged
 * `reason='skipped-disabled'` so traces show why a stage was skipped.
 *
 * Re-entry: each `applyStatusTransition` call re-emits the `transition` hook,
 * which re-enters this function. The internal loop is defense in depth — it
 * lets a single emit walk the chain even if the hook dispatcher is awaited
 * sequentially.
 */
async function autoSkipDisabledStages(
  payload: HookPayloads['transition'],
  preloaded: { cfg: PipelineConfig | null; ownerId: string | null },
): Promise<void> {
  if (!SKIPPABLE_STAGES.has(payload.to)) return;

  const { cfg, ownerId } = preloaded;
  if (!cfg?.enabled) return;
  const states = cfg.states;
  if (!states) return;
  if (states[payload.to]?.enabled !== false) return;

  const [issue] = await db
    .select({
      id: issues.id,
      projectId: issues.projectId,
      status: issues.status,
      reopenCount: issues.reopenCount,
    })
    .from(issues)
    .where(eq(issues.id, payload.issueId))
    .limit(1);
  if (!issue) return;
  if (issue.status !== payload.to) return; // raced with another writer

  const device = resolveSkipDevice(payload.actor, ownerId);
  if (!device) {
    logger.warn(
      { issueId: issue.id, projectId: issue.projectId },
      'orchestrator: skip-disabled requires a device principal; none available',
    );
    return;
  }

  let current = { ...issue };
  for (let hop = 0; hop < MAX_SKIP_CHAIN; hop++) {
    // Walk forward one stage at a time so each hop emits its own transition
    // event + Sentry breadcrumb. resolveSkipTarget collapses the chain in a
    // single pure call — useful for validation, but per-hop emission gives
    // post-hoc traces the full status history.
    if (!SKIPPABLE_STAGES.has(current.status)) break;
    if (states[current.status]?.enabled !== false) break;
    const nextStatus = STAGE_FORWARD[current.status];
    if (!nextStatus) break;

    try {
      // skip: true — the orchestrator's STAGE_FORWARD chain collapses stages
      // the state-machine matrix doesn't allow as direct one-hop transitions
      // (notably `developed → testing` skips both review and deploy). The
      // chain is validated at config-save time, so bypassing canTransition
      // here is safe.
      await applyStatusTransition(current, nextStatus, device, { skip: true });
    } catch (err) {
      logger.warn(
        { err, issueId: current.id, from: current.status, to: nextStatus },
        'orchestrator: skip-disabled chain failed to advance',
      );
      return;
    }

    if (isSentryEnabled()) {
      Sentry.addBreadcrumb({
        category: 'pipeline_run.status_changed',
        level: 'info',
        message: `${current.status} -> ${nextStatus} (skipped-disabled)`,
        data: {
          issueId: current.id,
          projectId: current.projectId,
          fromStatus: current.status,
          toStatus: nextStatus,
          reason: 'skipped-disabled',
          hop,
        },
      });
    }

    current = { ...current, status: nextStatus };
  }

  if (states[current.status]?.enabled === false) {
    // Validator should have rejected this config at save time; reaching this
    // branch means a backdoor write (manual DB edit, pre-validator data, etc.).
    logger.error(
      { issueId: current.id, status: current.status },
      'orchestrator: skip-disabled chain exhausted MAX_SKIP_CHAIN without landing on an enabled stage',
    );
  }
}

function resolveSkipDevice(actor: Actor, ownerId: string | null): DeviceLite | null {
  // applyStatusTransition needs a DeviceLite for its WS broadcast / hook
  // payload. The skip is system-initiated; route it through the original
  // actor when it's already device-typed, otherwise synthesize from the
  // project owner. activity_log.actorId has no FK so attributing the skip
  // to the owner is harmless and matches the WS event's actorId field.
  if (actor.type === 'device') {
    return { id: actor.id, ownerId: ownerId ?? actor.id };
  }
  if (ownerId) {
    return { id: ownerId, ownerId };
  }
  return null;
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
      // Short-circuit BEFORE loading cfg if the target isn't even mapped to a
      // skill — saves a DB hit on human-gated transitions.
      if (!resolveJobTypeForStatus(payload.to) && !SKIPPABLE_STAGES.has(payload.to)) return;
      const preloaded = await loadPipelineConfig(payload.projectId);
      await autoSkipDisabledStages(payload, preloaded);
      await considerEnqueue({
        projectId: payload.projectId,
        issueId: payload.issueId,
        status: payload.to,
        actor: payload.actor,
        reason: { transition: { from: payload.from, to: payload.to } },
        preloaded,
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
