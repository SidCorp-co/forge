/**
 * ISS-971 — reading the DEPLOYED APPLICATION, because Coolify's verdict is
 * about the build and not about what the build does.
 *
 * On 2026-09-07 a pg-boss 10→12 bump crash-looped the forge-beta API for ~40
 * minutes. Coolify built the image, started the container and reported the
 * deployment `finished`; pg-boss v12 aborts at `start()` on a schema below 25,
 * beta sat at 24, and the process died before it ever opened its port. Every
 * signal Forge had said green, the proxy answered `no available server`, and a
 * human reverted it by hand.
 *
 * So a target that declares a `healthUrl` is not proven by `confirm.ts`. Its
 * hold stays pending, one `coolify.health-gate` job polls the running
 * application after a grace period, and a window that closes with no healthy
 * reading FAILS the deploy and pages.
 *
 * It used to restore the previous image itself. That is gone (ISS-1042): from
 * inside this gate a build that came up dead and an outage that predates it
 * read identically, and an automatic rollback answers both by deleting the
 * build somebody reviewed while the outage survives it. The same rule the
 * driver has run under since ISS-897 now holds here — repair forward, and where
 * you cannot, say so and stop. The capability is not gone, only the automatic
 * caller: `runCoolifyRollback` and `listCoolifyRollbackImages` are still reached
 * from `integrations/coolify-routes.ts`, where a person picks the image.
 */

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
// cm:guard a transport failure is a READING, not a missing one. The pg-boss crash-loop produced no HTTP response at all — connection refused, DNS failure and abort are the shape the incident actually had, so `unreachable` must count against the deadline exactly as a 503 does. Returning null here and skipping the tick would make the only failure this gate exists to catch invisible to it.
export async function probeHealth(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<HealthReading> {
  const target = new URL(url);
  // cm:why the cache-buster and the no-cache header both matter — the probe reads through whatever proxy fronts the app, and a cached 200 from the build that WAS healthy is the reading that would clear a dead deploy
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
    // cm:guard the dedup key must move with every re-poll, for the same reason `enqueueCoolifyConfirm`'s does — pg-boss drops a `send` whose singletonKey is already in flight, so a fixed key makes the first poll the only one and every gate resolves at its deadline.
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
// cm:guard `window-too-short` must NOT silently become a gate. Below the floor the gate degrades to a single probe taken after its own deadline, which fails a deploy whose container simply had not finished booting — the caller settles on the build verdict and says out loud that nothing was proven, because an unproven deploy is the pre-gate state and a rolled-back healthy one is a new outage.
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
  // cm:guard `targetId` wins where the caller has one. The label is the fallback because a `coolify.confirm` job carries only that, and it names one target only while `provider-schemas.ts` refuses a duplicate — a binding STORED with duplicates predates that rule, and there this reads the first match's health URL while stamping its id.
  const targets = args.config?.targets ?? [];
  const target = args.targetId
    ? targets.find((t) => t.id === args.targetId)
    : targets.find((t) => t.label === args.targetLabel);
  const healthUrl = target?.healthUrl;
  if (!target || !healthUrl) return { kind: 'not-declared' };
  const now = args.now ?? Date.now();
  // cm:guard the gate is SCHEDULED entirely inside the confirmation hold's own deadline, so `resolveDeployGate` cannot read the hold as failed-unconfirmed while this gate is still polling. It bounds the schedule and not the settle, and what keeps the run's outcome single-writer there is `closeRun`'s own `status IN ('running','paused')` predicate, not this line.
  const limit = args.notAfter ? Date.parse(args.notAfter) : Number.POSITIVE_INFINITY;
  const remainingMs = limit - now;
  // cm:guard test the FLOOR with NaN in mind — `remainingMs < floor` is false for NaN, so an unparseable `notAfter` would slip past and throw a RangeError out of `toISOString()` instead of refusing
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
// cm:guard NOTHING is dispatched from here. Until ISS-1042 this restored the previous image through `runCoolifyRollback`, and the reason it does not any more is that from inside this gate a build that came up dead and an outage that predates it are the same reading — so the automatic answer to both was to delete a reviewed build while the outage survived it. The deploy hold still FAILS, loudly and by name, which is what makes the operator's own `runCoolifyRollback` on `integrations/coolify-routes.ts` a decision somebody takes rather than one they discover was taken.
// cm:guard the hold must be settled on EVERY path out of this function. It is the only thing that ends the deploy's confirmation, and a gate that pages and returns without settling leaves the run pending until the sweeper's quiet window — which reads to an operator as a deploy still in flight.
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
// cm:guard a SECOND write of this row must not end the job. Its `requestId` is deterministic and `integration_deliveries_binding_request_id_uq` is unique on (binding_id, request_id), so a re-run after a transient failure downstream would die here — before the rollback marker that is supposed to make `failGate` idempotent is ever read, and before the hold is settled. Swallowing the collision is what makes that marker the live mechanism rather than a guard describing something the code cannot reach.
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
