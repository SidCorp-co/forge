import { type CoolifyConfig, probeHealth } from '../integrations/coolify/index.js';
import { recordDelivery } from '../integrations/index.js';
import { logger } from '../observability/logger.js';
import { boss } from '../queue/boss.js';
import { INTEGRATIONS_QUEUE_NAME } from '../queue/names.js';
import { applyDeploySettlement } from './coolify-confirm.js';

export interface CoolifyHealthGateJob {
  jobKind: 'coolify.health-gate';
  bindingId: string;
  /** `null` for a run-less redeploy — probed and audited, advances no run. */
  runId: string | null;
  /** The delivery whose hold this gate settles; `null` for a run-less redeploy. */
  deliveryId: string | null;
  deploymentUuid: string;
  targetId: string;
  targetLabel: string;
  healthUrl: string;
  /** ISO-8601. No reading before this counts. */
  graceUntil: string;
  /** ISO-8601. Past this with no healthy reading, the deploy has failed. */
  deadlineAt: string;
}

const HEALTH_GRACE_MS = 45_000;
const HEALTH_WINDOW_MS = 5 * 60_000;
const HEALTH_POLL_INTERVAL_SECONDS = 15;

export async function enqueueCoolifyHealthGate(
  job: CoolifyHealthGateJob,
  opts: { startAfterSeconds?: number } = {},
): Promise<void> {
  await boss.send(INTEGRATIONS_QUEUE_NAME, job, {
    retryLimit: 3,
    retryBackoff: true,
    startAfter: opts.startAfterSeconds ?? HEALTH_POLL_INTERVAL_SECONDS,
    singletonKey: `health:${job.deploymentUuid}:${Date.now()}`,
  });
}

/**
 * Whether this deployment gets a health gate, and when it does not, why.
 */
type HealthGateDecision =
  | { kind: 'gate'; job: CoolifyHealthGateJob }
  | { kind: 'not-declared' }
  | { kind: 'window-too-short'; remainingMs: number };

/**
 * The shortest window worth opening: the grace period the container is owed,
 * plus room for more than one reading inside it.
 */
const HEALTH_MIN_WINDOW_MS = HEALTH_GRACE_MS + 60_000;

/** Build the gate job for a target that declares a health URL, or say why not. */
export function healthGateFor(args: {
  config: CoolifyConfig | null;
  bindingId: string;
  runId: string | null;
  deliveryId: string | null;
  deploymentUuid: string;
  /** Preferred over `targetLabel` — a `coolify.confirm` job has only the label. */
  targetId?: string;
  targetLabel: string;
  /** The confirmation hold's own deadline; the gate may never outlive it. */
  notAfter?: string;
  now?: number;
}): HealthGateDecision {
  const targets = args.config?.targets ?? [];
  const target = args.targetId
    ? targets.find((t) => t.id === args.targetId)
    : targets.find((t) => t.label === args.targetLabel);
  const healthUrl = target?.healthUrl;
  if (!target || !healthUrl) return { kind: 'not-declared' };
  const now = args.now ?? Date.now();
  const limit = args.notAfter ? Date.parse(args.notAfter) : Number.POSITIVE_INFINITY;
  const remainingMs = limit - now;
  if (Number.isNaN(remainingMs) || remainingMs < HEALTH_MIN_WINDOW_MS) {
    return { kind: 'window-too-short', remainingMs };
  }
  const deadline = Math.min(now + HEALTH_GRACE_MS + HEALTH_WINDOW_MS, limit);
  return {
    kind: 'gate',
    job: {
      jobKind: 'coolify.health-gate',
      bindingId: args.bindingId,
      runId: args.runId,
      deliveryId: args.deliveryId,
      deploymentUuid: args.deploymentUuid,
      targetId: target.id,
      targetLabel: target.label,
      healthUrl,
      graceUntil: new Date(now + HEALTH_GRACE_MS).toISOString(),
      deadlineAt: new Date(deadline).toISOString(),
    },
  };
}

interface HealthGateOutcome {
  /** `null` while the window is open and another poll is queued. */
  verdict: 'healthy' | 'unhealthy' | null;
  reason?: string;
}

/** Settle the deploy hold this gate deferred — `coolify-confirm.ts` owns the write. */
async function settle(
  data: CoolifyHealthGateJob,
  verdict: 'succeeded' | 'failed',
  detail?: string,
): Promise<void> {
  if (!data.deliveryId) return;
  await applyDeploySettlement({ ...data, deliveryId: data.deliveryId }, verdict, detail);
}

/**
 * Poll one deployment's health once: settle it, fail it, or queue the next poll.
 */
export async function runCoolifyHealthGate(data: CoolifyHealthGateJob): Promise<HealthGateOutcome> {
  if (Date.now() < new Date(data.graceUntil).getTime()) {
    await enqueueCoolifyHealthGate(data);
    return { verdict: null };
  }

  const reading = await probeHealth(data.healthUrl);
  if (reading.healthy) {
    await settle(data, 'succeeded');
    return { verdict: 'healthy' };
  }

  if (Date.now() < new Date(data.deadlineAt).getTime()) {
    await enqueueCoolifyHealthGate(data);
    return { verdict: null, reason: reading.reason };
  }

  return failGate(data, reading.reason);
}

/**
 * The window closed with no healthy reading: record which deploy failed and on
 * what signal, page, and fail the hold.
 */
async function failGate(data: CoolifyHealthGateJob, reason: string): Promise<HealthGateOutcome> {
  const detail = `never became healthy within ${Math.round(HEALTH_WINDOW_MS / 1000)}s — last reading: ${reason}`;

  await recordGateFailure(data, 'deploy.unhealthy', detail);
  logger.error(
    {
      bindingId: data.bindingId,
      deploymentUuid: data.deploymentUuid,
      targetLabel: data.targetLabel,
      healthUrl: data.healthUrl,
      detail,
    },
    'coolify health gate: the deploy never became healthy — the build that failed is still serving and NOTHING was rolled back; repair forward, or roll back by hand from the integration routes if that is the decision',
  );
  await settle(data, 'failed', detail);
  return { verdict: 'unhealthy', reason: detail };
}

/**
 * The inbound row saying this gate's window closed unhealthy.
 */
async function recordGateFailure(
  data: CoolifyHealthGateJob,
  eventName: 'deploy.unhealthy',
  detail: string,
): Promise<void> {
  try {
    await recordDelivery({
      bindingId: data.bindingId,
      direction: 'inbound',
      eventName,
      payload: {
        source: 'health-gate',
        deployment_uuid: data.deploymentUuid,
        targetLabel: data.targetLabel,
        healthUrl: data.healthUrl,
        detail,
      },
      requestId: `health:${data.deploymentUuid}`,
      status: 'failed',
    });
  } catch (err) {
    logger.error(
      { err, bindingId: data.bindingId, deploymentUuid: data.deploymentUuid, eventName, detail },
      'coolify health gate: could not write the unhealthy-deploy row — carrying on so the settle still happens',
    );
  }
}
