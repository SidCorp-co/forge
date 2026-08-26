import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import type { JobType, RunnerType } from '../db/schema.js';
import { issueLabels, issues, jobs, labels, projects, runners } from '../db/schema.js';
import { publishPipelineHealthChanged } from '../issues/pipeline-health.js';
import { buildPipelinePreambleStructured } from '../lib/chat-preamble.js';
import { applyKernelTransition } from '../lifecycle/transition.js';
import { logger } from '../logger.js';
import {
  recordDispatchBarrierSkip,
  recordResumeBoundFresh,
  recordRunnerDeathDetection,
} from '../observability/hold-metrics.js';
import { isSentryEnabled, Sentry } from '../observability/sentry.js';
import { AUTONOMOUS_JOB_TYPE } from '../pipeline/autonomous-mode.js';
import { classifyFailure, failureStamp } from '../pipeline/failure-classifier.js';
import { hooks } from '../pipeline/hooks.js';
import { resolveRunnerChainForJob } from '../pipeline/resolve-step-runner.js';
import { injectTurnLevelRules } from '../prompt/user.js';
import { boss } from '../queue/boss.js';
import { getRunnerAdapter } from '../runners/registry.js';
import { getTrippedDeviceIds, selectRunnerForJob } from '../runners/select.js';
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
import { persistPromptSnapshot } from './prompt-snapshot.js';
import { JOB_QUEUE_NAME, PM_QUEUE_NAME, RECONCILE_QUEUE_NAME } from './queue-name.js';
import { resolveJobMcpServers } from './resolve-job-mcp-servers.js';
import { readAutoRetryPayload } from './retry.js';
import {
  estimateGroupContextTokens,
  findPriorSessionInGroup,
  loadResumeBounds,
} from './session-resume.js';
import {
  applySkillMaintenanceCarveout,
  extractStageStatus,
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
  if (o.sessionGroup !== null) out.sessionGroup = o.sessionGroup;
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
        ...failureStamp('code', 'monthly_budget_exhausted', 'terminal'),
        failureMeta: {
          spent: budgetCheck.spent,
          budget: budgetCheck.budget,
          stageStatus: budgetCheck.stageStatus,
        } as never,
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
 * to `['claude-code']` — antigravity does not run PM in v0.1.
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

  // PR-5 — if this job belongs to a sessionGroup AND a prior session of the
  // same (issue, group) exists, pin selection to that device so the runner
  // can resume the same CLI session file. Source `sessionGroup` from the
  // per-state config resolver (same SoT as the legacy dispatchViaDevice
  // path) so the two paths can never disagree on the group name.
  const preDispatchOverrides = await resolveStageOverrides(job.projectId, job.payload);
  let priorClaudeSessionId: string | null = null;
  let pinDeviceId: string | null = null;
  const stagePool = preDispatchOverrides.deviceIds;
  // cm:guard a drive job must never inherit a staged step's CLI session: it resumes through `forge_phase` action `resume_point`, and --resume onto a stale triage session would hand the driver another step's transcript as its own history
  if (preDispatchOverrides.sessionGroup && job.issueId && job.type !== AUTONOMOUS_JOB_TYPE) {
    const prior = await findPriorSessionInGroup({
      issueId: job.issueId,
      sessionGroup: preDispatchOverrides.sessionGroup,
    });
    if (prior) {
      priorClaudeSessionId = prior.claudeSessionId;
      pinDeviceId = prior.deviceId;
    }
  }

  // cm:why the stage pool outranks the session-group resume pin: a resume is an optimisation, but "this stage ran on the box the operator pinned" is the guarantee the pool exists to make — so a prior session on an out-of-pool box loses BOTH the pin and the --resume (same shape as the stale-pin path below)
  if (stagePool && pinDeviceId && !stagePool.includes(pinDeviceId)) {
    logger.info(
      { jobId: job.id, pinDeviceId, stagePool, stageStatus: extractStageStatus(job.payload) },
      'dispatcher: session-group resume pin is outside the stage runner pool — dispatching fresh inside the pool',
    );
    pinDeviceId = null;
    priorClaudeSessionId = null;
  }

  // Compute isRetry here so the bound check below can skip the 3-query block
  // (+ metric/Sentry side effects) on retry dispatches — the retry path nulls
  // priorClaudeSessionId at its own site unconditionally.
  const isRetry = job.retryOf != null;

  // ISS-580 — bound check: if the accumulated context of the sessionGroup
  // exceeds the configured token limit, or the issue has been reopened more
  // than the cycle limit, drop the resume and dispatch fresh. Continuity is
  // preserved via the existing handoff/sessionContext mechanism (ISS-537).
  // Skip on retries — the retry block unconditionally nulls priorClaudeSessionId
  // anyway, so running this block on a retry is pure wasted work + spurious
  // resume_bound_fresh_total increments.
  if (!isRetry && priorClaudeSessionId && preDispatchOverrides.sessionGroup && job.issueId) {
    const bounds = await loadResumeBounds(job.projectId, cachedAgentConfig);
    const estTokens = await estimateGroupContextTokens({
      issueId: job.issueId,
      sessionGroup: preDispatchOverrides.sessionGroup,
    });
    let reopenCount = 0;
    try {
      const [issueRow] = await db
        .select({ reopenCount: issues.reopenCount })
        .from(issues)
        .where(eq(issues.id, job.issueId))
        .limit(1);
      reopenCount = issueRow?.reopenCount ?? 0;
    } catch (err) {
      logger.warn(
        { err, jobId: job.id, issueId: job.issueId },
        'dispatcher: failed to read reopenCount, treating as 0',
      );
    }
    const overTokens = bounds.maxResumeTokens > 0 && estTokens > bounds.maxResumeTokens;
    const overCycles =
      bounds.maxResumeReopenCycles > 0 && reopenCount > bounds.maxResumeReopenCycles;
    if (overTokens || overCycles) {
      const reason = overTokens ? ('tokens' as const) : ('reopen_cycles' as const);
      logger.info(
        {
          jobId: job.id,
          issueId: job.issueId,
          sessionGroup: preDispatchOverrides.sessionGroup,
          estTokens,
          reopenCount,
          maxResumeTokens: bounds.maxResumeTokens,
          maxResumeReopenCycles: bounds.maxResumeReopenCycles,
          reason,
        },
        'dispatcher: sessionGroup resume bound exceeded — dispatching fresh session',
      );
      recordResumeBoundFresh(reason);
      if (isSentryEnabled()) {
        Sentry.addBreadcrumb({
          category: 'pipeline.resume_bound',
          data: { reason, estTokens, reopenCount },
        });
      }
      priorClaudeSessionId = null;
      pinDeviceId = null;
    }
  }

  // Device selection splits cleanly into two cases (jobs/retry.ts owns the
  // retry side):
  //
  //   - FIRST dispatch (`job.retryOf == null`): keep the primary-pinned
  //     behaviour, plus the circuit breaker — skip devices whose runner is
  //     failing repeatedly so the first dispatch doesn't land on a known-bad
  //     device. The selector's wrap-around still probes a tripped device when
  //     EVERY device is tripped, so a single-device project never wedges.
  //
  //   - RETRY (`job.retryOf != null`): the uniform round-robin drives it. Pin
  //     the rotation `target`, exclude the devices already `done` this round,
  //     and set `skipPrimary` so no device gets preferential treatment. The
  //     circuit breaker is intentionally NOT applied here — the round-robin
  //     already cycles devices fairly, and layering the breaker on top would
  //     fight it (a device tripped after its 3 tries would be skipped for the
  //     rest of the chain instead of getting its turn next round).
  const autoRetry = readAutoRetryPayload(job.payload);
  // isRetry was hoisted above to gate the ISS-580 bound check block.

  let excludeDeviceIds: string[];
  let skipPrimary: boolean;
  if (isRetry) {
    skipPrimary = true;
    excludeDeviceIds = autoRetry.done;
    // Rotation moves devices on purpose → never resume a prior session.
    pinDeviceId = autoRetry.target;
    priorClaudeSessionId = null;
    // cm:why a rotation target computed before the pool was configured (or from a wider fleet) is dropped rather than honoured — selection then picks a standby INSIDE the pool instead of returning null and stalling the retry chain
    if (stagePool && pinDeviceId && !stagePool.includes(pinDeviceId)) pinDeviceId = null;
  } else {
    skipPrimary = false;
    const trippedDeviceIds = await getTrippedDeviceIds(job.projectId);
    excludeDeviceIds = trippedDeviceIds;
    if (trippedDeviceIds.length > 0) {
      logger.warn(
        { jobId: job.id, projectId: job.projectId, trippedDeviceIds },
        'dispatcher: device circuit breaker tripped — rotating away from failing device(s)',
      );
    }
    if (pinDeviceId && excludeDeviceIds.includes(pinDeviceId)) {
      pinDeviceId = null;
      priorClaudeSessionId = null;
    }
  }

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
    // cm:why the pool is named in the log because the two conditions are operationally different: an empty fleet is an outage, a busy/limited POOL is the configured price of pinning a stage — VISION No.10 forbids the second one reading as the first
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
    // cm:why ISS-812 — the classifier already owns this string (PERMANENT_PATTERNS), so the gate persists ITS verdict rather than hand-writing the kind: hand-writing left 17 kinetrak rows on 2026-08-20 with no action, no version and no finishedAt, unreadable to every action-keyed query
    const verdict = classifyFailure({ error: errorMsg });
    await applyKernelTransition(db, {
      entity: 'job',
      to: 'failed',
      set: {
        error: errorMsg,
        finishedAt: new Date(),
        ...failureStamp(verdict.kind, verdict.reason, verdict.action),
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

  // AUTHORITATIVE per-runner cap gate (the picker's L4 EXISTS is pool-coarse —
  // it only proves SOME runner is free, not that THIS selected runner is). When
  // maxConcurrentIssues>1 the load-aware selector usually avoids a full runner,
  // but a resume-pin to a busy host, or two ticks racing on the same free
  // runner, can still target one at capacity. Enforce it atomically: lock the
  // runner row (FOR UPDATE serializes concurrent dispatches to the same host),
  // recount orphan-aware in-flight under the lock, and only then claim the job.
  // This makes it IMPOSSIBLE to exceed RUNNER_CAP_PER_RUNNER regardless of race.
  // Mirror runner→deviceId for backwards-compat with consumers reading the
  // legacy column (antigravity-remote runners have deviceId=null → stays null).
  const dispatchedAt = new Date();
  const claim = await claimRunnerSlot({
    jobId: job.id,
    runnerId: runner.id,
    deviceId: runner.deviceId,
    dispatchedAt,
  });

  if (claim === 'runner_full') {
    // Selected runner filled up between pick and claim. Leave queued; the tick
    // excludes this job and tries the next candidate (no head-of-line block),
    // and a freed slot re-picks it on a later tick.
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

  const repoPath = await loadRepoPath(job.projectId);
  const agentSessionId = await ensureAgentSessionForJob(
    {
      ...job,
      status: 'dispatched',
      runnerId: runner.id,
      deviceId: runner.deviceId,
      dispatchedAt,
    },
    { repoPath },
  );

  const runnerPayload = (job.payload ?? {}) as { promptString?: unknown } & Record<string, unknown>;
  const runnerBasePromptString =
    typeof runnerPayload.promptString === 'string' ? runnerPayload.promptString : null;
  // Reuse the overrides we resolved before runner selection — saves one
  // round-trip to projects, and guarantees the sessionGroup we pinned on
  // matches the sessionGroup we forward to the runner.
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

  // PR-5 fallback — when resuming a prior CLI session via --resume, the CLI
  // may ignore --append-system-prompt (undocumented). Embed the state's
  // system prompt redundantly at the head of the user prompt so the agent
  // sees the right rules either way. No-op for fresh dispatches.
  const runnerPromptString =
    priorClaudeSessionId && runnerBasePromptString
      ? injectTurnLevelRules(runnerBasePromptString, runnerSystemPrompt)
      : runnerBasePromptString;

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
      type: job.type,
      // Surface stage overrides + claudeSessionId (PR-5 resume) on payload so
      // adapters that forward `payload` verbatim (claude-code) propagate them
      // to the runner.
      payload: {
        ...(job.payload ?? {}),
        ...buildOverridesPayload(runnerStageOverrides),
        ...(priorClaudeSessionId ? { claudeSessionId: priorClaudeSessionId } : {}),
      },
      promptString: runnerPromptString,
      systemPrompt: runnerSystemPrompt,
      dispatchedAt,
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
        ...failureStamp('infra', errorReason),
        failureMeta: { needsReview: true } as never,
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
