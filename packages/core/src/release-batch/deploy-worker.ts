import { DEPLOY_CONFIRM_WINDOW_MS } from '@forge/contracts/pipeline';
import { probeHealth } from '../integrations/deploy/index.js';
import {
  type DeployDispatchOutcome,
  type OutboundDispatchJob,
  runOutboundDispatch,
} from '../integrations/index.js';
import { logger } from '../observability/logger.js';
import {
  deployHoldsIdle,
  deployHoldsLocks,
  readDeployHolds,
  releaseDeployLocksForRun,
  replaceDispatchHoldWithTargets,
} from '../pipeline/index.js';
import { boss } from '../queue/boss.js';
import { INTEGRATIONS_QUEUE_NAME } from '../queue/names.js';
import {
  applyDeploySettlement,
  type CoolifyConfirmJob,
  enqueueCoolifyConfirm,
  runCoolifyConfirm,
} from './coolify-confirm.js';
import { type CoolifyHealthGateJob, runCoolifyHealthGate } from './coolify-health-gate.js';

/**
 * The bookkeeping one deploy dispatch owes whatever became of it: the holds recording what it
 * authorised, the confirmations polling what Coolify accepted, and the environment it no longer
 * needs. The deploy port reports the outcome; what it means to a run is the release's.
 */
async function recordDispatchOutcome(
  outcome: DeployDispatchOutcome,
  confirmDeadlineAt: string,
): Promise<void> {
  const { runId, bindingId } = outcome;
  let held = false;
  if (runId) {
    held = await replaceDispatchHoldWithTargets({
      runId,
      bindingId,
      targets: outcome.targets,
      ...(outcome.requestId ? { requestId: outcome.requestId } : {}),
    }).catch((err: unknown) => {
      // The placeholder stands where this could not be written, so the gate stays deferred rather
      // than reading a run with no holds as proven, and the environment stays held to its expiry.
      logger.error({ err, runId, bindingId }, 'coolify deploy: holds unwritable');
      return false;
    });
    if (!held) {
      logger.error(
        { runId, bindingId, targets: outcome.targets.length },
        'coolify deploy: the run refused its confirmation holds — this deploy will be polled and audited, but no run can witness its outcome',
      );
    }
  }

  // Outside the `runId` guard: a run-less resource redeploy is polled and audited exactly as a
  // run-tracked one is, and only the holds are the run's. Each send stands alone, so one queue
  // refusal cannot take the siblings' polling with it.
  for (const target of outcome.targets) {
    if (target.status !== 'pending' || !target.deploymentUuid) continue;
    const job: CoolifyConfirmJob = {
      jobKind: 'coolify.confirm',
      bindingId,
      runId,
      deliveryId: target.deliveryId,
      deploymentUuid: target.deploymentUuid,
      targetLabel: target.targetLabel,
      deadlineAt: confirmDeadlineAt,
    };
    try {
      await enqueueCoolifyConfirm(job, { startAfterSeconds: 0 });
    } catch (err) {
      logger.error(
        { err, runId, bindingId, deliveryId: job.deliveryId },
        'coolify deploy: confirmation could not be queued — Coolify accepted a deploy nothing will poll',
      );
    }
  }

  // ISS-1279 — read off the holds and only where they were written: every target resolved means
  // nothing is reaching the environment, while a refused hold says nothing at all about what
  // Coolify is running, and freeing on that is how a second deploy joins the first one in flight.
  if (!runId || !held) return;
  const holds = await readDeployHolds(runId);
  if (deployHoldsIdle(holds)) {
    await releaseDeployLocksForRun(runId, deployHoldsLocks(holds));
  }
}

/** One outbound dispatch, with the release's bookkeeping attached to any deploy it makes. */
async function runDispatch(data: OutboundDispatchJob): Promise<void> {
  const confirmDeadlineAt = new Date(Date.now() + DEPLOY_CONFIRM_WINDOW_MS).toISOString();
  await runOutboundDispatch(data, {
    onDeployOutcome: (outcome) => recordDispatchOutcome(outcome, confirmDeadlineAt),
  });
}

/**
 * The collaborators the health gate calls out to, bound here so the gate
 * itself stays a decision function a test drives without a queue or a network.
 */
function healthGateDeps(data: CoolifyHealthGateJob) {
  return {
    probe: (url: string) => probeHealth(url),
    settle: async (verdict: 'succeeded' | 'failed', detail?: string) => {
      const deliveryId = data.deliveryId;
      if (!deliveryId) return;
      await applyDeploySettlement({ ...data, deliveryId }, verdict, detail);
    },
  };
}

let workerId: string | null = null;

/**
 * Register the boss.work consumer for the integrations queue: outbound dispatches, and the deploy
 * confirmations and health gates a release's deploys owe. Must be called once at boot AFTER
 * startBoss(). Idempotent.
 */
export async function registerDeployWorker(): Promise<void> {
  if (workerId) return;
  await boss.createQueue(INTEGRATIONS_QUEUE_NAME);
  const id = await boss.work<OutboundDispatchJob | CoolifyConfirmJob | CoolifyHealthGateJob>(
    INTEGRATIONS_QUEUE_NAME,
    { batchSize: 1 },
    async (jobs) => {
      for (const entry of jobs) {
        const data = entry.data;
        if (!data) continue;
        try {
          if (data.jobKind === 'coolify.dispatch') {
            await runDispatch(data);
          } else if (data.jobKind === 'coolify.confirm') {
            const outcome = await runCoolifyConfirm(data);
            if (outcome.settled) {
              logger.info(
                { bindingId: data.bindingId, runId: data.runId, ...outcome },
                'deploy worker: coolify deploy confirmation settled',
              );
            }
          } else if (data.jobKind === 'coolify.health-gate') {
            const outcome = await runCoolifyHealthGate(data, healthGateDeps(data));
            if (outcome.verdict) {
              logger.info(
                { bindingId: data.bindingId, runId: data.runId, ...outcome },
                'deploy worker: coolify post-deploy health gate resolved',
              );
            }
          }
        } catch (err) {
          logger.error(
            { err, bindingId: data.bindingId, runId: data.runId, jobKind: data.jobKind },
            'deploy worker: coolify job threw — retry will be scheduled by pg-boss',
          );
          throw err;
        }
      }
    },
  );
  workerId = id;
  logger.info({ workerId, queue: INTEGRATIONS_QUEUE_NAME }, 'deploy worker registered');
}
