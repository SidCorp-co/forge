import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, pipelineRuns, projects } from '../db/schema.js';
import { findDeliveryByRequestId } from '../integrations/deliveries.js';
import { enqueueOutboundDispatch } from '../integrations/queue.js';
import { listActiveDeployBindingsForProvider } from '../integrations/store.js';
import { logger } from '../logger.js';
import { isSentryEnabled, Sentry } from '../observability/sentry.js';
import { openDeployDispatchHold } from './deploy-confirmations.js';
import { RELEASE_DEPLOY_IN_FLIGHT_STEP, setCurrentStep } from './runs.js';

/**
 * Substep markers stamped onto pipelineRuns.currentStep so the UI / WS
 * observers can render the deploy state without a state-machine change.
 * The in-flight / failed / done trio lives in `runs.ts` beside the gate that
 * writes it; these two are dispatch-side only.
 */
export const RELEASE_DEPLOY_PENDING = 'release.deploy.pending_human';
export const RELEASE_DEPLOY_SKIPPED = 'release.deploy.skipped';

export interface DispatchOutcome {
  dispatched: boolean;
  pendingHumanConfirm: boolean;
  integrationIds: string[];
  reason?: string;
}

/**
 * Per-project opt-in: when `agentConfig.pipelineConfig.autoProdDeploy === true`,
 * a prod Coolify deploy auto-dispatches on release exactly like staging,
 * skipping the human-confirm gate. Default false keeps the gate. Best-effort —
 * a read failure falls back to the safe (gated) behavior.
 */
export async function projectAutoProdDeploy(projectId: string): Promise<boolean> {
  try {
    const [row] = await db
      .select({ agentConfig: projects.agentConfig })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    const ac = (row?.agentConfig ?? null) as Record<string, unknown> | null;
    const pc = ac?.pipelineConfig as Record<string, unknown> | undefined;
    return pc?.autoProdDeploy === true;
  } catch (err) {
    logger.warn({ err, projectId }, 'coolify: failed to read autoProdDeploy — keeping prod gate');
    return false;
  }
}

/**
 * Whether a run-less action against a `prod` binding must park for a human.
 *
 * There is exactly one rule and this is the only place it is written: a prod
 * binding with no run behind it never dispatches, because confirming a prod
 * deploy is run-keyed and a run-less action has no gate to release. The
 * project can opt out wholesale with `pipelineConfig.autoProdDeploy`.
 */
export async function liveActionNeedsHumanConfirm(
  projectId: string,
  stages: readonly string[],
): Promise<boolean> {
  if (!stages.includes('live')) return false;
  return !(await projectAutoProdDeploy(projectId));
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
// cm:flow release/deploy after:reap — job completion, not the close, is what dispatches the deploy; a prod binding parks for a human unless pipelineConfig.autoProdDeploy is on
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
  let pairs = await listActiveDeployBindingsForProvider(projectId, 'coolify');
  if (integrationId) pairs = pairs.filter((p) => p.binding.id === integrationId);
  if (!allowLive) pairs = pairs.filter((p) => !(p.binding.stages ?? []).includes('live'));
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
    if ((binding.stages ?? []).includes('live') && !autoProd) {
      // Manual approval gate — never auto-dispatch prod. The UI sticky
      // banner calls /integrations/:id/confirm-prod-deploy to release the gate.
      // Skipped entirely when the project opted into autoProdDeploy.
      const gateState = await getProdGateState(binding.id);
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

  if (await liveActionNeedsHumanConfirm(projectId, binding.stages ?? [])) {
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

async function getProdGateState(bindingId: string): Promise<ProdGateState | null> {
  // Find the most recent run (regardless of status) that has a gate for this
  // integration. The release flow closes the issue-run before the deploy hook
  // fires, so we must look at completed runs too — otherwise the prod gate
  // would never be observable post-merge.
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

/**
 * Subscribes to `jobCompleted` and forwards `release`-type completions into
 * the Coolify dispatch path. Must be called once at boot.
 */
export function registerReleaseCompletedSubscriber(hooks: {
  on: (
    event: 'jobCompleted',
    listener: (payload: {
      jobId: string;
      projectId: string;
      issueId: string | null;
      type: string;
    }) => void | Promise<void>,
  ) => void;
}): void {
  hooks.on('jobCompleted', async (payload) => {
    if (payload.type !== 'release') return;

    if (!payload.issueId) return;
    const runId = await resolveLatestIssueRunId(payload.issueId);
    if (!runId) {
      logger.debug(
        { jobId: payload.jobId, issueId: payload.issueId },
        'release.deploy hook: no run found for issue — skipping coolify dispatch',
      );
      return;
    }
    try {
      await tryDispatchCoolifyRelease({
        projectId: payload.projectId,
        issueId: payload.issueId,
        runId,
      });
    } catch (err) {
      logger.error(
        { err, jobId: payload.jobId, projectId: payload.projectId },
        'release.deploy hook: dispatch threw',
      );
    }
  });
}
