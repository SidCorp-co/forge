import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, pipelineRuns } from '../db/schema.js';
import {
  enqueueOutboundDispatch,
  findDeliveryByRequestId,
  listActiveDeployBindingsForProvider,
} from '../integrations/index.js';
import { logger } from '../observability/logger.js';
import { traceStep } from '../observability/sentry.js';
import {
  abandonDeployDispatchHold,
  acquireDeployLocks,
  type DeployLockHeld,
  openDeployDispatchHold,
  RELEASE_DEPLOY_IN_FLIGHT_STEP,
  releaseDeployLocksForRun,
  setCurrentStep,
} from '../pipeline/index.js';
import { type DeployMap, readDeployMap } from '../project-config/index.js';
import { productionDeploysOnLand } from './production-trigger.js';
import {
  type DeployLockIntent,
  deployLockIntent,
  freeLockIfNothingPending,
  giveBackUnusedEnvironments,
  locksOf,
  targetLabelOf,
} from './release-coolify-hold.js';

/**
 * Substep markers stamped onto pipelineRuns.currentStep so the UI / WS
 * observers can render the deploy state without a state-machine change.
 * The in-flight / failed / done trio lives in `runs.ts` beside the gate that
 * writes it; these two are dispatch-side only.
 */
/** Re-exported so this module's existing callers and their mocks keep one path. */
export { productionDeploysOnLand };

const RELEASE_DEPLOY_PENDING = 'release.deploy.pending_human';
const RELEASE_DEPLOY_SKIPPED = 'release.deploy.skipped';

export interface DispatchOutcome {
  dispatched: boolean;
  pendingHumanConfirm: boolean;
  integrationIds: string[];
  reason?: string;
}

/**
 * Whether a run-less action against this binding must park for a human.
 *
 * A binding reaching production with no run behind it never dispatches, because confirming a
 * production deploy is run-keyed and a run-less action has no gate to release. The project opts
 * out when production deploys `on-land` (`productionDeploysOnLand`).
 */
export async function liveActionNeedsHumanConfirm(
  projectId: string,
  binding: { id: string; config: unknown },
): Promise<boolean> {
  let reaches: boolean;
  try {
    reaches = await bindingReachesProduction(projectId, binding);
  } catch (err) {
    logger.warn(
      { err, projectId },
      'coolify: could not read what reaches production — keeping prod gate',
    );
    return true;
  }
  if (!reaches) return false;
  return !(await productionDeploysOnLand(projectId));
}

/** Whether this binding deploys the production environment's box. */
export async function bindingReachesProduction(
  projectId: string,
  binding: { id: string; config: unknown },
): Promise<boolean> {
  const pairs = await listActiveDeployBindingsForProvider(projectId, 'coolify');
  return reachesProductionOf(await readDeployMap(projectId), pairs)(binding);
}

/**
 * Which of these bindings reach the production box — by being the production environment's
 * binding, or by deploying to an application that binding also deploys to.
 *
 * Built from the WHOLE binding set before any filter, because the shared resource is only
 * visible while the production binding is still in the list: drop it first and the one beside
 * it stops looking like production — measured on forge-dev, whose two deploy bindings both
 * target `y8w4c4kss8ogo8gc44ow44kc`.
 */
function reachesProductionOf(
  map: DeployMap,
  pairs: ReadonlyArray<{ binding: { id: string; config: unknown } }>,
): (binding: { id: string; config: unknown }) => boolean {
  const live = new Set(
    pairs
      .filter((p) => p.binding.id === map.productionBinding)
      .flatMap((p) => resourceUuidsOf(p.binding.config)),
  );
  return (binding) =>
    binding.id === map.productionBinding ||
    resourceUuidsOf(binding.config).some((u) => live.has(u));
}

/** The Coolify applications a binding's config names, however sparse it is. */
function resourceUuidsOf(config: unknown): string[] {
  const targets = (config as { targets?: unknown } | null)?.targets;
  if (!Array.isArray(targets)) return [];
  return targets
    .map((t) => (t as { resourceUuid?: unknown })?.resourceUuid)
    .filter((u): u is string => typeof u === 'string' && u.length > 0);
}

function reportUnwitnessedDeploy(runId: string, issueId: string | null, bindingId?: string): void {
  logger.error(
    { runId, issueId, ...(bindingId ? { bindingId } : {}) },
    'coolify dispatch: the run is terminal and refused the confirmation hold — this deploy will be polled and audited, but no run can witness its outcome',
  );
}

async function warnIfRunAlreadyTerminal(runId: string, issueId: string | null): Promise<void> {
  const [row] = await db
    .select({ status: pipelineRuns.status })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, runId))
    .limit(1);
  if (!row || row.status === 'running' || row.status === 'paused') return;
  reportUnwitnessedDeploy(runId, issueId);
}

/**
 * Enqueue a Coolify deploy for each active binding an environment of the project document names,
 * except one whose environment deploys itself (`trigger: provider`); a project with nothing to
 * dispatch returns `reason: 'no-integration'` and stamps the skipped substep.
 */
// cm:flow release/deploy after:stamp — the deploy is a caller's act on a landed change (`forge_coolify_deploy`): the issue path reaches every environment but production before the release stage, and the release run reaches production; a binding reaching production parks for a human unless the project document's production environment deploys on-land
export async function tryDispatchCoolifyRelease(args: {
  projectId: string;
  issueId: string | null;
  runId: string;
  /** Hard filter — when set, dispatch ONLY this binding. */
  integrationId?: string | null;
  allowLive?: boolean;
  /** ISS-1279 — the release path passes it; the landing auto-subscriber does not. */
  takeEnvironmentLock?: boolean;
}): Promise<DispatchOutcome> {
  const { projectId, issueId, runId, integrationId, allowLive = true } = args;
  const takeEnvironmentLock = args.takeEnvironmentLock === true;
  await warnIfRunAlreadyTerminal(runId, issueId);
  const allPairs = await listActiveDeployBindingsForProvider(projectId, 'coolify');
  const map = await readDeployMap(projectId);
  const reachesLive = reachesProductionOf(map, allPairs);
  const envOf = (binding: { id: string }) => map.environments.get(binding.id)?.name ?? null;
  const production = map.productionBinding
    ? (map.environments.get(map.productionBinding)?.name ?? null)
    : null;
  const reachedBy = (binding: { id: string; config: unknown }): string[] => {
    const own = envOf(binding);
    const reached = production !== null && reachesLive(binding) ? [production] : [];
    return [...new Set([...(own ? [own] : []), ...reached])];
  };
  let pairs = allPairs.filter((p) => {
    const env = map.environments.get(p.binding.id);
    return env !== undefined && env.trigger !== 'provider';
  });
  if (integrationId) pairs = pairs.filter((p) => p.binding.id === integrationId);
  if (!allowLive) pairs = pairs.filter((p) => !reachesLive(p.binding));
  if (pairs.length === 0) {
    await setCurrentStep(runId, RELEASE_DEPLOY_SKIPPED);
    return {
      dispatched: false,
      pendingHumanConfirm: false,
      integrationIds: [],
      reason: 'no-integration',
    };
  }

  const lock = takeEnvironmentLock ? deployLockIntent(projectId, pairs, reachedBy) : null;
  // Each placeholder records the rows its own binding needs (ISS-1279).
  const takenLocks: DeployLockHeld[] = lock
    ? await acquireDeployLocks({ projectId, runId, subject: lock.subject }, lock.environments)
    : [];

  const dispatched: string[] = [];
  let pendingHumanConfirm = false;
  const autoProd = await productionDeploysOnLand(projectId);

  // EVERY hold before the FIRST enqueue: opened beside its own enqueue, the holds registered so
  // far read as the whole set, and a target settling there closes the run and frees the
  // environment while a binding this loop has not reached is still to be dispatched.
  const armed: Array<{ binding: (typeof pairs)[number]['binding']; requestId: string }> = [];
  let witnessed = 0;
  try {
    for (const { binding } of pairs) {
      if (reachesLive(binding) && !autoProd) {
        // Manual approval gate — never auto-dispatch prod. The UI sticky
        // banner calls /integrations/:id/confirm-prod-deploy to release the gate.
        // Skipped entirely where production deploys on-land.
        const gateState = await getProdGateStateForRun(binding.id, runId);
        if (!gateState || gateState.confirmedAt === null) {
          await markPendingHumanConfirm({
            runId,
            issueId,
            bindingId: binding.id,
            // THIS binding's, never the fan-out's: a sibling's would refuse its own press.
            ...(lock ? { lock: deployLockIntent(projectId, [{ binding }], reachedBy) } : {}),
          });
          pendingHumanConfirm = true;
          continue;
        }
      }

      const requestId = `${runId}:${binding.id}:${Date.now()}-${randomUUID().slice(0, 8)}`;
      await setCurrentStep(runId, RELEASE_DEPLOY_IN_FLIGHT_STEP);
      const held = await openDeployDispatchHold({
        runId,
        bindingId: binding.id,
        requestId,
        targetLabel: targetLabelOf(envOf(binding), binding),
        // One this fan-out WROTE, never one it attempted (ISS-1279).
        authorisedBySibling: witnessed > 0,
        locks: locksOf(takenLocks, deployLockIntent(projectId, [{ binding }], reachedBy)),
      });
      if (held) witnessed += 1;
      else reportUnwitnessedDeploy(runId, issueId, binding.id);
      armed.push({ binding, requestId });
    }

    for (const { binding, requestId } of armed) {
      await enqueueOutboundDispatch({
        jobKind: 'coolify.dispatch',
        bindingId: binding.id,
        runId,
        issueId,
        eventName: 'release.requested',
        requestId,
      });
      dispatched.push(binding.id);

      traceStep({
        category: 'integration.coolify.dispatch',
        level: 'info',
        message: 'enqueued coolify dispatch',
        data: { bindingId: binding.id, environment: envOf(binding), runId },
      });
    }
  } catch (err) {
    // A placeholder whose deploy was never queued is a hold nothing can settle.
    for (const { binding, requestId } of armed) {
      if (!dispatched.includes(binding.id)) await abandonDeployDispatchHold(runId, requestId);
    }
    await freeLockIfNothingPending(lock, runId, dispatched, takenLocks);
    throw err;
  }
  // Only where something WAS armed: with nothing armed the whole hold goes back below.
  if (armed.length > 0) {
    await giveBackUnusedEnvironments(
      runId,
      takenLocks,
      armed.flatMap(
        ({ binding }) => deployLockIntent(projectId, [{ binding }], reachedBy).environments,
      ),
    );
  }
  await freeLockIfNothingPending(lock, runId, dispatched, takenLocks);

  if (dispatched.length === 0 && pendingHumanConfirm) {
    return {
      dispatched: false,
      pendingHumanConfirm: true,
      integrationIds: pairs.filter((p) => reachesLive(p.binding)).map((p) => p.binding.id),
      reason: 'awaiting-prod-confirm',
    };
  }
  return { dispatched: dispatched.length > 0, pendingHumanConfirm, integrationIds: dispatched };
}

export async function dispatchCoolifyDeployDirect(args: {
  projectId: string;
  integrationId: string;
}): Promise<DispatchOutcome> {
  const { projectId, integrationId } = args;
  const pairs = await listActiveDeployBindingsForProvider(projectId, 'coolify');
  const pair = pairs.find((p) => p.binding.id === integrationId);
  if (!pair) {
    return {
      dispatched: false,
      pendingHumanConfirm: false,
      integrationIds: [],
      reason: 'no-integration',
    };
  }
  const { binding } = pair;

  if (await liveActionNeedsHumanConfirm(projectId, binding)) {
    return {
      dispatched: false,
      pendingHumanConfirm: true,
      integrationIds: [binding.id],
      reason: 'awaiting-prod-confirm',
    };
  }

  const requestId = `direct:${binding.id}:${Date.now()}-${randomUUID().slice(0, 8)}`;
  await enqueueOutboundDispatch({
    jobKind: 'coolify.dispatch',
    bindingId: binding.id,
    runId: null,
    issueId: null,
    eventName: 'release.requested',
    requestId,
  });

  traceStep({
    category: 'integration.coolify.dispatch',
    level: 'info',
    message: 'enqueued run-less coolify dispatch',
    data: { bindingId: binding.id, runId: null },
  });

  return { dispatched: true, pendingHumanConfirm: false, integrationIds: [binding.id] };
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

async function markPendingHumanConfirm(input: {
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
  await db
    .update(pipelineRuns)
    .set({
      metadata: { ...current, [GATE_METADATA_KEY]: gates },
      updatedAt: new Date(),
    })
    .where(eq(pipelineRuns.id, input.runId));

  await setCurrentStep(input.runId, RELEASE_DEPLOY_PENDING);

  logger.info(
    { bindingId: input.bindingId, runId: input.runId },
    'coolify: prod deploy awaiting human confirmation',
  );
}

/** One human confirmation authorises one deploy, so the gate is run-scoped. */
async function getProdGateStateForRun(
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
    await db
      .update(pipelineRuns)
      .set({ metadata: { ...md, [GATE_METADATA_KEY]: gates }, updatedAt: new Date() })
      .where(eq(pipelineRuns.id, run.id));

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

export async function resolveLatestIssueRunId(issueId: string): Promise<string | null> {
  const [run] = await db
    .select({ id: pipelineRuns.id })
    .from(pipelineRuns)
    .where(and(eq(pipelineRuns.issueId, issueId), eq(pipelineRuns.kind, 'issue')))
    .orderBy(desc(pipelineRuns.createdAt))
    .limit(1);
  return run?.id ?? null;
}

/**
 * Whether an issue has reached the post-release stage (`awaiting_release`/`closed`) —
 * the only statuses where an agent-driven `forge_coolify_deploy` call is
 * allowed to touch a prod integration. Every pre-release status returns
 * `false`, so a mid-pipeline deploy (code/fix/testing) is staging-only.
 */
export async function isIssueAtReleaseStage(issueId: string): Promise<boolean> {
  const [row] = await db
    .select({ status: issues.status })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  return row?.status === 'awaiting_release' || row?.status === 'closed';
}
