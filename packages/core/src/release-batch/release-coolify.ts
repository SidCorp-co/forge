import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { pipelineRuns } from '../db/schema.js';
import { releaseAttempts } from '../db/schema-release-ledger.js';
import { coolifyIntegration } from '../integrations/deploy/index.js';
import {
  enqueueOutboundDispatch,
  listActiveDeployBindingsForProvider,
} from '../integrations/index.js';
import { traceStep } from '../lib/error-tracking.js';
import { logger } from '../lib/logger.js';
import {
  abandonDeployDispatchHold,
  acquireDeployLocks,
  type DeployLockHeld,
  openDeployDispatchHold,
  RELEASE_DEPLOY_IN_FLIGHT_STEP,
  setCurrentStep,
} from '../pipeline/index.js';
import { type DeployMap, readDeployMap } from '../project-config/index.js';
import {
  getProdGateStateForRun,
  markPendingHumanConfirm,
  reportUnwitnessedDeploy,
} from './coolify-prod-gate.js';
import { type AlreadySent, type DeployCaller, deployOnce } from './deploy-once.js';
import { productionDeploysOnLand } from './production-trigger.js';
import {
  deployLockIntent,
  freeLockIfNothingPending,
  giveBackUnusedEnvironments,
  locksOf,
  targetLabelOf,
} from './release-coolify-hold.js';

/** The provider these bindings belong to, as the adapter's own declaration names it (ADR 0006). */
const COOLIFY = coolifyIntegration.provider;

/** Stamped on the run's current step where nothing was dispatched; in-flight lives in `runs.ts`. */
const RELEASE_DEPLOY_SKIPPED = 'release.deploy.skipped';

export interface DispatchOutcome {
  dispatched: boolean;
  pendingHumanConfirm: boolean;
  integrationIds: string[];
  reason?: string;
  /** Each binding this call did not send to because the same deploy was already sent (ISS-1116). */
  alreadySent?: AlreadySent[];
  /** Each deploy an explicit redeploy went out over, named so the answer says it was on purpose. */
  redeployedOver?: AlreadySent[];
}

/** Who asked, and whether they asked to deploy again on purpose: the door's key (`deploy-once.ts`). */
interface DeployAsk {
  sentBy?: DeployCaller | null | undefined;
  redeploy?: boolean | undefined;
}

/**
 * Splits the bindings into those this deploy goes out to, each with the commit read for it, and
 * those a deploy already sent answers. An explicit redeploy sends to every one, naming what it
 * went out over.
 */
async function splitAlreadySent<T extends { binding: { id: string } }>(
  projectId: string,
  runId: string | null,
  pairs: readonly T[],
  ask: DeployAsk,
): Promise<{
  send: Array<T & { commit: string | null }>;
  alreadySent: AlreadySent[];
  redeployedOver: AlreadySent[];
}> {
  const send: Array<T & { commit: string | null }> = [];
  const alreadySent: AlreadySent[] = [];
  const redeployedOver: AlreadySent[] = [];
  for (const pair of pairs) {
    const once = await deployOnce({
      projectId,
      runId,
      bindingId: pair.binding.id,
      redeploy: ask.redeploy === true,
    });
    if (once.prior && ask.redeploy !== true) {
      alreadySent.push(once.prior);
      continue;
    }
    if (once.prior) redeployedOver.push(once.prior);
    send.push({ ...pair, commit: once.commit.commit });
  }
  return { send, alreadySent, redeployedOver };
}

/** What a dispatch reports beside its own outcome: the deploys it did not repeat, or went over. */
const keyed = (k: { alreadySent: AlreadySent[]; redeployedOver: AlreadySent[] }) => ({
  ...(k.alreadySent.length > 0 ? { alreadySent: k.alreadySent } : {}),
  ...(k.redeployedOver.length > 0 ? { redeployedOver: k.redeployedOver } : {}),
});

const noIntegration = (): DispatchOutcome => ({
  dispatched: false,
  pendingHumanConfirm: false,
  integrationIds: [],
  reason: 'no-integration',
});

const awaitingConfirm = (integrationIds: string[]): DispatchOutcome => ({
  dispatched: false,
  pendingHumanConfirm: true,
  integrationIds,
  reason: 'awaiting-prod-confirm',
});

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
  const pairs = await listActiveDeployBindingsForProvider(projectId, COOLIFY);
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
 * The bindings this dispatch sends to — every environment's own binding but one that deploys
 * itself (`trigger: provider`) — and how each one maps onto environments and production.
 */
async function deployTargets(projectId: string, integrationId: string | null, allowLive: boolean) {
  const allPairs = await listActiveDeployBindingsForProvider(projectId, COOLIFY);
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
  const pairs = allPairs.filter((p) => {
    const env = map.environments.get(p.binding.id);
    if (env === undefined || env.trigger === 'provider') return false;
    if (integrationId && p.binding.id !== integrationId) return false;
    return allowLive || !reachesLive(p.binding);
  });
  return { pairs, reachesLive, envOf, reachedBy };
}

/**
 * Whether a person confirmed this production deploy on this run. Never auto-dispatch prod: the UI
 * banner calls /integrations/:id/confirm-prod-deploy to release the gate.
 */
async function prodConfirmed(bindingId: string, runId: string): Promise<boolean> {
  const gateState = await getProdGateStateForRun(bindingId, runId);
  return gateState !== null && gateState.confirmedAt !== null;
}

/**
 * One queued deploy per armed binding; `dispatched` grows as each lands, so a throw shows how far.
 * A production deploy records its `deploy` attempt BEFORE it is queued: an abort reads that row as
 * "this run's code may be serving" (`releasing-recovery.ts:runRecordedPromotion`).
 */
async function enqueueArmed(
  armed: ReadonlyArray<{
    binding: { id: string; config: unknown };
    requestId: string;
    live: boolean;
    commit: string | null;
  }>,
  ctx: {
    runId: string;
    issueId: string | null;
    envOf: (binding: { id: string }) => string | null;
    targetLabels?: readonly string[] | undefined;
    ask: DeployAsk;
  },
  dispatched: string[],
): Promise<void> {
  for (const { binding, requestId, live, commit } of armed) {
    if (live) {
      await db
        .insert(releaseAttempts)
        .values({ runId: ctx.runId, stage: 'deploy', idempotencyKey: requestId })
        .onConflictDoNothing();
    }
    await enqueueOutboundDispatch({
      jobKind: 'coolify.dispatch',
      bindingId: binding.id,
      runId: ctx.runId,
      issueId: ctx.issueId,
      eventName: 'release.requested',
      requestId,
      ...sentPayload(ctx.runId, ctx.issueId, commit, ctx.ask, ctx.targetLabels),
    });
    dispatched.push(binding.id);
    traceStep({
      category: 'integration.coolify.dispatch',
      level: 'info',
      message: 'enqueued coolify dispatch',
      data: { bindingId: binding.id, environment: ctx.envOf(binding), runId: ctx.runId },
    });
  }
}

/**
 * The job payload, which the adapter writes onto each target's delivery: the run, the commit the door
 * read and who asked, the door's own record of what it sent (`sent-deploys.ts`); and the targets a
 * web-only deploy reaches (`adapter.ts:dispatchOutbound` deploys those alone), absent for every one.
 */
function sentPayload(
  runId: string | null,
  issueId: string | null,
  commit: string | null,
  ask: DeployAsk,
  targetLabels: readonly string[] | undefined,
): { payload: Record<string, unknown> } {
  return {
    payload: {
      runId,
      issueId,
      commit,
      sentBy: ask.sentBy ?? null,
      ...(ask.redeploy === true ? { redeploy: true } : {}),
      ...(targetLabels ? { targetLabels: [...targetLabels] } : {}),
    },
  };
}

/**
 * Enqueue a Coolify deploy for each active binding an environment of the project document names,
 * except one whose environment deploys itself (`trigger: provider`); a project with nothing to
 * dispatch returns `reason: 'no-integration'` and stamps the skipped substep.
 */
// release/deploy after:stamp — the deploy is a caller's act on a landed change (`POST …/integrations/coolify/deploy`): the issue path reaches every environment but production before the release stage, and the release run reaches production; a binding reaching production parks for a human unless the project document's production environment deploys on-land
export async function tryDispatchCoolifyRelease(args: {
  projectId: string;
  issueId: string | null;
  runId: string;
  /** Hard filter — when set, dispatch ONLY this binding. */
  integrationId?: string | null;
  allowLive?: boolean;
  /** ISS-1279 — the release path passes it; the landing auto-subscriber does not. */
  takeEnvironmentLock?: boolean;
  /** Deploy only these targets of each binding: the fast lane's web-only deploy (REQ-39 BC-7). */
  targetLabels?: readonly string[] | undefined;
} & DeployAsk): Promise<DispatchOutcome> {
  const { projectId, issueId, runId } = args;
  const takeEnvironmentLock = args.takeEnvironmentLock === true;
  await warnIfRunAlreadyTerminal(runId, issueId);
  const targets = await deployTargets(projectId, args.integrationId ?? null, args.allowLive ?? true);
  const { reachesLive, envOf, reachedBy } = targets;
  if (targets.pairs.length === 0) {
    await setCurrentStep(runId, RELEASE_DEPLOY_SKIPPED);
    return noIntegration();
  }
  // ISS-1116: a deploy this run already sent at this commit answers the call, before any lock is
  // taken, so a repeat never reaches Coolify, nor another run's deploy of a commit already running
  const once = await splitAlreadySent(projectId, runId, targets.pairs, args);
  const pairs = once.send;
  if (pairs.length === 0) {
    return {
      dispatched: false,
      pendingHumanConfirm: false,
      integrationIds: [],
      reason: 'already-sent',
      ...keyed(once),
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
  const armed: Array<{
    binding: (typeof pairs)[number]['binding'];
    requestId: string;
    live: boolean;
    commit: string | null;
  }> = [];
  let witnessed = 0;
  try {
    for (const { binding, commit } of pairs) {
      if (reachesLive(binding) && !autoProd && !(await prodConfirmed(binding.id, runId))) {
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
      armed.push({ binding, requestId, live: reachesLive(binding), commit });
    }

    await enqueueArmed(
      armed,
      {
        runId,
        issueId,
        envOf,
        targetLabels: args.targetLabels,
        ask: { sentBy: args.sentBy, redeploy: args.redeploy },
      },
      dispatched,
    );
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

  if (dispatched.length > 0 || !pendingHumanConfirm) {
    return {
      dispatched: dispatched.length > 0,
      pendingHumanConfirm,
      integrationIds: dispatched,
      ...keyed(once),
    };
  }
  const parked = pairs.filter((p) => reachesLive(p.binding)).map((p) => p.binding.id);
  return { ...awaitingConfirm(parked), ...keyed(once) };
}

/** A uuid fixed by `key`: the same act always names the same job. */
function jobIdOf(key: string): string {
  const h = createHash('sha256').update(key).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export async function dispatchCoolifyDeployDirect(args: {
  projectId: string;
  integrationId: string;
  /** Deploy only these targets of the binding: the fast lane's web-only deploy (REQ-39 BC-7). */
  targetLabels?: readonly string[] | undefined;
  /**
   * One act's own key, so a redelivered landing deploys once (`landing-deploy.ts`): the job is queued
   * under an id derived from it, and a second send finds it there. Fresh where absent.
   */
  requestId?: string | undefined;
} & DeployAsk): Promise<DispatchOutcome> {
  const { projectId, integrationId } = args;
  const pairs = await listActiveDeployBindingsForProvider(projectId, COOLIFY);
  const pair = pairs.find((p) => p.binding.id === integrationId);
  if (!pair) return noIntegration();
  const { binding } = pair;

  if (await liveActionNeedsHumanConfirm(projectId, binding)) return awaitingConfirm([binding.id]);

  // ISS-1116: with no run, only a deploy of the same commit still running answers this one
  const once = await splitAlreadySent(projectId, null, [pair], args);
  const [send] = once.send;
  if (!send) {
    return {
      dispatched: false,
      pendingHumanConfirm: false,
      integrationIds: [],
      reason: 'already-sent',
      ...keyed(once),
    };
  }

  const requestId =
    args.requestId ?? `direct:${binding.id}:${Date.now()}-${randomUUID().slice(0, 8)}`;
  await enqueueOutboundDispatch(
    {
      jobKind: 'coolify.dispatch',
      bindingId: binding.id,
      runId: null,
      issueId: null,
      eventName: 'release.requested',
      requestId,
      ...sentPayload(null, null, send.commit, args, args.targetLabels),
    },
    args.requestId ? { jobId: jobIdOf(args.requestId) } : {},
  );

  traceStep({
    category: 'integration.coolify.dispatch',
    level: 'info',
    message: 'enqueued run-less coolify dispatch',
    data: { bindingId: binding.id, runId: null },
  });

  return {
    dispatched: true,
    pendingHumanConfirm: false,
    integrationIds: [binding.id],
    ...keyed(once),
  };
}
