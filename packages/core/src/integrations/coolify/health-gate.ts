import { INTEGRATIONS_QUEUE_NAME } from '../../jobs/queue-name.js';
import { logger } from '../../logger.js';
import { boss } from '../../queue/boss.js';
import { recordDelivery } from '../deliveries.js';
import type { CoolifyConfig, CoolifyTarget } from './types.js';

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

export const HEALTH_GRACE_MS = 45_000;
export const HEALTH_WINDOW_MS = 5 * 60_000;
const HEALTH_POLL_INTERVAL_SECONDS = 15;
const HEALTH_PROBE_TIMEOUT_MS = 10_000;

export type HealthReading = { healthy: true } | { healthy: false; reason: string };

/**
 * One reading of the running application.
 */
export async function probeHealth(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<HealthReading> {
  const target = new URL(url);
  target.searchParams.set('_forge_cb', String(Date.now()));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_PROBE_TIMEOUT_MS);
  try {
    const res = await fetchImpl(target, {
      headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
      redirect: 'follow',
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) return { healthy: false, reason: `http ${res.status}` };
    return readBody(text);
  } catch (err) {
    return {
      healthy: false,
      reason: `unreachable (${err instanceof Error ? err.message : 'unknown error'})`,
    };
  } finally {
    clearTimeout(timer);
  }
}

function readBody(text: string): HealthReading {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { healthy: false, reason: 'http 200 with an unparseable body' };
  }
  if (typeof body !== 'object' || body === null) {
    return { healthy: false, reason: 'http 200 with a non-object body' };
  }
  const obj = body as Record<string, unknown>;
  if (obj.ok === true) return { healthy: true };
  const down = Object.entries(obj)
    .filter(([, v]) => typeof v === 'object' && v !== null && (v as { ok?: unknown }).ok === false)
    .map(([k]) => k);
  return {
    healthy: false,
    reason: down.length > 0 ? `ok:false (${down.join(', ')} down)` : 'ok:false',
  };
}

export async function enqueueCoolifyHealthGate(
  job: CoolifyHealthGateJob,
  opts: { startAfterSeconds?: number } = {},
): Promise<void> {
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss send signature varies
  await (boss as any).send(INTEGRATIONS_QUEUE_NAME, job, {
    retryLimit: 3,
    retryBackoff: true,
    startAfter: opts.startAfterSeconds ?? HEALTH_POLL_INTERVAL_SECONDS,
    singletonKey: `health:${job.deploymentUuid}:${Date.now()}`,
  });
}

/** The target of a binding by id, or `null` when the config no longer holds it. */
export function findTarget(config: CoolifyConfig | null, targetId: string): CoolifyTarget | null {
  return (config?.targets ?? []).find((t) => t.id === targetId) ?? null;
}

/**
 * Whether this deployment gets a health gate, and when it does not, why.
 */
export type HealthGateDecision =
  | { kind: 'gate'; job: CoolifyHealthGateJob }
  | { kind: 'not-declared' }
  | { kind: 'window-too-short'; remainingMs: number };

/**
 * The shortest window worth opening: the grace period the container is owed,
 * plus room for more than one reading inside it.
 */
export const HEALTH_MIN_WINDOW_MS = HEALTH_GRACE_MS + 60_000;

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

export interface HealthGateOutcome {
  /** `null` while the window is open and another poll is queued. */
  verdict: 'healthy' | 'unhealthy' | null;
  reason?: string;
}

export interface HealthGateDeps {
  probe: (url: string) => Promise<HealthReading>;
  /** Settle the deploy hold this gate deferred — `confirm.ts` owns the write. */
  settle: (verdict: 'succeeded' | 'failed', detail?: string) => Promise<void>;
  now?: () => number;
}

/**
 * Poll one deployment's health once: settle it, fail it, or queue the next poll.
 */
export async function runCoolifyHealthGate(
  data: CoolifyHealthGateJob,
  deps: HealthGateDeps,
): Promise<HealthGateOutcome> {
  const now = deps.now ?? Date.now;
  if (now() < new Date(data.graceUntil).getTime()) {
    await enqueueCoolifyHealthGate(data);
    return { verdict: null };
  }

  const reading = await deps.probe(data.healthUrl);
  if (reading.healthy) {
    await deps.settle('succeeded');
    return { verdict: 'healthy' };
  }

  if (now() < new Date(data.deadlineAt).getTime()) {
    await enqueueCoolifyHealthGate(data);
    return { verdict: null, reason: reading.reason };
  }

  return failGate(data, reading.reason, deps);
}

/**
 * The window closed with no healthy reading: record which deploy failed and on
 * what signal, page, and fail the hold.
 */
async function failGate(
  data: CoolifyHealthGateJob,
  reason: string,
  deps: HealthGateDeps,
): Promise<HealthGateOutcome> {
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
  await deps.settle('failed', detail);
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
