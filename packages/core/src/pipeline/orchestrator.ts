import { and, eq, inArray, sql } from 'drizzle-orm';
import { env } from '../config/env.js';
import { db } from '../db/client.js';
import {
  type IssueComplexity,
  type IssueStatus,
  issues,
  type JobType,
  jobs,
  projects,
} from '../db/schema.js';
import { applyStatusTransition, type DeviceLite } from '../issues/apply-transition.js';
import { resolveMergeStates } from '../issues/merged-at.js';
import { isBlankPlan, isPlanStageLive } from '../issues/transition-evidence.js';
import { buildJobPromptString } from '../jobs/prompt-string.js';
import { logger } from '../logger.js';
import { isSentryEnabled, Sentry } from '../observability/sentry.js';
import { loadIssueSnapshot } from '../prompt/issue-snapshot.js';
import { buildMergeRequiredBlock } from '../prompt/merge-required.js';
import type { Actor } from './activity.js';
import { dispatchAutonomous, dispatchDriveManual, isAutonomous } from './autonomous-dispatch.js';
import { type PreventivePattern, queryPreventivePatterns } from './ci-fix-pattern-query.js';
import { findDecompositionParent } from './decomposition.js';
import { ActiveJobConflictError, insertAndEnqueueJob } from './enqueue-helper.js';
import { fetchHandoffPromptInputs } from './handoff-prefetch.js';
import type { HookPayloads, HooksBus } from './hooks.js';
import { pausePipelineRunMissingSkill, postMissingSkillComment } from './missing-skill-guard.js';
import {
  type PipelineConfig,
  pipelineConfigSchema,
  STAGE_NAMES,
  type StageConfig,
  type StageName,
} from './pipeline-config-schema.js';
import { postMissingPlanComment } from './plan-gate-guard.js';
import { PIPELINE_STEPS } from './registry.js';
import { openIssueRun } from './runs.js';
import {
  createProjectSkillResolver,
  inverseJobTypeToStatus,
  type ProjectSkillResolver,
  type ResolvedSkill,
  resolveJobTypeForStatus,
} from './skill-mapping.js';
import { appendSkipChainEntry, postSkipChainCappedComment } from './skip-chain-log.js';
import {
  MAX_SKIP_CHAIN,
  resolveSkipTarget,
  SKIPPABLE_STAGES,
  STAGE_FORWARD,
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
): Promise<{ cfg: PipelineConfig | null; projectCreatedBy: string | null }> {
  const [row] = await db
    .select({
      agentConfig: projects.agentConfig,
      createdBy: projects.createdBy,
      archivedAt: projects.archivedAt,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!row) return { cfg: null, projectCreatedBy: null };
  // ISS-353 — archived projects pause auto-pipeline dispatch. cfg=null falls
  // through to the same "no auto pipeline" path as a missing/invalid config,
  // so no NEW agent jobs are queued. In-flight jobs are untouched (this only
  // gates dispatch, not running work).
  if (row.archivedAt != null) return { cfg: null, projectCreatedBy: row.createdBy ?? null };
  const ac = (row.agentConfig as { pipelineConfig?: unknown } | null) ?? {};
  // Parse through the canonical schema so the typed read path stays in
  // lockstep with what was validated on write. Bad data → cfg=null (caller
  // falls through to "no auto pipeline" behavior, same as missing row).
  const parsed = pipelineConfigSchema.safeParse(ac.pipelineConfig ?? {});
  return {
    cfg: parsed.success ? parsed.data : null,
    projectCreatedBy: row.createdBy ?? null,
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

/**
 * ISS-819 requirement 4 — has a `plan` job already run to completion for this
 * issue? Decides the blank-plan backstop's route: back to `clarified` (first
 * time) vs `needs_info` (a plan job already ran and produced nothing —
 * routing back to `clarified` again would loop). Fails open (false) on any
 * query error: worst case is one extra `clarified` hop, never a freeze.
 */
async function hasDonePlanJob(issueId: string): Promise<boolean> {
  try {
    const [row] = await db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.issueId, issueId), eq(jobs.type, 'plan'), eq(jobs.status, 'done')))
      .limit(1);
    return row != null;
  } catch (err) {
    logger.warn(
      { err, issueId },
      'orchestrator: hasDonePlanJob check failed, treating as no prior plan job',
    );
    return false;
  }
}

/**
 * ISS-819 owner-flagged blocking collision — decompose children land at
 * `approved` with `plan:null` by design (their own `clarified`/`plan` stage
 * has not run yet); the blank-plan backstop must not treat that as the
 * fabrication it targets. Fails closed (not-a-child) on any query error, so
 * a broken check costs one extra `clarified` hop rather than skipping the
 * anti-fabrication guard it can't verify the exemption for.
 */
async function isDecompositionChild(issueId: string): Promise<boolean> {
  try {
    return (await findDecompositionParent(issueId)) !== null;
  } catch (err) {
    logger.warn(
      { err, issueId },
      'orchestrator: decompose-child check failed, treating as not a decompose child',
    );
    return false;
  }
}

function resolveCreatedBy(actor: Actor, projectCreatedBy: string | null): string {
  // Device-triggered triggers: fall back to the project creator (audit user;
  // jobs.createdBy FK is users.id).
  if (actor.type === 'user') return actor.id;
  if (projectCreatedBy) return projectCreatedBy;
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

const MAX_ADVISORY_LOCK_ATTEMPTS = 3;

// cm:why mirrors isUniqueViolation (lib/db-errors.ts) — postgres-js surfaces the SQLSTATE on err.code, but drizzle re-throws inside a `{cause}` wrapper on some paths, so check both
function isLockNotAvailable(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; cause?: { code?: unknown } };
  return e.code === '55P03' || e.cause?.code === '55P03';
}

/**
 * Shared tail of the manual + auto enqueue paths: build prompt inputs, open
 * the issue run, then insert + enqueue the job under the per-issue advisory
 * lock.
 *
 * ISS-196 — `pg_advisory_xact_lock` serialises check-active-job + INSERT
 * across all workers and processes; it auto-releases at COMMIT/ROLLBACK.
 * Multiple outbox rows for the same (issue, jobType) collapse to one INSERT
 * because the loser re-enters with the row already present. Both paths take
 * the same lock (the manual path historically relied on the unique index
 * alone; it now serialises identically with the auto path).
 *
 * On an in-lock race: `onRacing: 'throw'` (manual) throws
 * `ActiveJobConflictError` so the route can 409; `onRacing: 'skip'` (auto)
 * debug-logs and returns null (dedupe skip).
 *
 * ISS-678 — the advisory-lock wait is bounded by `SET LOCAL lock_timeout`
 * and retried up to `MAX_ADVISORY_LOCK_ATTEMPTS` times on `55P03` (backoff
 * outside the transaction — the tx mutates nothing before the lock, and
 * `preventiveContext`/`issueSnapshot`/`run` above are fetched once, outside
 * the retried block, so a retry never repeats them). On exhaustion this
 * returns null exactly like an in-lock race does: the manual path's existing
 * `if (!enqueued) throw new ActiveJobConflictError(...)` converts that to
 * the same 409 a race would produce, and the auto path already treats null
 * as a dedupe-skip — no new error type, no route change.
 */
async function buildAndEnqueueStepJob(args: {
  projectId: string;
  issueId: string;
  status: IssueStatus;
  createdBy: string;
  skill: { type: JobType; skillName: string };
  stageCfg: StageConfig | undefined;
  cfg: PipelineConfig | null;
  reason: Record<string, unknown>;
  onRacing: 'throw' | 'skip';
  logLabel: string;
}): Promise<{ jobId: string } | null> {
  const { skill, stageCfg } = args;

  const [preventiveContext, issueSnapshot] = await Promise.all([
    buildPreventiveContext(skill.type, args.projectId, args.issueId),
    loadIssueSnapshot(args.issueId),
  ]);

  const run = await openIssueRun({ projectId: args.projectId, issueId: args.issueId });

  // Operator-supplied per-state skill name wins over the resolver default.
  const effectiveSkillName = stageCfg?.skillName ?? skill.skillName;

  let enqueued: { jobId: string } | null = null;
  for (let attempt = 1; attempt <= MAX_ADVISORY_LOCK_ATTEMPTS; attempt++) {
    try {
      await db.transaction(async (tx) => {
        // cm:why SET is a utility statement — postgres rejects a bind parameter here ("syntax error at or near $1"), so the value must be inlined as a literal; safe because env.PIPELINE_ADVISORY_LOCK_TIMEOUT_MS is z.coerce.number().int().positive()
        await tx.execute(
          sql`SET LOCAL lock_timeout = '${sql.raw(String(env.PIPELINE_ADVISORY_LOCK_TIMEOUT_MS))}ms'`,
        );
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('issue:' || ${args.issueId}))`);

        // Re-check inside the lock — the caller's cheap pre-check may have raced.
        const racing = await findActiveJob(args.issueId, skill.type);
        if (racing) {
          if (args.onRacing === 'throw') throw new ActiveJobConflictError(racing, skill.type);
          logger.debug(
            { issueId: args.issueId, type: skill.type, racing },
            `${args.logLabel}: active job appeared while waiting on lock`,
          );
          return;
        }

        // ISS-232 — inject merge-required block when this stage is configured
        // as the project's merge point. The state-machine writer keys on the
        // same `mergeStates.baseBranch`; without the prompt block the skill has
        // no signal it must merge + push before transitioning.
        const mergeRequiredText = buildMergeRequiredBlock({
          stageStatus: args.status,
          mergeStates: resolveMergeStates(args.cfg),
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
          jobType: skill.type,
          policy: stageCfg?.userPromptPolicy ?? null,
        });
        enqueued = await insertAndEnqueueJob({
          projectId: args.projectId,
          issueId: args.issueId,
          pipelineRunId: run.id,
          createdBy: args.createdBy,
          type: skill.type,
          skillName: effectiveSkillName,
          promptString: buildJobPromptString({
            skillName: effectiveSkillName,
            jobType: skill.type,
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
          // On unique-violation the error names the racing job id.
          resolveRacingJobId: () => findActiveJob(args.issueId, skill.type),
        });
        logger.info(
          { jobId: enqueued.jobId, type: skill.type, issueId: args.issueId },
          `${args.logLabel}: enqueued`,
        );
      });
      break;
    } catch (err) {
      if (!isLockNotAvailable(err)) throw err;
      if (attempt >= MAX_ADVISORY_LOCK_ATTEMPTS) {
        logger.warn(
          { issueId: args.issueId, type: skill.type, attempts: attempt },
          `${args.logLabel}: advisory lock wait exhausted retries — reconciler will re-enqueue if this was a real transition`,
        );
        if (isSentryEnabled()) {
          Sentry.addBreadcrumb({
            category: 'pipeline.advisory_lock.timeout',
            level: 'warning',
            data: { issueId: args.issueId, jobType: skill.type },
          });
        }
        return null;
      }
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt + Math.random() * 50));
    }
  }
  return enqueued;
}

/**
 * Manual fire from the issue UI (ISS-5): one staged stage, or the whole drive
 * session on an autonomous project. Bypasses every automation gate — the user
 * clicked "Run". Throws `ActiveJobConflictError` when a job of the same
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
  const { cfg, projectCreatedBy } = await loadPipelineConfig(args.projectId);
  // cm:guard the autonomous branch must sit BEFORE skill resolution: `forge-drive` ships in the runner binary and is never in `skill_registrations`, so the staged resolver throws NO_SKILL_REGISTERED and Run is dead on every autonomous project — which is the only escape from a gated entry stage
  if (isAutonomous(cfg)) return dispatchDriveManual({ ...args, projectCreatedBy });
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

  // Cheap pre-check — 409s before opening a run or building prompt inputs.
  const existing = await findActiveJob(args.issueId, skill.type);
  if (existing) throw new ActiveJobConflictError(existing, skill.type);

  const enqueued = await buildAndEnqueueStepJob({
    projectId: args.projectId,
    issueId: args.issueId,
    status: args.status,
    createdBy: resolveCreatedBy(args.actor, projectCreatedBy),
    skill,
    stageCfg: stageConfigFor(cfg, args.status),
    cfg,
    reason: args.reason,
    onRacing: 'throw',
    logLabel: 'manual trigger',
  });
  if (!enqueued) throw new ActiveJobConflictError(null, skill.type);
  return { jobId: enqueued.jobId, type: skill.type };
}

// cm:flow release/enqueue after:stamp — maps the new status to a step via PIPELINE_STEPS; `released` is the only trigger that enqueues the release job, so a project whose registry drops that entry silently never releases
async function considerEnqueue(args: {
  projectId: string;
  issueId: string;
  status: IssueStatus;
  actor: Actor;
  reason: Record<string, unknown>;
  preloaded?: {
    cfg: PipelineConfig | null;
    projectCreatedBy: string | null;
    resolver?: ProjectSkillResolver;
  };
}): Promise<void> {
  const jobMap = resolveJobTypeForStatus(args.status);
  if (!jobMap) return; // human-gated status

  const { cfg, projectCreatedBy } = args.preloaded ?? (await loadPipelineConfig(args.projectId));
  if (!cfg?.enabled) return;
  if (await dispatchAutonomous({ ...args, cfg, projectCreatedBy })) return;
  // Belt-and-suspenders: if the landing stage is disabled in `states`, never
  // enqueue a job. autoSkipDisabledStages should have moved the issue past
  // this stage already; this fallback ensures a failed skip path never
  // produces a job for a stage the operator explicitly turned off.
  const stageCfg = stageConfigFor(cfg, args.status);
  if (stageCfg && stageCfg.enabled === false) return;
  if (stageCfg && stageCfg.mode === 'manual') return;
  if (!isToggleEnabled(cfg, jobMap.toggle)) return;

  // ISS-635 Change A — re-verify the LIVE issue status before dispatching.
  // The transition hook can fire from a stale outbox snapshot (`payload.to`)
  // after another writer has already advanced the issue past this stage
  // (e.g. a review self-correction reopen→testing racing the reopen→fix
  const liveIssue = await loadIssueForSkip(args.issueId);
  if (!liveIssue || liveIssue.status !== args.status) {
    logger.debug(
      { issueId: args.issueId, expected: args.status, live: liveIssue?.status ?? null },
      'orchestrator: skip enqueue — live status no longer matches dispatch target',
    );
    return;
  }

  // ISS-239 — reuse the resolver from autoSkipDisabledStages when available
  // so we don't refetch skill_registrations a second time per hook fire.
  const resolver = args.preloaded?.resolver ?? createProjectSkillResolver(args.projectId);

  // cm:why backstop for issues already at `approved` with a blank plan predating the transition-evidence writer guard — routes to `clarified` to get a plan written, or `needs_info` if a `plan` job already ran and it's still blank (else routing back would loop)
  // cm:why isPlanStageComplexitySkipped short-circuits BEFORE the DB checks — on a project that skips the plan stage for this complexity the blank plan is legitimate and rerouting would livelock against the auto-skip resolver (ISS-819 review r2 blocker)
  if (
    jobMap.type === 'code' &&
    isBlankPlan(liveIssue.plan) &&
    !isPlanStageComplexitySkipped(cfg, liveIssue.complexity) &&
    (await isPlanStageLive(args.projectId, resolver))
  ) {
    const planJobRan = await hasDonePlanJob(args.issueId);
    // cm:guard exempt ONLY the cascade kickoff — a decompose child created at `approved`/`plan:null` whose own clarified/plan stage has not run yet. Once a `plan` job HAS run done and the plan is still blank, the child is the same fabrication class as any other issue and must be routed, not exempted forever (ISS-819 review r2 finding 4)
    const exemptCascadeKickoff = !planJobRan && (await isDecompositionChild(args.issueId));
    if (!exemptCascadeKickoff) {
      const device = resolveSkipDevice(args.actor, projectCreatedBy);
      const routedTo: IssueStatus = planJobRan ? 'needs_info' : 'clarified';
      // cm:edge ordering -> packages/core/src/pipeline/plan-gate-guard.ts — post BEFORE attempting the route, same convention as the needs_info guard below and the park-comment.ts precedent: a null-device or throwing transition must not silence the refusal (ISS-819 review r2 finding 2)
      await postMissingPlanComment({ issueId: args.issueId, authorId: projectCreatedBy, routedTo });
      if (device) {
        try {
          await applyStatusTransition(liveIssue, routedTo, device, { skip: true });
        } catch (err) {
          logger.warn(
            { err, issueId: args.issueId, to: routedTo },
            'orchestrator: plan-required guard failed to route',
          );
        }
      } else {
        logger.warn(
          { issueId: args.issueId },
          'orchestrator: plan-required guard has no device principal for status transition',
        );
      }
      logger.info(
        { issueId: args.issueId, routedTo },
        'orchestrator: plan-required guard — approved with blank plan, routed',
      );
      return;
    }
  }

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

  await buildAndEnqueueStepJob({
    projectId: args.projectId,
    issueId: args.issueId,
    status: args.status,
    createdBy: resolveCreatedBy(args.actor, projectCreatedBy),
    skill,
    stageCfg,
    cfg,
    reason: args.reason,
    onRacing: 'skip',
    logLabel: 'orchestrator',
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
    projectCreatedBy: string | null;
    resolver: ProjectSkillResolver;
  },
): Promise<boolean> {
  const { cfg, projectCreatedBy, resolver } = preloaded;
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

  const device = resolveSkipDevice(payload.actor, projectCreatedBy);
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
  plan: string | null;
};

async function loadIssueForSkip(issueId: string): Promise<SkipIssueRow | null> {
  const [issue] = await db
    .select({
      id: issues.id,
      projectId: issues.projectId,
      status: issues.status,
      reopenCount: issues.reopenCount,
      complexity: issues.complexity,
      plan: issues.plan,
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

/**
 * ISS-819 (review round 2) — is the plan stage (`clarified`) being
 * auto-skipped for THIS issue's `complexity`? When `states.clarified` declares
 * a matching `skipComplexities`, the plan step legitimately never runs and the
 * issue reaches `approved` with a blank plan by design. The dispatch-side
 * blank-plan backstop MUST treat the stage as not-live in that case: otherwise
 * it reroutes `approved → clarified`, `autoSkipDisabledStages` skips straight
 * back to `approved`, and the pair livelock forever (blank-plan comment on
 * every cycle). Mirrors `complexityMatches` in `autoSkipDisabledStages`.
 */
// cm:edge lockstep -> packages/core/src/pipeline/state-machine.ts — same skipComplexities criterion resolveSkipTarget applies via complexityMatches; if that predicate changes, this must too
function isPlanStageComplexitySkipped(
  cfg: PipelineConfig | null,
  complexity: IssueComplexity | null,
): boolean {
  if (!cfg || !complexity) return false;
  return stageConfigFor(cfg, 'clarified')?.skipComplexities?.includes(complexity) === true;
}

function resolveSkipDevice(actor: Actor, projectCreatedBy: string | null): DeviceLite | null {
  // applyStatusTransition needs a DeviceLite for its WS broadcast / hook
  // payload. The skip is system-initiated; route it through the original
  // actor when it's already device-typed, otherwise synthesize from the
  // project creator (`projects.createdBy`, audit-only). activity_log.actorId
  // has no FK so attributing the skip to the creator is harmless and matches
  // the WS event's actorId field.
  if (actor.type === 'device') {
    return { id: actor.id, ownerId: projectCreatedBy ?? actor.id };
  }
  if (projectCreatedBy) {
    return { id: projectCreatedBy, ownerId: projectCreatedBy };
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
  bus.on(
    'transition',
    async (payload) => {
      try {
        // cm:guard leaving a park dispatches like any other transition (RFC 0002 INV-6) — do NOT re-add an actor or reason gate here. The guard deleted from this spot refused every non-user exit from `waiting`/`on_hold`; on ISS-163 it refused four legitimate resume attempts in a row and produced no work at all. Entering a park is free from anywhere, so leaving one is too.
        // cm:why the short-circuit runs BEFORE loadPipelineConfig so a human-gated transition costs no DB hit
        if (!resolveJobTypeForStatus(payload.to) && !SKIPPABLE_STAGES.has(payload.to)) return;
        const { cfg, projectCreatedBy } = await loadPipelineConfig(payload.projectId);
        // cm:guard the answered-question short-circuit is STAGED-ONLY — under the autonomous driver `needs_info → open` IS the resume (pipeline/answer-resume.ts), and returning here leaves the issue `open` with no job, which the board renders as running: the one failure shape nobody thinks to check
        if (payload.to === 'open' && payload.from === 'needs_info' && !isAutonomous(cfg)) return;
        // ISS-239 — build the resolver once and thread it through both phases
        // so skill_registrations is read exactly once per transition hook.
        const resolver = createProjectSkillResolver(payload.projectId);
        // When the skip chain advanced the issue, the re-emitted transition
        // hook owns the new status — do NOT considerEnqueue for the stage the
        // issue just left (it would enqueue a job for a stage already skipped).
        const advanced = await autoSkipDisabledStages(payload, { cfg, projectCreatedBy, resolver });
        if (advanced) return;
        await considerEnqueue({
          projectId: payload.projectId,
          issueId: payload.issueId,
          status: payload.to,
          actor: payload.actor,
          reason: { transition: { from: payload.from, to: payload.to } },
          preloaded: { cfg, projectCreatedBy, resolver },
        });
      } catch (err) {
        logger.error(
          { err, issueId: payload.issueId, to: payload.to },
          'orchestrator: transition handler failed',
        );
        // cm:edge contract -> packages/core/src/pipeline/hooks.ts — rethrow so HooksBus records this subscriber in EmitResult.failures and the outbox stops stamping the row processed; the bus still runs the remaining subscribers and never throws at the emitter, so the isolation this local catch used to provide is unchanged
        throw err;
      }
    },
    { name: 'pipeline-orchestrator' },
  );

  bus.on(
    'issueCreated',
    async (payload) => {
      try {
        await considerEnqueue({
          projectId: payload.projectId,
          issueId: payload.issueId,
          status: payload.status,
          actor: payload.actor,
          reason: { created: true },
        });
      } catch (err) {
        logger.error(
          { err, issueId: payload.issueId },
          'orchestrator: issueCreated handler failed',
        );
        throw err;
      }
    },
    { name: 'pipeline-orchestrator' },
  );
}
