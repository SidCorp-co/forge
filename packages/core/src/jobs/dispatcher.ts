import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, jobs, projects, runners } from '../db/schema.js';
import type { JobType, RunnerType } from '../db/schema.js';
import { applyEpodsystemMcpServers } from '../integrations/epodsystem/resolver.js';
import { applyPostmanMcpServers } from '../integrations/postman/resolver.js';
import { applySentryMcpServers } from '../integrations/sentry/resolver.js';
import { isIntegrationSentinelName } from '../pipeline/mcp-catalog.js';
import { publishPipelineHealthChanged } from '../issues/pipeline-health.js';
import { buildPipelinePreambleStructured } from '../lib/chat-preamble.js';
import { applyKernelTransition } from '../lifecycle/transition.js';
import { logger } from '../logger.js';
import {
  recordDispatchBarrierSkip,
  recordResumeBoundFresh,
  recordRunnerDeathDetection,
} from '../observability/hold-metrics.js';
import { Sentry, isSentryEnabled } from '../observability/sentry.js';
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
import { JOB_QUEUE_NAME, PM_QUEUE_NAME } from './queue-name.js';
import { readAutoRetryPayload } from './retry.js';
import {
  estimateGroupContextTokens,
  findPriorSessionInGroup,
  loadResumeBounds,
} from './session-resume.js';
import {
  type StageOverrides,
  escalateModel,
  resolveProjectDefaultMcpServers,
  resolveStageOverrides,
} from './stage-overrides.js';

interface DispatchMessage {
  jobId: string;
}

let workerId: string | null = null;
let pmWorkerId: string | null = null;

/**
 * ISS-581 — belt-and-suspenders sweep: after integration resolvers run, delete
 * any remaining `true` sentinel for a known integration name. The resolvers
 * already strip their own sentinels; this catches a declared-but-no-active-
 * integration case so a bogus `true` never reaches the runner payload.
 */
function sweepIntegrationSentinels(
  map: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!map) return map;
  let dirty = false;
  for (const [k, v] of Object.entries(map)) {
    if (v === true && isIntegrationSentinelName(k)) {
      dirty = true;
      break;
    }
  }
  if (!dirty) return map;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(map)) {
    if (v === true && isIntegrationSentinelName(k)) continue;
    out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * ISS-581 — when both playwright and chrome-devtools-mcp are present in the
 * merged map, drop playwright in favour of chrome-devtools-mcp (the preferred
 * browser MCP for pipeline jobs). Operates on the map in place (shallow copy
 * is already owned by the caller); returns the (possibly mutated) map.
 */
function dedupeBrowserServers(
  map: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!map) return map;
  if (map.playwright && map['chrome-devtools-mcp']) {
    const { playwright: _dropped, ...rest } = map;
    return rest;
  }
  return map;
}

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
    await applyKernelTransition(db, {
      entity: 'job',
      to: 'failed',
      set: {
        finishedAt: new Date(),
        failureKind: 'code',
        failureReason: 'monthly_budget_exhausted',
        failureMeta: {
          spent: budgetCheck.spent,
          budget: budgetCheck.budget,
          stageStatus: budgetCheck.stageStatus,
        } as never,
        classifierVersion: 1,
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
    // Defensive: a non-PM job should never land on this queue. Skip rather
    // than dispatch via the PM-only path.
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
  if (preDispatchOverrides.sessionGroup && job.issueId) {
    const prior = await findPriorSessionInGroup({
      issueId: job.issueId,
      sessionGroup: preDispatchOverrides.sessionGroup,
    });
    if (prior) {
      priorClaudeSessionId = prior.claudeSessionId;
      pinDeviceId = prior.deviceId;
    }
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
      logger.warn({ err, jobId: job.id, issueId: job.issueId }, 'dispatcher: failed to read reopenCount, treating as 0');
    }
    const overTokens = bounds.maxResumeTokens > 0 && estTokens > bounds.maxResumeTokens;
    const overCycles = bounds.maxResumeReopenCycles > 0 && reopenCount > bounds.maxResumeReopenCycles;
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
  });
  if (!runner) {
    // ISS-198 — selectRunnerForJob filters runners with stale heartbeats
    // (Gate L5). When no runner is selectable, observe the worst stale
    // candidate so the runner_death_detection_seconds histogram captures
    // the time between worker death and dispatcher reaction. If the project
    // simply has no runners at all there's nothing to observe; that's a
    // configuration condition rather than a worker death.
    await maybeRecordL5Skip(job.projectId, job.id, fallbackChain);
    logger.warn(
      { jobId: job.id, projectId: job.projectId, fallbackChain },
      'dispatcher: no runner online, leaving queued',
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
  const runnerStageOverrides = { ...preDispatchOverrides };
  // ISS-535 — reopen-driven escalation. When an issue was reopened from
  // review/test (`reopenCount >= 1`), bump the `fix`/`review` job up the model
  // tier ladder so the retry runs on a stronger model (ECC upgrade-on-failure).
  // Mutate ONLY the shallow copy (never preDispatchOverrides / EMPTY), and keep
  // it best-effort: a DB hiccup must not crash dispatch (mirror loadStageMap).
  if (job.issueId && (job.type === 'fix' || job.type === 'review')) {
    try {
      const [issueRow] = await db
        .select({ reopenCount: issues.reopenCount })
        .from(issues)
        .where(eq(issues.id, job.issueId))
        .limit(1);
      const reopenCount = issueRow?.reopenCount ?? 0;
      if (reopenCount > 0) {
        runnerStageOverrides.model = escalateModel(runnerStageOverrides.model, reopenCount);
      }
    } catch (err) {
      logger.warn(
        { err, jobId: job.id, issueId: job.issueId, type: job.type },
        'dispatcher: reopenCount escalation lookup failed, dispatching without model bump',
      );
    }
  }
  // Project-default MCP servers are the BASE of the merge: load + expand
  // `pipelineConfig.mcpServers` (catalog shorthand → full specs) and lay the
  // per-state `mcpServers` ON TOP (a per-state entry overrides the default by
  // server name). Both maps are already fresh clones (expandMcpServers returns
  // a new object; resolveStageOverrides shallow-clones the per-state map), so
  // this assignment cannot pollute the cached drizzle row or the EMPTY
  // singleton. Integration servers (postman/epodsystem) then layer on top
  // below, unchanged. Net order: project-default < per-state < integrations.
  const projectDefaultMcpServers = await resolveProjectDefaultMcpServers(job.projectId);
  // ISS-623 W2 — the truthy sentinel names declared BEFORE the merge/expand/
  // integration-resolve chain runs, so we can diff them against what actually
  // made it into the final map and surface anything that silently dropped.
  const declaredMcpNames = new Set<string>([
    ...projectDefaultMcpServers.declaredNames,
    ...(runnerStageOverrides.declaredNames ?? []),
  ]);
  if (
    Object.keys(projectDefaultMcpServers.servers).length > 0 ||
    runnerStageOverrides.mcpServers !== null
  ) {
    runnerStageOverrides.mcpServers = {
      ...projectDefaultMcpServers.servers,
      ...(runnerStageOverrides.mcpServers ?? {}),
    };
  }
  // ISS-336 — inject the project's Postman MCP entry (when an active postman
  // integration exists) into the per-project mcpServers override on EVERY
  // dispatch: project-default, all stages, not pinned to one. The API key is
  // rendered only into this dispatch payload (the runner writes it to a temp
  // --mcp-config file); it is never persisted. active=false/deleted → the
  // resolver returns null and the next dispatch drops the entry.
  runnerStageOverrides.mcpServers = await applyPostmanMcpServers(
    job.projectId,
    runnerStageOverrides.mcpServers,
  );
  // ISS-387 — chain the Epodsystem MCP inject right after Postman. Same
  // contract: active-only resolver, non-mutating merge, crmk_ key only in the
  // dispatch payload. active=false/deleted → next dispatch drops the entry.
  runnerStageOverrides.mcpServers = await applyEpodsystemMcpServers(
    job.projectId,
    runnerStageOverrides.mcpServers,
  );
  // ISS-524 — chain the Sentry MCP inject right after Epodsystem. Same contract:
  // active-only resolver, non-mutating merge, sntryu_ token only in the dispatch
  // payload. active=false/deleted → next dispatch drops the entry.
  runnerStageOverrides.mcpServers = await applySentryMcpServers(
    job.projectId,
    runnerStageOverrides.mcpServers,
  );
  // ISS-581 — (1) sentinel sweep: drop any leftover `true` for integration
  // names (declared but no active integration); (2) browser dedup: prefer
  // chrome-devtools-mcp over playwright when both are present.
  runnerStageOverrides.mcpServers = sweepIntegrationSentinels(runnerStageOverrides.mcpServers);
  const beforeBrowserDedupe = new Set(Object.keys(runnerStageOverrides.mcpServers ?? {}));
  runnerStageOverrides.mcpServers = dedupeBrowserServers(runnerStageOverrides.mcpServers);
  // ISS-623 W2 — diff the declared sentinel names against what actually
  // resolved. `playwright` dropped ONLY via the browser dedup (both it and
  // chrome-devtools-mcp resolved, and chrome-devtools-mcp won) is an
  // intentional preference, not a failure to resolve — exclude it so the
  // agent isn't warned about a server it never needed.
  const resolvedMcpNames = new Set(Object.keys(runnerStageOverrides.mcpServers ?? {}));
  const playwrightDedupedNotDropped =
    beforeBrowserDedupe.has('playwright') && !resolvedMcpNames.has('playwright');
  const droppedMcpNames = [...declaredMcpNames].filter(
    (name) =>
      !resolvedMcpNames.has(name) && !(name === 'playwright' && playwrightDedupedNotDropped),
  );
  const { content: runnerSystemPrompt, blocks: runnerBlocks } =
    await buildPipelinePreambleStructured(job.projectId, {
      step: job.type,
      override: runnerStageOverrides.systemPrompt,
      mcpDiagnostics: { resolved: [...resolvedMcpNames], dropped: droppedMcpNames },
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
        failureKind: 'infra',
        failureReason: errorReason,
        failureMeta: { needsReview: true } as never,
        classifierVersion: 3,
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

export async function registerDispatcher(): Promise<void> {
  if (workerId) return;
  // pg-boss v10 requires explicit createQueue before work().
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).createQueue(JOB_QUEUE_NAME);
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions; the runtime contract (handler receives an array) is stable.
  const id = (await (boss as any).work(JOB_QUEUE_NAME, { batchSize: 1 }, async (arg: any) => {
    const entries = Array.isArray(arg) ? arg : [arg];
    for (const entry of entries) {
      const data = entry?.data as DispatchMessage | undefined;
      if (!data || typeof data.jobId !== 'string') continue;
      try {
        await handleDispatch(data);
      } catch (err) {
        logger.error({ err, jobId: data.jobId }, 'dispatcher: handler threw');
        throw err;
      }
    }
  })) as string;
  workerId = id;
}

export async function unregisterDispatcher(): Promise<void> {
  if (!workerId) return;
  const id = workerId;
  workerId = null;
  // biome-ignore lint/suspicious/noExplicitAny: see registerDispatcher above.
  await (boss as any).offWork(id);
}

export function isDispatcherRegistered(): boolean {
  return workerId !== null;
}

export async function registerPmDispatcher(): Promise<void> {
  if (pmWorkerId) return;
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).createQueue(PM_QUEUE_NAME);
  // teamSize/teamConcurrency=1 caps in-flight PM work per process at one,
  // matching the per-project DB-level cap from `jobs_pm_per_project_unique_idx`.
  // The DB index is the source of truth; this is defence-in-depth.
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  const id = (await (boss as any).work(
    PM_QUEUE_NAME,
    { batchSize: 1, teamSize: 1, teamConcurrency: 1 },
    // biome-ignore lint/suspicious/noExplicitAny: pg-boss handler arg type varies across versions
    async (arg: any) => {
      const entries = Array.isArray(arg) ? arg : [arg];
      for (const entry of entries) {
        const data = entry?.data as DispatchMessage | undefined;
        if (!data || typeof data.jobId !== 'string') continue;
        try {
          await handlePmDispatch(data);
        } catch (err) {
          logger.error({ err, jobId: data.jobId }, 'pm-dispatcher: handler threw');
          throw err;
        }
      }
    },
  )) as string;
  pmWorkerId = id;
}

export async function unregisterPmDispatcher(): Promise<void> {
  if (!pmWorkerId) return;
  const id = pmWorkerId;
  pmWorkerId = null;
  // biome-ignore lint/suspicious/noExplicitAny: see registerPmDispatcher above.
  await (boss as any).offWork(id);
}

export function isPmDispatcherRegistered(): boolean {
  return pmWorkerId !== null;
}
