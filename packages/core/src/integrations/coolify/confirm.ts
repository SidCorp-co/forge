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

/**
 * Write the inbound audit row, mark the hold, and — when this was the last
 * unresolved hold — perform the close the gate deferred.
 */
// cm:edge lockstep -> packages/core/src/pipeline/runs.ts — `gatedOutcome` defers a close and records it; this is the only thing that ever performs the deferred close. Change one side's contract and a deferred run waits for a sweeper instead.
async function settle(
  data: CoolifyConfirmJob,
  verdict: Exclude<DeploymentVerdict, 'pending'>,
  detail?: string,
): Promise<ConfirmOutcome> {
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
