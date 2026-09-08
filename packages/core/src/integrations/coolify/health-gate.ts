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

export interface RollbackImage {
  tag: string;
  createdAt: string | null;
  isCurrent: boolean;
}

/**
 * The image a failed deploy is restored to: the newest Coolify still lists that
 * is not the one running now.
 */
// cm:guard the running build must be IDENTIFIED before anything is excluded. `is_current` is optional on Coolify's row and `current` can be null, and a list where nothing says which image is live has the just-failed build sitting at the top of it — so an unidentifiable list returns null and the caller refuses, rather than restoring the broken build and calling it a rollback.
// cm:guard a `createdAt` that will not parse sorts LAST, never wherever Coolify happened to list it — a comparator returning NaN reads as 0 and leaves the input order untouched, which silently makes "the newest image" mean "the first one Coolify printed".
export function pickRollbackImage(images: RollbackImage[], current: string | null): string | null {
  const identified = current !== null || images.some((i) => i.isCurrent);
  if (!identified) return null;
  const candidates = images.filter((i) => !i.isCurrent && i.tag !== current);
  if (candidates.length === 0) return null;
  const at = (i: RollbackImage) => {
    const t = Date.parse(i.createdAt ?? '');
    return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
  };
  return [...candidates].sort((a, b) => at(b) - at(a))[0]?.tag ?? null;
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
  targetLabel: string;
  forRollback: boolean;
  /** The confirmation hold's own deadline; the gate may never outlive it. */
  notAfter?: string;
  now?: number;
}): HealthGateDecision {
  // cm:guard a binding's target LABELS are unique (`provider-schemas.ts` refuses a duplicate), which is what lets a `coolify.confirm` job — which carries only the label — name one target. Drop that rule and this reads the first match's health URL while stamping its id, so the rollback restores a different application.
  const target = (args.config?.targets ?? []).find((t) => t.label === args.targetLabel);
  const healthUrl = target?.healthUrl;
  if (!target || !healthUrl) return { kind: 'not-declared' };
  const now = args.now ?? Date.now();
  // cm:guard the gate is SCHEDULED entirely inside the confirmation hold's own deadline, so `resolveDeployGate` cannot read the hold as failed-unconfirmed while this gate is still polling. It bounds the schedule and not the settle: the rollback between the last reading and the settle is unbounded, and what keeps the run's outcome single-writer there is `closeRun`'s own `status IN ('running','paused')` predicate, not this line.
  const limit = args.notAfter ? Date.parse(args.notAfter) : Number.POSITIVE_INFINITY;
  const remainingMs = limit - now;
  if (remainingMs < HEALTH_MIN_WINDOW_MS) return { kind: 'window-too-short', remainingMs };
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
      forRollback: args.forRollback,
    },
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
  }) => Promise<{ current: string | null; images: RollbackImage[] }>;
  /** Has this failed deploy already had a rollback dispatched for it? */
  findRollbackMarker: (bindingId: string, requestId: string) => Promise<boolean>;
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
// cm:edge protocol -> packages/core/src/integrations/coolify/controls.ts — the rollback goes through `runCoolifyRollback`, never `client.rollbackApplication`, so it inherits `assertRollbackTagListed`, the outbound audit delivery and the `coolify.confirm` poll on the resulting build.
// cm:guard an OPEN circuit breaker blocks this rollback, and the block is named here rather than discovered downstream: `maybeTripBreaker` writes `connections.active = false`, and `activeCoolifyIntegrations` filters on it, so `runCoolifyRollback` would answer `no active Coolify integration` — a sentence about configuration for a condition that is about Coolify refusing calls. Three failed deliveries in five minutes is Coolify refusing everything, a rollback included, so this pages instead of pretending; do not "fix" it by reactivating the connection, which is the breaker's state to own.
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

  if (connection && !connection.active) {
    logger.error(
      { bindingId: data.bindingId, connectionId: binding.connectionId, detail },
      'coolify health gate: the deploy is unhealthy and the Coolify circuit breaker is OPEN, so no rollback can be dispatched — the dead build is still serving and this needs a human',
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
    commit = pickRollbackImage(listed.images, listed.current);
  } catch (err) {
    page(
      'coolify health gate: the deploy is unhealthy and its rollback images could not be read — nothing was rolled back, this needs a human',
      { err },
    );
    return null;
  }

  if (!commit) {
    page(
      'coolify health gate: the deploy is unhealthy and Coolify named no earlier image it could be restored to — nothing was rolled back, this needs a human',
    );
    return null;
  }

  // cm:guard this marker, not the delivery table's unique index, is what stops a SECOND rollback. `failGate` is re-entered whenever anything after the dispatch throws and pg-boss retries the job, and by then `is_current` names the restored image — so an unguarded retry picks the build that just failed and restores THAT. The requestId is deterministic on purpose; it is the one dedup key in this module that must NOT move.
  const marker = `health-rollback:${data.deploymentUuid}`;
  if (await deps.findRollbackMarker(data.bindingId, marker)) {
    page(
      'coolify health gate: a rollback for this deploy was already dispatched — not rolling back again, this needs a human',
      { commit },
    );
    return null;
  }
  await recordDelivery({
    bindingId: data.bindingId,
    direction: 'outbound',
    eventName: 'deploy.rollback.auto',
    payload: { source: 'health-gate', deployment_uuid: data.deploymentUuid, commit, detail },
    requestId: marker,
    status: 'pending',
  });

  let outcome: { performed: boolean; deploymentUuid: string | null; detail?: string };
  // cm:guard the try covers the dispatch ALONE. Widen it and a `boss.send` failure after Coolify accepted the rollback pages "nothing was rolled back", which tells an operator mid-outage that the broken build is still serving while it is being replaced.
  try {
    outcome = await deps.rollback({
      projectId: binding.projectId,
      integrationId: data.bindingId,
      resourceUuid: target.resourceUuid,
      commit,
    });
  } catch (err) {
    page(
      'coolify health gate: the deploy is unhealthy and the rollback was REFUSED — nothing was rolled back, this needs a human',
      { commit, err: err instanceof CoolifyCommandError ? err.message : err },
    );
    return null;
  }

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
  if (gate.kind === 'gate') await enqueueCoolifyHealthGate(gate.job, { startAfterSeconds: 0 });
  return commit;
}
