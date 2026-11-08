// The production confirm gate: a deploy reaching production parks on its run until a person
// presses confirm, unless the project's production environment deploys on-land.

import { desc, eq, inArray, type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { pipelineRuns } from '../db/schema.js';
import { enqueueOutboundDispatch, findDeliveryByRequestId } from '../integrations/index.js';
import { logger } from '../lib/logger.js';
import { peopleOf } from '../lib/people.js';
import { emitEvent } from '../outbox/index.js';
import {
  acquireDeployLocks,
  type DeployLockHeld,
  openDeployDispatchHold,
  RELEASE_DEPLOY_IN_FLIGHT_STEP,
  releaseDeployLocksForRun,
  setCurrentStep,
  writeRunMetadata,
} from '../pipeline/index.js';
import { type ProjectDocument, productionSitesOf } from '../project-config/index.js';
import { type ResumeOutcome, resumeConfirmedRelease } from './confirm-resume.js';
import type { ReleaseChannel } from './plan.js';
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

/** A production deploy parked on its run for a person's confirm, not pressed yet (ISS-1096). */
export interface PendingProdConfirm {
  bindingId: string;
  requestedAt: string;
}

/**
 * The production deploy a run's metadata holds parked for a person's confirm, the oldest first, or
 * null where none waits: what the release reads as waiting on that person (`release-view.ts`).
 */
export function pendingProdConfirmOf(metadata: unknown): PendingProdConfirm | null {
  const gates = (metadata as Record<string, unknown> | null)?.[GATE_METADATA_KEY];
  if (typeof gates !== 'object' || gates === null) return null;
  const waiting = Object.values(gates as Record<string, Partial<ProdGateState>>)
    .filter((g) => typeof g?.bindingId === 'string' && !g.confirmedAt)
    .map((g) => ({ bindingId: g.bindingId as string, requestedAt: String(g.requestedAt ?? '') }))
    .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
  return waiting[0] ?? null;
}

/**
 * Whether a run's `metadata` (as SQL) holds a production deploy parked for a person's confirm: the
 * run waits on that person, so no sweep closes it for the job under it having ended (ISS-1096).
 */
export const awaitsProdConfirm = (metadata: SQL): SQL => sql`(
  jsonb_typeof(${metadata} -> ${GATE_METADATA_KEY}) = 'object'
  AND EXISTS (
    SELECT 1 FROM jsonb_each(${metadata} -> ${GATE_METADATA_KEY}) g
     WHERE coalesce(g.value ->> 'confirmedAt', '') = ''
  ))`;

/** The binding each of these runs waits on a person's confirm for, by run; runs with none are absent. */
export async function pendingProdConfirmsOfRuns(
  runIds: readonly string[],
): Promise<Map<string, PendingProdConfirm>> {
  if (runIds.length === 0) return new Map();
  const rows = await db
    .select({ id: pipelineRuns.id, metadata: pipelineRuns.metadata })
    .from(pipelineRuns)
    .where(inArray(pipelineRuns.id, [...runIds]));
  return new Map(
    rows.flatMap((r) => {
      const pending = pendingProdConfirmOf(r.metadata);
      return pending ? [[r.id, pending] as const] : [];
    }),
  );
}

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
  await writeRunMetadata(input.runId, {
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
  /** How the release run was carried on once confirmed (`confirm-resume.ts`); absent where none was. */
  resumed?: ResumeOutcome;
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
    await writeRunMetadata(run.id, {
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

  // the person's row leaves Needs you, and the release run is carried on to its finish (ISS-1096)
  const projectId = await announceConfirmed(run.id, gate.bindingId);
  const by = confirmedByUserId
    ? ((await peopleOf([confirmedByUserId])).get(confirmedByUserId)?.name ?? confirmedByUserId)
    : 'a project admin';
  const resumed = projectId && enqueued ? await resumeConfirmedRelease(run.id, by) : undefined;
  return {
    confirmed: true,
    runId: run.id,
    integrationId: bindingId,
    ...(resumed ? { resumed } : {}),
  };
}

/** The confirm settles the person's decision in Activity (`activity/settle-events.ts`); answers the run's project. */
async function announceConfirmed(runId: string, bindingId: string): Promise<string | null> {
  const [row] = await db
    .select({ projectId: pipelineRuns.projectId, version: pipelineRuns.releaseVersion })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, runId))
    .limit(1);
  if (!row) return null;
  await db.transaction((tx) =>
    emitEvent(tx, 'decision.settled', {
      projectId: row.projectId,
      act: 'release.confirmDeploy',
      subject: row.version ?? `${runId}:${bindingId}`,
    }),
  );
  return row.projectId;
}

/**
 * Whether a release's production deploy will park for a person's confirm: a production site is bound
 * to a Coolify binding the release run deploys, on request rather than on land or by the provider
 * itself (`release-coolify.ts:tryDispatchCoolifyRelease`), so the approval can say so (ISS-1096). Each
 * site keeps its own trigger (ISS-1077): one site deployed on request is enough.
 */
export function productionAsksConfirm(
  channels: readonly Pick<ReleaseChannel, 'provider'>[],
  document: ProjectDocument | undefined,
): boolean {
  if (channels[0]?.provider !== 'coolify' || !document) return false;
  return productionSitesOf(document).some((s) => s.trigger === 'on-request');
}
