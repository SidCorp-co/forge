import { INTEGRATIONS_QUEUE_NAME } from '../jobs/queue-name.js';
import { logger } from '../logger.js';
import { boss } from '../queue/boss.js';
import { coolifyAdapter } from './coolify/adapter.js';
import { buildContextFromBinding, findBindingById, findConnectionById } from './store.js';
import type { CoolifyConfig, CoolifySecrets } from './coolify/types.js';

export interface CoolifyDispatchJob {
  jobKind: 'coolify.dispatch';
  /** Active binding to dispatch on (== old project_integration id for backfilled rows). */
  bindingId: string;
  /** `null` for a run-less resource redeploy (no pipeline run to track). */
  runId: string | null;
  issueId: string | null;
  eventName: string;
  requestId?: string;
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
        const data = entry?.data as CoolifyDispatchJob | undefined;
        if (!data || data.jobKind !== 'coolify.dispatch') continue;
        try {
          await runCoolifyDispatch(data);
        } catch (err) {
          // Let pg-boss surface this to the retry policy. The adapter has
          // already recorded the failed delivery + maybe-tripped the breaker.
          logger.error(
            { err, bindingId: data.bindingId, runId: data.runId },
            'integrations worker: coolify dispatch threw — retry will be scheduled by pg-boss',
          );
          throw err;
        }
      }
    },
  )) as string;
  workerId = id;
  logger.info({ workerId, queue: INTEGRATIONS_QUEUE_NAME }, 'integrations worker registered');
}

async function runCoolifyDispatch(data: CoolifyDispatchJob): Promise<void> {
  const binding = await findBindingById(data.bindingId);
  if (!binding || !binding.active) {
    logger.warn(
      { bindingId: data.bindingId },
      'coolify dispatch worker: binding missing or inactive — dropping job',
    );
    return;
  }
  const connection = await findConnectionById(binding.connectionId);
  if (!connection || !connection.active) {
    logger.warn(
      { bindingId: data.bindingId, connectionId: binding.connectionId },
      'coolify dispatch worker: connection missing or inactive (breaker open?) — dropping job',
    );
    return;
  }
  const ctx = buildContextFromBinding<CoolifyConfig, CoolifySecrets>({ binding, connection });
  await coolifyAdapter.dispatchOutbound(ctx, {
    eventName: data.eventName,
    payload: { runId: data.runId, issueId: data.issueId, environment: ctx.environment },
    ...(data.requestId ? { requestId: data.requestId } : {}),
    runId: data.runId,
  });
}

export interface EnqueueOptions {
  /** Override default 5x exp backoff for testing. */
  retryLimit?: number;
  retryBackoff?: boolean;
  retryDelay?: number;
}

export async function enqueueCoolifyDispatch(
  job: CoolifyDispatchJob,
  opts: EnqueueOptions = {},
): Promise<string> {
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss send signature varies
  const id = (await (boss as any).send(INTEGRATIONS_QUEUE_NAME, job, {
    retryLimit: opts.retryLimit ?? 5,
    retryBackoff: opts.retryBackoff ?? true,
    retryDelay: opts.retryDelay ?? 30,
    singletonKey: job.requestId, // pg-boss dedup if same requestId already in-flight
  })) as string;
  return id;
}
