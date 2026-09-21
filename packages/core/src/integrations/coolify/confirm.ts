import { INTEGRATIONS_QUEUE_NAME } from '../../jobs/queue-name.js';
import { logger } from '../../logger.js';
import {
  isCloseDeferred,
  resolveDeployGate,
  settleDeployTarget,
} from '../../pipeline/deploy-confirmations.js';
import { closeRun, RELEASE_DEPLOY_DONE_STEP, setCurrentStep } from '../../pipeline/runs.js';
import { boss } from '../../queue/boss.js';
import { recordDelivery } from '../deliveries.js';
import { buildContextFromBinding, findBindingById, findConnectionById } from '../store.js';
import { enqueueCoolifyHealthGate, healthGateFor } from './health-gate.js';
import { buildClient } from './log-fetch.js';
import type { CoolifyConfig, CoolifySecrets } from './types.js';

export interface CoolifyConfirmJob {
  jobKind: 'coolify.confirm';
  bindingId: string;
  /** `null` for a run-less resource redeploy — polled and audited, advances no run. */
  runId: string | null;
  deliveryId: string;
  deploymentUuid: string;
  targetLabel: string;
  /** ISO-8601. Past this, an unconfirmed deploy is a failure, never a wait. */
  deadlineAt: string;
}

const POLL_INTERVAL_SECONDS = 20;

const SUCCESS_STATUSES = new Set(['finished', 'success', 'succeeded', 'completed']);
const FAILURE_STATUSES = new Set(['failed', 'error', 'cancelled', 'canceled', 'cancelled-by-user']);

export type DeploymentVerdict = 'succeeded' | 'failed' | 'pending';

/**
 * What one poll actually did. Returned rather than only logged so the caller —
 * and a test — can read the decision instead of inferring it from which
 * collaborator got called.
 */
export interface ConfirmOutcome {
  /** `null` while the deployment is non-terminal and another poll is queued. */
  settled: 'succeeded' | 'failed' | null;
  /** Whether this poll wrote the run's terminal status. */
  closedRun: false | 'completed' | 'failed';
  /**
   * The build finished and a health gate now owns the hold. Distinct from a
   * bare `settled: null`, which means this poller queued another poll.
   */
  handedToHealthGate?: true;
  detail?: string;
}

/** Classify one `GET /deployments/{uuid}` status string. */
export function classifyDeploymentStatus(status: string | null | undefined): DeploymentVerdict {
  if (!status) return 'pending';
  const s = status.toLowerCase().trim();
  if (SUCCESS_STATUSES.has(s)) return 'succeeded';
  if (FAILURE_STATUSES.has(s)) return 'failed';
  return 'pending';
}

export async function enqueueCoolifyConfirm(
  job: CoolifyConfirmJob,
  opts: { startAfterSeconds?: number } = {},
): Promise<void> {
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss send signature varies
  await (boss as any).send(INTEGRATIONS_QUEUE_NAME, job, {
    retryLimit: 3,
    retryBackoff: true,
    startAfter: opts.startAfterSeconds ?? POLL_INTERVAL_SECONDS,
    singletonKey: `${job.deliveryId}:${Date.now()}`,
  });
}

/**
 * Poll one deployment once, and either settle it or schedule the next poll.
 */
export async function runCoolifyConfirm(data: CoolifyConfirmJob): Promise<ConfirmOutcome> {
  const binding = await findBindingById(data.bindingId);
  const connection = binding ? await findConnectionById(binding.connectionId) : null;
  if (!binding || !connection) {
    return settle(data, 'failed', 'integration binding or connection is gone');
  }

  const ctx = buildContextFromBinding<CoolifyConfig, CoolifySecrets>({ binding, connection });
  let verdict: DeploymentVerdict;
  let detail: string | undefined;
  try {
    const dep = await buildClient(ctx).getDeployment(data.deploymentUuid);
    verdict = classifyDeploymentStatus(dep.status);
    if (verdict === 'failed') detail = `coolify reported ${dep.status}`;
  } catch (err) {
    verdict = 'pending';
    detail = err instanceof Error ? err.message : 'unknown error';
    logger.debug(
      { err, deploymentUuid: data.deploymentUuid, bindingId: data.bindingId },
      'coolify confirm: deployment read failed — will re-poll until the deadline',
    );
  }

  if (verdict === 'succeeded') {
    const healthGate = healthGateFor({
      config: ctx.config,
      bindingId: data.bindingId,
      runId: data.runId,
      deliveryId: data.deliveryId,
      deploymentUuid: data.deploymentUuid,
      targetLabel: data.targetLabel,
      notAfter: data.deadlineAt,
    });
    if (healthGate.kind === 'gate') {
      await recordDeployDelivery(data, 'succeeded', detail);
      await enqueueCoolifyHealthGate(healthGate.job, { startAfterSeconds: 0 });
      return { settled: null, closedRun: false, handedToHealthGate: true };
    }
    if (healthGate.kind === 'window-too-short') {
      detail = `health gate skipped: ${Math.max(0, Math.round(healthGate.remainingMs / 1000))}s left on the confirmation deadline, too short to give the container its grace period — this deploy is NOT proven to serve`;
      logger.error(
        {
          bindingId: data.bindingId,
          runId: data.runId,
          deploymentUuid: data.deploymentUuid,
          targetLabel: data.targetLabel,
          remainingMs: healthGate.remainingMs,
        },
        "coolify confirm: the build finished too close to its confirmation deadline to health-check it — settling on Coolify's verdict, this deploy is NOT proven to serve",
      );
    }
  }

  if (verdict !== 'pending') return settle(data, verdict, detail);

  if (Date.now() >= new Date(data.deadlineAt).getTime()) {
    return settle(
      data,
      'failed',
      `unconfirmed at deadline${detail ? ` (last read: ${detail})` : ''}`,
    );
  }

  await enqueueCoolifyConfirm(data);
  return { settled: null, closedRun: false, ...(detail ? { detail } : {}) };
}

/** Write the inbound audit row, then settle the hold it reports on. */
async function settle(
  data: CoolifyConfirmJob,
  verdict: Exclude<DeploymentVerdict, 'pending'>,
  detail?: string,
): Promise<ConfirmOutcome> {
  await recordDeployDelivery(data, verdict, detail);
  return applyDeploySettlement(data, verdict, detail);
}

/** The inbound audit row for one deployment's outcome. */
async function recordDeployDelivery(
  data: Pick<CoolifyConfirmJob, 'bindingId' | 'deploymentUuid' | 'targetLabel'>,
  verdict: Exclude<DeploymentVerdict, 'pending'>,
  detail?: string,
): Promise<void> {
  await recordDelivery({
    bindingId: data.bindingId,
    direction: 'inbound',
    eventName: verdict === 'succeeded' ? 'deploy.succeeded' : 'deploy.failed',
    payload: {
      source: 'poll',
      deployment_uuid: data.deploymentUuid,
      status: verdict,
      targetLabel: data.targetLabel,
      ...(detail ? { detail } : {}),
    },
    requestId: data.deploymentUuid,
    status: 'ok',
  });
}

/** What one target's settled outcome does to its run. */
export type DeploySettlementTarget = Pick<
  CoolifyConfirmJob,
  'bindingId' | 'runId' | 'deliveryId' | 'deploymentUuid' | 'targetLabel'
>;

/**
 * Mark the hold and — when this was the last unresolved one — perform the
 * close the dispatcher deferred. Exported because a health gate settles the
 * hold this poller handed it, and there is still exactly ONE writer of that
 * decision.
 */
export async function applyDeploySettlement(
  data: DeploySettlementTarget,
  verdict: Exclude<DeploymentVerdict, 'pending'>,
  detail?: string,
): Promise<ConfirmOutcome> {
  if (!data.runId) {
    logger[verdict === 'failed' ? 'error' : 'info'](
      {
        bindingId: data.bindingId,
        deploymentUuid: data.deploymentUuid,
        targetLabel: data.targetLabel,
        verdict,
        detail,
      },
      'coolify confirm: deployment resolved with no pipeline run to advance',
    );
    return { settled: verdict, closedRun: false, ...(detail ? { detail } : {}) };
  }

  const holds = await settleDeployTarget({
    runId: data.runId,
    deliveryId: data.deliveryId,
    status: verdict,
    ...(detail ? { detail } : {}),
  });

  if (verdict === 'failed') {
    logger.error(
      { runId: data.runId, deploymentUuid: data.deploymentUuid, detail },
      'coolify confirm: deploy failed — failing the run',
    );
    await closeRun(data.runId, 'failed');
    return { settled: 'failed', closedRun: 'failed', ...(detail ? { detail } : {}) };
  }

  const gate = resolveDeployGate(holds);
  if (gate.verdict !== 'clear') return { settled: 'succeeded', closedRun: false };

  await setCurrentStep(data.runId, RELEASE_DEPLOY_DONE_STEP);
  if (!(await isCloseDeferred(data.runId))) return { settled: 'succeeded', closedRun: false };
  await closeRun(data.runId, 'completed');
  return { settled: 'succeeded', closedRun: 'completed' };
}
