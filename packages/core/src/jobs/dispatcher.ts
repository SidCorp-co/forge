import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import type { JobType, RunnerType } from '../db/schema.js';
import { issueLabels, jobs, labels, projects, runners } from '../db/schema.js';
import { publishPipelineHealthChanged } from '../issues/pipeline-health.js';
import { buildPipelinePreambleStructured } from '../lib/chat-preamble.js';
import { applyKernelTransition } from '../lifecycle/transition.js';
import { logger } from '../logger.js';
import {
  recordDispatchBarrierSkip,
  recordRunnerDeathDetection,
} from '../observability/hold-metrics.js';
import { isSentryEnabled, Sentry } from '../observability/sentry.js';
import { CLASSIFIER_VERSION } from '../pipeline/failure-classifier.js';
import { hooks } from '../pipeline/hooks.js';
import { resolveRunnerChainForJob } from '../pipeline/resolve-step-runner.js';
import { injectAfterInvocation, injectTurnLevelRules } from '../prompt/user.js';
import { boss } from '../queue/boss.js';
import { getRunnerAdapter } from '../runners/registry.js';
import { selectRunnerForJob } from '../runners/select.js';
import type { RequiredCapabilities } from '../runners/types.js';
import { ensureAgentSessionForJob } from './agent-session-link.js';
import { checkMonthlyBudget, postBudgetExhaustedComment, shouldEmitWarn } from './budget-check.js';
import {
  assertDispatchable,
  claimRunnerSlot,
  resolveProjectCap,
  runnerSupportsJobType,
} from './dispatch-gates.js';
import { finalizeFailedJob } from './finalize-failure.js';
import { loadPriorAttempts, renderPriorAttemptsBlock } from './prior-attempts.js';
import { persistPromptSnapshot } from './prompt-snapshot.js';
import { JOB_QUEUE_NAME, PM_QUEUE_NAME, RECONCILE_QUEUE_NAME } from './queue-name.js';
import { resolveJobMcpServers } from './resolve-job-mcp-servers.js';
import { finalizeResumeForDevice, resolveResumePolicy } from './resume-policy.js';
import {
  applySkillMaintenanceCarveout,
  resolveStageOverrides,
  SKILL_MAINTENANCE_LABEL,
  type StageOverrides,
} from './stage-overrides.js';

interface DispatchMessage {
  jobId: string;
}

let workerId: string | null = null;
let pmWorkerId: string | null = null;
let reconcileWorkerId: string | null = null;

/**
 * Flatten stage overrides into the WS payload/job.payload shape consumed by
 * runners (the desktop dev runner in `use-job-handler.ts` + future remote
 * runners). Skips null fields so legacy jobs (no stageStatus stamped) emit
 * an unchanged payload — backwards-compatible.
 */
function buildOverridesPayload(o: StageOverrides): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (o.model !== null) out.model = o.model;
  if (o.allowedTools !== null) out.allowedTools = o.allowedTools.join(',');
  if (o.disallowedTools !== null) out.disallowedTools = o.disallowedTools.join(',');
  if (o.permissionMode !== null) out.permissionMode = o.permissionMode;
  if (o.timeoutSeconds !== null) out.timeoutSeconds = o.timeoutSeconds;
  if (o.mcpServers !== null) out.mcpServersOverride = o.mcpServers;
  return out;
}

// cm:flow dispatch/handoff after:gate — last step: builds the prompt, claims the job, and hands it to a runner over WS. Everything before this is reversible; this is not
export async function handleDispatch(msg: DispatchMessage): Promise<'dispatched' | 'skipped'> {
  const { jobId } = msg;

  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  if (!job) {
    logger.warn({ jobId }, 'dispatcher: job not found');
    return 'skipped';
  }
  if (job.status !== 'queued') {
    logger.debug({ jobId, status: job.status }, 'dispatcher: non-queued job, skipping');
    return 'skipped';
  }

  // ISS-228 — SSOT dispatch barrier. Mirrors EVERY picker gate (blocked_by,
  // project_cap, runner_full, retry_cooldown, pipeline_run_running,
  // issue_busy) so the pg-boss-direct path enforces the same invariants as
  // `pickNextDispatchableJobForProject`. Replaces the ISS-226 narrow L1-only
  // check that left 5/6 gates bypassed and caused the 2026-05-25 cascade.
  //
  // When the barrier fails: job stays `queued`, no row update, no hook
  // emission. The fire-and-forget `dispatchTickForProject` re-picks the job
  // via the picker once state stabilises (job complete, runner online,
  // terminal transition).
  const barrier = await assertDispatchable(job.id);
  if (!barrier.ok) {
    logger.debug(
      { jobId, reason: barrier.reason, hint: barrier.hint },
      'dispatcher: barrier failed, leaving queued',
    );
    recordDispatchBarrierSkip(barrier.reason);
    if (isSentryEnabled()) {
      Sentry.addBreadcrumb({
        category: 'dispatch.barrier_skip',
        level: 'info',
        message: `dispatch barrier skip (${barrier.reason})`,
        data: { jobId, reason: barrier.reason, hint: barrier.hint },
      });
    }
    return 'skipped';
  }

  // W2.3.2 — pre-dispatch monthly budget gate. Sits ahead of runner
  // selection so the cap binds on every dispatch. PM jobs flow through
  // `handlePmDispatch` and therefore bypass this check by construction —
  // see W2.3.2 PR notes.
  const budgetCheck = await checkMonthlyBudget(job);
  if (budgetCheck.action === 'pause') {
    // cm:why ISS-823 — routes through finalizeFailedJob (below) so a budget-exhausted job parks the issue + closes the run like any other terminal failure, instead of stranding both
    const [updated] = await applyKernelTransition(db, {
      entity: 'job',
      to: 'failed',
      set: {
        finishedAt: new Date(),
        failureKind: 'code',
        failureAction: 'terminal',
        failureReason: 'monthly_budget_exhausted',
        failureMeta: {
          spent: budgetCheck.spent,
          budget: budgetCheck.budget,
          stageStatus: budgetCheck.stageStatus,
        } as never,
        classifierVersion: CLASSIFIER_VERSION,
      },
      where: and(eq(jobs.id, job.id), eq(jobs.status, 'queued')),
      fromStatus: 'queued',
      reason: 'monthly_budget_exhausted',
      actor: { type: 'system' },
      source: 'dispatcher',
    });
    await hooks.emit('pipeline.budgetBreach', {
      projectId: job.projectId,
      stageStatus: budgetCheck.stageStatus ?? '',
      jobType: job.type,
      spent: budgetCheck.spent,
      budget: budgetCheck.budget ?? 0,
      jobId: job.id,
      issueId: job.issueId,
    });
    if (job.issueId) {
      try {
        await postBudgetExhaustedComment({
          issueId: job.issueId,
          jobType: job.type,
          result: budgetCheck,
        });
      } catch (err) {
        logger.warn(
          { err, jobId: job.id, issueId: job.issueId },
          'dispatcher: postBudgetExhaustedComment threw, continuing',
        );
      }
    }
    logger.warn(
      {
        jobId: job.id,
        projectId: job.projectId,
        stageStatus: budgetCheck.stageStatus,
        spent: budgetCheck.spent,
        budget: budgetCheck.budget,
      },
      'dispatcher: monthly budget exhausted, failing job',
    );
    if (updated) {
      try {
        await finalizeFailedJob(updated, {
          error: 'monthly_budget_exhausted',
          precomputedRetry: { scheduled: false, reason: 'monthly_budget_exhausted' },
        });
      } catch (err) {
        logger.error(
          { err, jobId: job.id, issueId: job.issueId },
          'dispatcher: finalizeFailedJob threw after budget pause',
        );
      }
    }
    return 'skipped';
  }
  if (
    budgetCheck.action === 'warn-80' &&
    budgetCheck.stageStatus !== null &&
    shouldEmitWarn(job.projectId, budgetCheck.stageStatus)
  ) {
    await hooks.emit('pipeline.budgetWarning', {
      projectId: job.projectId,
      stageStatus: budgetCheck.stageStatus,
      jobType: job.type,
      spent: budgetCheck.spent,
      budget: budgetCheck.budget ?? 0,
      pct:
        budgetCheck.budget && budgetCheck.budget > 0 ? budgetCheck.spent / budgetCheck.budget : 0,
    });
  }

  return dispatchViaRunner(job);
}

/**
 * PM-isolated dispatch. Always runner-path, always requires `capabilities.pm`,
 * and ignores any caller-supplied `requiredCapabilities` for the PM filter so
 * a malicious or buggy producer cannot opt out. Fallback chain is hard-coded
 * to `['claude-code']`.
 */
export async function handlePmDispatch(msg: DispatchMessage): Promise<'dispatched' | 'skipped'> {
  const { jobId } = msg;
  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  if (!job) {
    logger.warn({ jobId }, 'pm-dispatcher: job not found');
    return 'skipped';
  }
  if (job.status !== 'queued') {
    logger.debug({ jobId, status: job.status }, 'pm-dispatcher: non-queued job, skipping');
    return 'skipped';
  }
  if (job.type !== 'pm') {
    logger.warn({ jobId, type: job.type }, 'pm-dispatcher: non-pm job on pm queue, skipping');
    return 'skipped';
  }
  // ISS-228 — same SSOT barrier as handleDispatch. `assertDispatchable`
  // detects `j.type = 'pm'` internally and skips `blocked_by` accordingly
  // (PM jobs have no issue deps); other gates (project_cap,
  // runner_full, retry_cooldown, pipeline_run_running, issue_busy) still
  // apply.
  const barrier = await assertDispatchable(job.id);
  if (!barrier.ok) {
    logger.debug(
      { jobId, reason: barrier.reason, hint: barrier.hint },
      'pm-dispatcher: barrier failed, leaving queued',
    );
    recordDispatchBarrierSkip(barrier.reason);
    if (isSentryEnabled()) {
      Sentry.addBreadcrumb({
        category: 'dispatch.barrier_skip',
        level: 'info',
        message: `pm-dispatch barrier skip (${barrier.reason})`,
        data: { jobId, reason: barrier.reason, hint: barrier.hint, queue: 'pm' },
      });
    }
    return 'skipped';
  }
  return dispatchViaRunner(job, { pm: true }, ['claude-code']);
}

async function loadRepoPath(projectId: string): Promise<string | null> {
  const [row] = await db
    .select({ repoPath: projects.repoPath, agentConfig: projects.agentConfig })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!row) return null;
  if (row.repoPath) return row.repoPath;
  const ac = (row.agentConfig ?? {}) as Record<string, unknown>;
  return typeof ac.repoPath === 'string' ? ac.repoPath : null;
}

/**
 * Shared runner dispatch. Default behaviour reads capabilities + fallback
 * chain off the job/project; the PM path passes `forcedCapabilities` and
 * `forcedChain` to lock the filter regardless of payload.
 */
function buildDispatchPayload(
  payload: unknown,
  overrides: Parameters<typeof buildOverridesPayload>[0],
  priorClaudeSessionId: string | null | undefined,
): Record<string, unknown> {
  return {
    ...((payload ?? {}) as Record<string, unknown>),
    ...buildOverridesPayload(overrides),
    ...(priorClaudeSessionId ? { claudeSessionId: priorClaudeSessionId } : {}),
  };
}

async function dispatchViaRunner(
  job: typeof jobs.$inferSelect,
  forcedCapabilities?: RequiredCapabilities,
  forcedChain?: RunnerType[],
): Promise<'dispatched' | 'skipped'> {
  // ISS-162 — L1/L2/L3 are evaluated inline by the picker. The dispatcher
  // trusts the picker and only enforces post-pick checks that depend on the
  // runner selection step below (L4 + race-loss guard).
  let required: RequiredCapabilities;
  let fallbackChain: RunnerType[];

  let cachedAgentConfig: Record<string, unknown> | undefined;
  if (forcedCapabilities !== undefined || forcedChain !== undefined) {
    required = forcedCapabilities ?? {};
    fallbackChain = forcedChain ?? [];
  } else {
    const payload = (job.payload ?? {}) as { requiredCapabilities?: RequiredCapabilities };
    required = payload.requiredCapabilities ?? {};

    const [project] = await db
      .select({ agentConfig: projects.agentConfig })
      .from(projects)
      .where(eq(projects.id, job.projectId))
      .limit(1);
    cachedAgentConfig = (project?.agentConfig ?? {}) as Record<string, unknown>;
    fallbackChain = resolveRunnerChainForJob(job.type, cachedAgentConfig);
  }

  const preDispatchOverrides = await resolveStageOverrides(job.projectId, job.payload);
  const proposedResume = await resolveResumePolicy({
    job,
    overrides: preDispatchOverrides,
    agentConfig: cachedAgentConfig,
  });
  const { pinDeviceId, excludeDeviceIds, skipPrimary } = proposedResume;
  const stagePool = preDispatchOverrides.deviceIds;

  // ISS-232 Phase 2 — `selectRunnerForJob` no longer takes `fallbackChain`.
  // Runner-type filtering is enforced post-select via `runnerSupportsJobType`
  // (failure = permanent `runner_unsupported_type:<runner-type>`). The chain
  // is kept around purely for the L5-skip telemetry breadcrumb below.
  // cap>1 makes runner selection load-aware (primary-first, spill to a free
  // runner). At the default cap=1 this is the unchanged primary-pinned path.
  const projectCap = await resolveProjectCap(job.projectId);
  const runner = await selectRunnerForJob({
    projectId: job.projectId,
    requiredCapabilities: required,
    pinDeviceId,
    excludeDeviceIds,
    skipPrimary,
    projectCap,
    allowDeviceIds: stagePool,
  });
  if (!runner) {
    // ISS-198 — selectRunnerForJob filters runners with stale heartbeats
    // (Gate L5). When no runner is selectable, observe the worst stale
    // candidate so the runner_death_detection_seconds histogram captures
    // the time between worker death and dispatcher reaction. If the project
    // simply has no runners at all there's nothing to observe; that's a
    // configuration condition rather than a worker death.
    await maybeRecordL5Skip(job.projectId, job.id, fallbackChain);
    // cm:why the pool is named in the log because the two conditions are operationally different: an empty fleet is an outage, a busy/limited POOL is the configured price of pinning a stage — `VISION: state-never-lies` forbids the second one reading as the first
    logger.warn(
      { jobId: job.id, projectId: job.projectId, fallbackChain, stagePool },
      stagePool
        ? 'dispatcher: no runner available inside the stage runner pool, leaving queued'
        : 'dispatcher: no runner online, leaving queued',
    );
    return 'skipped';
  }

  const adapter = getRunnerAdapter(runner.type);
  if (!adapter) {
    logger.error(
      { jobId: job.id, runnerId: runner.id, type: runner.type },
      'dispatcher: runner has no registered adapter, leaving queued',
    );
    return 'skipped';
  }

  // ISS-115 — runner/job-type capability gate. PM jobs run through their own
  // path (handlePmDispatch is the entrypoint but still funnels here); they
  // are not in RUNNER_CAPABILITIES so we skip the check for them.
  if (job.type !== 'pm' && !runnerSupportsJobType(runner.type as RunnerType, job.type as JobType)) {
    const errorMsg = `runner_unsupported_type:${runner.type}`;
    await applyKernelTransition(db, {
      entity: 'job',
      to: 'failed',
      set: {
        error: errorMsg,
        failureKind: 'code',
        failureReason: errorMsg,
      },
      where: eq(jobs.id, job.id),
      fromStatus: job.status,
      reason: errorMsg,
      actor: { type: 'system' },
      source: 'dispatcher',
    });
    logger.warn(
      { jobId: job.id, runnerType: runner.type, jobType: job.type },
      'dispatcher: runner does not support job type, failing permanently',
    );
    return 'skipped';
  }

  // cm:guard this is the AUTHORITATIVE per-runner cap gate and it must stay atomic — lock the runner row (FOR UPDATE serializes concurrent dispatches to the same host), recount orphan-aware in-flight under that lock, and only then claim. The picker's L4 EXISTS is pool-coarse: it proves SOME runner is free, never that THIS selected one is, and at maxConcurrentIssues>1 a resume-pin to a busy host or two ticks racing on the same free runner still targets one at capacity. Checking outside the lock makes exceeding RUNNER_CAP_PER_RUNNER a race away.
  // cm:why `deviceId` mirrors the runner for consumers still reading the legacy column
  const dispatchedAt = new Date();
  const claim = await claimRunnerSlot({
    jobId: job.id,
    runnerId: runner.id,
    deviceId: runner.deviceId,
    dispatchedAt,
  });

  if (claim === 'runner_full') {
    // cm:why left queued rather than failed: the tick excludes this job and tries the next candidate, so a runner that filled up between pick and claim never head-of-line-blocks, and a freed slot re-picks it on a later tick
    logger.debug(
      { jobId: job.id, runnerId: runner.id },
      'dispatcher: selected runner at per-runner cap, leaving queued',
    );
    return 'skipped';
  }
  if (claim === 'lost') {
    logger.debug({ jobId: job.id }, 'dispatcher: lost race to another dispatcher');
    return 'skipped';
  }

  // cm:edge ordering -> packages/core/src/jobs/resume-policy.ts — the resume is provisional until a device is picked; `selectRunnerForJob` silently falls through a stale pin, so this must sit between selection and the session row that records the answer
  const resume = finalizeResumeForDevice(proposedResume, runner.deviceId);
  const repoPath = await loadRepoPath(job.projectId);
  const agentSessionId = await ensureAgentSessionForJob(
    {
      ...job,
      status: 'dispatched',
      runnerId: runner.id,
      deviceId: runner.deviceId,
      dispatchedAt,
    },
    { repoPath, resume: resume.record },
  );

  const runnerPayload = (job.payload ?? {}) as { promptString?: unknown } & Record<string, unknown>;
  const runnerBasePromptString =
    typeof runnerPayload.promptString === 'string' ? runnerPayload.promptString : null;
  // Reuse the overrides we resolved before runner selection — saves one
  //
  // Shallow-copy before mutating: resolveStageOverrides returns a shared
  // module-level EMPTY singleton by reference on its early-return paths
  // (no stageStatus / no configured stage). Assigning mcpServers directly to
  // preDispatchOverrides would otherwise write this project's Postman API key
  // onto that singleton process-wide, leaking it into the next EMPTY-path
  // dispatch for any other project (cross-tenant) and breaking the
  // active=false/deleted → drop-entry guarantee. (ISS-336 review blocker.)

  // cm:edge contract -> packages/core/src/jobs/stage-overrides.ts — `.model` arrives fixed per stage status and must reach the runner unmodified; the ISS-535 reopenCount escalation that used to mutate it here was deleted with escalateModel
  const runnerStageOverrides = { ...preDispatchOverrides };

  // ISS-637 — skill-maintenance carve-out. Skill bodies are DB-canonical but
  // `.claude/skills/*` is a git-ignored sync mirror, so the standard git-based
  // ladder gives a skill-maintenance issue no way to persist its edit — every
  // stage's `disallowedTools` blocks the skill-write tools. When the issue
  // carries the human-applied `skill-maintenance` label (NOT `issue.category`,
  // which is LLM-set and too easy to mis-classify — see plan discussion), the
  // `code`/`fix` jobs get the non-destructive skill-write tools back. Mutate
  // ONLY the shallow copy, best-effort (mirror the reopenCount lookup above).
  if (job.issueId && (job.type === 'code' || job.type === 'fix')) {
    try {
      // Two flat select().where().limit() lookups (never .innerJoin) so an
      // unmocked/absent label falls through cleanly: labels is unique per
      // (projectId, name), issueLabels is the join row for THIS issue.
      const [labelRow] = await db
        .select({ id: labels.id })
        .from(labels)
        .where(and(eq(labels.projectId, job.projectId), eq(labels.name, SKILL_MAINTENANCE_LABEL)))
        .limit(1);
      let hasSkillMaintenanceLabel = false;
      if (labelRow) {
        const [issueLabelRow] = await db
          .select({ issueId: issueLabels.issueId })
          .from(issueLabels)
          .where(and(eq(issueLabels.issueId, job.issueId), eq(issueLabels.labelId, labelRow.id)))
          .limit(1);
        hasSkillMaintenanceLabel = Boolean(issueLabelRow);
      }
      const removed = applySkillMaintenanceCarveout(runnerStageOverrides, {
        hasSkillMaintenanceLabel,
        jobType: job.type,
      });
      if (removed > 0) {
        logger.info(
          { jobId: job.id, issueId: job.issueId, jobType: job.type, removed },
          'dispatcher: skill-maintenance carve-out unblocked skill-write tools',
        );
        if (isSentryEnabled()) {
          Sentry.addBreadcrumb({
            category: 'dispatch.skill_carveout',
            data: { jobId: job.id, issueId: job.issueId, jobType: job.type, removed },
          });
        }
      }
    } catch (err) {
      logger.warn(
        { err, jobId: job.id, issueId: job.issueId, type: job.type },
        'dispatcher: skill-maintenance label lookup failed, dispatching without carve-out',
      );
    }
  }
  // Full merge + integration-resolve chain lives in resolve-job-mcp-servers.ts
  // (project-default < per-state < integration resolvers, then sentinel sweep
  // + browser dedupe). Adding an integration = one registry entry there.
  const resolvedMcp = await resolveJobMcpServers({
    projectId: job.projectId,
    stageMcpServers: runnerStageOverrides.mcpServers,
    stageDeclaredNames: runnerStageOverrides.declaredNames,
  });
  runnerStageOverrides.mcpServers = resolvedMcp.mcpServers;
  const { content: runnerSystemPrompt, blocks: runnerBlocks } =
    await buildPipelinePreambleStructured(job.projectId, {
      step: job.type,
      override: runnerStageOverrides.systemPrompt,
      mcpDiagnostics: { resolved: resolvedMcp.resolvedNames, dropped: resolvedMcp.droppedNames },
    });

  // cm:why on --resume the Claude CLI may ignore --append-system-prompt (undocumented), so the state's system prompt is embedded redundantly at the head of the user prompt; a fresh dispatch gets it through the flag and needs no copy
  const resumedPromptString =
    resume.priorClaudeSessionId && runnerBasePromptString
      ? injectTurnLevelRules(runnerBasePromptString, runnerSystemPrompt)
      : runnerBasePromptString;

  // cm:edge contract -> packages/core/src/jobs/prior-attempts.ts — spliced HERE, at dispatch, not by `buildJobPromptString` at enqueue: `retry.ts` copies the parent's `payload.promptString` verbatim, so a block added at enqueue time would describe the parent's own attempt rather than the one that just failed
  const runnerPromptString =
    resume.isRetry && resumedPromptString
      ? injectAfterInvocation(
          resumedPromptString,
          renderPriorAttemptsBlock(await loadPriorAttempts(job), job.attempts),
        )
      : resumedPromptString;

  await persistPromptSnapshot({
    jobId: job.id,
    systemPrompt: runnerSystemPrompt,
    userPrompt: runnerPromptString ?? '',
    blocks: runnerBlocks,
    model: runnerStageOverrides.model ?? job.modelTier ?? 'default',
  });
  const result = await adapter.dispatch({
    job: {
      id: job.id,
      projectId: job.projectId,
      issueId: job.issueId,
      createdBy: job.createdBy,
      type: job.type,
      // cm:why the overrides and the resume id ride on `payload` rather than as top-level fields because the claude-code adapter forwards `payload` verbatim; a top-level field would need lifting on the adapter side to reach the runner at all.
      payload: buildDispatchPayload(job.payload, runnerStageOverrides, resume.priorClaudeSessionId),
      promptString: runnerPromptString,
      systemPrompt: runnerSystemPrompt,
      dispatchedAt,
      attempts: job.attempts,
      agentSessionId,
    },
    runner,
  });

  if (result.status === 'failed') {
    // Adapter dispatch failure: the runner returned an explicit error from its
    // claim/spawn path. CAS-flip the job to `failed` and route through the
    // shared finalize tail (ISS-393) so it gets the same verify-first retry
    // (device-rotated onto a fresh runner) or, when the budget is exhausted,
    // parks the issue at `waiting` + reaps the run — never a silent no-op.
    const errorReason = result.errorReason ?? 'adapter dispatch failed';
    const [updated] = await applyKernelTransition(db, {
      entity: 'job',
      to: 'failed',
      set: {
        finishedAt: new Date(),
        error: errorReason,
        // ISS-450 — adapter dispatch failures are environment problems by
        // construction (claim/spawn path); flag for review since no classifier
        // pattern matched a structured cause.
        failureKind: 'infra',
        failureReason: errorReason,
        failureMeta: { needsReview: true } as never,
        classifierVersion: CLASSIFIER_VERSION,
      },
      where: and(eq(jobs.id, job.id), eq(jobs.status, 'dispatched'), eq(jobs.runnerId, runner.id)),
      fromStatus: 'dispatched',
      reason: errorReason,
      actor: { type: 'system' },
      source: 'dispatcher',
    });
    await db
      .update(runners)
      .set({ lastError: errorReason, updatedAt: new Date() })
      .where(eq(runners.id, runner.id));
    if (updated) {
      try {
        await finalizeFailedJob(updated, { error: errorReason });
      } catch (err) {
        logger.error(
          { err, jobId: job.id, issueId: job.issueId },
          'dispatcher: finalizeFailedJob threw after adapter fail',
        );
      }
    }
    logger.warn(
      { jobId: job.id, runnerId: runner.id, reason: errorReason },
      'dispatcher: adapter failed, marked failed + finalized',
    );
    return 'skipped';
  }

  logger.info(
    { jobId: job.id, runnerId: runner.id, type: runner.type },
    'dispatcher: dispatched (runner path)',
  );
  // ISS-164 — a previously-gated job just admitted; refresh pipelineHealth
  // so the FE sees `waitingOn` clear within one round-trip instead of
  // waiting for the next sweep.
  if (job.issueId) {
    await publishPipelineHealthChanged(job.projectId, [job.issueId]);
  }
  return 'dispatched';
}

/**
 * ISS-198 — emit a `dispatch.gate_l5_runner_stale` Sentry breadcrumb + add a
 * sample to the `runner_death_detection_seconds` histogram for each candidate
 * runner whose heartbeat is stale at the moment the dispatcher tried to pick
 * one. Runs only when `selectRunnerForJob` returned null; we look up the
 * runners that would have matched and observe the gap between `now()` and
 * each one's `last_seen_at`. Runners that have never pinged (`last_seen_at`
 * IS NULL) emit the breadcrumb without a histogram sample.
 */
async function maybeRecordL5Skip(
  projectId: string,
  jobId: string,
  fallbackChain: RunnerType[],
): Promise<void> {
  try {
    const candidates = await db.execute<{
      id: string;
      last_seen_at: Date | string | null;
      type: string;
    }>(sql`
      SELECT id, last_seen_at, type
      FROM runners
      WHERE project_id = ${projectId}
        AND status IN ('online', 'offline')
    `);
    const filtered =
      fallbackChain.length === 0
        ? candidates
        : candidates.filter((r) => (fallbackChain as string[]).includes(r.type));
    if (filtered.length === 0) return;
    for (const c of filtered) {
      const lastSeenMs = c.last_seen_at ? new Date(c.last_seen_at).getTime() : null;
      const lastSeenAgoMs = lastSeenMs === null ? null : Date.now() - lastSeenMs;
      if (isSentryEnabled()) {
        Sentry.addBreadcrumb({
          category: 'dispatch.gate_l5_runner_stale',
          level: 'info',
          message: `runner ${c.id} stale (lastSeenAgoMs=${lastSeenAgoMs ?? 'null'})`,
          data: { runnerId: c.id, lastSeenAgo: lastSeenAgoMs, jobId },
        });
      }
      if (lastSeenAgoMs !== null) {
        recordRunnerDeathDetection(lastSeenAgoMs / 1000);
      }
    }
  } catch (err) {
    logger.debug(
      { err, jobId, projectId },
      'dispatcher: maybeRecordL5Skip telemetry failed (non-fatal)',
    );
  }
}

// cm:guard 0.5 is pg-boss's own floor (`MIN_POLLING_INTERVAL_MS`), and only these three DISPATCH queues get it — the five maintenance queues (stale-detector, retention, memory-decay, memory-candidates, device-prune) keep the 2000ms default, where a cron waking a second late costs nothing and four times the queue queries buys nothing.
// cm:why measured 2026-08-25 on the device-runner E2E: at the 2000ms default, enqueue to `job.assigned` took 1418/1554/1667/1716ms — a mean ~1s of pure poll wait before dispatch work begins. At 0.5 it is 191/217/802ms. That hop is nearly all of the `request -> running-pipeline-issue` metric, which is one dispatch rather than a whole pipeline.
const WORKER_OPTS = { batchSize: 1, pollingIntervalSeconds: 0.5 } as const;

/**
 * Create the queue and start one worker on it, returning pg-boss's worker id.
 *
 * `label` appears in the handler-threw log line and is the only thing that
 * differed between the three registrations besides the queue and the handler.
 */
// cm:guard rethrow after logging. pg-boss decides retry/dead-letter from whether the handler threw, so swallowing here turns a failed dispatch into a job pg-boss believes it delivered — silently dropped rather than retried.
async function startDispatchWorker(
  queue: string,
  label: string,
  handler: (message: DispatchMessage) => Promise<unknown>,
  extraOpts: Record<string, unknown> = {},
): Promise<string> {
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions; the runtime contract (createQueue before work, handler receives an array) is stable.
  const b = boss as any;
  await b.createQueue(queue);
  const id = await b.work(
    queue,
    { ...WORKER_OPTS, ...extraOpts },
    // biome-ignore lint/suspicious/noExplicitAny: pg-boss handler arg type varies across versions
    async (arg: any) => {
      for (const entry of Array.isArray(arg) ? arg : [arg]) {
        const data = entry?.data as DispatchMessage | undefined;
        if (!data || typeof data.jobId !== 'string') continue;
        try {
          await handler(data);
        } catch (err) {
          logger.error({ err, jobId: data.jobId }, `${label}: handler threw`);
          throw err;
        }
      }
    },
  );
  return id as string;
}

export async function registerDispatcher(): Promise<void> {
  if (workerId) return;
  workerId = await startDispatchWorker(JOB_QUEUE_NAME, 'dispatcher', handleDispatch);
}

export async function unregisterDispatcher(): Promise<void> {
  if (!workerId) return;
  const id = workerId;
  workerId = null;
  // biome-ignore lint/suspicious/noExplicitAny: see startDispatchWorker above.
  await (boss as any).offWork(id);
}

export function isDispatcherRegistered(): boolean {
  return workerId !== null;
}

export async function registerPmDispatcher(): Promise<void> {
  if (pmWorkerId) return;
  // cm:why teamSize/teamConcurrency=1 caps in-flight PM work per process at one, mirroring the per-project DB cap from `jobs_pm_per_project_unique_idx`; the index is the source of truth and this is defence in depth
  pmWorkerId = await startDispatchWorker(PM_QUEUE_NAME, 'pm-dispatcher', handlePmDispatch, {
    teamSize: 1,
    teamConcurrency: 1,
  });
}

export async function unregisterPmDispatcher(): Promise<void> {
  if (!pmWorkerId) return;
  const id = pmWorkerId;
  pmWorkerId = null;
  // biome-ignore lint/suspicious/noExplicitAny: see startDispatchWorker above.
  await (boss as any).offWork(id);
}

export function isPmDispatcherRegistered(): boolean {
  return pmWorkerId !== null;
}

// cm:edge contract -> packages/core/src/jobs/enqueue.ts#enqueueReconcileJob — separate queue so a reconcile backlog never stalls coder dispatch (ISS-801, BLOCKER E).
export async function registerReconcileDispatcher(): Promise<void> {
  if (reconcileWorkerId) return;
  reconcileWorkerId = await startDispatchWorker(
    RECONCILE_QUEUE_NAME,
    'reconcile-dispatcher',
    handleDispatch,
  );
}

export async function unregisterReconcileDispatcher(): Promise<void> {
  if (!reconcileWorkerId) return;
  const id = reconcileWorkerId;
  reconcileWorkerId = null;
  // biome-ignore lint/suspicious/noExplicitAny: see registerDispatcher above.
  await (boss as any).offWork(id);
}

export function isReconcileDispatcherRegistered(): boolean {
  return reconcileWorkerId !== null;
}
