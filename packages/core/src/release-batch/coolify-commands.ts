/**
 * The Coolify deploy commands, for every surface that offers them.
 *
 * The MCP tool (`integration-door/coolify-tool.ts`) and the REST twin under
 * `/api/projects/:projectId/integrations/...` call the same functions rather
 * than restating the branch rules — `deploy` in particular decides whether a
 * PROD binding may dispatch, and that decision must not exist twice.
 *
 * Authorisation is the CALLER's job: each surface knows its own principal.
 * Nothing here checks membership.
 */

import type { CoolifyRefusalCode } from '@forge/contracts/integrations';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, pipelineRuns } from '../db/schema.js';
import type { CoolifyConfig } from '../integrations/deploy/index.js';
import {
  effectiveConfig,
  findLastOutboundForTarget,
  listActiveDeployBindingsForProvider,
} from '../integrations/index.js';
import { refuser } from '../lib/refusal.js';
import { approvalRequired, readDeployMap } from '../project-config/index.js';
import { assertApprovalAllowsAttempt } from './approvals.js';
import { readRunMethod } from './method.js';
import { isOpenReleaseBatchRun } from './queries.js';
import { refuseRelease } from './refuse.js';
import {
  type DispatchOutcome,
  dispatchCoolifyDeployDirect,
  tryDispatchCoolifyRelease,
} from './release-coolify.js';

/** A Coolify rule refused by name, in the one refusal envelope. */
export const refuseCoolify = refuser<CoolifyRefusalCode>('COOLIFY_REFUSED');

/**
 * Active Coolify bindings for a project, flattened to the shape the commands
 * consume. `id` is the BINDING id (== old project_integration id for
 * backfilled rows, so the runner-facing `integrationId` values are stable).
 * Health/breaker come from the owning connection; config is the effective
 * connection⊕binding overlay. `pair` is retained for the log commands.
 */
export async function activeCoolifyIntegrations(projectId: string) {
  const [pairs, map] = await Promise.all([
    listActiveDeployBindingsForProvider(projectId, 'coolify'),
    readDeployMap(projectId),
  ]);
  return pairs.map((pair) => ({
    id: pair.binding.id,
    /** The project-document environment this binding deploys; null where none names it. */
    environment: map.environments.get(pair.binding.id)?.name ?? null,
    config: effectiveConfig<CoolifyConfig>(pair),
    lastHealthStatus: pair.connection.lastHealthStatus,
    breakerOpenedAt: pair.connection.breakerOpenedAt,
    pair,
  }));
}

export type CoolifyIntegrationRow = Awaited<ReturnType<typeof activeCoolifyIntegrations>>[number];

/**
 * Pick the one integration the caller means: an explicit `integrationId`, else
 * the project's sole active integration. Returns null when the project has
 * none — the only case the caller must shape itself, because each command's
 * "nothing configured" payload names different fields.
 */
export function resolveIntegrationRow<T extends { id: string }>(
  rows: T[],
  input: { integrationId?: string | undefined },
): T | null {
  const row = input.integrationId
    ? rows.find((r) => r.id === input.integrationId)
    : rows.length === 1
      ? rows[0]
      : undefined;
  if (row) return row;
  if (input.integrationId) {
    throw refuseCoolify(
      'COOLIFY_INTEGRATION_UNRESOLVED',
      'no active Coolify integration with that integrationId',
    );
  }
  if (rows.length === 0) return null;
  throw refuseCoolify(
    'COOLIFY_INTEGRATION_UNRESOLVED',
    'multiple active Coolify integrations — pass integrationId',
  );
}

export async function listCoolifyIntegrations(projectId: string) {
  const rows = await activeCoolifyIntegrations(projectId);
  return {
    integrations: rows.map((row) => ({
      id: row.id,
      environment: row.environment,
      targets: ((row.config as CoolifyConfig | null)?.targets ?? []).map((t) => ({
        id: t.id,
        label: t.label,
        resourceUuid: t.resourceUuid,
      })),
      lastHealthStatus: row.lastHealthStatus,
      breakerOpen: row.breakerOpenedAt !== null,
    })),
  };
}

const shape = (outcome: DispatchOutcome) => ({
  dispatched: outcome.dispatched,
  pendingHumanConfirm: outcome.pendingHumanConfirm,
  integrationIds: outcome.integrationIds,
  ...(outcome.reason ? { reason: outcome.reason } : {}),
});

/**
 * The only thing establishing, before production changes, that this session's credential reaches
 * the half that records what the deploy did (ISS-1211).
 *
 * It read as a method gate and never was one: `readRunMethod` answers non-null for any
 * announcement, `loaded: false` included. ISS-1276 removed the method gate at `finish` and renamed
 * this to say what it checks — a run announcing that its method would not load still deploys.
 */
const RELEASE_DEPLOY_BEFORE_RECORDING =
  'this release run has recorded nothing on its release batch, so nothing ' +
  'shows the credential it runs on can record what this deploy would do. Make one call first — POST .../method ' +
  'says what you are working from, and `loaded: false` with a detail is a valid answer — then deploy. ' +
  'A release deploy is refused before production changes, never after.';

export async function runCoolifyDeploy(input: {
  projectId: string;
  issueId?: string | undefined;
  pipelineRunId?: string | undefined;
  integrationId?: string | undefined;
}) {
  const { projectId } = input;

  if (input.pipelineRunId && !input.issueId) {
    if (!(await isOpenReleaseBatchRun(projectId, input.pipelineRunId))) {
      throw refuseRelease(
        'RELEASE_RUN_NOT_OPEN',
        `pipelineRunId ${input.pipelineRunId} is not an open release-batch run for this project`,
        '/pipelineRunId',
      );
    }
    if ((await readRunMethod(input.pipelineRunId)) === null) {
      throw refuseRelease('RELEASE_NOTHING_RECORDED', RELEASE_DEPLOY_BEFORE_RECORDING);
    }
    // A release run's deploy is one of its production acts, held to the same approval its attempts are.
    await assertApprovalAllowsAttempt(input.pipelineRunId, projectId);
    // ISS-1279 — the release path, and the only caller that takes the deploy lock: a release
    // reaching an environment another is mid-deploy to is refused rather than queued.
    return shape(
      await tryDispatchCoolifyRelease({
        projectId,
        issueId: null,
        runId: input.pipelineRunId,
        integrationId: input.integrationId ?? null,
        allowLive: true,
        takeEnvironmentLock: true,
      }),
    );
  }

  if (input.issueId) {
    const runId = await resolveLatestIssueRunId(input.issueId);
    if (!runId) {
      return {
        dispatched: false,
        pendingHumanConfirm: false,
        integrationIds: [],
        reason: 'no-run',
      };
    }
    const allowLive = await isIssueAtReleaseStage(input.issueId);
    if (allowLive && (await approvalRequired(projectId))) {
      throw refuseRelease(
        'RELEASE_APPROVAL_REQUIRED',
        `project ${projectId} requires release approval (project document \`release.approval.required\`), so an issue at its release stage reaches production only through a release batch an admin approved — cut one with POST /api/projects/${projectId}/release-batches and deploy it by its pipelineRunId`,
      );
    }
    return shape(
      await tryDispatchCoolifyRelease({
        projectId,
        issueId: input.issueId,
        runId,
        integrationId: input.integrationId ?? null,
        allowLive,
      }),
    );
  }

  const row = resolveIntegrationRow(await activeCoolifyIntegrations(projectId), input);
  if (!row) {
    return {
      dispatched: false,
      pendingHumanConfirm: false,
      integrationIds: [],
      reason: 'no-integration',
    };
  }
  return shape(await dispatchCoolifyDeployDirect({ projectId, integrationId: row.id }));
}

/**
 * One row PER TARGET (backend / frontend / …) so an operator can see each app
 * of a multi-target integration independently. A binding with no targets is
 * refused by name: the write schema never lets one in.
 */
export async function coolifyDeliveryStatus(input: {
  projectId: string;
  integrationId?: string | undefined;
}) {
  const rows = await activeCoolifyIntegrations(input.projectId);
  const scoped = input.integrationId ? rows.filter((r) => r.id === input.integrationId) : rows;
  const deliveries = (
    await Promise.all(
      scoped.map(async (row) => {
        const targets = (row.config as CoolifyConfig | null)?.targets ?? [];
        const base = { integrationId: row.id, environment: row.environment };
        const breakerOpen = row.breakerOpenedAt !== null;
        if (targets.length === 0) {
          throw refuseCoolify(
            'COOLIFY_TARGET_UNRESOLVED',
            `coolify binding ${row.id} has no deploy targets; coolifyConfigSchema requires at least one on every write, so a row without any was stored outside it`,
          );
        }
        return Promise.all(
          targets.map(async (t) => {
            const last = await findLastOutboundForTarget(row.id, t.id);
            const response = (last?.response ?? null) as { deployment_uuid?: string } | null;
            return {
              ...base,
              targetId: t.id,
              targetLabel: t.label,
              deploymentUuid: response?.deployment_uuid ?? null,
              status: last?.status ?? null,
              breakerOpen,
              createdAt: last?.createdAt ?? null,
            };
          }),
        );
      }),
    )
  ).flat();
  return { deliveries };
}

async function resolveLatestIssueRunId(issueId: string): Promise<string | null> {
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
async function isIssueAtReleaseStage(issueId: string): Promise<boolean> {
  const [row] = await db
    .select({ status: issues.status })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  return row?.status === 'awaiting_release' || row?.status === 'closed';
}
