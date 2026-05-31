import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { pipelineRuns, projectIntegrations } from '../db/schema.js';
import { findDeliveryByRequestId } from '../integrations/deliveries.js';
import { enqueueCoolifyDispatch } from '../integrations/queue.js';
import { logger } from '../logger.js';
import { isSentryEnabled, Sentry } from '../observability/sentry.js';
import { setCurrentStepForce } from './runs.js';

/**
 * Substep markers stamped onto pipelineRuns.currentStep so the UI / WS
 * observers can render the deploy state without a state-machine change.
 */
export const RELEASE_DEPLOY_PENDING = 'release.deploy.pending_human';
export const RELEASE_DEPLOY_IN_FLIGHT = 'release.deploy.in_flight';
export const RELEASE_DEPLOY_SKIPPED = 'release.deploy.skipped';

export interface DispatchOutcome {
  dispatched: boolean;
  pendingHumanConfirm: boolean;
  integrationIds: string[];
  reason?: string;
}

/**
 * Hook called after a `release`-type job completes. Looks up the project's
 * Coolify integrations (staging + prod), enqueues a deploy job for each
 * environment that's active and not waiting for prod confirmation.
 *
 * No-op (returns `dispatched=false, integrationIds=[]`) when the project
 * has no Coolify configured — preserves backwards-compatible behaviour.
 */
export async function tryDispatchCoolifyRelease(args: {
  projectId: string;
  issueId: string | null;
  runId: string;
}): Promise<DispatchOutcome> {
  const { projectId, issueId, runId } = args;
  const rows = await db
    .select()
    .from(projectIntegrations)
    .where(
      and(
        eq(projectIntegrations.projectId, projectId),
        eq(projectIntegrations.provider, 'coolify'),
        eq(projectIntegrations.active, true),
      ),
    );
  if (rows.length === 0) {
    await setCurrentStepForce(runId, RELEASE_DEPLOY_SKIPPED);
    return { dispatched: false, pendingHumanConfirm: false, integrationIds: [], reason: 'no-integration' };
  }

  const dispatched: string[] = [];
  let pendingHumanConfirm = false;

  for (const row of rows) {
    if (row.environment === 'prod') {
      // Manual approval gate — never auto-dispatch prod. The UI sticky
      // banner calls /integrations/:id/confirm-prod-deploy to release the gate.
      const gateState = await getProdGateState(row.id);
      if (!gateState || gateState.confirmedAt === null) {
        await markPendingHumanConfirm({ runId, issueId, integrationId: row.id });
        pendingHumanConfirm = true;
        continue;
      }
    }

    // Per-attempt requestId (ISS-290). Every deploy call is its own request, so
    // a re-deploy of the same run after a branch fix actually fires instead of
    // being silently no-op'd. The timestamp + random suffix keep the
    // `integration_deliveries` unique constraint + pg-boss singletonKey
    // collision-free (even for two dispatches in the same ms) without a dedup
    // lookup. (Coolify-side, the adapter force-rebuilds so the build is fresh.)
    const requestId = `${runId}:${row.id}:${Date.now()}-${randomUUID().slice(0, 8)}`;

    await setCurrentStepForce(runId, RELEASE_DEPLOY_IN_FLIGHT);
    await enqueueCoolifyDispatch({
      jobKind: 'coolify.dispatch',
      integrationId: row.id,
      runId,
      issueId,
      eventName: 'release.requested',
      requestId,
    });
    dispatched.push(row.id);

    if (isSentryEnabled()) {
      Sentry.addBreadcrumb({
        category: 'integration.coolify.dispatch',
        level: 'info',
        message: 'enqueued coolify dispatch',
        data: { integrationId: row.id, environment: row.environment, runId },
      });
    }
  }

  if (dispatched.length === 0 && pendingHumanConfirm) {
    return {
      dispatched: false,
      pendingHumanConfirm: true,
      integrationIds: rows.filter((r) => r.environment === 'prod').map((r) => r.id),
      reason: 'awaiting-prod-confirm',
    };
  }
  return { dispatched: dispatched.length > 0, pendingHumanConfirm, integrationIds: dispatched };
}

/**
 * Run-less Coolify deploy (ISS-312). Triggers a resource redeploy for a single
 * integration with no pipeline run attached — the path for a plain "ship latest
 * main now" that isn't tied to any issue. Keeps `tryDispatchCoolifyRelease`
 * run-centric and untouched.
 *
 * Enqueues with `runId=null` + a synthetic per-attempt requestId (no
 * `setCurrentStepForce` — there is no run to stamp). The adapter records the
 * outbound delivery with runId:null; the inbound webhook then no-ops (it can't
 * map a run), so a run-less deploy simply won't advance any pipeline.
 *
 * Prod is never auto-dispatched: a prod integration returns
 * `pendingHumanConfirm` without enqueueing. (The confirm-prod-deploy endpoint
 * is run-keyed, so completing a prod deploy still requires the issueId path —
 * documented limitation. The invariant that matters — prod is never
 * auto-dispatched run-less — is preserved.)
 */
export async function dispatchCoolifyDeployDirect(args: {
  projectId: string;
  integrationId: string;
}): Promise<DispatchOutcome> {
  const { projectId, integrationId } = args;
  const rows = await db
    .select()
    .from(projectIntegrations)
    .where(
      and(
        eq(projectIntegrations.projectId, projectId),
        eq(projectIntegrations.provider, 'coolify'),
        eq(projectIntegrations.active, true),
      ),
    );
  const row = rows.find((r) => r.id === integrationId);
  if (!row) {
    return { dispatched: false, pendingHumanConfirm: false, integrationIds: [], reason: 'no-integration' };
  }

  if (row.environment === 'prod') {
    // Prod is never auto-dispatched run-less. Confirming a prod deploy is
    // run-keyed (confirm-prod-deploy endpoint), so it still requires the
    // issueId path — return the gate outcome without enqueueing.
    return {
      dispatched: false,
      pendingHumanConfirm: true,
      integrationIds: [row.id],
      reason: 'awaiting-prod-confirm',
    };
  }

  const requestId = `direct:${integrationId}:${Date.now()}-${randomUUID().slice(0, 8)}`;
  await enqueueCoolifyDispatch({
    jobKind: 'coolify.dispatch',
    integrationId: row.id,
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
      data: { integrationId: row.id, environment: row.environment, runId: null },
    });
  }

  return { dispatched: true, pendingHumanConfirm: false, integrationIds: [row.id] };
}

// Pending-confirmation gate state. Persisted on pipelineRuns.metadata under
// a stable key so the inbound webhook and the UI banner can observe it.
interface ProdGateState {
  runId: string;
  issueId: string | null;
  integrationId: string;
  requestedAt: string;
  confirmedAt: string | null;
  confirmedByUserId?: string;
}

const GATE_METADATA_KEY = '__forge_prod_deploy_gate';

async function markPendingHumanConfirm(input: {
  runId: string;
  issueId: string | null;
  integrationId: string;
}): Promise<void> {
  const [row] = await db
    .select({ metadata: pipelineRuns.metadata })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, input.runId))
    .limit(1);
  const current = (row?.metadata ?? {}) as Record<string, unknown>;
  const gates = (current[GATE_METADATA_KEY] as Record<string, ProdGateState>) ?? {};
  gates[input.integrationId] = {
    runId: input.runId,
    issueId: input.issueId,
    integrationId: input.integrationId,
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

  await setCurrentStepForce(input.runId, RELEASE_DEPLOY_PENDING);

  logger.info(
    { integrationId: input.integrationId, runId: input.runId },
    'coolify: prod deploy awaiting human confirmation',
  );
}

async function getProdGateState(integrationId: string): Promise<ProdGateState | null> {
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
    const g = gates[integrationId];
    if (g) return g;
  }
  return null;
}

export interface ConfirmProdResult {
  confirmed: boolean;
  runId: string | null;
  integrationId: string;
}

/**
 * Called by POST /api/projects/:projectId/integrations/:id/confirm-prod-deploy.
 * Flips the gate state to confirmed and enqueues the deploy.
 */
export async function confirmPendingProdDeploy(
  integrationId: string,
  confirmedByUserId?: string,
): Promise<ConfirmProdResult> {
  const gate = await getProdGateState(integrationId);
  if (!gate) {
    return { confirmed: false, runId: null, integrationId };
  }

  // Persist the confirmation onto the run's metadata.
  const [run] = await db
    .select({ id: pipelineRuns.id, metadata: pipelineRuns.metadata })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, gate.runId))
    .limit(1);
  if (!run) return { confirmed: false, runId: null, integrationId };

  const md = (run.metadata ?? {}) as Record<string, unknown>;
  const gates = (md[GATE_METADATA_KEY] as Record<string, ProdGateState>) ?? {};
  gates[integrationId] = {
    ...gate,
    confirmedAt: new Date().toISOString(),
    ...(confirmedByUserId ? { confirmedByUserId } : {}),
  };
  await db
    .update(pipelineRuns)
    .set({ metadata: { ...md, [GATE_METADATA_KEY]: gates }, updatedAt: new Date() })
    .where(eq(pipelineRuns.id, run.id));

  await setCurrentStepForce(run.id, RELEASE_DEPLOY_IN_FLIGHT);

  // Same idempotency guard as the staging loop (ISS-242): a confirmed prod
  // deploy already enqueued for this `:confirmed` requestId must not fire
  // twice if the confirm endpoint is hit again.
  const confirmedRequestId = `${run.id}:${integrationId}:confirmed`;
  const existing = await findDeliveryByRequestId(integrationId, confirmedRequestId);
  if (!existing) {
    await enqueueCoolifyDispatch({
      jobKind: 'coolify.dispatch',
      integrationId,
      runId: run.id,
      issueId: gate.issueId,
      eventName: 'release.requested',
      requestId: confirmedRequestId,
    });
  }

  return { confirmed: true, runId: run.id, integrationId };
}

/**
 * Resolve the most recent issue-run id for an issue, regardless of status.
 *
 * Both the auto-subscriber (below) and the agent-driven `forge_coolify_deploy
 * → deploy` MCP tool need to map an `issueId` to its pipeline run before
 * dispatching, and neither has the runId in hand: by the time a deploy is
 * triggered the issue state-machine has already transitioned to a terminal
 * status (`released` / `closed`) and closed the run, so a status filter would
 * silently skip every deploy. The runId is used purely as a tracking key for
 * the deploy_uuid → run mapping; downstream helpers (setCurrentStep, closeRun)
 * are no-ops on terminal runs, so taking a closed run here is safe.
 */
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
 * Subscribes to `jobCompleted` and forwards `release`-type completions into
 * the Coolify dispatch path. Must be called once at boot.
 */
export function registerReleaseCompletedSubscriber(
  hooks: { on: (event: 'jobCompleted', listener: (payload: {
    jobId: string;
    projectId: string;
    issueId: string | null;
    type: string;
  }) => void | Promise<void>) => void },
): void {
  hooks.on('jobCompleted', async (payload) => {
    if (payload.type !== 'release') return;

    // Map the issue to its latest run (see resolveLatestIssueRunId for why
    // we take the most recent run regardless of status).
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
