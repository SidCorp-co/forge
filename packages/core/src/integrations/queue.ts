import { logger } from '../lib/logger.js';
import { boss } from '../queue/boss.js';
import { INTEGRATIONS_QUEUE_NAME } from '../queue/names.js';
import { recordDelivery } from './deliveries.js';
import { dispatchThrough } from './registry.js';
import { buildContextFromBinding, findBindingById, findConnectionById } from './store.js';
import { NonRetryableDispatchError, type OutboundDispatchInput } from './types.js';

/**
 * One outbound dispatch, on whichever provider the binding names.
 *
 * `jobKind` keeps Coolify's name although the job is no longer Coolify's alone (ISS-1085): the
 * string is a pg-boss payload field, and renaming it would strand every job already in flight when
 * the change deploys. It is renamed in a later change, once no `coolify.dispatch` job is queued.
 */
export interface OutboundDispatchJob {
  jobKind: 'coolify.dispatch';
  /** Active binding to dispatch on (== old project_integration id for backfilled rows). */
  bindingId: string;
  /** `null` for a run-less resource redeploy (no pipeline run to track). */
  runId: string | null;
  issueId: string | null;
  eventName: string;
  requestId?: string;
  payload?: Record<string, unknown>;
}

/**
 * Dispatch one outbound job through the binding's OWN provider.
 *
 * It called `coolifyAdapter.dispatchOutbound` directly until ISS-1085, which was right only while
 * Coolify was the one provider that dispatched: with Sentry dispatching too, the delivery log's
 * Retry button on a failed Sentry delivery would have handed that delivery to Coolify's client and
 * called it a deploy.
 */
export async function runOutboundDispatch(
  data: OutboundDispatchJob,
  hooks: Pick<OutboundDispatchInput, 'onDeployOutcome'> = {},
): Promise<void> {
  const binding = await findBindingById(data.bindingId);
  const connection = binding ? await findConnectionById(binding.connectionId) : null;
  if (!binding?.active || !connection?.active) {
    // A dropped job leaves a failed row under the requestId it was queued with, saying why.
    const why = !binding?.active
      ? 'the binding is missing or switched off'
      : 'the connection is missing or switched off (the breaker may have opened it)';
    logger.warn({ bindingId: data.bindingId, why }, 'integrations dispatch worker: dropping job');
    if (binding) {
      await recordDelivery({
        bindingId: binding.id,
        direction: 'outbound',
        eventName: data.eventName,
        payload: data.payload ?? { runId: data.runId, issueId: data.issueId },
        ...(data.requestId ? { requestId: data.requestId } : {}),
        status: 'failed',
        errorMessage: `not dispatched: ${why}`,
      });
    }
    return;
  }
  const ctx = buildContextFromBinding({ binding, connection });
  try {
    await dispatchThrough(binding.provider, ctx, {
      eventName: data.eventName,
      payload: data.payload ?? { runId: data.runId, issueId: data.issueId },
      ...(data.requestId ? { requestId: data.requestId } : {}),
      runId: data.runId,
      ...hooks,
    });
  } catch (err) {
    if (err instanceof NonRetryableDispatchError) {
      logger.warn(
        { bindingId: data.bindingId, eventName: data.eventName, reason: err.reason },
        'integrations dispatch worker: refused terminally, not retrying',
      );
      return;
    }
    throw err;
  }
}

interface EnqueueOptions {
  /** Override default 5x exp backoff for testing. */
  retryLimit?: number;
  retryBackoff?: boolean;
  retryDelay?: number;
}

export async function enqueueOutboundDispatch(
  job: OutboundDispatchJob,
  opts: EnqueueOptions = {},
): Promise<string> {
  const id = await boss.send(INTEGRATIONS_QUEUE_NAME, job, {
    retryLimit: opts.retryLimit ?? 5,
    retryBackoff: opts.retryBackoff ?? true,
    retryDelay: opts.retryDelay ?? 30,
    ...(job.requestId ? { singletonKey: job.requestId } : {}),
  });
  if (!id) throw new Error(`integrations: the ${job.jobKind} dispatch was not queued`);
  return id;
}
