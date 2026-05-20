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
import {
  buildJobPromptString,
  type IssueSnapshot,
  type SessionContextSnapshot,
} from '../jobs/prompt-string.js';
import { logger } from '../logger.js';
import { Sentry, isSentryEnabled } from '../observability/sentry.js';
import type { Actor } from './activity.js';
import {
  type PreventivePattern,
  queryPreventivePatterns,
} from './ci-fix-pattern-query.js';
import { ActiveJobConflictError, insertAndEnqueueJob } from './enqueue-helper.js';
import type { HookPayloads, HooksBus } from './hooks.js';
import { PIPELINE_STEPS } from './registry.js';
import { openIssueRun } from './runs.js';
import {
  type ResolvedSkill,
  createProjectSkillResolver,
  inverseJobTypeToStatus,
  resolveJobTypeForStatus,
} from './skill-mapping.js';
import {
  SKIPPABLE_STAGES,
  type StagesConfig,
  resolveSkipTarget,
} from './state-machine.js';

export { ActiveJobConflictError } from './enqueue-helper.js';

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

/**
 * Pre-load issue fields used by `buildJobPromptString` to inline an
 * `## Issue` block + sessionContext preamble into the runner prompt.
 * Single SELECT; per-state field gating happens inside prompt-string.ts.
 */
async function loadIssueSnapshot(issueId: string): Promise<IssueSnapshot | null> {
  const [row] = await db
    .select({
      title: issues.title,
      status: issues.status,
      priority: issues.priority,
      complexity: issues.complexity,
      description: issues.description,
      plan: issues.plan,
      acceptanceCriteria: issues.acceptanceCriteria,
      sessionContext: issues.sessionContext,
    })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  if (!row) return null;
  return {
    title: row.title,
    status: row.status,
    priority: row.priority,
    complexity: row.complexity,
    description: row.description,
    plan: row.plan,
    acceptanceCriteria: row.acceptanceCriteria,
    sessionContext: (row.sessionContext ?? null) as SessionContextSnapshot | null,
  };
}

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
    // the matching status; if there's no row, fall back to the canonical
    // PIPELINE_STEPS entry for the conventional skill name and toggle.
    // Manual-only types (clarify) and operator-defined `custom` aren't in
    // PIPELINE_STEPS — they fall through to the `forge-<type>` convention.
    const stageType = args.stage;
    const status = inverseJobTypeToStatus(stageType);
    skill = status ? await resolver.resolve(status) : null;
    if (!skill) {
      const step = PIPELINE_STEPS.find((s) => s.jobType === stageType);
      if (step) {
        skill = { type: stageType, toggle: step.toggle, skillName: step.skillName };
      } else {
        skill = { type: stageType, toggle: 'autoTriage', skillName: `forge-${stageType}` };
      }
    }
  } else {
    skill = await resolver.resolve(args.status);
  }
  if (!skill) throw new Error('NO_SKILL_REGISTERED: no skill registration for this status');

  const { ownerId } = await loadPipelineConfig(args.projectId);

  const existing = await findActiveJob(args.issueId, skill.type);
  if (existing) throw new ActiveJobConflictError(existing, skill.type);

  const createdBy = resolveCreatedBy(args.actor, ownerId);

  const [preventiveContext, issueSnapshot] = await Promise.all([
    buildPreventiveContext(skill.type, args.projectId, args.issueId),
    loadIssueSnapshot(args.issueId),
  ]);

  const run = await openIssueRun({ projectId: args.projectId, issueId: args.issueId });

  const skillRef = skill;
  const { jobId } = await insertAndEnqueueJob({
    projectId: args.projectId,
    issueId: args.issueId,
    pipelineRunId: run.id,
    createdBy,
    type: skillRef.type,
    skillName: skillRef.skillName,
    promptString: buildJobPromptString({
      skillName: skillRef.skillName,
      jobType: skillRef.type,
      issueId: args.issueId,
      issueSnapshot,
    }),
    payloadExtras: {
      ...args.reason,
      preventiveContext,
    },
    resolveRacingJobId: () => findActiveJob(args.issueId, skillRef.type),
  });

  logger.info(
    { jobId, type: skill.type, issueId: args.issueId },
    'manual trigger: enqueued',
  );
  return { jobId, type: skill.type };
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

  const [preventiveContext, issueSnapshot] = await Promise.all([
    buildPreventiveContext(skill.type, args.projectId, args.issueId),
    loadIssueSnapshot(args.issueId),
  ]);

  const run = await openIssueRun({ projectId: args.projectId, issueId: args.issueId });

  try {
    const skillRef = skill;
    const { jobId } = await insertAndEnqueueJob({
      projectId: args.projectId,
      issueId: args.issueId,
      pipelineRunId: run.id,
      createdBy,
      type: skillRef.type,
      skillName: skillRef.skillName,
      promptString: buildJobPromptString({
        skillName: skillRef.skillName,
        jobType: skillRef.type,
        issueId: args.issueId,
        issueSnapshot,
      }),
      payloadExtras: {
        ...args.reason,
        preventiveContext,
      },
    });
    logger.info(
      { jobId, type: skill.type, issueId: args.issueId },
      'orchestrator: enqueued',
    );
  } catch (err) {
    if (err instanceof ActiveJobConflictError) {
      logger.debug(
        { issueId: args.issueId, type: skill.type },
        'orchestrator: unique-index dedupe — active job already exists',
      );
      return;
    }
    throw err;
  }
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
  const { cfg, ownerId } = preloaded;
  if (!cfg?.enabled) return;
  const states = cfg.states;
  if (!states) return;

  // resolveSkipTarget is the SSOT for skip-chain validation: it returns
  // null when the source isn't skippable, isn't disabled, or has no valid
  // forward chain. Per-hop iteration below only handles side-effects
  // (transition + Sentry breadcrumb + WS broadcast).
  const skipResult = resolveSkipTarget(payload.to, states);
  if (!skipResult) return;

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
  let hop = 0;
  for (const nextStatus of skipResult.chain) {
    try {
      // skip: true — the chain may collapse stages the state-machine matrix
      // doesn't allow as direct one-hop transitions (e.g. `developed →
      // testing` skips review + deploy). resolveSkipTarget validates the
      // chain end-to-end, so bypassing canTransition per hop is safe.
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
    hop++;
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
        status: payload.status,
        actor: payload.actor,
        reason: { created: true },
      });
    } catch (err) {
      logger.error({ err, issueId: payload.issueId }, 'orchestrator: issueCreated handler failed');
    }
  });
}
