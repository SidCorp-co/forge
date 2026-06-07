import { logger } from '../../logger.js';
import { isSentryEnabled, Sentry } from '../../observability/sentry.js';
import { recentOutboundDeliveries } from '../deliveries.js';
import { findBindingById, findConnectionById, updateConnection } from '../store.js';

/** Per the issue's AC: 3 consecutive failed outbound deliveries within 5 minutes trips the breaker. */
export const BREAKER_FAILURE_THRESHOLD = 3;
export const BREAKER_WINDOW_MS = 5 * 60_000;

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
    return { tripped: false, consecutiveFailures: recent.filter((r) => r.status === 'failed').length };
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
 * Called after a successful outbound delivery. If the owning connection's
 * breaker was previously open, reset it. Otherwise no-op.
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
