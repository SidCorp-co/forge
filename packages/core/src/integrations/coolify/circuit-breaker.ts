import { logger } from '../../logger.js';
import { isSentryEnabled, Sentry } from '../../observability/sentry.js';
import { recentOutboundDeliveries } from '../deliveries.js';
import { findById, updateIntegration } from '../store.js';

/** Per the issue's AC: 3 consecutive failed outbound deliveries within 5 minutes trips the breaker. */
export const BREAKER_FAILURE_THRESHOLD = 3;
export const BREAKER_WINDOW_MS = 5 * 60_000;

export interface BreakerEvaluation {
  tripped: boolean;
  consecutiveFailures: number;
}

export async function evaluateBreaker(projectIntegrationId: string): Promise<BreakerEvaluation> {
  const recent = await recentOutboundDeliveries(
    projectIntegrationId,
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
 * Called after a `failed` outbound delivery is recorded. If the recent
 * history meets the breaker threshold, flips active=false on the integration
 * row, stamps breaker_opened_at, and emits a Sentry event.
 *
 * Returns true if the breaker was tripped by this call (caller uses this to
 * decide whether to auto-create a Forge issue for ops follow-up).
 */
export async function maybeTripBreaker(projectIntegrationId: string): Promise<boolean> {
  const evaluation = await evaluateBreaker(projectIntegrationId);
  if (!evaluation.tripped) return false;

  const row = await findById(projectIntegrationId);
  if (!row || !row.active) {
    // Already tripped previously; nothing to do.
    return false;
  }

  await updateIntegration(projectIntegrationId, {
    active: false,
    breakerOpenedAt: new Date(),
  });

  logger.error(
    {
      integrationId: projectIntegrationId,
      provider: row.provider,
      environment: row.environment,
      consecutiveFailures: evaluation.consecutiveFailures,
    },
    'integration: circuit breaker tripped',
  );

  if (isSentryEnabled()) {
    Sentry.captureMessage('integration.coolify.breaker_tripped', {
      level: 'error',
      tags: {
        provider: row.provider,
        environment: row.environment,
        projectId: row.projectId,
      },
      extra: {
        integrationId: projectIntegrationId,
        consecutiveFailures: evaluation.consecutiveFailures,
      },
    });
  }

  return true;
}

/**
 * Called after a successful outbound delivery. If the breaker was previously
 * open, reset it. Otherwise no-op.
 */
export async function maybeResetBreaker(projectIntegrationId: string): Promise<void> {
  const row = await findById(projectIntegrationId);
  if (!row || row.active) return;
  await updateIntegration(projectIntegrationId, {
    active: true,
    breakerOpenedAt: null,
  });
  logger.info({ integrationId: projectIntegrationId }, 'integration: circuit breaker reset');
}
