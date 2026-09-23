import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, pipelineRuns } from '../db/schema.js';
import { findDeliveryByRequestId } from '../integrations/deliveries.js';
import { enqueueOutboundDispatch } from '../integrations/queue.js';
import { listActiveDeployBindingsForProvider } from '../integrations/store.js';
import { logger } from '../logger.js';
import { isSentryEnabled, Sentry } from '../observability/sentry.js';
import { projectAutoProdDeploy } from './auto-prod-deploy.js';
import { openDeployDispatchHold } from './deploy-confirmations.js';
import { RELEASE_DEPLOY_IN_FLIGHT_STEP, setCurrentStep } from './runs.js';

/**
 * Substep markers stamped onto pipelineRuns.currentStep so the UI / WS
 * observers can render the deploy state without a state-machine change.
 * The in-flight / failed / done trio lives in `runs.ts` beside the gate that
 * writes it; these two are dispatch-side only.
 */
/** Re-exported so this module's existing callers and their mocks keep one path. */
export { projectAutoProdDeploy };

export const RELEASE_DEPLOY_PENDING = 'release.deploy.pending_human';
export const RELEASE_DEPLOY_SKIPPED = 'release.deploy.skipped';

export interface DispatchOutcome {
  dispatched: boolean;
  pendingHumanConfirm: boolean;
  integrationIds: string[];
  reason?: string;
}

/**
 * Whether a run-less action against a `prod` binding must park for a human.
 *
 * A prod binding with no run behind it never dispatches, because confirming a
 * prod deploy is run-keyed and a run-less action has no gate to release. The
 * project can opt out wholesale with `pipelineConfig.autoProdDeploy`.
 * `tryDispatchCoolifyRelease` applies the same rule through `reachesLiveOf`,
 * which it needs anyway to answer for a whole binding set at once.
 */
export async function liveActionNeedsHumanConfirm(
  projectId: string,
  stages: readonly string[],
  targets: readonly string[] = [],
): Promise<boolean> {
  const reachesLive =
    stages.includes('live') || (await sharesAResourceWithLive(projectId, targets));
  if (!reachesLive) return false;
  return !(await projectAutoProdDeploy(projectId));
}

/**
 * Whether these resources are also served by a binding that carries `live`.
 *
 * A stage is a label on a binding; the production box is a fact about what the
 * binding deploys to. Where one branch and one application serve both stages,
 * asking only the label lets a `preview` deploy reach production with no human
 * in front of it — measured on forge-dev, whose two deploy bindings both target
 * `y8w4c4kss8ogo8gc44ow44kc`. A project whose stages are separate boxes shares
 * no resource here, so this answers `false` and the gate is what it was.
 */
async function sharesAResourceWithLive(
  projectId: string,
  targets: readonly string[],
): Promise<boolean> {
  if (targets.length === 0) return false;
  try {
    const pairs = await listActiveDeployBindingsForProvider(projectId, 'coolify');
    const live = new Set(
      pairs
        .filter((p) => (p.binding.stages ?? []).includes('live'))
        .flatMap((p) => resourceUuidsOf(p.binding.config)),
    );
    return targets.some((t) => live.has(t));
  } catch (err) {
    logger.warn({ err, projectId }, 'coolify: could not read sibling bindings — keeping prod gate');
    return true;
  }
}

/**
 * Which of these bindings reach the production box — by carrying `live`, or by
 * deploying to an application a `live` binding also deploys to.
 *
 * Built from the WHOLE binding set before any filter, because the shared
 * resource is only visible while the `live` binding is still in the list: drop
 * it first and the one beside it stops looking like production.
 */
function reachesLiveOf(
  pairs: ReadonlyArray<{ binding: { stages: string[] | null; config: unknown } }>,
): (binding: { stages: string[] | null; config: unknown }) => boolean {
  const live = new Set(
    pairs
      .filter((p) => (p.binding.stages ?? []).includes('live'))
      .flatMap((p) => resourceUuidsOf(p.binding.config)),
  );
  return (binding) =>
    (binding.stages ?? []).includes('live') ||
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
 * Enqueue a Coolify deploy for each active binding of this project, called
 * after a release-type job completes. A prod binding is parked for a human
 * unless the project opted into `autoProdDeploy`; a project with no binding
 * at all returns `reason: 'no-integration'` and stamps the skipped substep.
 */
// cm:flow release/deploy after:stamp — the landing is what dispatches the deploy: an issue arriving at `developed` calls this, which is why a change is judgeable before anything reaches the release gate; a prod binding parks for a human unless pipelineConfig.autoProdDeploy is on
export async function tryDispatchCoolifyRelease(args: {
  projectId: string;
  issueId: string | null;
  runId: string;
  /** Hard filter — when set, dispatch ONLY this binding. */
  integrationId?: string | null;
  allowLive?: boolean;
}): Promise<DispatchOutcome> {
  const { projectId, issueId, runId, integrationId, allowLive = true } = args;
  await warnIfRunAlreadyTerminal(runId, issueId);
  const allPairs = await listActiveDeployBindingsForProvider(projectId, 'coolify');
  const reachesLive = reachesLiveOf(allPairs);
  let pairs = allPairs;
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

  const dispatched: string[] = [];
  let pendingHumanConfirm = false;
  const autoProd = await projectAutoProdDeploy(projectId);

  for (const { binding } of pairs) {
    if (reachesLive(binding) && !autoProd) {
      // Manual approval gate — never auto-dispatch prod. The UI sticky
      // banner calls /integrations/:id/confirm-prod-deploy to release the gate.
      // Skipped entirely when the project opted into autoProdDeploy.
      const gateState = await getProdGateStateForRun(binding.id, runId);
      if (!gateState || gateState.confirmedAt === null) {
        await markPendingHumanConfirm({ runId, issueId, bindingId: binding.id });
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
      targetLabel: `${(binding.stages ?? []).join('+') || binding.role} deploy`,
    });
    if (!held) reportUnwitnessedDeploy(runId, issueId, binding.id);
    await enqueueOutboundDispatch({
      jobKind: 'coolify.dispatch',
      bindingId: binding.id,
      runId,
      issueId,
      eventName: 'release.requested',
      requestId,
    });
    dispatched.push(binding.id);

    if (isSentryEnabled()) {
      Sentry.addBreadcrumb({
        category: 'integration.coolify.dispatch',
        level: 'info',
        message: 'enqueued coolify dispatch',
        data: { bindingId: binding.id, stages: binding.stages, runId },
      });
    }
  }

  if (dispatched.length === 0 && pendingHumanConfirm) {
    return {
      dispatched: false,
      pendingHumanConfirm: true,
      integrationIds: pairs
        .filter((p) => (p.binding.stages ?? []).includes('live'))
        .map((p) => p.binding.id),
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

  if (
    await liveActionNeedsHumanConfirm(
      projectId,
      binding.stages ?? [],
      resourceUuidsOf(binding.config),
    )
  ) {
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

  if (isSentryEnabled()) {
    Sentry.addBreadcrumb({
      category: 'integration.coolify.dispatch',
      level: 'info',
      message: 'enqueued run-less coolify dispatch',
      data: { bindingId: binding.id, stages: binding.stages, runId: null },
    });
  }

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
}

const GATE_METADATA_KEY = '__forge_prod_deploy_gate';

async function markPendingHumanConfirm(input: {
  runId: string;
  issueId: string | null;
  bindingId: string;
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

export interface ConfirmProdResult {
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
  const confirmedRequestId = `${run.id}:${bindingId}:confirmed`;
  const existing = await findDeliveryByRequestId(bindingId, confirmedRequestId);
  if (!existing) {
    const held = await openDeployDispatchHold({
      runId: run.id,
      bindingId,
      requestId: confirmedRequestId,
      targetLabel: 'prod deploy',
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
