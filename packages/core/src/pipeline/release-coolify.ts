import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { pipelineRuns, projectIntegrations } from '../db/schema.js';
import { enqueueCoolifyDispatch } from '../integrations/queue.js';
import { logger } from '../logger.js';
import { isSentryEnabled, Sentry } from '../observability/sentry.js';
import { setCurrentStep, setCurrentStepForOpenIssueRun } from './runs.js';

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
    await setCurrentStep(runId, RELEASE_DEPLOY_SKIPPED);
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

    await setCurrentStep(runId, RELEASE_DEPLOY_IN_FLIGHT);
    if (issueId) await setCurrentStepForOpenIssueRun(issueId, RELEASE_DEPLOY_IN_FLIGHT);
    await enqueueCoolifyDispatch({
      jobKind: 'coolify.dispatch',
      integrationId: row.id,
      runId,
      issueId,
      eventName: 'release.requested',
      requestId: `${runId}:${row.id}`,
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

  await setCurrentStep(input.runId, RELEASE_DEPLOY_PENDING);
  if (input.issueId) await setCurrentStepForOpenIssueRun(input.issueId, RELEASE_DEPLOY_PENDING);

  logger.info(
    { integrationId: input.integrationId, runId: input.runId },
    'coolify: prod deploy awaiting human confirmation',
  );
}

async function getProdGateState(integrationId: string): Promise<ProdGateState | null> {
  // Find the most recent paused/running run that has a gate for this integration.
  const rows = await db
    .select({ id: pipelineRuns.id, metadata: pipelineRuns.metadata })
    .from(pipelineRuns)
    .where(inArray(pipelineRuns.status, ['running', 'paused']));
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

  await setCurrentStep(run.id, RELEASE_DEPLOY_IN_FLIGHT);
  if (gate.issueId) await setCurrentStepForOpenIssueRun(gate.issueId, RELEASE_DEPLOY_IN_FLIGHT);

  await enqueueCoolifyDispatch({
    jobKind: 'coolify.dispatch',
    integrationId,
    runId: run.id,
    issueId: gate.issueId,
    eventName: 'release.requested',
    requestId: `${run.id}:${integrationId}:confirmed`,
  });

  return { confirmed: true, runId: run.id, integrationId };
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

    // Locate the open issue-run so we can stamp + dispatch against it.
    if (!payload.issueId) return;
    const [run] = await db
      .select({ id: pipelineRuns.id })
      .from(pipelineRuns)
      .where(
        and(
          eq(pipelineRuns.issueId, payload.issueId),
          eq(pipelineRuns.kind, 'issue'),
          inArray(pipelineRuns.status, ['running', 'paused']),
        ),
      )
      .limit(1);
    if (!run) {
      logger.debug(
        { jobId: payload.jobId, issueId: payload.issueId },
        'release.deploy hook: no open run — skipping coolify dispatch',
      );
      return;
    }
    try {
      await tryDispatchCoolifyRelease({
        projectId: payload.projectId,
        issueId: payload.issueId,
        runId: run.id,
      });
    } catch (err) {
      logger.error(
        { err, jobId: payload.jobId, projectId: payload.projectId },
        'release.deploy hook: dispatch threw',
      );
    }
  });
}
