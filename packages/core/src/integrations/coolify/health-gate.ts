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
 * reading fails the deploy and restores the previous image through
 * `runCoolifyRollback`.
 */

import { INTEGRATIONS_QUEUE_NAME } from '../../jobs/queue-name.js';
import { logger } from '../../logger.js';
import { boss } from '../../queue/boss.js';
import { recordDelivery } from '../deliveries.js';
import { effectiveConfig, findBindingById, findConnectionById } from '../store.js';
import { CoolifyCommandError } from './commands.js';
import type { CoolifyConfig, CoolifyTarget } from './types.js';

export interface CoolifyHealthGateJob {
  jobKind: 'coolify.health-gate';
  bindingId: string;
  /** `null` for a run-less redeploy — probed and audited, advances no run. */
  runId: string | null;
  /** The delivery whose hold this gate settles; `null` for a rollback's own gate. */
  deliveryId: string | null;
  deploymentUuid: string;
  targetId: string;
  targetLabel: string;
  healthUrl: string;
  /** ISO-8601. No reading before this counts. */
  graceUntil: string;
  /** ISO-8601. Past this with no healthy reading, the deploy has failed. */
  deadlineAt: string;
  /** True when this gate watches a rollback: its failure pages instead of rolling back again. */
  forRollback: boolean;
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

/**
 * The image a failed deploy is restored to: the newest Coolify still lists that
 * is not the one running now.
 */
// cm:guard the CURRENT image is the build that just failed its health gate, so it is excluded by construction rather than by ordering. An empty remainder returns null and the caller refuses — it must never fall through to `images[0]`, which would roll the application back onto the broken build and report a rollback.
export function pickRollbackImage(
  images: { tag: string; createdAt: string | null; isCurrent: boolean }[],
): string | null {
  const candidates = images.filter((i) => !i.isCurrent);
  if (candidates.length === 0) return null;
  const newest = [...candidates].sort(
    (a, b) => Date.parse(b.createdAt ?? '') - Date.parse(a.createdAt ?? ''),
  );
  return newest[0]?.tag ?? candidates[0]?.tag ?? null;
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

/** Build the gate job for a target that declares a health URL, or `null`. */
export function healthGateFor(args: {
  config: CoolifyConfig | null;
  bindingId: string;
  runId: string | null;
  deliveryId: string | null;
  deploymentUuid: string;
  targetLabel: string;
  forRollback: boolean;
  /** The confirmation hold's own deadline; the gate may never outlive it. */
  notAfter?: string;
  now?: number;
}): CoolifyHealthGateJob | null {
  const target = (args.config?.targets ?? []).find((t) => t.label === args.targetLabel);
  const healthUrl = target?.healthUrl;
  if (!target || !healthUrl) return null;
  const now = args.now ?? Date.now();
  // cm:guard the gate must resolve BEFORE the confirmation hold's own deadline, or two mechanisms decide one deploy: `resolveDeployGate` reads a hold past its deadline as failed-unconfirmed while this gate is still polling, and the run then carries a verdict nobody's reading produced. A build slow enough to eat the window leaves the gate a shorter one, never a later one.
  const limit = args.notAfter ? Date.parse(args.notAfter) : Number.POSITIVE_INFINITY;
  const deadline = Math.min(now + HEALTH_GRACE_MS + HEALTH_WINDOW_MS, limit);
  const grace = Math.min(now + HEALTH_GRACE_MS, deadline);
  return {
    jobKind: 'coolify.health-gate',
    bindingId: args.bindingId,
    runId: args.runId,
    deliveryId: args.deliveryId,
    deploymentUuid: args.deploymentUuid,
    targetId: target.id,
    targetLabel: target.label,
    healthUrl,
    graceUntil: new Date(grace).toISOString(),
    deadlineAt: new Date(deadline).toISOString(),
    forRollback: args.forRollback,
  };
}

export interface HealthGateOutcome {
  /** `null` while the window is open and another poll is queued. */
  verdict: 'healthy' | 'unhealthy' | null;
  reason?: string;
  /** The image the deploy was restored to, when one was dispatched. */
  rolledBackTo?: string;
}

export interface HealthGateDeps {
  probe: (url: string) => Promise<HealthReading>;
  /** Settle the deploy hold this gate deferred — `confirm.ts` owns the write. */
  settle: (verdict: 'succeeded' | 'failed', detail?: string) => Promise<void>;
  rollback: (input: {
    projectId: string;
    integrationId: string;
    resourceUuid: string;
    commit: string;
  }) => Promise<{ performed: boolean; deploymentUuid: string | null; detail?: string }>;
  listImages: (input: {
    projectId: string;
    integrationId: string;
    resourceUuid: string;
  }) => Promise<{ images: { tag: string; createdAt: string | null; isCurrent: boolean }[] }>;
  now?: () => number;
}

/**
 * Poll one deployment's health once: settle it, roll it back, or queue the
 * next poll.
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
    if (data.forRollback) {
      logger.info(
        { bindingId: data.bindingId, deploymentUuid: data.deploymentUuid },
        'coolify health gate: the rollback is serving',
      );
      return { verdict: 'healthy' };
    }
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
 * The window closed with no healthy reading. Record which deploy failed and on
 * what signal, restore the previous image, and only then fail the hold.
 */
async function failGate(
  data: CoolifyHealthGateJob,
  reason: string,
  deps: HealthGateDeps,
): Promise<HealthGateOutcome> {
  const detail = `never became healthy within ${Math.round(HEALTH_WINDOW_MS / 1000)}s — last reading: ${reason}`;

  // cm:guard the rollback's own gate must NOT roll back again. A restored image that also cannot serve is a state no further automation improves, and a second rollback walks the application down a list of builds nobody chose while the outage continues.
  if (data.forRollback) {
    await recordDelivery({
      bindingId: data.bindingId,
      direction: 'inbound',
      eventName: 'deploy.rollback.unhealthy',
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
    logger.error(
      {
        bindingId: data.bindingId,
        deploymentUuid: data.deploymentUuid,
        targetLabel: data.targetLabel,
        detail,
      },
      'coolify health gate: the ROLLBACK is not serving either — this needs a human, nothing further is automatic',
    );
    return { verdict: 'unhealthy', reason: detail };
  }

  await recordDelivery({
    bindingId: data.bindingId,
    direction: 'inbound',
    eventName: 'deploy.unhealthy',
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

  const rolledBackTo = await restorePrevious(data, detail, deps);
  await deps.settle('failed', rolledBackTo ? `${detail}; rolled back to ${rolledBackTo}` : detail);
  return {
    verdict: 'unhealthy',
    reason: detail,
    ...(rolledBackTo ? { rolledBackTo } : {}),
  };
}

/**
 * Restore the previous image, and page rather than pretend when it cannot be.
 */
// cm:edge protocol -> packages/core/src/integrations/coolify/controls.ts — the rollback goes through `runCoolifyRollback`, never `client.rollbackApplication`, so it inherits `assertRollbackTagListed`, the outbound audit delivery and the `coolify.confirm` poll on the resulting build. That path also does NOT consult the circuit breaker, which gates `dispatchOutbound` alone: the breaker exists to stop repeated outbound deploys, and a rollback it swallowed would leave the dead build serving.
async function restorePrevious(
  data: CoolifyHealthGateJob,
  detail: string,
  deps: HealthGateDeps,
): Promise<string | null> {
  const binding = await findBindingById(data.bindingId);
  const connection = binding ? await findConnectionById(binding.connectionId) : null;
  // cm:guard read `targets` through `effectiveConfig`, never off `binding.config` alone — a binding that has not overridden them INHERITS the connection's, and a bare read finds no target and turns "roll this back" into "cannot roll back".
  const config =
    binding && connection ? effectiveConfig<CoolifyConfig>({ binding, connection }) : null;
  const target = findTarget(config, data.targetId);
  if (!binding || !target) {
    logger.error(
      { bindingId: data.bindingId, targetId: data.targetId },
      'coolify health gate: the deploy is unhealthy and its target is no longer configured — cannot roll back, this needs a human',
    );
    return null;
  }

  const page = (message: string, extra: Record<string, unknown> = {}) =>
    logger.error(
      {
        bindingId: data.bindingId,
        projectId: binding.projectId,
        targetLabel: data.targetLabel,
        deploymentUuid: data.deploymentUuid,
        detail,
        ...extra,
      },
      message,
    );

  let commit: string | null;
  try {
    const listed = await deps.listImages({
      projectId: binding.projectId,
      integrationId: data.bindingId,
      resourceUuid: target.resourceUuid,
    });
    commit = pickRollbackImage(listed.images);
  } catch (err) {
    page(
      'coolify health gate: the deploy is unhealthy and its rollback images could not be read — nothing was rolled back, this needs a human',
      { err },
    );
    return null;
  }

  if (!commit) {
    page(
      'coolify health gate: the deploy is unhealthy and Coolify lists no earlier image to restore — nothing was rolled back, this needs a human',
    );
    return null;
  }

  try {
    const outcome = await deps.rollback({
      projectId: binding.projectId,
      integrationId: data.bindingId,
      resourceUuid: target.resourceUuid,
      commit,
    });
    // cm:guard `performed:false` is the human-confirm gate on a production binding answering NO. It is a rollback that did not happen, so it pages — reading it as done is the class of defect this whole gate exists to remove.
    if (!outcome.performed || !outcome.deploymentUuid) {
      page(
        'coolify health gate: the deploy is unhealthy and the rollback was not dispatched — this needs a human',
        { commit, rollbackDetail: outcome.detail },
      );
      return null;
    }
    logger.error(
      {
        bindingId: data.bindingId,
        deploymentUuid: data.deploymentUuid,
        rollbackDeploymentUuid: outcome.deploymentUuid,
        commit,
        detail,
      },
      'coolify health gate: the deploy never became healthy — rolled back to the previous image',
    );
    const gate = healthGateFor({
      config,
      bindingId: data.bindingId,
      runId: null,
      deliveryId: null,
      deploymentUuid: outcome.deploymentUuid,
      targetLabel: data.targetLabel,
      forRollback: true,
    });
    if (gate) await enqueueCoolifyHealthGate(gate, { startAfterSeconds: 0 });
    return commit;
  } catch (err) {
    page(
      'coolify health gate: the deploy is unhealthy and the rollback was REFUSED — nothing was rolled back, this needs a human',
      { commit, err: err instanceof CoolifyCommandError ? err.message : err },
    );
    return null;
  }
}
