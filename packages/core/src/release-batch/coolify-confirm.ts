import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { releaseAttempts } from '../db/schema-release-ledger.js';
import {
  buildClient,
  type CoolifyConfig,
  type CoolifySecrets,
} from '../integrations/deploy/index.js';
import {
  buildContextFromBinding,
  findBindingById,
  findConnectionById,
  findDeliveryById,
  recordDelivery,
} from '../integrations/index.js';
import { logger } from '../lib/logger.js';
import {
  closeRun,
  deployHoldsLocks,
  isCloseDeferred,
  RELEASE_DEPLOY_DONE_STEP,
  releaseDeployLocksForRun,
  resolveDeployGate,
  setCurrentStep,
  settleDeployTarget,
  targetHoldKey,
} from '../pipeline/index.js';
import { boss } from '../queue/boss.js';
import { INTEGRATIONS_QUEUE_NAME } from '../queue/names.js';
import { resolveReleaseChannels } from './channel.js';
import { enqueueCoolifyHealthGate, healthGateFor } from './coolify-health-gate.js';
import { deploymentConfirms, readLiveState } from './verify.js';

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
  /** Set once Coolify has reported this deployment failed, while that report is held against
   *  what the target serves. */
  failureReported?: { status: string; at: string };
}

const POLL_INTERVAL_SECONDS = 20;

/**
 * How long Coolify's failure report is held against what the target serves before it is believed.
 * Coolify has reported `failed` two seconds into a deployment that went on to build and serve its
 * commit (deployment h888sk8c0s0coscwo4kg00s0, release 0.4.0-dev.27), so the status field alone
 * cannot fail a run where the target's own identity can still answer.
 */
const CONTESTED_FAILURE_WINDOW_MS = 10 * 60_000;

const SUCCESS_STATUSES = new Set(['finished', 'success', 'succeeded', 'completed']);
const FAILURE_STATUSES = new Set(['failed', 'error', 'cancelled', 'canceled', 'cancelled-by-user']);

type DeploymentVerdict = 'succeeded' | 'failed' | 'pending';

/**
 * What one poll actually did. Returned rather than only logged so the caller —
 * and a test — can read the decision instead of inferring it from which
 * collaborator got called.
 */
interface ConfirmOutcome {
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
function classifyDeploymentStatus(status: string | null | undefined): DeploymentVerdict {
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
  await boss.send(INTEGRATIONS_QUEUE_NAME, job, {
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
    if (verdict === 'failed') {
      return contestFailure(data, binding.projectId, String(dep.status), dep.commit ?? null);
    }
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
      const left = Math.max(0, Math.round(healthGate.remainingMs / 1000));
      logger.error(
        {
          bindingId: data.bindingId,
          runId: data.runId,
          deploymentUuid: data.deploymentUuid,
          targetLabel: data.targetLabel,
          remainingMs: healthGate.remainingMs,
        },
        'coolify confirm: the build finished too close to its confirmation deadline to health-check it — settling it failed, since nothing proved it serves',
      );
      return settle(
        data,
        'failed',
        `health gate could not run: ${left}s left on the confirmation deadline, too short for the container's grace period, so this deploy is not proven to serve`,
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

/** What the target serves, read through the probes its project declares for this binding. */
type ServedReading =
  | { kind: 'read'; identity: string | null; readings: string[] }
  | { kind: 'unreadable'; why: string };

async function readServed(projectId: string, bindingId: string): Promise<ServedReading> {
  const channel = (await resolveReleaseChannels(projectId)).find((c) => c.bindingId === bindingId);
  if (!channel?.verify) {
    return {
      kind: 'unreadable',
      why: `binding ${bindingId} declares no runtime probe that reports the commit it serves`,
    };
  }
  const live = await readLiveState(channel.verify);
  return { kind: 'read', identity: live.identity, readings: live.readings };
}

/**
 * Coolify said the deployment failed. Believe it only once what the target serves agrees: a
 * target serving the deployment's own commit settles it succeeded, naming the contradiction; one
 * still serving something else is re-read until the contested window closes, then fails naming
 * both readings; one nothing can read fails at once, as the report alone says.
 */
async function contestFailure(
  data: CoolifyConfirmJob,
  projectId: string,
  status: string,
  commit: string | null,
): Promise<ConfirmOutcome> {
  const reported = data.failureReported ?? { status, at: new Date().toISOString() };
  const said = `coolify reported deployment ${data.deploymentUuid} \`${status}\` at ${reported.at}`;
  if (!commit)
    return settle(data, 'failed', `${said}, and named no commit to compare the target with`);

  let served: ServedReading;
  try {
    served = await readServed(projectId, data.bindingId);
  } catch (err) {
    served = { kind: 'unreadable', why: err instanceof Error ? err.message : String(err) };
  }
  if (served.kind === 'unreadable') return settle(data, 'failed', `${said}; ${served.why}`);

  if (served.identity !== null && deploymentConfirms(commit, served.identity)) {
    const detail = `${said}, but the target serves its commit ${commit} (${served.readings.join('; ')}), so the deploy is serving`;
    logger.warn(
      { runId: data.runId, deploymentUuid: data.deploymentUuid, detail },
      'coolify confirm: a failure report the target contradicts',
    );
    return settle(data, 'succeeded', detail);
  }

  const until = Math.min(
    Date.parse(reported.at) + CONTESTED_FAILURE_WINDOW_MS,
    Date.parse(data.deadlineAt),
  );
  const serving = `the target serves ${served.identity ?? 'no agreed commit'} (${served.readings.join('; ')}), not ${commit}`;
  if (Date.now() >= until) {
    return settle(data, 'failed', `${said}, and at ${new Date().toISOString()} ${serving}`);
  }
  if (!data.failureReported) {
    logger.warn(
      { runId: data.runId, deploymentUuid: data.deploymentUuid, status, commit },
      'coolify confirm: Coolify reported a failure — holding it against what the target serves before failing the run',
    );
  }
  await enqueueCoolifyConfirm({ ...data, failureReported: reported });
  return {
    settled: null,
    closedRun: false,
    detail: `${said}; ${serving}; re-read until ${new Date(until).toISOString()}`,
  };
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
type DeploySettlementTarget = Pick<
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
  await settleDeployAttempt(data.runId, data.deliveryId, data.bindingId, holds);

  // ISS-1279 — the environment is free once nothing of this run is still reaching it, and this
  // target's own recorded hold is the evidence that the record can answer that at all. Absent, the
  // deploy was never witnessed and its siblings are unknown, so the expiry ends the hold instead.
  // One target failing does not stop the siblings Coolify is still building, so the run going
  // terminal is not the moment. By run id, so a run that took no lock frees nothing and one whose
  // hold was reclaimed cannot free its successor.
  const witnessed = holds[targetHoldKey(data.deliveryId)];
  const stillReaching = Object.values(holds).some((h) => h.status === 'pending');
  if (witnessed && !stillReaching) {
    await releaseDeployLocksForRun(data.runId, deployHoldsLocks(holds));
  }

  if (verdict === 'failed') {
    const why = detail ?? 'the deploy settled failed with no detail recorded';
    logger.error(
      { runId: data.runId, deploymentUuid: data.deploymentUuid, detail: why },
      'coolify confirm: deploy failed — failing the run',
    );
    await closeRun(data.runId, 'failed', {
      code: 'deploy_failed',
      detail: `deploy of target \`${data.targetLabel}\` (deployment ${data.deploymentUuid}) failed: ${why}`,
    });
    return { settled: 'failed', closedRun: 'failed', detail: why };
  }

  const gate = resolveDeployGate(holds);
  if (gate.verdict !== 'clear') return { settled: 'succeeded', closedRun: false };

  await setCurrentStep(data.runId, RELEASE_DEPLOY_DONE_STEP);
  if (!(await isCloseDeferred(data.runId))) return { settled: 'succeeded', closedRun: false };
  await closeRun(data.runId, 'completed');
  return { settled: 'succeeded', closedRun: 'completed' };
}

/**
 * The run's `deploy` attempt for this binding, settled once every target it dispatched has: failed
 * if any did. The attempt is keyed by the dispatch's request id, and each target's delivery by
 * that id and the target, so the delivery's request id is what finds it.
 */
async function settleDeployAttempt(
  runId: string,
  deliveryId: string,
  bindingId: string,
  holds: Awaited<ReturnType<typeof settleDeployTarget>>,
): Promise<void> {
  const mine = Object.values(holds).filter((h) => h.bindingId === bindingId);
  if (mine.some((h) => h.status === 'pending')) return;
  const delivery = await findDeliveryById(deliveryId);
  if (!delivery?.requestId) {
    logger.error(
      { runId, deliveryId, bindingId },
      'coolify confirm: the delivery carries no request id, so no deploy attempt can be settled from it',
    );
    return;
  }
  const failed = mine.filter((h) => h.status === 'failed');
  const reason = (failed.length > 0 ? failed : mine)
    .map((h) => `${h.targetLabel}: ${h.detail ?? h.status}`)
    .join('; ');
  await db
    .update(releaseAttempts)
    .set({
      settledAt: new Date(),
      verdict: failed.length > 0 ? 'failed' : 'ok',
      verdictReason: reason,
    })
    .where(
      and(
        eq(releaseAttempts.runId, runId),
        eq(releaseAttempts.stage, 'deploy'),
        isNull(releaseAttempts.settledAt),
        sql`starts_with(${delivery.requestId}, ${releaseAttempts.idempotencyKey} || ':')`,
      ),
    );
}
