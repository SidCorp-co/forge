import { INTEGRATIONS_QUEUE_NAME } from '../jobs/queue-name.js';
import { logger } from '../logger.js';
import { boss } from '../queue/boss.js';
import {
  applyDeploySettlement,
  type CoolifyConfirmJob,
  runCoolifyConfirm,
} from './coolify/confirm.js';
import {
  type CoolifyHealthGateJob,
  probeHealth,
  runCoolifyHealthGate,
} from './coolify/health-gate.js';
import { dispatchThrough } from './registry.js';
import { buildContextFromBinding, findBindingById, findConnectionById } from './store.js';
import { NonRetryableDispatchError } from './types.js';

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
  /**
   * The exact request to dispatch, where the caller has one to replay.
   *
   * A RETRY sets this from the failed delivery's own recorded payload, which is what makes the
   * retry a replay: a Sentry status update names a target label and a status that
   * `{ runId, issueId, stages }` cannot carry, so rebuilding the payload would re-dispatch a
   * different request under the same button. Absent — every release-path enqueue, and every job
   * queued before this landed — the payload is built the way it always was.
   */
  payload?: Record<string, unknown>;
}

let workerId: string | null = null;

/**
 * Register the boss.work consumer for the integrations queue. Must be called
 * once at boot AFTER startBoss(). Idempotent.
 */
export async function registerIntegrationsWorker(): Promise<void> {
  if (workerId) return;
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).createQueue(INTEGRATIONS_QUEUE_NAME);
  // biome-ignore lint/suspicious/noExplicitAny: handler arity / arg shape stabilised at runtime
  const id = (await (boss as any).work(
    INTEGRATIONS_QUEUE_NAME,
    { batchSize: 1 },
    async (arg: any) => {
      const entries = Array.isArray(arg) ? arg : [arg];
      for (const entry of entries) {
        const data = entry?.data as
          | OutboundDispatchJob
          | CoolifyConfirmJob
          | CoolifyHealthGateJob
          | undefined;
        if (!data) continue;
        try {
          if (data.jobKind === 'coolify.dispatch') {
            await runOutboundDispatch(data);
          } else if (data.jobKind === 'coolify.confirm') {
            const outcome = await runCoolifyConfirm(data);
            if (outcome.settled) {
              logger.info(
                { bindingId: data.bindingId, runId: data.runId, ...outcome },
                'integrations worker: coolify deploy confirmation settled',
              );
            }
          } else if (data.jobKind === 'coolify.health-gate') {
            const outcome = await runCoolifyHealthGate(data, healthGateDeps(data));
            if (outcome.verdict) {
              logger.info(
                { bindingId: data.bindingId, runId: data.runId, ...outcome },
                'integrations worker: coolify post-deploy health gate resolved',
              );
            }
          }
        } catch (err) {
          // cm:guard rethrow — pg-boss's retry policy is the only thing that re-runs this, and the delivery row plus the breaker were already written by the adapter, so swallowing here loses the retry and keeps the failure.
          logger.error(
            { err, bindingId: data.bindingId, runId: data.runId, jobKind: data.jobKind },
            'integrations worker: coolify job threw — retry will be scheduled by pg-boss',
          );
          throw err;
        }
      }
    },
  )) as string;
  workerId = id;
  logger.info({ workerId, queue: INTEGRATIONS_QUEUE_NAME }, 'integrations worker registered');
}

/**
 * The collaborators the health gate calls out to, bound here so the gate
 * itself stays a decision function a test drives without a queue or a network.
 */
function healthGateDeps(data: CoolifyHealthGateJob) {
  return {
    probe: (url: string) => probeHealth(url),
    // cm:guard a gate with no `deliveryId` is watching a ROLLBACK's own build, which holds nothing — settling there would resolve a hold the failed deploy already owns and hand the run a second, contradictory outcome.
    settle: async (verdict: 'succeeded' | 'failed', detail?: string) => {
      const deliveryId = data.deliveryId;
      if (!deliveryId) return;
      await applyDeploySettlement({ ...data, deliveryId }, verdict, detail);
    },
  };
}

/**
 * Dispatch one outbound job through the binding's OWN provider.
 *
 * It called `coolifyAdapter.dispatchOutbound` directly until ISS-1085, which was right only while
 * Coolify was the one provider that dispatched: with Sentry dispatching too, the delivery log's
 * Retry button on a failed Sentry delivery would have handed that delivery to Coolify's client and
 * called it a deploy.
 */
// cm:edge lockstep -> packages/core/src/integrations/registry.ts — `dispatchThrough` is the one place the refusal for a provider implementing no outbound call is worded, and asking it is what stops this worker naming a provider
async function runOutboundDispatch(data: OutboundDispatchJob): Promise<void> {
  const binding = await findBindingById(data.bindingId);
  if (!binding?.active) {
    logger.warn(
      { bindingId: data.bindingId },
      'integrations dispatch worker: binding missing or inactive — dropping job',
    );
    return;
  }
  const connection = await findConnectionById(binding.connectionId);
  if (!connection?.active) {
    logger.warn(
      { bindingId: data.bindingId, connectionId: binding.connectionId },
      'integrations dispatch worker: connection missing or inactive (breaker open?) — dropping job',
    );
    return;
  }
  const ctx = buildContextFromBinding({ binding, connection });
  try {
    await dispatchThrough(binding.provider, ctx, {
      eventName: data.eventName,
      payload: data.payload ?? { runId: data.runId, issueId: data.issueId, stages: ctx.stages },
      ...(data.requestId ? { requestId: data.requestId } : {}),
      runId: data.runId,
    });
  } catch (err) {
    // cm:guard a TERMINAL refusal is logged and swallowed, and that is not the same as ignoring it.
    // The delivery row carries the failure and its sentence; what this stops is the five-times
    // exponential backoff above, which for an operation like a merge would send the same request
    // again an hour later, after the very condition that refused it may have changed. ISS-1073's
    // third rule is that a merge that cannot be made is refused by name, never retried — and a
    // rethrow here is a retry however the adapter worded its refusal.
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

export interface EnqueueOptions {
  /** Override default 5x exp backoff for testing. */
  retryLimit?: number;
  retryBackoff?: boolean;
  retryDelay?: number;
}

export async function enqueueOutboundDispatch(
  job: OutboundDispatchJob,
  opts: EnqueueOptions = {},
): Promise<string> {
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss send signature varies
  const id = (await (boss as any).send(INTEGRATIONS_QUEUE_NAME, job, {
    retryLimit: opts.retryLimit ?? 5,
    retryBackoff: opts.retryBackoff ?? true,
    retryDelay: opts.retryDelay ?? 30,
    // cm:guard the dedup key is the caller's `requestId` — pg-boss DROPS a send whose singletonKey is already in flight, so two deploys that reuse one requestId become one deploy and the second one's caller waits on a hold nothing will settle
    singletonKey: job.requestId,
  })) as string;
  return id;
}
