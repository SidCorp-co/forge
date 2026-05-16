import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { devices, jobs, projects, runners } from '../db/schema.js';
import type { JobType, RunnerType } from '../db/schema.js';
import { dispatchLivenessMs, isLastSeenFresh } from '../lib/dispatch-liveness.js';
import { isEnabled } from '../lib/feature-flags.js';
import { logger } from '../logger.js';
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
  checkLayer1IssueBusy,
  checkLayer2Dependencies,
  checkLayer3ProjectFull,
  checkLayer4RunnerFull,
  type GateResult,
  markJobGated,
  runnerSupportsJobType,
} from './dispatch-gates.js';
import { JOB_QUEUE_NAME, PM_QUEUE_NAME } from './queue-name.js';

interface DispatchMessage {
  jobId: string;
}

let workerId: string | null = null;
let pmWorkerId: string | null = null;

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
  roomManager.publish(deviceRoom(deviceId), {
    event: 'job.assigned',
    data: {
      jobId: job.id,
      projectId: job.projectId,
      issueId: job.issueId,
      type: job.type,
      payload: job.payload,
      promptString: legacyPromptString,
      dispatchedAt: dispatchedAt.toISOString(),
      agentSessionId,
    },
  });

  logger.info({ jobId: job.id, deviceId }, 'dispatcher: dispatched (legacy device path)');
  return 'dispatched';
}

/**
 * Centralised "gate failed → leave queued" path. Records the cause on the
 * job row (canonical signal for queued-watchdog) and returns 'skipped' so
 * the caller short-circuits.
 */
async function reportGateSkip(
  jobId: string,
  result: GateResult,
  layer: 'L1' | 'L2' | 'L3' | 'L4',
): Promise<'skipped'> {
  if (result.pass) return 'skipped'; // unreachable but keeps the type narrow
  await markJobGated(jobId, result.reason, result.hint, result.metadata);
  logger.info(
    {
      jobId,
      layer,
      reason: result.reason,
      hint: result.hint,
    },
    'dispatcher: gate failed, leaving queued',
  );
  return 'skipped';
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
  // ISS-40 PR-E — pre-runner-selection gates. PM jobs (issueId=null) bypass
  // L1+L2 since they are project-scoped coordinators governed by the
  // existing `jobs_pm_per_project_unique_idx`. Layer 3 is also a no-op for
  // PM (it counts agent_sessions with issueId, PM sessions don't have one).
  const isPm = job.type === 'pm';
  if (!isPm && job.issueId) {
    // The pipeline pre-creates `agent_sessions` for issue-driven jobs and
    // links via `job.agent_session_id`. Exclude that row so a single queued
    // session doesn't self-trip the gate.
    const l1Opts: { excludeJobId: string; excludeSessionId?: string } = {
      excludeJobId: job.id,
    };
    if (job.agentSessionId) l1Opts.excludeSessionId = job.agentSessionId;
    const l1 = await checkLayer1IssueBusy(job.issueId, l1Opts);
    if (!l1.pass) return reportGateSkip(job.id, l1, 'L1');

    const l2 = await checkLayer2Dependencies(job.issueId, job.type);
    if (!l2.pass) return reportGateSkip(job.id, l2, 'L2');
  }
  if (!isPm && job.issueId) {
    // Skip L3 for non-PM jobs without an issueId: the gate's "exclude
    // candidate's own issue from the running count" logic only works when
    // we have a candidateIssueId to exclude. Such jobs are rare (PM is the
    // designed bypass) but typing allows them; treat as PASS rather than
    // applying a one-stricter cap.
    const l3 = await checkLayer3ProjectFull(job.projectId, job.issueId);
    if (!l3.pass) return reportGateSkip(job.id, l3, 'L3');
  }

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

  const runner = await selectRunnerForJob({
    projectId: job.projectId,
    requiredCapabilities: required,
    fallbackChain,
  });
  if (!runner) {
    logger.warn(
      { jobId: job.id, projectId: job.projectId, fallbackChain },
      'dispatcher: no runner online, leaving queued',
    );
    // Surface the no-runner state on the job row so queued-watchdog and
    // Sentry breadcrumb explain why the job is sitting in queued. Uses
    // `runner_full` as the canonical skip reason; the hint narrates the
    // real cause for operator log greps.
    await markJobGated(job.id, 'runner_full', 'no online runner', {
      fallbackChain,
    });
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
  // runner is full we just skip and the next tick will retry.
  const l4 = await checkLayer4RunnerFull(runner.id, { excludeJobId: job.id });
  if (!l4.pass) return reportGateSkip(job.id, l4, 'L4');

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
      // Clear gate state — dispatch succeeded.
      gateReason: null,
      gateAt: null,
      gateMetadata: null,
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
  const runnerPromptString =
    typeof runnerPayload.promptString === 'string' ? runnerPayload.promptString : null;
  const result = await adapter.dispatch({
    job: {
      id: job.id,
      projectId: job.projectId,
      issueId: job.issueId,
      type: job.type,
      payload: job.payload,
      promptString: runnerPromptString,
      dispatchedAt,
      agentSessionId,
    },
    runner,
  });

  if (result.status === 'failed') {
    // Revert: put the job back on the queue so retry/stale logic can act.
    // Conditional WHERE prevents stomping on a concurrent lifecycle update
    // (e.g. /jobs/:id/complete fired in the meantime). Use SQL `attempts + 1`
    // so the increment is computed against the current row, not the stale read.
    await db
      .update(jobs)
      .set({
        status: 'queued',
        runnerId: null,
        deviceId: null,
        dispatchedAt: null,
        error: result.errorReason ?? 'adapter dispatch failed',
        attempts: sql`${jobs.attempts} + 1`,
      })
      .where(and(eq(jobs.id, job.id), eq(jobs.status, 'dispatched'), eq(jobs.runnerId, runner.id)));
    // Also flag the runner as last-error for surface visibility.
    await db
      .update(runners)
      .set({ lastError: result.errorReason ?? 'dispatch failed', updatedAt: new Date() })
      .where(eq(runners.id, runner.id));
    logger.warn(
      { jobId: job.id, runnerId: runner.id, reason: result.errorReason },
      'dispatcher: adapter failed, requeued',
    );
    return 'skipped';
  }

  logger.info(
    { jobId: job.id, runnerId: runner.id, type: runner.type },
    'dispatcher: dispatched (runner path)',
  );
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
