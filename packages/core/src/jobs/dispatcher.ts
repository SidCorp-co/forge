import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { devices, jobs, projects, runners } from '../db/schema.js';
import { publishPipelineHealthChanged } from '../issues/pipeline-health.js';
import type { JobType, RunnerType } from '../db/schema.js';
import { buildPipelinePreambleStructured } from '../lib/chat-preamble.js';
import { dispatchLivenessMs, isLastSeenFresh } from '../lib/dispatch-liveness.js';
import { isEnabled } from '../lib/feature-flags.js';
import { logger } from '../logger.js';
import { setManualHoldBlock } from '../pipeline/manual-hold.js';
import { resolveRunnerChainForJob } from '../pipeline/resolve-step-runner.js';
import { boss } from '../queue/boss.js';
import { getRunnerAdapter } from '../runners/registry.js';
import { selectRunnerForJob } from '../runners/select.js';
import type { RequiredCapabilities } from '../runners/types.js';
import { deviceRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';
import { getActiveDeviceId } from './active-device.js';
import { ensureAgentSessionForJob } from './agent-session-link.js';
import {
  checkLayer4RunnerFull,
  runnerSupportsJobType,
} from './dispatch-gates.js';
import { persistPromptSnapshot } from './prompt-snapshot.js';
import { JOB_QUEUE_NAME, PM_QUEUE_NAME } from './queue-name.js';
import { injectTurnLevelRules } from '../prompt/user.js';
import { findPriorSessionInGroup } from './session-resume.js';
import { resolveStageOverrides, type StageOverrides } from './stage-overrides.js';

interface DispatchMessage {
  jobId: string;
}

let workerId: string | null = null;
let pmWorkerId: string | null = null;

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

  if (isEnabled('runnerFramework')) {
    return dispatchViaRunner(job);
  }
  return dispatchViaDevice(job);
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
  return dispatchViaRunner(job, { pm: true }, ['claude-code']);
}

async function dispatchViaDevice(job: typeof jobs.$inferSelect): Promise<'dispatched' | 'skipped'> {
  const deviceId = await getActiveDeviceId(job.projectId);
  if (!deviceId) {
    logger.warn(
      { jobId: job.id, projectId: job.projectId },
      'dispatcher: no active device, leaving queued',
    );
    return 'skipped';
  }

  const [device] = await db.select().from(devices).where(eq(devices.id, deviceId)).limit(1);
  if (!device) {
    logger.warn({ jobId: job.id, deviceId }, 'dispatcher: active device not found, leaving queued');
    return 'skipped';
  }
  if (device.status !== 'online') {
    logger.warn(
      { jobId: job.id, deviceId, status: device.status },
      'dispatcher: device offline, leaving queued',
    );
    return 'skipped';
  }
  // Belt-and-braces against a stale `online` flag — stale-detector lags
  // up to 2min, but a missed liveness window means no worker will claim.
  if (!isLastSeenFresh(device.lastSeenAt)) {
    logger.warn(
      {
        jobId: job.id,
        deviceId,
        lastSeenAt: device.lastSeenAt,
        livenessMs: dispatchLivenessMs(),
      },
      'dispatcher: device heartbeat stale, leaving queued',
    );
    return 'skipped';
  }

  const dispatchedAt = new Date();
  const updated = await db
    .update(jobs)
    .set({ status: 'dispatched', deviceId, dispatchedAt })
    .where(and(eq(jobs.id, job.id), eq(jobs.status, 'queued')))
    .returning({ id: jobs.id });

  if (updated.length === 0) {
    logger.debug({ jobId: job.id }, 'dispatcher: lost race to another dispatcher');
    return 'skipped';
  }

  const repoPath = await loadRepoPath(job.projectId);
  const agentSessionId = await ensureAgentSessionForJob(
    { ...job, status: 'dispatched', deviceId, dispatchedAt },
    { repoPath },
  );

  const legacyPayload = (job.payload ?? {}) as { promptString?: unknown } & Record<string, unknown>;
  const legacyPromptString =
    typeof legacyPayload.promptString === 'string' ? legacyPayload.promptString : null;
  const stageOverrides = await resolveStageOverrides(job.projectId, job.payload);
  const { content: systemPrompt, blocks } = await buildPipelinePreambleStructured(
    job.projectId,
    stageOverrides.systemPrompt,
  );

  // PR-5 — resume prior CLI session in the same sessionGroup.
  let legacyPriorClaudeSessionId: string | null = null;
  if (stageOverrides.sessionGroup && job.issueId) {
    const prior = await findPriorSessionInGroup({
      issueId: job.issueId,
      sessionGroup: stageOverrides.sessionGroup,
    });
    if (prior) legacyPriorClaudeSessionId = prior.claudeSessionId;
  }

  // PR-5 fallback — embed system prompt redundantly in user prompt when
  // resuming, so the agent sees the state's rules even if CLI ignores
  // --append-system-prompt on --resume. See dispatchViaRunner for context.
  const legacyEffectivePromptString =
    legacyPriorClaudeSessionId && legacyPromptString
      ? injectTurnLevelRules(legacyPromptString, systemPrompt)
      : legacyPromptString;

  await persistPromptSnapshot({
    jobId: job.id,
    systemPrompt,
    userPrompt: legacyEffectivePromptString ?? '',
    blocks,
    model: stageOverrides.model ?? job.modelTier ?? 'default',
  });
  roomManager.publish(deviceRoom(deviceId), {
    event: 'job.assigned',
    data: {
      jobId: job.id,
      projectId: job.projectId,
      issueId: job.issueId,
      type: job.type,
      payload: job.payload,
      promptString: legacyEffectivePromptString,
      systemPrompt,
      // PR-4 — per-state dispatch overrides forwarded to runner.
      ...buildOverridesPayload(stageOverrides),
      // PR-5 — resume the prior session's claudeSessionId when this stage
      // belongs to a sessionGroup with a completed prior run.
      ...(legacyPriorClaudeSessionId ? { claudeSessionId: legacyPriorClaudeSessionId } : {}),
      dispatchedAt: dispatchedAt.toISOString(),
      agentSessionId,
    },
  });

  logger.info({ jobId: job.id, deviceId }, 'dispatcher: dispatched (legacy device path)');
  // ISS-164 — see runner-path comment below.
  if (job.issueId) {
    await publishPipelineHealthChanged(job.projectId, [job.issueId]);
  }
  return 'dispatched';
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
    const agentConfig = (project?.agentConfig ?? {}) as Record<string, unknown>;
    fallbackChain = resolveRunnerChainForJob(job.type, agentConfig);
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

  const runner = await selectRunnerForJob({
    projectId: job.projectId,
    requiredCapabilities: required,
    fallbackChain,
    pinDeviceId,
  });
  if (!runner) {
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
  if (
    job.type !== 'pm' &&
    !runnerSupportsJobType(runner.type as RunnerType, job.type as JobType)
  ) {
    const errorMsg = `runner_unsupported_type:${runner.type}`;
    await db
      .update(jobs)
      .set({
        status: 'failed',
        error: errorMsg,
        failureKind: 'permanent',
        failureReason: errorMsg,
      })
      .where(eq(jobs.id, job.id));
    logger.warn(
      { jobId: job.id, runnerType: runner.type, jobType: job.type },
      'dispatcher: runner does not support job type, failing permanently',
    );
    return 'skipped';
  }

  // L4 — runner-cap check after we've picked a runner. We don't pre-filter
  // full runners in selectRunnerForJob to keep its signature simple; if a
  // runner is full we just skip and the next tick will retry. No persisted
  // gate state — the picker will skip this candidate if/when it remains
  // ineligible (sibling job in flight) on the next sweep.
  const l4 = await checkLayer4RunnerFull(runner.id, { excludeJobId: job.id });
  if (!l4.pass) {
    logger.info(
      {
        jobId: job.id,
        runnerId: runner.id,
        hint: l4.hint,
      },
      'dispatcher: runner full, leaving queued',
    );
    return 'skipped';
  }

  const dispatchedAt = new Date();
  const updated = await db
    .update(jobs)
    .set({
      status: 'dispatched',
      runnerId: runner.id,
      // Mirror to deviceId for backwards-compat with consumers reading the
      // legacy column. Antigravity-remote runners have deviceId=null so this
      // remains null in that case.
      deviceId: runner.deviceId,
      dispatchedAt,
    })
    .where(and(eq(jobs.id, job.id), eq(jobs.status, 'queued')))
    .returning({ id: jobs.id });

  if (updated.length === 0) {
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
  const runnerStageOverrides = preDispatchOverrides;
  const { content: runnerSystemPrompt, blocks: runnerBlocks } =
    await buildPipelinePreambleStructured(job.projectId, runnerStageOverrides.systemPrompt);

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
    // Adapter dispatch failure is a strong signal: the runner returned an
    // explicit error from its claim/spawn path. Mark the job failed and
    // surface to operator via setManualHoldBlock — auto-retry would just
    // spawn another adapter call against the same broken state.
    const errorReason = result.errorReason ?? 'adapter dispatch failed';
    await db
      .update(jobs)
      .set({
        status: 'failed',
        finishedAt: new Date(),
        error: errorReason,
        failureKind: 'unknown',
        failureReason: errorReason,
        classifierVersion: 1,
      })
      .where(and(eq(jobs.id, job.id), eq(jobs.status, 'dispatched'), eq(jobs.runnerId, runner.id)));
    await db
      .update(runners)
      .set({ lastError: errorReason, updatedAt: new Date() })
      .where(eq(runners.id, runner.id));
    if (job.issueId) {
      try {
        await setManualHoldBlock({
          issueId: job.issueId,
          context: {
            step: job.type,
            trigger: 'adapter_error',
            classification: {
              kind: 'unknown',
              reason: errorReason,
              evidence: { jobId: job.id, runnerId: runner.id, runnerType: runner.type },
            },
            attempts: job.attempts,
            lastFailureAt: new Date().toISOString(),
            suggestedActions: ['resume', 'skip-step', 'close'],
          },
        });
      } catch (err) {
        logger.error(
          { err, jobId: job.id, issueId: job.issueId },
          'dispatcher: setManualHoldBlock threw after adapter fail',
        );
      }
    }
    logger.warn(
      { jobId: job.id, runnerId: runner.id, reason: errorReason },
      'dispatcher: adapter failed, marked failed + operator-blocked',
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
