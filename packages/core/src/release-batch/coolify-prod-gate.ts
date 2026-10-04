// The production confirm gate: a deploy reaching production parks on its run until a person
// presses confirm, unless the project's production environment deploys on-land.

import { desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { pipelineRuns } from '../db/schema.js';
import { enqueueOutboundDispatch, findDeliveryByRequestId } from '../integrations/index.js';
import { logger } from '../observability/logger.js';
import {
  acquireDeployLocks,
  type DeployLockHeld,
  openDeployDispatchHold,
  RELEASE_DEPLOY_IN_FLIGHT_STEP,
  releaseDeployLocksForRun,
  setCurrentStep,
} from '../pipeline/index.js';
import { releaseBatchPorts } from './ports.js';
import type { DeployLockIntent } from './release-coolify-hold.js';

const RELEASE_DEPLOY_PENDING = 'release.deploy.pending_human';

export function reportUnwitnessedDeploy(
  runId: string,
  issueId: string | null,
  bindingId?: string,
): void {
  logger.error(
    { runId, issueId, ...(bindingId ? { bindingId } : {}) },
    'coolify dispatch: the run is terminal and refused the confirmation hold — this deploy will be polled and audited, but no run can witness its outcome',
  );
}

// Pending-confirmation gate state. Persisted on pipelineRuns.metadata under
// a stable key so the inbound webhook and the UI banner can observe it.
interface ProdGateState {
  runId: string;
  issueId: string | null;
  bindingId: string;
  requestedAt: string;
  confirmedAt: string | null;
  confirmedByUserId?: string;
  /** ISS-1279 — set only where the parked deploy held the lock, and carried rather than
   *  recomputed: the confirm endpoint resolves no binding set of its own. */
  lock?: DeployLockIntent;
}

const GATE_METADATA_KEY = '__forge_prod_deploy_gate';

export async function markPendingHumanConfirm(input: {
  runId: string;
  issueId: string | null;
  bindingId: string;
  lock?: DeployLockIntent;
}): Promise<void> {
  const [row] = await db
    .select({ metadata: pipelineRuns.metadata })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, input.runId))
    .limit(1);
  const current = (row?.metadata ?? {}) as Record<string, unknown>;
  const gates = (current[GATE_METADATA_KEY] as Record<string, ProdGateState>) ?? {};
  gates[input.bindingId] = {
    runId: input.runId,
    issueId: input.issueId,
    bindingId: input.bindingId,
    requestedAt: new Date().toISOString(),
    confirmedAt: null,
    ...(input.lock ? { lock: input.lock } : {}),
  };
  await releaseBatchPorts().writeRunMetadata(input.runId, {
    merge: { [GATE_METADATA_KEY]: gates },
    touch: true,
  });

  await setCurrentStep(input.runId, RELEASE_DEPLOY_PENDING);

  logger.info(
    { bindingId: input.bindingId, runId: input.runId },
    'coolify: prod deploy awaiting human confirmation',
  );
}

/** One human confirmation authorises one deploy, so the gate is run-scoped. */
export async function getProdGateStateForRun(
  bindingId: string,
  runId: string,
): Promise<ProdGateState | null> {
  const [row] = await db
    .select({ metadata: pipelineRuns.metadata })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, runId))
    .limit(1);
  const md = (row?.metadata ?? {}) as Record<string, unknown>;
  const gates = (md[GATE_METADATA_KEY] as Record<string, ProdGateState>) ?? {};
  const gate = gates[bindingId];
  if (!gate) return null;
  return gate.runId === runId ? gate : null;
}

async function getProdGateState(bindingId: string): Promise<ProdGateState | null> {
  // The confirm endpoint is handed a binding id and nothing else, and the run
  // that opened the gate may already be closed, so completed runs are in scope.
  const rows = await db
    .select({ id: pipelineRuns.id, metadata: pipelineRuns.metadata })
    .from(pipelineRuns)
    .orderBy(desc(pipelineRuns.updatedAt))
    .limit(100);
  for (const r of rows) {
    const md = (r.metadata ?? {}) as Record<string, unknown>;
    const gates = (md[GATE_METADATA_KEY] as Record<string, ProdGateState>) ?? {};
    const g = gates[bindingId];
    if (g) return g;
  }
  return null;
}

interface ConfirmProdResult {
  confirmed: boolean;
  runId: string | null;
  /** The binding id the confirmation targeted (== old project_integration id). */
  integrationId: string;
}

/**
 * Called by POST /api/projects/:projectId/integrations/:id/confirm-prod-deploy.
 * Flips the gate state to confirmed and enqueues the deploy. `bindingId` is the
 * `:id` route param (a binding id).
 */
export async function confirmPendingProdDeploy(
  bindingId: string,
  confirmedByUserId?: string,
): Promise<ConfirmProdResult> {
  const gate = await getProdGateState(bindingId);
  if (!gate) {
    return { confirmed: false, runId: null, integrationId: bindingId };
  }

  const [run] = await db
    .select({ id: pipelineRuns.id, metadata: pipelineRuns.metadata })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, gate.runId))
    .limit(1);
  if (!run) return { confirmed: false, runId: null, integrationId: bindingId };

  // ISS-1279 — the same release reaching the same box, taken BEFORE the gate flips so a refused confirmation can be pressed again.
  const confirmedRequestId = `${run.id}:${bindingId}:confirmed`;
  const alreadyEnqueued = await findDeliveryByRequestId(bindingId, confirmedRequestId);
  const took = Boolean(gate.lock) && !alreadyEnqueued;
  let taken: DeployLockHeld[] = [];
  if (gate.lock && took) {
    taken = await acquireDeployLocks(
      { projectId: gate.lock.projectId, runId: run.id, subject: gate.lock.subject },
      gate.lock.environments,
    );
  }

  let enqueued = false;
  try {
    const md = (run.metadata ?? {}) as Record<string, unknown>;
    const gates = (md[GATE_METADATA_KEY] as Record<string, ProdGateState>) ?? {};
    gates[bindingId] = {
      ...gate,
      confirmedAt: new Date().toISOString(),
      ...(confirmedByUserId ? { confirmedByUserId } : {}),
    };
    await releaseBatchPorts().writeRunMetadata(run.id, {
      merge: { [GATE_METADATA_KEY]: gates },
      touch: true,
    });

    await setCurrentStep(run.id, RELEASE_DEPLOY_IN_FLIGHT_STEP);

    // Same idempotency guard as the staging loop (ISS-242): a confirmed prod
    // deploy already enqueued for this `:confirmed` requestId must not fire
    // twice if the confirm endpoint is hit again.
    if (!alreadyEnqueued) {
      const held = await openDeployDispatchHold({
        runId: run.id,
        bindingId,
        requestId: confirmedRequestId,
        targetLabel: 'prod deploy',
        locks: taken,
      });
      if (!held) reportUnwitnessedDeploy(run.id, gate.issueId, bindingId);
      await enqueueOutboundDispatch({
        jobKind: 'coolify.dispatch',
        bindingId,
        runId: run.id,
        issueId: gate.issueId,
        eventName: 'release.requested',
        requestId: confirmedRequestId,
      });
      enqueued = true;
    }
  } catch (err) {
    // Left standing, this hold would refuse the person's own next press, in their run's name.
    if (took && !enqueued) await releaseDeployLocksForRun(run.id, taken);
    throw err;
  }

  return { confirmed: true, runId: run.id, integrationId: bindingId };
}
