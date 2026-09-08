/**
 * ISS-922 — reading a deploy's outcome back out of Coolify, because Coolify
 * cannot tell us.
 *
 * Coolify's `SendWebhookJob` posts with no headers and no signature
 * (`Http::withOptions(...)->post($url, $payload)`), so the inbound contract
 * `/in/:slug` enforces — a provider event header plus an HMAC — is one Coolify
 * can never satisfy. That path was removed rather than repaired; this poller
 * replaces it, and unlike a webhook it also works for a deploy nobody told
 * Forge about in advance.
 *
 * One `coolify.confirm` job per deploy TARGET polls
 * `GET /api/v1/deployments/{uuid}` until it reports terminal or the hold's
 * deadline passes. Every terminal read writes an inbound-direction delivery
 * row, so the audit log carries both directions again — this time from a
 * source that exists.
 */

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

// cm:guard these two sets must stay DISJOINT and must not grow a catch-all: a status this module cannot classify is polled again, and polling forever is exactly what the deadline is for. A Coolify status nobody listed here resolves as unconfirmed-at-deadline, which is loud, rather than as success, which would be the original defect wearing a new name.
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
    // cm:guard the dedup key must move with every re-poll — pg-boss drops a `send` whose singletonKey is already in flight, so a fixed key here silently makes the FIRST poll the only one and every deploy resolves at its deadline.
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
    // cm:guard a read failure is NOT a deploy failure — Coolify may not have written the row yet, and turning an unreachable API into a failed deploy would fail runs whose deploy succeeded. The deadline is what bounds this branch.
    verdict = 'pending';
    detail = err instanceof Error ? err.message : 'unknown error';
    logger.debug(
      { err, deploymentUuid: data.deploymentUuid, bindingId: data.bindingId },
      'coolify confirm: deployment read failed — will re-poll until the deadline',
    );
  }

  if (verdict === 'succeeded') {
    // cm:guard Coolify's `finished` is a verdict on the BUILD, never on what the build does — the pg-boss 10→12 crash-loop reported finished with no port ever open (ISS-971). A target that declares a health URL is proven by reading the running application, so this poller records the build and hands the hold on rather than clearing it.
    const healthGate = healthGateFor({
      config: ctx.config,
      bindingId: data.bindingId,
      runId: data.runId,
      deliveryId: data.deliveryId,
      deploymentUuid: data.deploymentUuid,
      targetLabel: data.targetLabel,
      forRollback: false,
      notAfter: data.deadlineAt,
    });
    if (healthGate.kind === 'gate') {
      await recordDeployDelivery(data, 'succeeded', detail);
      await enqueueCoolifyHealthGate(healthGate.job, { startAfterSeconds: 0 });
      return { settled: null, closedRun: false, handedToHealthGate: true };
    }
    if (healthGate.kind === 'window-too-short') {
      // cm:guard the reason travels ON THE RECORD, not only into the log — this hold settles `succeeded` and stamps `release.deploy.done` like a proven deploy, so without the detail the only trace that nothing read the running application is a log line nobody queries.
      detail = `health gate skipped: ${Math.max(0, Math.round(healthGate.remainingMs / 1000))}s left on the confirmation deadline, too short to give the container its grace period — this deploy is NOT proven to serve`;
      // cm:guard settle on the build verdict here and SAY the gate did not run — the remaining window is too short to give the container its grace period, so a gate opened on it would take one reading of a booting process and roll a healthy deploy back. An unproven deploy is the state before this gate existed; a rolled-back healthy one is a new outage.
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
// cm:edge lockstep -> packages/core/src/pipeline/runs.ts — `gatedOutcome` defers a close and records it; this is the only thing that ever performs the deferred close. Change one side's contract and a deferred run waits for a sweeper instead.
export async function applyDeploySettlement(
  data: DeploySettlementTarget,
  verdict: Exclude<DeploymentVerdict, 'pending'>,
  detail?: string,
): Promise<ConfirmOutcome> {
  if (!data.runId) {
    // cm:why ISS-922 requirement 3 — a deployment with no run to advance is recorded and said out loud rather than dropped, because silent is how the original defect looked.
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
  // cm:guard close ONLY when a close was already deferred — a run whose other jobs are still going has not finished, and closing it on the deploy's success would end the run early.
  if (!(await isCloseDeferred(data.runId))) return { settled: 'succeeded', closedRun: false };
  await closeRun(data.runId, 'completed');
  return { settled: 'succeeded', closedRun: 'completed' };
}
