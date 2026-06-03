import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  type IssueComplexity,
  type IssueStatus,
  type JobType,
  issues,
  jobs,
  projects,
} from '../db/schema.js';
import { type DeviceLite, applyStatusTransition } from '../issues/apply-transition.js';
import { resolveMergeStates } from '../issues/merged-at.js';
import { buildJobPromptString } from '../jobs/prompt-string.js';
import { logger } from '../logger.js';
import { Sentry, isSentryEnabled } from '../observability/sentry.js';
import { loadIssueSnapshot } from '../prompt/issue-snapshot.js';
import { buildMergeRequiredBlock } from '../prompt/merge-required.js';
import type { Actor } from './activity.js';
import { type PreventivePattern, queryPreventivePatterns } from './ci-fix-pattern-query.js';
import { ActiveJobConflictError, insertAndEnqueueJob } from './enqueue-helper.js';
import { fetchHandoffPromptInputs } from './handoff-prefetch.js';
import type { HookPayloads, HooksBus } from './hooks.js';
import { pausePipelineRunMissingSkill, postMissingSkillComment } from './missing-skill-guard.js';
import {
  type PipelineConfig,
  STAGE_NAMES,
  type StageConfig,
  type StageName,
  pipelineConfigSchema,
} from './pipeline-config-schema.js';
import { PIPELINE_STEPS } from './registry.js';
import { openIssueRun } from './runs.js';
import {
  type ProjectSkillResolver,
  type ResolvedSkill,
  createProjectSkillResolver,
  inverseJobTypeToStatus,
  resolveJobTypeForStatus,
} from './skill-mapping.js';
import { appendSkipChainEntry, postSkipChainCappedComment } from './skip-chain-log.js';
import {
  MAX_SKIP_CHAIN,
  SKIPPABLE_STAGES,
  STAGE_FORWARD,
  resolveSkipTarget,
} from './state-machine.js';

export { ActiveJobConflictError } from './enqueue-helper.js';

const ACTIVE_JOB_STATUSES = ['queued', 'dispatched', 'running'] as const;

const STAGE_NAME_SET: ReadonlySet<string> = new Set(STAGE_NAMES);

/**
 * Look up per-state config for a given issue status. Returns `undefined` for
 * statuses that are not valid stage names (e.g. `in_progress`, `closed`,
 * `on_hold`, `waiting` — terminal/transition states that don't dispatch).
 * Lets callers chain `cfg?.states && stageConfigFor(cfg, status)?.skillName`
 * without TS complaining about indexing a partial record with a wider key.
 */
function stageConfigFor(cfg: PipelineConfig | null, status: IssueStatus): StageConfig | undefined {
  if (!cfg?.states) return undefined;
  if (!STAGE_NAME_SET.has(status)) return undefined;
  return cfg.states[status as StageName];
}

async function loadPipelineConfig(
  projectId: string,
): Promise<{ cfg: PipelineConfig | null; ownerId: string | null }> {
  const [row] = await db
    .select({
      agentConfig: projects.agentConfig,
      ownerId: projects.ownerId,
      archivedAt: projects.archivedAt,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!row) return { cfg: null, ownerId: null };
  // ISS-353 — archived projects pause auto-pipeline dispatch. cfg=null falls
  // through to the same "no auto pipeline" path as a missing/invalid config,
  // so no NEW agent jobs are queued. In-flight jobs are untouched (this only
  // gates dispatch, not running work).
  if (row.archivedAt != null) return { cfg: null, ownerId: row.ownerId ?? null };
  const ac = (row.agentConfig as { pipelineConfig?: unknown } | null) ?? {};
  // Parse through the canonical schema so the typed read path stays in
  // lockstep with what was validated on write. Bad data → cfg=null (caller
  // falls through to "no auto pipeline" behavior, same as missing row).
  const parsed = pipelineConfigSchema.safeParse(ac.pipelineConfig ?? {});
  return {
    cfg: parsed.success ? parsed.data : null,
    ownerId: row.ownerId ?? null,
  };
}

function isToggleEnabled(cfg: PipelineConfig, key: string): boolean {
  const v = (cfg as Record<string, unknown>)[key];
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

// loadIssueSnapshot moved to `prompt/issue-snapshot.ts` so the preview
// endpoint (POST /api/prompts/preview) can share the same loader.

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
  const ctx = row.sessionContext as {
    ciFixContext?: { errors?: Array<{ type?: unknown }> };
  } | null;
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
    // Operator-defined `custom` isn't in PIPELINE_STEPS — it falls through
    // to the `forge-<type>` convention.
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

  const { cfg, ownerId } = await loadPipelineConfig(args.projectId);

  const existing = await findActiveJob(args.issueId, skill.type);
  if (existing) throw new ActiveJobConflictError(existing, skill.type);

  const createdBy = resolveCreatedBy(args.actor, ownerId);

  const [preventiveContext, issueSnapshot] = await Promise.all([
    buildPreventiveContext(skill.type, args.projectId, args.issueId),
    loadIssueSnapshot(args.issueId),
  ]);

  const run = await openIssueRun({ projectId: args.projectId, issueId: args.issueId });

  const skillRef = skill;
  const stageCfg = stageConfigFor(cfg, args.status);
  // Operator-supplied per-state skill name wins over the resolver default.
  const effectiveSkillName = stageCfg?.skillName ?? skillRef.skillName;
  // ISS-232 — inject merge-required block when this stage is configured
  // as the project's merge point. The state-machine writer keys on the
  // same `mergeStates.baseBranch`; without the prompt block the skill has
  // no signal it must merge + push before transitioning.
  const mergeRequiredText = buildMergeRequiredBlock({
    stageStatus: args.status,
    mergeStates: resolveMergeStates(cfg),
    issueId: args.issueId,
  });
  // Proposal Y — pre-fetch step handoffs scoped to this issue's current run
  // so buildJobPromptString can render `## Prior step handoffs` + the
  // `## Termination protocol` block with concrete scope literals.
  const handoffInputs = await fetchHandoffPromptInputs({
    projectId: args.projectId,
    issueId: args.issueId,
    pipelineRunId: run.id,
    attempt: 1,
    jobType: skillRef.type,
    policy: stageCfg?.userPromptPolicy ?? null,
  });
  const { jobId } = await insertAndEnqueueJob({
    projectId: args.projectId,
    issueId: args.issueId,
    pipelineRunId: run.id,
    createdBy,
    type: skillRef.type,
    skillName: effectiveSkillName,
    promptString: buildJobPromptString({
      skillName: effectiveSkillName,
      jobType: skillRef.type,
      issueId: args.issueId,
      issueSnapshot,
      policy: stageCfg?.userPromptPolicy ?? null,
      mergeRequiredText,
      priorHandoffs: handoffInputs.priorHandoffs,
      handoffScope: handoffInputs.handoffScope,
    }),
    payloadExtras: {
      ...args.reason,
      preventiveContext,
      // Stamp the stage so dispatcher can re-resolve overrides without a
      // second pipelineConfig load.
      stageStatus: args.status,
      // PR-5 — stamp session group membership so the dispatcher's
      // runner-framework path + agent-session-link can find the prior
      // session of the same (issue, group) without a second config load.
      ...(stageCfg?.sessionGroup ? { sessionGroup: stageCfg.sessionGroup } : {}),
    },
    resolveRacingJobId: () => findActiveJob(args.issueId, skillRef.type),
  });

  logger.info({ jobId, type: skill.type, issueId: args.issueId }, 'manual trigger: enqueued');
  return { jobId, type: skill.type };
}

async function considerEnqueue(args: {
  projectId: string;
  issueId: string;
  status: IssueStatus;
  actor: Actor;
  reason: Record<string, unknown>;
  preloaded?: {
    cfg: PipelineConfig | null;
    ownerId: string | null;
    resolver?: ProjectSkillResolver;
  };
}): Promise<void> {
  const jobMap = resolveJobTypeForStatus(args.status);
  if (!jobMap) return; // human-gated status

  const { cfg, ownerId } = args.preloaded ?? (await loadPipelineConfig(args.projectId));
  if (!cfg?.enabled) return;
  // Belt-and-suspenders: if the landing stage is disabled in `states`, never
  // enqueue a job. autoSkipDisabledStages should have moved the issue past
  // this stage already; this fallback ensures a failed skip path never
  // produces a job for a stage the operator explicitly turned off.
  const stageCfg = stageConfigFor(cfg, args.status);
  if (stageCfg && stageCfg.enabled === false) return;
  if (stageCfg && stageCfg.mode === 'manual') return;
  if (!isToggleEnabled(cfg, jobMap.toggle)) return;

  // ISS-239 — reuse the resolver from autoSkipDisabledStages when available
  // so we don't refetch skill_registrations a second time per hook fire.
  const resolver = args.preloaded?.resolver ?? createProjectSkillResolver(args.projectId);
  const skill = await resolver.resolve(args.status);
  if (!skill) {
    // ISS-238 — refuse + pause + comment instead of silently skipping. Loops
    // through the reconciler rescue path (`reEnqueueForIssue → considerEnqueue`)
    // previously re-entered here on every minute-cadence tick, burning runner
    // cycles without surfacing the operator-fixable misconfiguration.
    const run = await openIssueRun({ projectId: args.projectId, issueId: args.issueId });
    const { paused, alreadyPaused } = await pausePipelineRunMissingSkill({
      runId: run.id,
      projectId: args.projectId,
      issueId: args.issueId,
      stage: args.status,
      currentStep: args.status,
    });
    if (paused) {
      await postMissingSkillComment({
        projectId: args.projectId,
        issueId: args.issueId,
        stage: args.status,
      });
    }
    logger.warn(
      {
        projectId: args.projectId,
        issueId: args.issueId,
        status: args.status,
        runId: run.id,
        paused,
        alreadyPaused,
      },
      'orchestrator: refused enqueue — missing skill_registration, run paused',
    );
    return;
  }

  // Cheap pre-check — short-circuits before the advisory lock acquires.
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

  const skillRef = skill;
  const effectiveSkillName = stageCfg?.skillName ?? skillRef.skillName;

  // ISS-196 — serialise check-active-job + INSERT job across all workers
  // and processes. `pg_advisory_xact_lock` auto-releases at COMMIT/ROLLBACK.
  // Multiple outbox rows for the same (issue, jobType) collapse to one
  // INSERT because the loser re-enters with the row already present.
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('issue:' || ${args.issueId}))`);

    // Re-check inside the lock — pre-check above may have raced.
    const racing = await findActiveJob(args.issueId, skillRef.type);
    if (racing) {
      logger.debug(
        { issueId: args.issueId, type: skillRef.type, racing },
        'orchestrator: active job appeared while waiting on lock',
      );
      return;
    }

    // ISS-232 — same injection on the auto path; see manual-trigger comment.
    const mergeRequiredText = buildMergeRequiredBlock({
      stageStatus: args.status,
      mergeStates: resolveMergeStates(cfg),
      issueId: args.issueId,
    });
    // Proposal Y — see manual-trigger comment.
    const handoffInputs = await fetchHandoffPromptInputs({
      projectId: args.projectId,
      issueId: args.issueId,
      pipelineRunId: run.id,
      attempt: 1,
      jobType: skillRef.type,
      policy: stageCfg?.userPromptPolicy ?? null,
    });
    const { jobId } = await insertAndEnqueueJob({
      projectId: args.projectId,
      issueId: args.issueId,
      pipelineRunId: run.id,
      createdBy,
      type: skillRef.type,
      skillName: effectiveSkillName,
      promptString: buildJobPromptString({
        skillName: effectiveSkillName,
        jobType: skillRef.type,
        issueId: args.issueId,
        issueSnapshot,
        policy: stageCfg?.userPromptPolicy ?? null,
        mergeRequiredText,
        priorHandoffs: handoffInputs.priorHandoffs,
        handoffScope: handoffInputs.handoffScope,
      }),
      payloadExtras: {
        ...args.reason,
        preventiveContext,
        stageStatus: args.status,
        // PR-5 — stamp session group membership; see manual-trigger comment.
        ...(stageCfg?.sessionGroup ? { sessionGroup: stageCfg.sessionGroup } : {}),
      },
    });
    logger.info({ jobId, type: skillRef.type, issueId: args.issueId }, 'orchestrator: enqueued');
  });
}

/**
 * ISS-110 + ISS-239 + clarify-on-happy-path — When a project's
 * `pipelineConfig.states[stage].enabled === false`, OR no skill is registered
 * for the stage, OR the issue's sized `complexity` matches the stage's
 * `skipComplexities` config, the orchestrator must auto-transition issues
 * past `stage` instead of dispatching (or stalling). Chains of skippable
 * stages collapse transitively (capped at MAX_SKIP_CHAIN); all three skip
 * criteria share ONE resolver walk (`resolveSkipTarget`) and ONE hop loop so
 * the breadcrumb / skipChain telemetry cannot drift between them.
 *
 * Returns true when at least one hop was applied — the caller must then skip
 * considerEnqueue for the stage the issue just left (the re-emitted
 * transition hook owns the new status).
 *
 * Each hop:
 *  - applies the transition with `skip: true`
 *  - appends to `pipeline_runs.metadata.skipChain`
 *  - emits a `pipeline_run.status_changed` breadcrumb (compat with ISS-110)
 *  - emits a `pipeline_run.auto_skip` breadcrumb with the typed skip reason
 *
 * Re-entry: each `applyStatusTransition` re-emits the `transition` hook,
 * which re-enters this function. The internal loop is defense in depth — it
 * lets a single emit walk the chain even if the hook dispatcher is awaited
 * sequentially. The race-detection check (`issue.status !== payload.to`)
 * causes subsequent re-entries to bail once the chain has advanced.
 *
 * The resolver instance built here is returned so `considerEnqueue` can
 * reuse the memoized skill-registrations snapshot (one DB hit per hook fire).
 */
async function autoSkipDisabledStages(
  payload: HookPayloads['transition'],
  preloaded: {
    cfg: PipelineConfig | null;
    ownerId: string | null;
    resolver: ProjectSkillResolver;
  },
): Promise<boolean> {
  const { cfg, ownerId, resolver } = preloaded;
  if (!cfg?.enabled) return false;

  // ISS-239 — build the hasSkill predicate up-front so the resolver walks
  // skip stages with no registered skill as well as stages the operator
  // explicitly disabled. resolver.stages() shares the same memoized load()
  // as resolver.resolve(); the same instance flows into considerEnqueue.
  const skillStages = await resolver.stages();
  const hasSkill = (stage: IssueStatus) => skillStages.has(stage);

  // Clarify-on-happy-path — when any stage reachable from `payload.to` along
  // STAGE_FORWARD declares `skipComplexities`, the resolver needs the issue's
  // sized `complexity`, so load the row up-front (it doubles as the race
  // guard the post-resolve path otherwise performs). Projects without the
  // knob never pay this fetch.
  let issue: SkipIssueRow | null = null;
  if (chainMayUseComplexity(payload.to, cfg)) {
    issue = await loadIssueForSkip(payload.issueId);
    if (!issue) return false;
    if (issue.status !== payload.to) return false; // raced with another writer
  }
  const complexity = issue?.complexity ?? null;
  const complexityMatches = complexity
    ? (stage: IssueStatus) =>
        stageConfigFor(cfg, stage)?.skipComplexities?.includes(complexity) === true
    : undefined;

  // cfg.states is typed with the schema's narrower StageName keys; the
  // resolver accepts the wider IssueStatus shape, and reads only `.enabled`.
  // Cast through unknown to bridge the exactOptionalPropertyTypes mismatch
  // — structural compatibility (`enabled?: boolean`) is intact.
  const skipResult = resolveSkipTarget(
    payload.to,
    cfg.states as unknown as Parameters<typeof resolveSkipTarget>[1],
    { hasSkill, ...(complexityMatches ? { complexityMatches } : {}) },
  );
  if (!skipResult) return false;

  if (skipResult.capped) {
    // Chain exhausted MAX_SKIP_CHAIN without finding an anchor with a skill.
    // Surface the misconfiguration via comment + breadcrumb; leave the issue
    // parked at the source stage for operator intervention.
    if (isSentryEnabled()) {
      Sentry.addBreadcrumb({
        category: 'pipeline_run.auto_skip',
        level: 'warning',
        message: `auto-skip chain capped at ${payload.to}`,
        data: {
          issueId: payload.issueId,
          projectId: payload.projectId,
          fromStatus: payload.to,
          chain: skipResult.chain,
          reason: 'chain_capped',
        },
      });
    }
    await postSkipChainCappedComment({
      projectId: payload.projectId,
      issueId: payload.issueId,
      from: payload.to,
      visited: skipResult.chain,
    });
    logger.warn(
      {
        issueId: payload.issueId,
        projectId: payload.projectId,
        from: payload.to,
        chain: skipResult.chain,
      },
      'orchestrator: auto-skip chain capped without finding a skill anchor',
    );
    return false;
  }

  if (!issue) {
    issue = await loadIssueForSkip(payload.issueId);
    if (!issue) return false;
    if (issue.status !== payload.to) return false; // raced with another writer
  }

  const device = resolveSkipDevice(payload.actor, ownerId);
  if (!device) {
    logger.warn(
      { issueId: issue.id, projectId: issue.projectId },
      'orchestrator: skip-disabled requires a device principal; none available',
    );
    return false;
  }

  // Open the run once for the whole chain so per-hop metadata writes share
  // the same `pipeline_runs.id`. ISS-101 — openIssueRun is idempotent.
  const run = await openIssueRun({
    projectId: issue.projectId,
    issueId: issue.id,
  });

  let current = { ...issue };
  let hopIndex = 0;
  for (const hop of skipResult.hops) {
    const nextStatus = hop.to;
    try {
      // skip: true — the chain may collapse stages the state-machine matrix
      // doesn't allow as direct one-hop transitions (e.g. `developed →
      // testing` skips review + deploy). resolveSkipTarget validates the
      // chain end-to-end, so bypassing canTransition per hop is safe.
      await applyStatusTransition(current, nextStatus, device, { skip: true });
    } catch (err) {
      logger.warn(
        { err, issueId: current.id, from: current.status, to: nextStatus, reason: hop.reason },
        'orchestrator: auto-skip chain failed to advance',
      );
      return hopIndex > 0;
    }

    try {
      await appendSkipChainEntry(run.id, {
        from: current.status,
        to: nextStatus,
        reason: hop.reason,
        at: new Date().toISOString(),
      });
    } catch (err) {
      logger.warn(
        { err, runId: run.id, from: current.status, to: nextStatus },
        'orchestrator: failed to append skipChain metadata, continuing',
      );
    }

    // Structured info log per hop — the breadcrumbs below are Sentry-only
    // (opt-in, off in OSS/self-host builds), so plain log-based debugging
    // would otherwise have no record of a silent auto-advance.
    logger.info(
      {
        issueId: current.id,
        projectId: current.projectId,
        from: current.status,
        to: nextStatus,
        reason: hop.reason,
        hop: hopIndex,
        ...(hop.reason === 'complexity_skip' && complexity ? { complexity } : {}),
      },
      'orchestrator: auto-skip advanced issue',
    );

    if (isSentryEnabled()) {
      // Compat with ISS-110: existing dashboards key on this category. The
      // historical reason label is preserved for the config/skill cases;
      // complexity hops carry their own reason.
      const compatReason =
        hop.reason === 'complexity_skip' ? 'complexity_skip' : 'skipped-disabled';
      Sentry.addBreadcrumb({
        category: 'pipeline_run.status_changed',
        level: 'info',
        message: `${current.status} -> ${nextStatus} (${compatReason})`,
        data: {
          issueId: current.id,
          projectId: current.projectId,
          fromStatus: current.status,
          toStatus: nextStatus,
          reason: compatReason,
          hop: hopIndex,
        },
      });
      // ISS-239 — typed skip reason for the new auto_skip dashboard.
      Sentry.addBreadcrumb({
        category: 'pipeline_run.auto_skip',
        level: 'info',
        message: `${current.status} -> ${nextStatus} (${hop.reason})`,
        data: {
          runId: run.id,
          issueId: current.id,
          projectId: current.projectId,
          fromStatus: current.status,
          toStatus: nextStatus,
          reason: hop.reason,
          hop: hopIndex,
          ...(hop.reason === 'complexity_skip' && complexity ? { complexity } : {}),
        },
      });
    }

    current = { ...current, status: nextStatus };
    hopIndex++;
  }
  return hopIndex > 0;
}

type SkipIssueRow = {
  id: string;
  projectId: string;
  status: IssueStatus;
  reopenCount: number;
  complexity: IssueComplexity | null;
};

async function loadIssueForSkip(issueId: string): Promise<SkipIssueRow | null> {
  const [issue] = await db
    .select({
      id: issues.id,
      projectId: issues.projectId,
      status: issues.status,
      reopenCount: issues.reopenCount,
      complexity: issues.complexity,
    })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  return issue ?? null;
}

/**
 * Cheap pure pre-check: does any stage reachable from `start` along
 * STAGE_FORWARD (within the skip cap) declare `skipComplexities`? Decides
 * whether autoSkipDisabledStages must load the issue row BEFORE resolving
 * the skip chain (the complexity predicate is sync).
 */
function chainMayUseComplexity(start: IssueStatus, cfg: PipelineConfig): boolean {
  let cursor: IssueStatus | undefined = start;
  for (let hop = 0; hop <= MAX_SKIP_CHAIN && cursor; hop++) {
    if (stageConfigFor(cfg, cursor)?.skipComplexities?.length) return true;
    cursor = STAGE_FORWARD[cursor];
  }
  return false;
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
      const { cfg, ownerId } = await loadPipelineConfig(payload.projectId);
      // ISS-239 — build the resolver once and thread it through both phases
      // so skill_registrations is read exactly once per transition hook.
      const resolver = createProjectSkillResolver(payload.projectId);
      // When the skip chain advanced the issue, the re-emitted transition
      // hook owns the new status — do NOT considerEnqueue for the stage the
      // issue just left (it would enqueue a job for a stage already skipped).
      const advanced = await autoSkipDisabledStages(payload, { cfg, ownerId, resolver });
      if (advanced) return;
      await considerEnqueue({
        projectId: payload.projectId,
        issueId: payload.issueId,
        status: payload.to,
        actor: payload.actor,
        reason: { transition: { from: payload.from, to: payload.to } },
        preloaded: { cfg, ownerId, resolver },
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
