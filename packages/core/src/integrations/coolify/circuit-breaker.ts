import { logger } from '../../logger.js';
import { Sentry, isSentryEnabled } from '../../observability/sentry.js';
import { recentOutboundDeliveries } from '../deliveries.js';
import { findBindingById, findConnectionById, updateConnection } from '../store.js';

/** Per the issue's AC: 3 consecutive failed outbound deliveries within 5 minutes trips the breaker. */
export const BREAKER_FAILURE_THRESHOLD = 3;
export const BREAKER_WINDOW_MS = 5 * 60_000;
/**
 * Cooldown before an open breaker allows a single half-open trial dispatch.
 * Without this, an open breaker could only ever be reset by a successful
 * dispatch — which the breaker itself blocks (deadlock). After the cooldown the
 * next dispatch is allowed through once; success closes the breaker, failure
 * re-arms the cooldown.
 */
export const BREAKER_COOLDOWN_MS = 10 * 60_000;

export interface BreakerEvaluation {
  tripped: boolean;
  consecutiveFailures: number;
}

/**
 * Counts recent failures for a single binding. Breaker STATE lives on the
 * owning connection (so a shared credential trips once). For the 1:1 backfill
 * one binding maps to one connection, so per-binding counting == per-connection;
 * aggregating failures across sibling bindings of a shared connection is a
 * future concern.
 */
export async function evaluateBreaker(bindingId: string): Promise<BreakerEvaluation> {
  const recent = await recentOutboundDeliveries(
    bindingId,
    BREAKER_FAILURE_THRESHOLD,
    BREAKER_WINDOW_MS,
  );
  if (recent.length < BREAKER_FAILURE_THRESHOLD) {
    return {
      tripped: false,
      consecutiveFailures: recent.filter((r) => r.status === 'failed').length,
    };
  }
  const allFailed = recent.every((r) => r.status === 'failed');
  return {
    tripped: allFailed,
    consecutiveFailures: allFailed ? recent.length : 0,
  };
}

/**
 * Called after a `failed` outbound delivery is recorded. Evaluates the binding's
 * recent failures; if the threshold is met, flips active=false on the owning
 * CONNECTION, stamps breaker_opened_at, and emits a Sentry event.
 *
 * Returns true if the breaker was tripped by this call (caller uses this to
 * decide whether to auto-create a Forge issue for ops follow-up).
 */
export async function maybeTripBreaker(args: {
  bindingId: string;
  connectionId: string;
}): Promise<boolean> {
  const evaluation = await evaluateBreaker(args.bindingId);
  if (!evaluation.tripped) return false;

  const connection = await findConnectionById(args.connectionId);
  if (!connection || !connection.active) {
    // Already tripped previously; nothing to do.
    return false;
  }

  await updateConnection(args.connectionId, {
    active: false,
    breakerOpenedAt: new Date(),
  });

  const binding = await findBindingById(args.bindingId);
  logger.error(
    {
      connectionId: args.connectionId,
      bindingId: args.bindingId,
      provider: connection.provider,
      environment: binding?.environment ?? null,
      consecutiveFailures: evaluation.consecutiveFailures,
    },
    'integration: circuit breaker tripped',
  );

  if (isSentryEnabled()) {
    Sentry.captureMessage('integration.coolify.breaker_tripped', {
      level: 'error',
      tags: {
        provider: connection.provider,
        environment: binding?.environment ?? 'unknown',
        projectId: binding?.projectId ?? 'unknown',
      },
      extra: {
        connectionId: args.connectionId,
        bindingId: args.bindingId,
        consecutiveFailures: evaluation.consecutiveFailures,
      },
    });
  }

  return true;
}

/**
 * Dispatch-time gate. Decides whether an outbound deploy may proceed given the
 * connection's breaker state:
 *  - active (closed) → allow.
 *  - inactive (open) but `breakerOpenedAt` older than {@link BREAKER_COOLDOWN_MS}
 *    → HALF-OPEN: re-stamp `breakerOpenedAt` to now (so a failing trial waits
 *    another full cooldown) and allow ONE trial. A success then closes the
 *    breaker via {@link maybeResetBreaker}; a failure leaves it open with the
 *    fresh timestamp.
 *  - inactive and still within cooldown → deny.
 *
 * This breaks the deadlock where an open breaker blocks the very dispatch that
 * would reset it. Pass the already-fetched connection row to avoid a re-read.
 */
export async function breakerAllowsDispatch(connection: {
  id: string;
  active: boolean;
  breakerOpenedAt: Date | null;
}): Promise<{ allow: boolean; halfOpen: boolean }> {
  if (connection.active) return { allow: true, halfOpen: false };
  const openedAtMs = connection.breakerOpenedAt
    ? new Date(connection.breakerOpenedAt).getTime()
    : null;
  if (openedAtMs !== null && Date.now() - openedAtMs >= BREAKER_COOLDOWN_MS) {
    // Re-stamp BEFORE the trial: if the trial fails, maybeTripBreaker is a no-op
    // on an already-open connection, so this timestamp is what re-arms the next
    // cooldown window. A successful trial clears it via maybeResetBreaker.
    await updateConnection(connection.id, { breakerOpenedAt: new Date() });
    logger.info({ connectionId: connection.id }, 'integration: circuit breaker half-open trial');
    return { allow: true, halfOpen: true };
  }
  return { allow: false, halfOpen: false };
}

/**
 * Called after a successful outbound delivery OR a successful Test-connection
 * (operator-driven). If the owning connection's breaker was previously open,
 * reset it. Otherwise no-op.
 */
export async function maybeResetBreaker(connectionId: string): Promise<void> {
  const connection = await findConnectionById(connectionId);
  if (!connection || connection.active) return;
  await updateConnection(connectionId, {
    active: true,
    breakerOpenedAt: null,
  });
  logger.info({ connectionId }, 'integration: circuit breaker reset');
}
